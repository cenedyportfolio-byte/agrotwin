"""GCP files: reading the formats farmers' GPS gear exports, and lining a
detailed map up with RTK points — on a synthetic GeoTIFF whose targets sit
2.4 m / 0.2° off their surveyed positions, with a cluster of small markers as
decoys. The map must land on the points, go back exactly when the file is
removed, and stay put for handheld points or points that disagree.

Run (from backend/):  python -m tests.test_gcp_file
"""

import math
import os
import sys
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="agrotwin-gcpfile-test-"))
os.environ["AGROTWIN_DATA_DIR"] = str(_TMP / "data")
os.environ["AGROTWIN_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from app import models  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.services import gcp_correction_service as gc  # noqa: E402
from app.services import tile_service  # noqa: E402
from app.services.gcp_file_service import GcpFileError, check_near, parse  # noqa: E402

init_db()
tile_service.build_survey_tiles = lambda db, survey, layers=(), max_zoom=None: []  # no tiling in a unit test

UTM = "EPSG:32616"
FIELD = (36.0968, -85.5829)
ORIGIN = (627500.0, 3995800.0)  # top-left of the synthetic map, 0.1 m pixels, 2000 x 2000


def _raises(fn, *args, **kwargs) -> str:
    try:
        fn(*args, **kwargs)
    except GcpFileError as exc:
        return str(exc)
    raise AssertionError("expected GcpFileError")


def test_formats():
    f = parse(b"Name,Latitude,Longitude,Elevation\nGCP N,36.0974660,-85.5831727,262.5\nGCP E,36.0967688,-85.5821226,263.8\n")
    assert f.format == "csv-latlon" and [p.name for p in f.points] == ["GCP N", "GCP E"] and f.points[0].elevation_m == 262.5
    # no header, longitude first: in the US both columns are within ±90, the flight decides
    f = parse(b"-85.5831727,36.0974660\n-85.5821226,36.0967688\n", near=FIELD)
    assert abs(f.points[0].lat - 36.097466) < 1e-6 and abs(f.points[0].lon + 85.5831727) < 1e-6
    f = parse(b"pt;Easting (EPSG:32616);Northing;Ellipsoidal height\nN;627630.10;3995695.20;232.1\n")
    assert f.format == "csv-projected" and f.crs == "EPSG:32616" and abs(f.points[0].lat - 36.0975) < 1e-3
    # State Plane in US feet: EPSG from the form, elevation converted too
    f = parse(b"name,easting,northing,elev\nA,2091491.53,642212.33,860\n", epsg="6576")
    assert abs(f.points[0].lat - 36.0969) < 1e-6 and abs(f.points[0].elevation_m - 262.13) < 0.01
    assert "6576" in _raises(parse, b"name,easting,northing\nA,2091491.53,642212.33\n")
    f = parse(b"name,lat,lon,elevation (ft)\nA,36.09,-85.58,1000\n")
    assert abs(f.points[0].elevation_m - 304.8) < 1e-6
    # OpenDroneMap gcp_list.txt: each target once, the marks in photos counted
    f = parse(b"WGS84 UTM 16N\n627630.10 3995695.20 232.1 2400 1800 DJI_0001.JPG N\n"
              b"627630.10 3995695.20 232.1 610 1500 DJI_0002.JPG N\n627725.00 3995619.80 233.0 900 300 DJI_0007.JPG E\n")
    assert f.format == "odm" and f.crs == "EPSG:32616" and len(f.points) == 2 and f.odm_observations == 3
    assert "header" in _raises(parse, b"hello world\nfoo bar\n")
    assert "km" in _raises(check_near, parse(b"lat,lon\n40.0,-90.0\n").points, *FIELD)
    f = parse(b"name,lat,lon\nT,36.1,-85.5\nT,36.2,-85.6\n")
    assert [p.name for p in f.points] == ["T", "T (2)"]


def _write_raster(path: Path) -> None:
    import rasterio
    from rasterio.transform import from_origin

    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", width=2000, height=2000, count=1, dtype="uint8", crs=UTM,
                       transform=from_origin(ORIGIN[0], ORIGIN[1], 0.1, 0.1)) as ds:
        ds.write(np.zeros((1, 2000, 2000), np.uint8))


def _latlon(xs, ys):
    from rasterio.warp import transform

    lons, lats = transform(UTM, "EPSG:4326", list(xs), list(ys))
    return lats, lons


def _setup(db, rtk=True, shift=(2.4, -1.1), rot_deg=0.2, noise=None, with_raster=True):
    farm = models.Farm(name="f")
    db.add(farm)
    db.flush()
    field = models.Field(farm_id=farm.id, name="North 40", center_lat=FIELD[0], center_lon=FIELD[1])
    db.add(field)
    db.flush()
    survey = models.Survey(field_id=field.id, name="June")
    db.add(survey)
    db.flush()
    if with_raster:
        for kind in ("orthomosaic", "dsm"):
            path = settings.surveys_dir / survey.id / "outputs" / f"{kind}_odm.tif"
            _write_raster(path)
            db.add(models.SurveyAsset(survey_id=survey.id, asset_type=kind, file_path=str(path), format="tif",
                                      source="photogrammetry_odm"))
    # where the map shows the 5 targets, and a cluster of small markers by the first
    mx = np.array([627530.0, 627660.0, 627580.0, 627690.0, 627610.0])
    my = np.array([3995770.0, 3995760.0, 3995650.0, 3995640.0, 3995700.0])
    lats, lons = _latlon(mx, my)
    for k, (la, lo) in enumerate(zip(lats, lons)):
        db.add(models.GroundControlPoint(survey_id=survey.id, name=f"GCP {k}", lat=la, lon=lo, source="detected", size_m=0.6))
    rng = np.random.default_rng(3)
    cx, cy = mx[0] + 4 + rng.uniform(-3, 3, 12), my[0] - 3 + rng.uniform(-3, 3, 12)
    for k, (la, lo) in enumerate(zip(*_latlon(cx, cy))):
        db.add(models.GroundControlPoint(survey_id=survey.id, name=f"M{k + 1}", lat=la, lon=lo, source="detected", size_m=0.17))
    # where they really are: the map is shifted and turned about its centre
    c0 = np.array([mx.mean(), my.mean()])
    t = math.radians(rot_deg)
    rx = c0[0] + math.cos(t) * (mx - c0[0]) - math.sin(t) * (my - c0[1]) + shift[0]
    ry = c0[1] + math.sin(t) * (mx - c0[0]) + math.cos(t) * (my - c0[1]) + shift[1]
    if noise is not None:
        rx, ry = rx + noise[0], ry + noise[1]
    for k, (la, lo) in enumerate(zip(*_latlon(rx, ry))):
        db.add(models.GroundControlPoint(survey_id=survey.id, name=f"Surveyed {k}", lat=la, lon=lo, source="surveyed", rtk=rtk))
    db.commit()
    db.refresh(survey)
    return survey, (mx, my), (rx, ry)


def _transform(survey):
    import rasterio

    asset = next(a for a in survey.assets if a.asset_type == "orthomosaic")
    with rasterio.open(asset.path) as ds:
        return ds.transform


def test_rtk_points_move_the_map(db):
    from rasterio.warp import transform

    survey, (mx, my), (rx, ry) = _setup(db)
    before = _transform(survey)
    rep = gc.align(db, survey)
    assert rep["status"] == "applied", rep
    assert rep["model"]["points_used"] == 5 and abs(rep["model"]["rotation_deg"] - 0.2) < 0.01
    assert all(p["after_m"] < 0.01 and 2.0 < p["before_m"] < 3.5 for p in rep["points"]), rep["points"]
    assert all(p["matched"].startswith("GCP") for p in rep["points"])  # not the decoy markers
    # a pixel that showed target k now sits at its surveyed position
    after = _transform(survey)
    for k in range(5):
        col, row = ~before * (mx[k], my[k])
        x, y = after * (col, row)
        assert math.hypot(x - rx[k], y - ry[k]) < 0.01
    # the detected targets moved with the map
    db.refresh(survey)
    det = sorted([g for g in survey.gcps if g.source == "detected" and g.name.startswith("GCP")], key=lambda g: g.name)
    xs, ys = transform("EPSG:4326", UTM, [g.lon for g in det], [g.lat for g in det])
    assert max(math.hypot(x - a, y - b) for x, y, a, b in zip(xs, ys, rx, ry)) < 0.01
    # removing the file (restore) puts everything back exactly
    gc.restore(db, survey)
    db.commit()
    assert _transform(survey) == before
    db.refresh(survey)
    det = sorted([g for g in survey.gcps if g.source == "detected" and g.name.startswith("GCP")], key=lambda g: g.name)
    xs, ys = transform("EPSG:4326", UTM, [g.lon for g in det], [g.lat for g in det])
    assert max(math.hypot(x - a, y - b) for x, y, a, b in zip(xs, ys, mx, my)) < 0.005
    # aligning twice from the restored state gives the same map, not a doubled correction
    gc.align(db, survey)
    t1 = _transform(survey)
    gc.restore(db, survey)
    gc.align(db, survey)
    assert _transform(survey) == t1


def test_handheld_points_only_compared(db):
    survey, _, _ = _setup(db, rtk=False, noise=(np.array([1.5, -2, 0.7, 1, -1.2]), np.array([0.5, 1, -1.8, 0.2, 1.1])))
    before = _transform(survey)
    rep = gc.align(db, survey)
    assert rep["status"] == "check_only" and "not moved" in rep["message"]
    assert all(p["matched"] and p["after_m"] is None and p["before_m"] < 6 for p in rep["points"])
    assert _transform(survey) == before


def test_disagreeing_points_rejected(db):
    # one surveyed point 0.8 m off its true place: no single shift/turn/stretch fits
    survey, _, _ = _setup(db, noise=(np.array([0.8, 0, 0, 0, 0]), np.array([0.0, 0, 0, 0, 0])))
    rep = gc.align(db, survey)
    # the bad point is left out and reported with its distance, the other four fit exactly
    assert rep["status"] == "applied" and rep["model"]["points_used"] == 4 and rep["model"]["rms_m"] < 0.01, rep
    bad = next(p for p in rep["points"] if p["name"] == "Surveyed 0")
    assert not bad["used"] and bad["matched"] == "GCP 0" and 0.7 < bad["after_m"] < 0.9
    assert all(p["used"] for p in rep["points"] if p["name"] != "Surveyed 0")

    # what may move a map: any shift, hardly any turn or stretch, points that agree
    assert gc.acceptable(gc.Similarity(1.001, math.radians(0.2), 30.0, -20.0), 0.02)
    assert not gc.acceptable(gc.Similarity(1.02, 0.0, 0.0, 0.0), 0.0)  # 2 % stretch
    assert not gc.acceptable(gc.Similarity(1.0, math.radians(2), 0.0, 0.0), 0.0)  # 2° turn
    assert not gc.acceptable(gc.Similarity(1.0, 0.0, 5.0, 5.0), 0.3)  # points 30 cm apart after the fit


def test_waiting_without_detailed_map(db):
    survey, _, _ = _setup(db, with_raster=False)
    rep = gc.align(db, survey)
    assert rep["status"] == "waiting" and gc.load_report(survey)["status"] == "waiting"


def test_fit_math():
    p = np.array([[0.0, 0.0], [100.0, 0.0], [0.0, 80.0]])
    t = math.radians(0.5)
    q = 1.002 * (p @ np.array([[math.cos(t), math.sin(t)], [-math.sin(t), math.cos(t)]])) + [3.0, -2.0]
    sim = gc.fit(p, q)
    assert abs(sim.s - 1.002) < 1e-9 and abs(sim.theta - t) < 1e-9
    x, y = sim.apply(p[:, 0], p[:, 1])
    assert np.allclose(np.column_stack([x, y]), q)
    xi, yi = sim.inverse().apply(x, y)
    assert np.allclose(np.column_stack([xi, yi]), p)
    one = gc.fit(p[:1], q[:1])  # a single point: a shift only
    assert one.s == 1.0 and one.theta == 0.0


def main():
    test_formats()
    test_fit_math()
    db = SessionLocal()
    try:
        test_rtk_points_move_the_map(db)
        test_handheld_points_only_compared(db)
        test_disagreeing_points_rejected(db)
        test_waiting_without_detailed_map(db)
    finally:
        db.close()
    print("gcp files: all checks passed")


if __name__ == "__main__":
    main()
