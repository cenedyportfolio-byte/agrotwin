"""Imports an OpenDroneMap run (true photogrammetry) as survey assets.

ODM (opendronemap/odm, run via Docker on the survey's RGB frames) produces:
    odm_orthophoto/odm_orthophoto.tif     true orthophoto, RGBA, native GSD
    odm_dem/dsm.tif, odm_dem/dtm.tif       surface / bare-earth models
    odm_texturing/odm_textured_model_geo.obj  textured true-3D reality mesh
    odm_georeferencing/odm_georeferenced_model.laz  dense MVS point cloud

The reality mesh is re-tiled here by scripts/tile_mesh.py (ODM's own
--3d-tiles output keeps full-resolution atlases at every LOD and is not
streamable on a laptop). Unlike the 2.5D heightfield from build_dense.py it
is a full 3D triangle mesh: tree crowns are rounded volumes and edges have
real vertical faces instead of curtains. Assets are registered with
source="photogrammetry_odm", which the viewer ranks above the quick
direct-georeferenced and splat-derived products. Tile pyramids are then
rebuilt from the new rasters so the map zooms to the native GSD.

Afterwards the multispectral orthophotos are built on the GPU from this run's
camera solution (app/services/band_ortho_service.py) and the GCP targets are
found in the new orthophoto (--skip-bands to leave them).

Run (agrotwin venv):
    python -m scripts.import_odm --survey <id> [--odm-dir data/surveys/<id>/odm]
"""

import argparse
import json
import logging
import shutil
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="  %(message)s")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import models  # noqa: E402
from app.config import AGROTWIN_ROOT, settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.services.orthomosaic_service import extract_bounds_geojson  # noqa: E402
from app.services.tile_service import build_survey_tiles  # noqa: E402

SOURCE = "photogrammetry_odm"
PUBLIC_MODELS = AGROTWIN_ROOT / "frontend" / "public" / "models"


def _register(db, survey, asset_type, path: Path, fmt: str, bounds: dict | None):
    # replace only the same kind of file: a raster's "xyz" tile pyramid is a separate row
    for old in [a for a in survey.assets if a.asset_type == asset_type and a.source == SOURCE and (a.format or "") == fmt]:
        db.delete(old)
    db.flush()
    asset = models.SurveyAsset(
        survey_id=survey.id, asset_type=asset_type, file_path=str(path), format=fmt,
        bounds_geojson=json.dumps(bounds) if bounds else None, source=SOURCE,
    )
    db.add(asset)
    db.flush()
    logging.info("registered %s -> %s", asset_type, path)
    return asset


def _ground_h(dtm_path: Path, field) -> float | None:
    """Height of the field's ground in the ODM products' own vertical datum:
    median DTM value at the field centre and boundary vertices (the same
    points the viewer samples on the global terrain, so the two heights
    describe the same ground and their difference is the lift to apply)."""
    import numpy as np
    import rasterio
    from rasterio.warp import transform

    pts = [(field.center_lon, field.center_lat)]
    if field.boundary_geojson:
        geom = json.loads(field.boundary_geojson)
        if geom.get("type") == "Polygon":
            pts += [(x, y) for x, y in geom["coordinates"][0]]
    with rasterio.open(dtm_path) as src:
        xs, ys = transform("EPSG:4326", src.crs, [p[0] for p in pts], [p[1] for p in pts])
        vals = [v[0] for v in src.sample(zip(xs, ys))]
        nodata = src.nodata
    vals = [float(v) for v in vals if np.isfinite(v) and (nodata is None or v != nodata)]
    return float(np.median(vals)) if vals else None


def _fix_obj2tiles_axes(tileset_json: Path) -> None:  # kept for tilesets produced by ODM's --3d-tiles
    """ODM's Obj2Tiles writes b3dm geometry already in the tile's ENU frame
    (x=E, y=N, z=Up, absolute elevations) under a plain ENU->ECEF root
    transform. Cesium, per the 3D Tiles spec, rotates glTF content from
    y-up to z-up before applying that transform, which lands the mesh
    hundreds of metres south and standing on edge. Folding the inverse
    rotation (x, y, z) -> (x, z, -y) into the root transform cancels it;
    the bounding boxes, authored for the rotated content, come out right too."""
    import numpy as np

    t = json.loads(tileset_json.read_text())
    root = t["root"]
    if not root.get("transform"):
        return
    T = np.array(root["transform"], dtype=float).reshape(4, 4).T  # column-major -> matrix
    R = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)
    root["transform"] = (T @ R).T.flatten().tolist()
    t.setdefault("asset", {})["agrotwin_axis_fix"] = "z-up content, y-up->z-up glTF rotation pre-cancelled"
    tileset_json.write_text(json.dumps(t))


def _copy_tileset(src_dir: Path, dst_dir: Path) -> Path | None:
    if not (src_dir / "tileset.json").exists():
        return None
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)
    _fix_obj2tiles_axes(dst_dir / "tileset.json")
    return dst_dir / "tileset.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--survey", required=True)
    ap.add_argument("--odm-dir", default=None)
    ap.add_argument("--skip-tiles", action="store_true")
    ap.add_argument("--skip-mesh", action="store_true", help="keep the existing reality-mesh tileset")
    ap.add_argument("--skip-bands", action="store_true",
                    help="don't build the multispectral orthophotos / GCPs on the ODM camera solution")
    args = ap.parse_args()

    init_db()
    db = SessionLocal()
    try:
        survey = db.get(models.Survey, args.survey)
        if survey is None:
            sys.exit(f"no survey {args.survey}")
        odm = Path(args.odm_dir) if args.odm_dir else settings.surveys_dir / survey.id / "odm"
        out = settings.surveys_dir / survey.id / "outputs"
        out.mkdir(parents=True, exist_ok=True)

        rasters = {
            "orthomosaic": odm / "odm_orthophoto" / "odm_orthophoto.tif",
            "dsm": odm / "odm_dem" / "dsm.tif",
            "dtm": odm / "odm_dem" / "dtm.tif",
        }
        for asset_type, src in rasters.items():
            if not src.exists():
                logging.warning("missing %s", src)
                continue
            dst = out / f"{asset_type}_odm.tif"
            shutil.copy2(src, dst)
            _register(db, survey, asset_type, dst, "tif", extract_bounds_geojson(dst))

        ground_h = _ground_h(rasters["dtm"], survey.field) if rasters["dtm"].exists() else None
        logging.info("ground height in ODM datum: %s", ground_h)
        mesh_ts = PUBLIC_MODELS / survey.id / "odm-model" / "tileset.json"
        if not args.skip_mesh and (odm / "odm_texturing" / "odm_textured_model_geo.obj").exists():
            from scripts.tile_mesh import build as tile_mesh

            mesh_ts = tile_mesh(survey.id, depth=3, tex_px=2048, draco=False, ground_h=ground_h)
        if mesh_ts.exists():
            _register(db, survey, "model3d", mesh_ts, "json", None)
        laz = odm / "odm_georeferencing" / "odm_georeferenced_model.laz"
        if not args.skip_mesh and laz.exists():
            from scripts.tile_points import build as tile_points

            _register(db, survey, "pointcloud", tile_points(survey.id, 5_000_000, ground_h), "json", None)
        laz = odm / "odm_georeferencing" / "odm_georeferenced_model.laz"
        if laz.exists():
            _register(db, survey, "pointcloud_laz", laz, "laz", None)

        db.commit()
        db.refresh(survey)
        if not args.skip_tiles:
            build_survey_tiles(db, survey, ("orthomosaic", "dsm", "dtm"))
            db.commit()
        if not args.skip_bands:
            # band orthophotos (GPU) on this run's cameras, GCP targets, field boundary
            from app.services.processing_service import build_photogrammetry_products

            db.refresh(survey)
            build_photogrammetry_products(db, survey)
    finally:
        db.close()


if __name__ == "__main__":
    main()
