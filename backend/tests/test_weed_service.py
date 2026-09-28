"""Synthetic check of weed_service: a field with known rows, an open canopy
and one weed patch between rows must come back with the right spacing,
bearing, an open-canopy status and a candidate polygon at the patch.

Run (from backend/):  python -m tests.test_weed_service
"""

import math
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import weed_service  # noqa: E402


def make_field(path: Path, spacing_m=0.5, bearing_deg=30.0, gsd=0.02, size_m=80.0, patch_m=(20.0, 30.0, 3.0)):
    import rasterio
    from rasterio.transform import from_origin

    n = int(size_m / gsd)
    yy, xx = np.mgrid[0:n, 0:n]
    # map coords (E, N) of each pixel; north-up raster, origin at top-left
    E = xx * gsd
    N = (n - yy) * gsd
    # rows run along the bearing; distance across rows is the perpendicular coordinate
    b = math.radians(bearing_deg)
    across = E * math.cos(b) - N * math.sin(b)
    row_phase = (across % spacing_m) / spacing_m
    on_row = (row_phase < 0.25) | (row_phase > 0.75)  # 25 cm wide crop line per 50 cm row
    rng = np.random.default_rng(0)
    veg = on_row & (rng.random((n, n)) > 0.05)
    px, py, pr = patch_m
    patch = (E - px) ** 2 + (N - py) ** 2 < pr ** 2
    veg |= patch
    rgb = np.zeros((3, n, n), np.uint8)
    rgb[0] = np.where(veg, 60, 150)
    rgb[1] = np.where(veg, 160, 120)
    rgb[2] = np.where(veg, 50, 90)
    with rasterio.open(
        path, "w", driver="GTiff", height=n, width=n, count=3, dtype="uint8", crs="EPSG:32616",
        transform=from_origin(500000.0, 4000000.0 + size_m, gsd, gsd), nodata=0,
    ) as dst:
        dst.write(rgb)
    return px, py


def test_rows_and_candidate():
    from rasterio.warp import transform as warp_transform

    with tempfile.TemporaryDirectory(dir=str(Path(__file__).resolve().parents[2] / ".cache" / "tmp")) as d:
        path = Path(d) / "synthetic.tif"
        px, py = make_field(path)
        r = weed_service.analyze_rows(path)
        print(r.metrics())
        assert r.status == "measured", r.reason
        assert abs(r.row_spacing_m - 0.5) <= 0.06, r.row_spacing_m
        assert min(abs(r.row_orientation_deg - 30.0), abs(r.row_orientation_deg - 210.0) % 180) <= 2.0, r.row_orientation_deg
        assert r.midrow_cover_percent < 35, r.midrow_cover_percent
        assert 1 <= r.candidate_count <= 3, r.candidate_count  # one patch, not one sliver per inter-row
        big = max(r.candidates, key=lambda c: c["area_m2"])
        assert 18 <= big["area_m2"] <= 40, big["area_m2"]  # pi*3^2 = 28 m2 footprint
        # the largest candidate must sit on the synthetic patch
        lon, lat = warp_transform("EPSG:32616", "EPSG:4326", [500000.0 + px], [4000000.0 + py])
        xs = [c[0] for c in big["geometry"]["coordinates"][0]]
        ys = [c[1] for c in big["geometry"]["coordinates"][0]]
        assert min(xs) <= lon[0] <= max(xs) and min(ys) <= lat[0] <= max(ys)
        print("weed_service synthetic test passed")


if __name__ == "__main__":
    test_rows_and_candidate()
