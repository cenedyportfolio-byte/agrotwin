"""Orthomosaic / raster-asset import, bounds extraction, and preview rendering.

For the local MVP an orthomosaic (or NDVI/NDRE/GNDVI index raster) is
imported manually (from ODM/WebODM, DJI Terra, Metashape, or a multispectral
pipeline) as a GeoTIFF and registered as a SurveyAsset. Georeferenced bounds
are read directly from the raster so the frontend places it correctly in
Cesium — never at an arbitrary location.

There is no tile server (TiTiler/GeoServer) yet — that's the documented next
step for large rasters. For the MVP, `generate_preview_png` reprojects the
raster to EPSG:4326, downsamples it to a browser-friendly size, and rasters
it to a flat PNG that exactly covers the same bounds returned by
`extract_bounds_geojson`. The frontend then places that PNG with Cesium's
SingleTileImageryProvider + Rectangle — simple, but geospatially correct.
"""

from pathlib import Path

import numpy as np

HEALTH_STOPS = [0.0, 0.5, 1.0]
HEALTH_COLORS = [(239, 68, 68), (234, 179, 8), (34, 197, 94)]  # problem -> attention -> healthy


class RasterioUnavailableError(Exception):
    pass


def _require_rasterio():
    try:
        import rasterio
        from rasterio.warp import transform_bounds

        return rasterio, transform_bounds
    except ImportError as exc:
        raise RasterioUnavailableError(
            "rasterio is not installed — run `pip install rasterio` to import GeoTIFF assets"
        ) from exc


def get_bounds_wsen(path: Path) -> tuple[float, float, float, float]:
    """Returns (west, south, east, north) in EPSG:4326."""
    rasterio, transform_bounds = _require_rasterio()
    with rasterio.open(path) as src:
        b = src.bounds
        if src.crs and src.crs.to_epsg() != 4326:
            return transform_bounds(src.crs, "EPSG:4326", *b)
        return (b.left, b.bottom, b.right, b.top)


def extract_bounds_geojson(path: Path) -> dict:
    """Returns a GeoJSON Polygon of the raster's bounding box in EPSG:4326."""
    west, south, east, north = get_bounds_wsen(path)
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ]
        ],
    }


INDEX_DISPLAY_RANGE = (-0.2, 0.8)  # display stretch for NDVI-type indices; bare soil ~0, dense canopy ~0.8


def _colorize_index(band: np.ndarray, valid_mask: np.ndarray, vmin: float = INDEX_DISPLAY_RANGE[0], vmax: float = INDEX_DISPLAY_RANGE[1]) -> np.ndarray:
    """Maps a vegetation-index raster to the app's red/amber/green scale.
    Only the display stretch is tuned — stored statistics are never altered."""
    v = np.clip(np.nan_to_num(band, nan=vmin), vmin, vmax)
    v = (v - vmin) / (vmax - vmin)  # -> 0..1

    r = np.interp(v, HEALTH_STOPS, [c[0] for c in HEALTH_COLORS])
    g = np.interp(v, HEALTH_STOPS, [c[1] for c in HEALTH_COLORS])
    b = np.interp(v, HEALTH_STOPS, [c[2] for c in HEALTH_COLORS])

    alpha = np.where(valid_mask, 255, 0)
    rgba = np.dstack([r, g, b, alpha]).astype(np.uint8)
    rgba[~valid_mask, :3] = 0  # no colour under transparent pixels -> no fringe when resampled
    return rgba


ELEVATION_STOPS = [0.0, 0.25, 0.5, 0.75, 1.0]
ELEVATION_COLORS = [(38, 70, 83), (42, 157, 143), (233, 196, 106), (244, 162, 97), (231, 111, 81)]  # low -> high


def _colorize_elevation(band: np.ndarray, valid_mask: np.ndarray) -> np.ndarray:
    """Hypsometric ramp stretched between the raster's 2nd/98th percentiles —
    relative relief of this field, not absolute height classes."""
    vals = band[valid_mask]
    lo, hi = (np.percentile(vals, [2, 98]) if vals.size else (0.0, 1.0))
    if hi <= lo:
        hi = lo + 1.0
    v = np.clip((np.nan_to_num(band, nan=lo) - lo) / (hi - lo), 0, 1)
    r = np.interp(v, ELEVATION_STOPS, [c[0] for c in ELEVATION_COLORS])
    g = np.interp(v, ELEVATION_STOPS, [c[1] for c in ELEVATION_COLORS])
    b = np.interp(v, ELEVATION_STOPS, [c[2] for c in ELEVATION_COLORS])
    rgba = np.dstack([r, g, b, np.where(valid_mask, 255, 0)]).astype(np.uint8)
    rgba[~valid_mask, :3] = 0
    return rgba


def _stretch_rgb(bands: np.ndarray, valid_mask: np.ndarray) -> np.ndarray:
    """Percentile-stretches 1-3+ raw bands into a displayable RGBA uint8 image."""
    band_count = bands.shape[0]
    channels = [bands[0], bands[1], bands[2]] if band_count >= 3 else [bands[0]] * 3

    out = []
    for ch in channels:
        ch = np.where(valid_mask, ch, 0.0)
        valid_values = ch[valid_mask]
        if valid_values.size == 0:
            out.append(np.zeros_like(ch, dtype=np.uint8))
            continue
        lo, hi = np.percentile(valid_values, [2, 98])
        if hi <= lo:
            hi = lo + 1.0
        stretched = np.clip((ch - lo) / (hi - lo), 0, 1) * 255
        out.append(stretched.astype(np.uint8))

    alpha = np.where(valid_mask, 255, 0).astype(np.uint8)
    return np.dstack([*out, alpha])


def generate_preview_png(path: Path, asset_type: str, max_dim: int = 2048) -> tuple[bytes, tuple[float, float, float, float]]:
    """Reprojects the raster to EPSG:4326 and rasters it to a PNG covering
    exactly (west, south, east, north) — the same bounds stored on the
    SurveyAsset — so Cesium can place it with a SingleTileImageryProvider.
    """
    rasterio, _ = _require_rasterio()
    from rasterio.warp import Resampling, reproject
    import io

    from PIL import Image

    west, south, east, north = get_bounds_wsen(path)
    aspect = (east - west) / (north - south) if north != south else 1.0
    if aspect >= 1:
        width, height = max_dim, max(1, round(max_dim / aspect))
    else:
        height, width = max_dim, max(1, round(max_dim * aspect))

    dst_transform = rasterio.transform.from_bounds(west, south, east, north, width, height)

    with rasterio.open(path) as src:
        src_dtype = str(src.dtypes[0])
        band_count = min(src.count, 3) if src.count >= 3 else src.count
        dst = np.full((band_count, height, width), np.nan, dtype=np.float32)
        for i in range(1, band_count + 1):
            reproject(
                source=rasterio.band(src, i),
                destination=dst[i - 1],
                src_transform=src.transform,
                src_crs=src.crs,
                dst_transform=dst_transform,
                dst_crs="EPSG:4326",
                src_nodata=src.nodata,
                dst_nodata=np.nan,
                # class rasters must not be blended into in-between values
                resampling=Resampling.nearest if asset_type == "vegetation_mask" else Resampling.bilinear,
            )

    valid_mask = ~np.isnan(dst[0])

    if asset_type == "vegetation_mask" and band_count == 1:
        # 2 = vegetation (green), 1 = soil/other (transparent), nodata outside
        veg = valid_mask & (dst[0] >= 1.5)
        rgba = np.zeros((height, width, 4), dtype=np.uint8)
        rgba[veg] = (34, 197, 94, 170)
    elif asset_type in ("ndvi", "ndre", "gndvi") and band_count == 1:
        rgba = _colorize_index(dst[0], valid_mask)
    elif asset_type == "dsm" and band_count == 1:
        rgba = _colorize_elevation(dst[0], valid_mask)
    elif src_dtype == "uint8" and band_count >= 3:
        # already display-ready (e.g. our own RGB mosaic): no stretch, or colours shift
        rgb = [np.clip(np.nan_to_num(dst[i], nan=0), 0, 255).astype(np.uint8) for i in range(3)]
        alpha = np.where(valid_mask, 255, 0).astype(np.uint8)
        rgba = np.dstack([*rgb, alpha])
    else:
        rgba = _stretch_rgb(dst, valid_mask)

    img = Image.fromarray(rgba, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), (west, south, east, north)
