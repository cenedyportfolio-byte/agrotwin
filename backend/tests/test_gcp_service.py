"""Synthetic checks of the ground-control-target finder and the boundary that
takes the targets in: a rotated 60 cm checkerboard on a straw-and-soil
texture is found at the right place, bright straw stripes are not, a 17 cm
marker is found at the orthophoto's own resolution while a dimmer straw
look-alike is not, targets are named (GCPs by compass, markers M1… north to
south) and sorted, and the field outline keeps a target outside the camera
hull GCP_MARGIN_M inside.

Run (from backend/):  python -m tests.test_gcp_service
"""

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import gcp_service  # noqa: E402
from app.services import survey_service  # noqa: E402

RES = 0.025


def _field(rng, size=480):
    """Soil with leaves and bright straw stripes, uint8 RGB (3, H, W)."""
    img = np.empty((3, size, size), np.float32)
    img[0], img[1], img[2] = 120, 105, 80  # soil
    img += rng.normal(0, 18, img.shape)
    yy, xx = np.mgrid[0:size, 0:size]
    for k in range(40):  # straw: bright, neutral, thin, crossing
        a = rng.uniform(0, math.pi)
        c = rng.uniform(0, size, 2)
        d = np.abs((xx - c[0]) * math.sin(a) - (yy - c[1]) * math.cos(a))
        along = np.abs((xx - c[0]) * math.cos(a) + (yy - c[1]) * math.sin(a))
        m = (d < 1.2) & (along < rng.uniform(10, 30))
        img[:, m] = 225
    for k in range(60):  # leaves
        c = rng.uniform(0, size, 2)
        m = (xx - c[0]) ** 2 + (yy - c[1]) ** 2 < rng.uniform(4, 30)
        img[0, m], img[1, m], img[2, m] = 60, 120, 40
    return img


def _put_target(img, cu, cv, theta_deg, half_side_m=0.30, black=55.0, white=240.0, res=RES):
    yy, xx = np.mgrid[0:img.shape[1], 0:img.shape[2]]
    a = math.radians(theta_deg)
    xr = (xx - cu) * math.cos(a) + (yy - cv) * math.sin(a)
    yr = -(xx - cu) * math.sin(a) + (yy - cv) * math.cos(a)
    h = half_side_m / res
    inside = (np.abs(xr) < h) & (np.abs(yr) < h)
    whites = inside & ((xr > 0) == (yr > 0))
    img[:, inside] = black  # glossy black reads dark to mid grey
    img[:, whites] = white


def test_target_found_stripes_ignored():
    import torch

    rng = np.random.default_rng(5)
    img = _field(rng)
    _put_target(img, 301.3, 187.6, 31.0)
    found = gcp_service.find_targets(torch, np.clip(img, 0, 255).astype(np.uint8), RES)
    assert len(found) == 1, found
    err_m = math.hypot(found[0]["u"] - 301.3, found[0]["v"] - 187.6) * RES
    assert err_m < 0.03, err_m


def test_target_on_bright_soil_found():
    """The case first missed in the field: a target on a cleared patch of bright
    soil (the white squares merge with it into one bright blob), its black
    squares reading mid-grey; plants on soil around it must not be taken for one."""
    import torch

    rng = np.random.default_rng(8)
    img = _field(rng)
    yy, xx = np.mgrid[0:img.shape[1], 0:img.shape[2]]
    patch = (xx - 150) ** 2 + (yy - 330) ** 2 < 40 ** 2  # ~2 m cleared soil
    img[0, patch], img[1, patch], img[2, patch] = 225, 205, 175
    _put_target(img, 150.4, 330.2, 12.0, black=165.0)
    found = gcp_service.find_targets(torch, np.clip(img, 0, 255).astype(np.uint8), RES)
    assert len(found) == 1, found
    assert math.hypot(found[0]["u"] - 150.4, found[0]["v"] - 330.2) * RES < 0.03


def test_refine_is_subpixel():
    import torch

    rng = np.random.default_rng(6)
    img = _field(rng, 160)
    _put_target(img, 80.4, 79.7, 58.0)
    gray = torch.from_numpy(np.clip(img, 0, 255).mean(axis=0).astype(np.float32))
    x0, y1 = 1000.0, 2000.0
    true_x, true_y = x0 + (80.4 + 0.5) * RES, y1 - (79.7 + 0.5) * RES
    x, y, score = gcp_service.refine_target(torch, gray, x0, y1, RES, true_x + 0.04, true_y - 0.03, search_m=0.08)
    assert math.hypot(x - true_x, y - true_y) < 0.008 and score > 0.85, (x - true_x, y - true_y, score)


def test_marker_found_straw_lookalike_ignored():
    """At the orthophoto's own ~0.8 cm a 17 cm marker is found at the right
    place; a straw crossing with the same four-sector shape is not — straw
    reads 197-210 grey where the markers' plastic reads 227+."""
    import torch

    res = 0.008
    rng = np.random.default_rng(9)
    img = _field(rng, 400)
    _put_target(img, 120.3, 260.6, 22.0, half_side_m=0.085, black=95.0, res=res)
    straw = np.zeros_like(img)
    _put_target(straw, 290.0, 110.0, 40.0, half_side_m=0.085, black=110.0, white=205.0, res=res)
    m = straw.any(axis=0)
    img[:, m] = straw[:, m] + rng.normal(0, 6, (3, int(m.sum())))  # straw is not quite flat
    found = gcp_service.find_targets(torch, np.clip(img, 0, 255).astype(np.uint8), res, gcp_service.MARKER)
    assert len(found) == 1, found
    assert math.hypot(found[0]["u"] - 120.3, found[0]["v"] - 260.6) * res < 0.01, found
    assert found[0]["half_side_m"] == 0.085


def test_names():
    """GCPs by compass direction from the centre, markers numbered north to
    south (west first on the same latitude), whatever order they were found in."""
    pts = [(0.0, -1.0), (0.1, 0.2), (0.0, 1.0), (-0.1, 0.3), (0.2, 0.2), (1.0, 0.0)]
    sizes = [0.6, 0.17, 0.6, 0.17, 0.17, 0.4]
    names = gcp_service._names(pts, sizes, (0.0, 0.0))
    assert names == ["GCP S", "M2", "GCP N", "M1", "M3", "GCP E"], names


def test_sort_key():
    from types import SimpleNamespace

    rows = [SimpleNamespace(name=n) for n in ("M10", "GCP W", "M2", "GCP E", "M1")]
    assert [r.name for r in sorted(rows, key=gcp_service.sort_key)] == ["GCP E", "GCP W", "M1", "M2", "M10"]


def test_compass_names():
    names = gcp_service._compass_names([(0.0, 1.0), (1.0, 0.0), (0.0, -1.0), (-1.0, 0.0), (0.7, 0.7)], (0.0, 0.0))
    assert names == ["GCP N", "GCP E", "GCP S", "GCP W", "GCP NE"], names


def test_boundary_takes_in_the_targets():
    from shapely.geometry import Point, shape

    lat0, lon0 = 36.0968, -85.5829
    # cameras on a 60 x 40 m grid; one target 6 m outside its north edge
    cams = [(lon0 + dx / 90000, lat0 + dy / 111000) for dx in range(-30, 31, 10) for dy in range(-20, 21, 10)]
    gcp = (lon0, lat0 + 26 / 111000)
    boundary, area, clat, clon = survey_service.compute_boundary_and_area(cams, [gcp], 2.0)
    poly = shape(boundary)
    assert poly.contains(Point(gcp))
    # the target sits ~2 m inside the outline (degrees -> metres at this latitude)
    d_m = poly.exterior.distance(Point(gcp)) * 111000
    assert 1.6 < d_m < 2.4, d_m
    plain, plain_area, _, _ = survey_service.compute_boundary_and_area(cams)
    assert area > plain_area and abs(clat - lat0) < 1e-6  # the centre stays the cameras'


def main():
    test_compass_names()
    test_names()
    test_sort_key()
    test_boundary_takes_in_the_targets()
    test_target_found_stripes_ignored()
    test_target_on_bright_soil_found()
    test_refine_is_subpixel()
    test_marker_found_straw_lookalike_ignored()
    print("gcp_service: all checks passed")


if __name__ == "__main__":
    main()
