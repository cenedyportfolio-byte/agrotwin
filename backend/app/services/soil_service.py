"""The soil under a field, from the USDA soil survey (SSURGO, through Soil Data
Access — public data, US fields only): every soil map unit inside the outline
with its share of the field, its drainage, hydrologic group, slope, flooding
and water table, and the main soil's surface layer — texture, organic matter,
pH and sand / silt / clay.

Context for the farmer and their agronomist: a spot that lies on a poorly
drained soil is shown as lying there, never as caused by it. Looked up once
per outline, in the background; only a box a little larger than the field is
sent, and the field is cut out of the answer here.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math

from shapely import wkt as shapely_wkt
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, box, mapping, shape
from shapely.ops import transform, unary_union

from app import models
from app.config import settings
from app.database import SessionLocal
from app.services import external_data
from app.services.external_data import LookupFailed

log = logging.getLogger(__name__)

SOURCE = "USDA NRCS Soil Survey (SSURGO)"
MARGIN_DEG = 0.001  # about 100 m around the field: the box that is sent
SIMPLIFY_DEG = 0.00001  # about 1 m, for the soil map drawn on the page
M2_PER_ACRE = 4046.86
MIN_PIECE_M2 = 40  # 0.01 acre
EARTH_RADIUS_M = 6371000.0
# wetter to drier is not a ranking of good to bad: shown as the survey words them
DRAINAGE = ["Excessively drained", "Somewhat excessively drained", "Well drained", "Moderately well drained",
            "Somewhat poorly drained", "Poorly drained", "Very poorly drained", "Subaqueous"]


def outline_key(field: models.Field) -> str | None:
    return hashlib.sha1(field.boundary_geojson.encode()).hexdigest()[:12] if field.boundary_geojson else None


def area_m2(geom) -> float:
    """Area of a longitude/latitude shape, on a flat projection around it."""
    if geom.is_empty:
        return 0.0
    lat0 = geom.centroid.y
    k = math.cos(math.radians(lat0)) * EARTH_RADIUS_M
    return transform(lambda x, y, z=None: (x * math.pi / 180 * k, y * math.pi / 180 * EARTH_RADIUS_M), geom).area


def _polygons(geom):
    """The polygon parts of a shape (an intersection can also give lines and points)."""
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    if isinstance(geom, GeometryCollection):
        return unary_union([g for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon))])
    return Polygon()


def _query(sql: str) -> list[dict]:
    data = external_data.get_json(settings.soil_data_url, body={"query": sql, "format": "JSON+COLUMNNAME"}, timeout=90)
    table = (data or {}).get("Table") or []
    if not table:
        return []
    header, *rows = table
    return [dict(zip(header, row)) for row in rows]


def _num(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fetch(outline) -> dict:
    """The soil map units inside an outline (a lon/lat shape). Raises LookupFailed."""
    minx, miny, maxx, maxy = outline.bounds
    area_box = box(round(minx - MARGIN_DEG, 4), round(miny - MARGIN_DEG, 4), round(maxx + MARGIN_DEG, 4), round(maxy + MARGIN_DEG, 4))
    g = f"geometry::STGeomFromText('{area_box.wkt}', 4326)"
    rows = _query(f"SELECT mp.mukey, mp.mupolygongeo.STIntersection({g}).STAsText() AS wkt "
                  f"FROM mupolygon mp WHERE mp.mupolygongeo.STIntersects({g}) = 1")
    pieces: dict[str, list] = {}
    for row in rows:
        key = str(row.get("mukey") or "")
        if not key.isdigit():
            continue
        try:
            geom = _polygons(shapely_wkt.loads(row["wkt"])).intersection(outline)
        except (ValueError, TypeError, KeyError):
            continue
        geom = _polygons(geom)
        if not geom.is_empty:
            pieces.setdefault(key, []).append(geom)
    if not pieces:
        return {"status": "none", "source": SOURCE}

    shapes = {k: unary_union(v) for k, v in pieces.items()}
    areas = {k: area_m2(geom) for k, geom in shapes.items()}
    # slivers where the survey's lines and the field's edge nearly meet
    shapes = {k: g for k, g in shapes.items() if areas[k] >= MIN_PIECE_M2} or shapes
    areas = {k: areas[k] for k in shapes}
    total = sum(areas.values()) or 1.0
    keys = ",".join(f"'{k}'" for k in shapes)
    units = {r["mukey"]: r for r in _query(
        "SELECT mu.mukey, mu.musym, mu.muname, ma.drclassdcd, ma.hydgrpdcd, ma.slopegraddcp, ma.flodfreqdcd, ma.wtdepannmin "
        f"FROM mapunit mu LEFT JOIN muaggatt ma ON ma.mukey = mu.mukey WHERE mu.mukey IN ({keys})")}
    surface: dict[str, dict] = {}
    for r in _query(
            "SELECT c.mukey, c.compname, c.comppct_r, h.om_r, h.ph1to1h2o_r, h.sandtotal_r, h.silttotal_r, h.claytotal_r, "
            "(SELECT TOP 1 tg.texdesc FROM chtexturegrp tg WHERE tg.chkey = h.chkey AND tg.rvindicator = 'Yes') AS texture "
            "FROM component c LEFT JOIN chorizon h ON h.cokey = c.cokey AND h.hzdept_r = 0 "
            f"WHERE c.mukey IN ({keys}) AND c.majcompflag = 'Yes'"):
        if (_num(r.get("comppct_r")) or 0) >= (_num((surface.get(r["mukey"]) or {}).get("comppct_r")) or -1):
            surface[r["mukey"]] = r

    out, features = [], []
    for key in sorted(shapes, key=lambda k: -areas[k]):
        u, top = units.get(key, {}), surface.get(key, {})
        out.append({
            "mukey": key,
            "symbol": u.get("musym"),
            "name": u.get("muname") or "Unnamed soil",
            "acres": round(areas[key] / M2_PER_ACRE, 2),
            "share": round(areas[key] / total * 100, 1),
            "drainage": u.get("drclassdcd"),
            "hydrologic_group": u.get("hydgrpdcd"),
            "slope_pct": _num(u.get("slopegraddcp")),
            "flooding": u.get("flodfreqdcd"),
            "water_table_cm": _num(u.get("wtdepannmin")),
            "soil": top.get("compname"),
            "texture": top.get("texture"),
            "organic_matter_pct": _num(top.get("om_r")),
            "ph": _num(top.get("ph1to1h2o_r")),
            "sand_pct": _num(top.get("sandtotal_r")),
            "silt_pct": _num(top.get("silttotal_r")),
            "clay_pct": _num(top.get("claytotal_r")),
        })
        geom = mapping(shapes[key].simplify(SIMPLIFY_DEG, preserve_topology=True))
        geom["coordinates"] = json.loads(json.dumps(geom["coordinates"]), parse_float=lambda v: round(float(v), 6))
        features.append({"type": "Feature", "geometry": geom,
                         "properties": {"mukey": key, "symbol": u.get("musym"), "drainage": u.get("drclassdcd")}})
    return {"status": "ok", "source": SOURCE, "units": out, "geojson": {"type": "FeatureCollection", "features": features}}


def lookup(field_id: str) -> None:
    """Background: the field's soil, kept in field.soil_json for this outline."""
    db = SessionLocal()
    try:
        field = db.get(models.Field, field_id)
        if field is None or not field.boundary_geojson:
            return
        key, outline = outline_key(field), shape(json.loads(field.boundary_geojson))
    finally:
        db.close()  # no database transaction open while the network is asked
    try:
        data = fetch(outline)
    except LookupFailed as exc:
        log.warning("soil for field %s: %s", field_id, exc)
        data = {"status": "unavailable", "reason": str(exc)[:300]}
    data.update(outline_key=key, checked_at=external_data.stamp())
    db = SessionLocal()
    try:
        field = db.get(models.Field, field_id)
        if field is not None and outline_key(field) == key:  # not if the outline changed meanwhile
            field.soil_json = json.dumps(data)
            db.commit()
    finally:
        db.close()


def soil(field: models.Field, start_lookup: bool = True) -> dict:
    """The field's soil as kept, or {"status": "fetching"} while it is looked
    up — started here when there is none for the current outline."""
    if not field.boundary_geojson:
        return {"status": "no_outline"}
    data = json.loads(field.soil_json) if field.soil_json else None
    if data and data.get("outline_key") == outline_key(field):
        if data["status"] in ("ok", "none"):
            return data
        if not external_data.stale(data.get("checked_at"), external_data.RETRY_AFTER):
            return data
    if not external_data.enabled():
        return {"status": "off"}
    if start_lookup:
        external_data.start(f"soil:{field.id}", lookup, field.id)
    return {"status": "fetching"}


def spots_by_soil(spots: list[dict]) -> dict[str, dict]:
    """How many of the spots lie (mostly) on each soil, and their acres."""
    out: dict[str, dict] = {}
    for spot in spots:
        t = out.setdefault(spot["mukey"], {"count": 0, "acres": 0.0})
        t["count"] += 1
        t["acres"] = round(t["acres"] + spot["acres"], 3)
    return out


def spots_on_soil(field: models.Field, data: dict, limit: int | None = None) -> list[dict]:
    """The latest analysed flight's spots, each with the soil it mostly lies on (largest first)."""
    if data.get("status") != "ok":
        return []
    results = [r for s in field.surveys for r in s.analysis_results]
    if not results:
        return []
    latest = max(results, key=lambda r: r.created_at)
    soils = [(f["properties"]["mukey"], shape(f["geometry"])) for f in data["geojson"]["features"]]
    names = {u["mukey"]: u for u in data["units"]}
    out = []
    for zone in latest.detections:
        try:
            geom = _polygons(shape(json.loads(zone.geometry_geojson)))
        except (ValueError, TypeError, KeyError, AttributeError):
            continue
        zone_area = area_m2(geom)
        if zone_area <= 0:
            continue
        overlaps = [(key, area_m2(_polygons(geom.intersection(s)))) for key, s in soils]
        key, shared = max(overlaps, key=lambda o: o[1], default=(None, 0.0))
        if not key or shared <= 0:
            continue
        unit = names.get(key, {})
        out.append({
            "zone_id": zone.id, "type": zone.type, "severity": zone.severity,
            "acres": round(zone_area / M2_PER_ACRE, 3),
            "mukey": key, "symbol": unit.get("symbol"), "soil": unit.get("name"), "drainage": unit.get("drainage"),
            "share": round(min(1.0, shared / zone_area) * 100),
        })
    out.sort(key=lambda s: -s["acres"])
    return out[:limit] if limit else out
