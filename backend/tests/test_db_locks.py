"""Long processing steps must not hold SQLite's write lock: while a job builds
tiles, mosaics, band maps or measures crop health for minutes, farmers still
sign in and upload (a single write lock: anyone else waiting 30 s gets
"database is locked" — found by the 2026-10-14 audit, sign-in failing during
a detailed-map job). Each slow step is replaced by a probe that takes the
write lock from a second connection, as a sign-in would, with half a second
to get it.

Run (from backend/):  python -m tests.test_db_locks
"""

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="agrotwin-locks-test-"))
os.environ["AGROTWIN_DATA_DIR"] = str(_TMP / "data")
os.environ["AGROTWIN_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from app import models  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402

init_db()
DB_FILE = _TMP / "test.db"
probes: list[tuple[str, bool]] = []


def can_write(label: str) -> None:
    """Records whether another connection could take the write lock right now."""
    con = sqlite3.connect(DB_FILE, timeout=0.5)
    try:
        con.execute("BEGIN IMMEDIATE")
        con.execute("ROLLBACK")
        probes.append((label, True))
    except sqlite3.OperationalError:
        probes.append((label, False))
    finally:
        con.close()


def _survey(db):
    farm = models.Farm(name="f")
    db.add(farm)
    db.flush()
    field = models.Field(farm_id=farm.id, name="North 40", center_lat=36.0, center_lon=-85.0)
    db.add(field)
    db.flush()
    survey = models.Survey(field_id=field.id, name="June")
    db.add(survey)
    db.commit()
    return survey


def _raster(path: Path) -> Path:
    import rasterio
    from rasterio.transform import from_origin

    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", driver="GTiff", width=64, height=64, count=3, dtype="uint8", crs="EPSG:32616",
                       transform=from_origin(627500.0, 3995800.0, 0.5, 0.5)) as ds:
        ds.write(np.full((3, 64, 64), 120, np.uint8))
    return path


def test_tiles(db):
    from app.services import tile_service

    survey = _survey(db)
    for layer in ("orthomosaic", "dsm"):
        db.add(models.SurveyAsset(survey_id=survey.id, asset_type=layer, format="tif", source="photogrammetry_odm",
                                  file_path=str(_raster(settings.surveys_dir / survey.id / f"{layer}.tif"))))
        # tiles from an earlier run, replaced as each layer is redone
        db.add(models.SurveyAsset(survey_id=survey.id, asset_type=layer, format="xyz", source="photogrammetry_odm",
                                  file_path=str(settings.public_tiles_dir / survey.id / layer)))
    db.commit()
    db.refresh(survey)
    real = tile_service.build_xyz_tiles

    def slow_tiles(src, out_dir, layer, max_zoom=None):
        can_write(f"tiles: while tiling {layer}")
        return {"minzoom": 1, "maxzoom": 2}

    tile_service.build_xyz_tiles = slow_tiles
    try:
        tile_service.build_survey_tiles(db, survey, ("orthomosaic", "dsm"))
    finally:
        tile_service.build_xyz_tiles = real
    db.commit()


def test_quick_mosaic(db):
    from app.services import mosaic_service

    survey = _survey(db)
    old = models.SurveyAsset(survey_id=survey.id, asset_type="orthomosaic", format="tif", source="direct_georeferencing",
                             file_path=str(_raster(settings.surveys_dir / survey.id / "old.tif")))
    db.add(old)
    db.add(models.SurveyImage(survey_id=survey.id, filename="a.jpg", file_path="/x/a.jpg", band="RGB", lat=36.0, lon=-85.0))
    db.commit()
    db.refresh(survey)
    real_rgb, real_idx = mosaic_service.build_rgb_mosaic, mosaic_service.build_index_mosaics
    out = settings.surveys_dir / survey.id / "outputs" / "orthomosaic_quick.tif"

    def slow_rgb(survey_, path, epsg):
        can_write("quick mosaic: while building the RGB map")
        _raster(path)
        return {"ok": True}

    def slow_idx(survey_, out_dir, epsg):
        can_write("quick mosaic: while building the index maps")
        return {}

    mosaic_service.build_rgb_mosaic, mosaic_service.build_index_mosaics = slow_rgb, slow_idx
    try:
        created = mosaic_service.build_quick_mosaics(db, survey)
    finally:
        mosaic_service.build_rgb_mosaic, mosaic_service.build_index_mosaics = real_rgb, real_idx
    db.commit()
    db.refresh(survey)
    quick = [a for a in survey.assets if a.source == "direct_georeferencing"]
    assert len(created) == 1 and len(quick) == 1 and quick[0].path == out  # the old map swapped for the new


def test_analysis(db):
    from app.services import analysis_service, weed_service

    survey = _survey(db)
    path = _raster(settings.surveys_dir / survey.id / "ortho.tif")
    db.refresh(survey)
    real_cells, real_rows = analysis_service._raster_cells, weed_service.analyze_rows
    cells = [(r, c, 0.2 + 0.6 * ((r * 7 + c * 3) % 10) / 10) for r in range(8) for c in range(8)]
    analysis_service._raster_cells = lambda p, m: (cells, __import__("affine").Affine(5, 0, 627500, 0, -5, 3995800),
                                                     "EPSG:32616", 10)

    def slow_rows(rgb, boundary):
        from types import SimpleNamespace

        can_write("analysis: while measuring crop rows")
        return SimpleNamespace(metrics=lambda: {"status": "rows_not_found", "reason": "test"}, candidates=[])

    weed_service.analyze_rows = slow_rows
    try:
        result = analysis_service.analyze_from_raster(db, survey, survey.field, path, "exg_map")
    finally:
        analysis_service._raster_cells, weed_service.analyze_rows = real_cells, real_rows
    db.commit()
    assert result is not None and result.id and len(result.detections) > 0


def test_detailed_products(db):
    from app.services import band_ortho_service, gcp_service, processing_service

    survey = _survey(db)
    real = (band_ortho_service.build_band_orthos, gcp_service.detect_and_store, band_ortho_service.update_qa_gcps)

    def found(db_, survey_):
        db_.add(models.GroundControlPoint(survey_id=survey_.id, name="GCP N", lat=36.0, lon=-85.0, source="detected"))
        db_.flush()
        return [1]

    band_ortho_service.build_band_orthos = lambda db_, s: None
    gcp_service.detect_and_store = found
    band_ortho_service.update_qa_gcps = lambda s: can_write("detailed map: while checking targets in the band maps")
    try:
        processing_service.build_photogrammetry_products(db, survey)
    finally:
        band_ortho_service.build_band_orthos, gcp_service.detect_and_store, band_ortho_service.update_qa_gcps = real


def main():
    db = SessionLocal()
    try:
        test_tiles(db)
        test_quick_mosaic(db)
        test_analysis(db)
        test_detailed_products(db)
    finally:
        db.close()
    held = [label for label, ok in probes if not ok]
    for label, ok in probes:
        print(f"  {'free ' if ok else 'HELD '} {label}")
    assert len(probes) >= 6, probes
    assert not held, f"write lock held during: {held}"
    print("db locks: all checks passed")


if __name__ == "__main__":
    main()
