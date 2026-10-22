"""Crop greenness over the season from the Sentinel-2 satellites (ESA
Copernicus data, free; read from the public copies on AWS found through
Element 84's Earth Search catalogue — no account needed): the field's average
NDVI on every clear pass, every few days, between the drone flights.
10 m pixels: the whole crop's trend, not weeds or single plants.

A pass counts when most of the field is clear: the scene's own classification
(SCL) marks cloud, cloud shadow, snow and bad pixels, which are left out.
Looked up in the background and kept with the field; later lookups read only
the passes not seen yet. Only a box a little larger than the field goes to the
catalogue; the images are read straight from the public files, just the few
pixels around the field.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import numpy as np
from shapely import contains_xy
from shapely.geometry import box, mapping, shape

from app import models
from app.config import settings
from app.database import SessionLocal
from app.services import external_data, soil_service
from app.services.external_data import LookupFailed

log = logging.getLogger(__name__)

COLLECTION = "sentinel-2-l2a"
SOURCE = "Contains modified Copernicus Sentinel data, read from Earth Search (AWS Open Data)"
CLEAR_SCL = (4, 5, 6, 7)  # vegetation, not vegetated, water, unclassified
# share of the field's pixels that must be clear for a pass to count: haze next
# to a cloud is not always marked, and pulls a partly clear pass down
MIN_CLEAR = 0.9
MIN_PIXELS = 20  # 10 m pixels: about half an acre
MARGIN_DEG = 0.002
REFRESH_AFTER = timedelta(hours=12)
READ_WORKERS = 3
SAVE_EVERY = 4  # passes between progress saves
GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MULTIRANGE": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_TIMEOUT": "60",
    "GDAL_HTTP_MAX_RETRY": "2",
    "GDAL_HTTP_RETRY_DELAY": "2",
}


def season(field: models.Field, today: date | None = None) -> tuple[date, date]:
    """March to November of the year of the field's latest flight (this year without one)."""
    today = today or external_data.now().date()
    dates = [(s.survey_date or s.created_at).date() for s in field.surveys if (s.survey_date or s.created_at)]
    year = max(dates).year if dates else today.year
    return date(year, 3, 1), min(date(year, 11, 30), today)


def search(bounds: tuple[float, float, float, float], start: date, end: date) -> list[dict]:
    """Every scene over the box between the dates, less cloudy than the limit."""
    body = {
        "collections": [COLLECTION],
        "bbox": [round(v, 3) for v in bounds],
        "datetime": f"{start.isoformat()}T00:00:00Z/{end.isoformat()}T23:59:59Z",
        "limit": 100,
        "query": {"eo:cloud_cover": {"lt": settings.satellite_max_cloud}},
    }
    url, items = f"{settings.stac_url.rstrip('/')}/search", []
    for _ in range(20):  # pages
        page = external_data.get_json(url, body=body, timeout=60)
        items.extend(page.get("features") or [])
        nxt = next((link for link in page.get("links") or [] if link.get("rel") == "next"), None)
        if not nxt:
            break
        url = nxt.get("href", url)
        body = {**body, **(nxt.get("body") or {})}
    return items


def passes(items: list[dict], field_box) -> dict[str, dict]:
    """One scene per satellite pass: the same pass is cut into overlapping
    tiles, and the tile that holds the whole field is the one read."""
    chosen: dict[str, dict] = {}
    for item in items:
        props = item.get("properties") or {}
        key = f"{props.get('datetime', '')[:16]}|{props.get('platform', '')}"
        if not props.get("datetime") or not all(k in (item.get("assets") or {}) for k in ("red", "nir", "scl")):
            continue
        try:
            covers = shape(item["geometry"]).contains(field_box)
        except (KeyError, ValueError, TypeError, AttributeError):
            covers = False
        if key not in chosen or (covers and not chosen[key]["covers"]):
            chosen[key] = {"item": item, "covers": covers}
    return {k: v["item"] for k, v in chosen.items() if v["covers"]}


def _path(href: str) -> str:
    """A scene file for rasterio: over HTTP for the public copies, else a local file."""
    return f"/vsicurl/{href}" if href.startswith(("http://", "https://")) else href


def _scale(asset: dict, offset_removed: bool) -> tuple[float, float]:
    """(scale, offset) to reflectance. Since processing baseline 04.00 ESA stores
    reflectance + 0.1; Earth Search removes that again in its copies (the item
    says earthsearch:boa_offset_applied), while the band metadata still lists
    the -0.1 — applied twice it would push the red below zero and every NDVI
    towards 1."""
    band = (asset.get("raster:bands") or [{}])[0]
    return float(band.get("scale", 0.0001)), 0.0 if offset_removed else float(band.get("offset", 0.0))


def read_pass(item: dict, outline) -> dict:
    """The field's NDVI on one pass: mean, 10th and 90th percentile over its
    clear pixels, or ndvi None when too much of it is under cloud."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import transform_geom
    from rasterio.windows import bounds as window_bounds
    from rasterio.windows import from_bounds
    from rasterio.windows import transform as window_transform

    props, assets = item["properties"], item["assets"]
    out = {"date": props["datetime"][:10], "time": props["datetime"][11:16], "scene": item.get("id"), "ndvi": None}
    with rasterio.Env(**GDAL_ENV):
        with rasterio.open(_path(assets["red"]["href"])) as red_src:
            geom = transform_geom("EPSG:4326", red_src.crs, mapping(outline))
            win = from_bounds(*shape(geom).bounds, transform=red_src.transform).round_offsets().round_lengths()
            win = win.__class__(win.col_off - 1, win.row_off - 1, win.width + 2, win.height + 2)
            h, w = int(win.height), int(win.width)
            win_tf = window_transform(win, red_src.transform)
            # pixels whose centre is inside the field (shapely: no GDAL dataset per call, safe on worker threads)
            cols, rows = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
            xs = win_tf.c + win_tf.a * cols + win_tf.b * rows
            ys = win_tf.f + win_tf.d * cols + win_tf.e * rows
            inside = contains_xy(shape(geom), xs, ys)
            n_field = int(inside.sum())
            if n_field < MIN_PIXELS:
                return {**out, "too_small": True}
            area = window_bounds(win, red_src.transform)
            with rasterio.open(_path(assets["scl"]["href"])) as scl_src:
                scl = scl_src.read(1, window=from_bounds(*area, transform=scl_src.transform), out_shape=(h, w),
                                   resampling=Resampling.nearest, boundless=True, fill_value=0)
            clear = inside & np.isin(scl, CLEAR_SCL)
            out["clear"] = round(float(clear.sum()) / n_field, 3)
            if out["clear"] < MIN_CLEAR:
                return out
            red_dn = red_src.read(1, window=win, boundless=True, fill_value=0).astype("float64")
        with rasterio.open(_path(assets["nir"]["href"])) as nir_src:
            nir_dn = nir_src.read(1, window=from_bounds(*area, transform=nir_src.transform), out_shape=(h, w),
                                  boundless=True, fill_value=0).astype("float64")
    removed = bool(props.get("earthsearch:boa_offset_applied"))
    (rs, ro), (ns, no) = _scale(assets["red"], removed), _scale(assets["nir"], removed)
    red, nir = red_dn * rs + ro, nir_dn * ns + no
    ok = clear & (red_dn > 0) & (nir_dn > 0) & ((nir + red) > 0)
    if int(ok.sum()) < MIN_PIXELS:
        out["clear"] = round(float(ok.sum()) / n_field, 3)
        return out
    ndvi = np.clip((nir[ok] - red[ok]) / (nir[ok] + red[ok]), -1, 1)
    out.update(ndvi=round(float(ndvi.mean()), 3), p10=round(float(np.percentile(ndvi, 10)), 3),
               p90=round(float(np.percentile(ndvi, 90)), 3), pixels=int(ok.sum()))
    return out


def _save(field_id: str, key: str, data: dict) -> bool:
    """Writes the field's satellite record unless its outline changed meanwhile."""
    db = SessionLocal()
    try:
        field = db.get(models.Field, field_id)
        if field is None or soil_service.outline_key(field) != key:
            return False
        field.satellite_json = json.dumps(data)
        db.commit()
        return True
    finally:
        db.close()


def lookup(field_id: str) -> None:
    """Background: reads the passes of the season not seen yet."""
    db = SessionLocal()
    try:
        field = db.get(models.Field, field_id)
        if field is None or not field.boundary_geojson:
            return
        key, outline = soil_service.outline_key(field), shape(json.loads(field.boundary_geojson))
        start, end = season(field)
        old = json.loads(field.satellite_json) if field.satellite_json else {}
    finally:
        db.close()  # no database transaction open while the network is asked
    same = old.get("outline_key") == key and old.get("season", {}).get("start") == start.isoformat()
    scenes: dict = dict(old.get("scenes") or {}) if same else {}
    data = {"outline_key": key, "season": {"start": start.isoformat(), "end": end.isoformat()},
            "source": SOURCE, "scenes": scenes}
    minx, miny, maxx, maxy = outline.bounds
    try:
        found = passes(search((minx - MARGIN_DEG, miny - MARGIN_DEG, maxx + MARGIN_DEG, maxy + MARGIN_DEG), start, end),
                       box(minx, miny, maxx, maxy))
    except LookupFailed as exc:
        log.warning("satellite passes for field %s: %s", field_id, exc)
        _save(field_id, key, {**data, "status": "unavailable", "reason": str(exc)[:300], "checked_at": external_data.stamp()})
        return
    todo = [(k, item) for k, item in sorted(found.items()) if k not in scenes]
    done = 0
    with ThreadPoolExecutor(READ_WORKERS, thread_name_prefix="agrotwin-sat") as pool:
        futures = [(k, pool.submit(read_pass, item, outline)) for k, item in todo]
        for k, fut in futures:
            try:
                result = fut.result()
            except Exception as exc:  # one unreadable pass is skipped, the rest carry on
                log.warning("satellite pass %s for field %s: %s", k, field_id, exc)
                continue
            if result.get("too_small"):
                _save(field_id, key, {**data, "status": "too_small", "checked_at": external_data.stamp()})
                pool.shutdown(cancel_futures=True)
                return
            scenes[k] = result
            done += 1
            if done % SAVE_EVERY == 0 and not _save(field_id, key, {**data, "status": "fetching", "progress": {"done": done, "todo": len(todo)}}):
                pool.shutdown(cancel_futures=True)
                return
    _save(field_id, key, {**data, "status": "ok", "checked_at": external_data.stamp()})


def timeline(field: models.Field, start_lookup: bool = True) -> dict:
    """The season's clear passes for the page; starts a lookup when the record
    is missing, is for another outline or season, or is half a day old."""
    if not field.boundary_geojson:
        return {"status": "no_outline"}
    data = json.loads(field.satellite_json) if field.satellite_json else {}
    start, end = season(field)
    current = data.get("outline_key") == soil_service.outline_key(field) and data.get("season", {}).get("start") == start.isoformat()
    status = data.get("status") if current else None
    wanted = (not current or status == "fetching"
              or (status == "ok" and external_data.stale(data.get("checked_at"), REFRESH_AFTER))
              or (status == "unavailable" and external_data.stale(data.get("checked_at"), external_data.RETRY_AFTER)))
    running = False
    if wanted and status != "too_small" and start_lookup:
        running = external_data.start(f"satellite:{field.id}", lookup, field.id)
    scenes = (data.get("scenes") or {}) if current else {}
    clear = [p for p in scenes.values() if p.get("ndvi") is not None and (p.get("clear") or 0) >= MIN_CLEAR]
    by_day: dict[str, dict] = {}
    for p in clear:  # two passes on one day: the clearer
        if p["date"] not in by_day or p.get("clear", 0) > by_day[p["date"]].get("clear", 0):
            by_day[p["date"]] = p
    flights = sorted(({"survey_id": s.id, "name": s.name, "date": (s.survey_date or s.created_at).date().isoformat()}
                      for s in field.surveys if (s.survey_date or s.created_at)), key=lambda f: f["date"])
    return {
        "status": "fetching" if running else (status or ("off" if not external_data.enabled() else "fetching")),
        "season": {"start": start.isoformat(), "end": end.isoformat()},
        "points": [{k: p.get(k) for k in ("date", "ndvi", "p10", "p90", "clear")} for _, p in sorted(by_day.items())],
        "passes": len(scenes),
        "cloudy": len(scenes) - len(clear),
        "flights": [f for f in flights if start.isoformat() <= f["date"] <= end.isoformat()],
        "progress": data.get("progress") if running or status == "fetching" else None,
        "checked_at": data.get("checked_at") if current else None,
        "source": SOURCE,
    }
