"""Web-Mercator XYZ tile pyramids for survey rasters (the Google-Maps model).

A single flat preview PNG cannot stay sharp when the user zooms in on a
crop row: 2048 px across a 250 m field is ~12 cm/px, however fine the
source raster is. A tile pyramid keeps the raster's native resolution at the
deepest zoom level and serves only the 256x256 tiles the view needs, so the
browser never decodes more than a few megapixels at once.

Layout (served as static files by Next.js, no tile server process):
    frontend/public/tiles/<survey_id>/<layer>/{z}/{x}/{y}.<webp|png>
    frontend/public/tiles/<survey_id>/<layer>/tilemeta.json

Deepest zoom is chosen from the raster's ground sample distance so the last
level is at (or slightly finer than) native resolution; coarser levels are
built bottom-up by 2x2 box-filtering the children with premultiplied alpha
(no dark fringes at the raster's edge). Reprojection to EPSG:3857 is done
per block through a rasterio WarpedVRT, so a multi-gigapixel orthophoto is
never held in memory.

Uses the same colour ramps as the flat previews (orthomosaic_service) so a
layer looks identical whichever provider the viewer picked.
"""

from __future__ import annotations

import io
import json
import logging
import math
import shutil
import threading
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

from app.config import settings
from app.services import gpu
from app.services import orthomosaic_service as ortho

log = logging.getLogger(__name__)

TILE = 256
R = 6378137.0
ORIGIN = -math.pi * R  # web-mercator extent is [-ORIGIN, ORIGIN]
BLOCK_TILES = 8  # warp 8x8 tiles (2048 px) at a time
PYRAMID_RAM_BYTES = 3_000_000_000  # deepest-level tiles kept in RAM (~11k); the rest are re-read from disk
MAX_PENDING_TILES = 512  # tiles queued for encoding before the reader waits
MIN_ZOOM = 14
MAX_ZOOM_CAP = 24
INDEX_LAYERS = {"ndvi", "ndre", "gndvi"}
ELEVATION_LAYERS = {"dsm", "dtm"}
SOURCE_RANK = {"photogrammetry_odm": 0, "direct_georeferencing": 1}


def tile_ext(layer: str) -> str:
    # photos compress far better as lossy WebP; colour ramps stay exact as PNG
    return "webp" if layer == "orthomosaic" else "png"


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tile_size_m(z: int) -> float:
    return 2 * math.pi * R / (2**z)


def zoom_for_gsd(gsd_m: float, lat: float) -> int:
    """Deepest zoom whose ground resolution at this latitude is <= the raster's GSD."""
    ground_per_px_z0 = 2 * math.pi * R * math.cos(math.radians(lat)) / TILE
    z = math.ceil(math.log2(ground_per_px_z0 / gsd_m))
    return int(min(max(z, MIN_ZOOM), MAX_ZOOM_CAP))


def _source_gsd_m(src) -> float:
    if src.crs and src.crs.is_projected:
        return float(abs(src.res[0]))
    lat = (src.bounds.top + src.bounds.bottom) / 2
    return float(abs(src.res[0]) * 111320.0 * math.cos(math.radians(lat)))


def _stats_for_colorize(src, layer: str) -> tuple[float, float] | None:
    """Global stretch limits so every tile of a DSM shares one colour ramp."""
    if layer not in ELEVATION_LAYERS:
        return None
    scale = max(1, max(src.width, src.height) // 2048)
    arr = src.read(1, out_shape=(src.height // scale, src.width // scale), masked=True).astype(np.float32)
    vals = np.asarray(arr.compressed())
    if vals.size == 0:
        return (0.0, 1.0)
    lo, hi = np.percentile(vals, [2, 98])
    return (float(lo), float(hi if hi > lo else lo + 1.0))


def _colorize(bands: np.ndarray, alpha: np.ndarray, layer: str, stats) -> np.ndarray:
    """(bands, H, W) float + alpha (H, W) uint8 -> RGBA uint8."""
    valid = alpha > 0
    if layer in INDEX_LAYERS:
        rgba = ortho._colorize_index(bands[0], valid)
    elif layer in ELEVATION_LAYERS:
        lo, hi = stats
        v = np.clip((np.nan_to_num(bands[0], nan=lo) - lo) / (hi - lo), 0, 1)
        r = np.interp(v, ortho.ELEVATION_STOPS, [c[0] for c in ortho.ELEVATION_COLORS])
        g = np.interp(v, ortho.ELEVATION_STOPS, [c[1] for c in ortho.ELEVATION_COLORS])
        b = np.interp(v, ortho.ELEVATION_STOPS, [c[2] for c in ortho.ELEVATION_COLORS])
        rgba = np.dstack([r, g, b, np.zeros_like(r)]).astype(np.uint8)
    elif bands.shape[0] >= 3:
        rgb = [np.clip(np.nan_to_num(bands[i], nan=0), 0, 255).astype(np.uint8) for i in range(3)]
        rgba = np.dstack([*rgb, np.zeros_like(rgb[0])])
    else:
        g = np.clip(np.nan_to_num(bands[0], nan=0), 0, 255).astype(np.uint8)
        rgba = np.dstack([g, g, g, np.zeros_like(g)])
    rgba[..., 3] = alpha
    rgba[~valid, :3] = 0
    return rgba


def _encode_tile(rgba: np.ndarray, ext: str) -> bytes:
    buf = io.BytesIO()
    img = Image.fromarray(rgba, "RGBA")
    if ext == "webp":
        img.save(buf, "WEBP", quality=88, method=4)
    else:
        img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _save_tile(rgba: np.ndarray, path: Path, ext: str) -> None:
    _write_tile_bytes(_encode_tile(rgba, ext), path)


def _write_tile_bytes(data: bytes, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _load_tile(path: Path) -> np.ndarray | None:
    if not path.exists():
        return None
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA"))


def _downsample(parent: np.ndarray) -> np.ndarray:
    """512x512 RGBA -> 256x256 with premultiplied-alpha box filter."""
    f = parent.astype(np.float32)
    a = f[..., 3:4] / 255.0
    pre = np.concatenate([f[..., :3] * a, a], axis=-1)
    box = pre.reshape(TILE, 2, TILE, 2, 4).mean(axis=(1, 3))
    out_a = box[..., 3:4]
    rgb = np.where(out_a > 1e-6, box[..., :3] / np.maximum(out_a, 1e-6), 0)
    return np.concatenate([rgb, out_a * 255.0], axis=-1).round().clip(0, 255).astype(np.uint8)


def build_xyz_tiles(src_path: Path, out_dir: Path, layer: str, max_zoom: int | None = None,
                    min_zoom: int = MIN_ZOOM) -> dict:
    """Builds the pyramid for one raster; returns the tilemeta that was written."""
    import rasterio
    from rasterio.enums import ColorInterp, Resampling
    from rasterio.transform import from_origin
    from rasterio.vrt import WarpedVRT
    from rasterio.windows import Window

    ext = tile_ext(layer)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    with rasterio.open(src_path) as src:
        west, south, east, north = ortho.get_bounds_wsen(src_path)
        lat_c = (south + north) / 2
        gsd = _source_gsd_m(src)
        zmax = max_zoom if max_zoom is not None else zoom_for_gsd(gsd, lat_c)
        zmin = min(min_zoom, zmax)
        stats = _stats_for_colorize(src, layer)
        has_alpha = src.count in (2, 4) and src.colorinterp[-1] == ColorInterp.alpha
        data_bands = src.count - 1 if has_alpha else src.count

        x0, y0 = lonlat_to_tile(west, north, zmax)
        x1, y1 = lonlat_to_tile(east, south, zmax)
        res = tile_size_m(zmax) / TILE
        grid_w, grid_h = (x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE
        transform = from_origin(ORIGIN + x0 * tile_size_m(zmax), -ORIGIN - y0 * tile_size_m(zmax), res, res)
        log.info("tiles %s: z%d..%d, %dx%d tiles at z%d (%.1f cm/px ground), gsd %.1f cm",
                 layer, zmin, zmax, x1 - x0 + 1, y1 - y0 + 1, zmax, res * math.cos(math.radians(lat_c)) * 100, gsd * 100)

        vrt_kwargs = dict(crs="EPSG:3857", transform=transform, width=grid_w, height=grid_h,
                          resampling=Resampling.bilinear)
        if not has_alpha:
            vrt_kwargs["add_alpha"] = True
        # Encoding (WebP/PNG) is CPU-only and dominated the build when it ran
        # on one thread; Pillow releases the GIL, so a pool scales ~10x. The
        # coarser levels are built from the tiles still in RAM, instead of
        # re-reading (and re-decoding lossy WebP of) the ones just written.
        pool = ThreadPoolExecutor(gpu.default_workers(), thread_name_prefix="agrotwin-tiles")
        pending: deque = deque()
        written = 0

        def save(tile: np.ndarray, z: int, key: tuple[int, int]) -> None:
            nonlocal written
            pending.append(pool.submit(_save_tile, tile, out_dir / str(z) / str(key[0]) / f"{key[1]}.{ext}", ext))
            written += 1
            while len(pending) > MAX_PENDING_TILES:  # backpressure keeps RAM bounded
                pending.popleft().result()

        def make_parent(children: dict, z: int, key: tuple[int, int]) -> np.ndarray:
            x, y = key
            parent = np.zeros((2 * TILE, 2 * TILE, 4), np.uint8)
            for dy in (0, 1):
                for dx in (0, 1):
                    ck = (2 * x + dx, 2 * y + dy)
                    if ck not in children:
                        continue
                    child = children[ck]
                    if child is None:  # spilled past the RAM budget
                        child = _load_tile(out_dir / str(z + 1) / str(ck[0]) / f"{ck[1]}.{ext}")
                    parent[dy * TILE:(dy + 1) * TILE, dx * TILE:(dx + 1) * TILE] = child
            return _downsample(parent)

        try:
            # None = past PYRAMID_RAM_BYTES: that tile is read back from disk
            level: dict[tuple[int, int], np.ndarray | None] = {}
            kept = 0
            # Blocks are warped + colourised on worker threads too (GDAL and
            # numpy release the GIL); a GDAL handle is not thread-safe, so
            # each worker opens its own.
            local = threading.local()
            handles: list = []
            handles_lock = threading.Lock()

            def warp_block(b: tuple[int, int, int, int]) -> np.ndarray | None:
                by, bx, nty, ntx = b
                if not hasattr(local, "vrt"):
                    h = rasterio.open(src_path)
                    local.vrt = WarpedVRT(h, **vrt_kwargs)
                    with handles_lock:
                        handles.append((local.vrt, h))
                win = Window(bx * TILE, by * TILE, ntx * TILE, nty * TILE)
                block = local.vrt.read(window=win).astype(np.float32)
                alpha = np.clip(block[-1], 0, 255).astype(np.uint8)
                if not alpha.any():
                    return None
                return _colorize(block[:data_bands], alpha, layer, stats)

            n_rows, n_cols = y1 - y0 + 1, x1 - x0 + 1
            blocks = [(by, bx, min(BLOCK_TILES, n_rows - by), min(BLOCK_TILES, n_cols - bx))
                      for by in range(0, n_rows, BLOCK_TILES) for bx in range(0, n_cols, BLOCK_TILES)]
            try:
                for i, ((by, bx, nty, ntx), rgba) in enumerate(gpu.prefetch(blocks, warp_block), 1):
                    if i % 16 == 0 or i == len(blocks):
                        log.info("tiles %s: z%d block %d/%d", layer, zmax, i, len(blocks))
                    if rgba is None:
                        continue
                    for ty in range(nty):
                        for tx in range(ntx):
                            tile = rgba[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE].copy()
                            if not tile[..., 3].any():
                                continue
                            key = (x0 + tx + bx, y0 + ty + by)
                            save(tile, zmax, key)
                            if kept + tile.nbytes <= PYRAMID_RAM_BYTES:
                                level[key] = tile
                                kept += tile.nbytes
                            else:
                                level[key] = None
            finally:
                for vrt, h in handles:
                    vrt.close()
                    h.close()

            # coarser levels, bottom-up; each is a quarter of the one below
            for z in range(zmax - 1, zmin - 1, -1):
                if any(v is None for v in level.values()):
                    while pending:  # spilled children must be on disk before they are read back
                        pending.popleft().result()
                keys = sorted({(cx // 2, cy // 2) for cx, cy in level})
                children = level
                level = dict(zip(keys, pool.map(lambda k: make_parent(children, z, k), keys)))
                for key, tile in level.items():
                    save(tile, z, key)
            while pending:
                pending.popleft().result()  # surfaces any encode/write error
        finally:
            pool.shutdown(cancel_futures=True)

    written += fill_blank_tiles(out_dir, west, south, east, north, zmin, zmax, ext)

    meta = {
        "layer": layer,
        "bounds": [west, south, east, north],
        "minzoom": zmin,
        "maxzoom": zmax,
        "format": ext,
        "tile_size": TILE,
        "scheme": "xyz",
        "source_gsd_m": round(gsd, 4),
        "tiles": written,
    }
    (out_dir / "tilemeta.json").write_text(json.dumps(meta, indent=2))
    log.info("tiles %s: %d tiles written to %s", layer, written, out_dir)
    return meta


def fill_blank_tiles(out_dir: Path, west, south, east, north, zmin: int, zmax: int, ext: str) -> int:
    """Writes a fully transparent tile at every in-bounds position that has
    no data, so the viewer never logs 404s for the raster's empty corners."""
    blank = _encode_tile(np.zeros((TILE, TILE, 4), np.uint8), ext)  # encode once
    missing = []
    for z in range(zmin, zmax + 1):
        x0, y0 = lonlat_to_tile(west, north, z)
        x1, y1 = lonlat_to_tile(east, south, z)
        # one tile of margin: Cesium's rectangle->tile range can round outwards
        for x in range(max(x0 - 1, 0), min(x1 + 2, 2**z)):
            for y in range(max(y0 - 1, 0), min(y1 + 2, 2**z)):
                path = out_dir / str(z) / str(x) / f"{y}.{ext}"
                if not path.exists():
                    missing.append(path)
    with ThreadPoolExecutor(gpu.default_workers(), thread_name_prefix="agrotwin-tiles") as pool:
        list(pool.map(lambda path: _write_tile_bytes(blank, path), missing))
    return len(missing)


def public_tiles_dir(survey_id: str, layer: str) -> Path:
    return settings.public_tiles_dir / survey_id / layer


def tiles_url(survey_id: str, layer: str) -> str:
    return f"/tiles/{survey_id}/{layer}"


def build_survey_tiles(db, survey, layers: tuple[str, ...] = ("orthomosaic", "ndvi", "ndre", "gndvi", "dsm"),
                       max_zoom: int | None = None) -> list:
    """Tiles each of the survey's GeoTIFF rasters and registers an "xyz" asset
    next to the source raster asset (same asset_type, format="xyz")."""
    from app import models

    created = []
    for layer in layers:
        cands = [a for a in survey.assets if a.asset_type == layer and (a.format or "").lower() in ("tif", "tiff")
                 and a.path.exists()]
        if not cands:
            continue
        src = min(cands, key=lambda a: SOURCE_RANK.get(a.source, 2))
        out_dir = public_tiles_dir(survey.id, layer)
        meta = build_xyz_tiles(src.path, out_dir, layer, max_zoom=max_zoom)
        for old in [a for a in survey.assets if a.asset_type == layer and a.format == "xyz"]:
            db.delete(old)
        db.flush()
        asset = models.SurveyAsset(
            survey_id=survey.id, asset_type=layer, file_path=str(out_dir), format="xyz",
            bounds_geojson=json.dumps(ortho.extract_bounds_geojson(src.path)), source=src.source,
        )
        db.add(asset)
        created.append(asset)
        log.info("registered xyz asset %s (z%d..%d)", layer, meta["minzoom"], meta["maxzoom"])
    db.flush()
    return created
