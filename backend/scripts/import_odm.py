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

With AGROTWIN_ODM_ENABLED the server runs ODM and this import by itself
after each upload (app/services/odm_service.py); this script is for a run
made by hand, e.g. in WebODM.

Run (agrotwin venv):
    python -m scripts.import_odm --survey <id> [--odm-dir data/surveys/<id>/odm]
"""

import argparse
import logging
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="  %(message)s")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import models  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.services import odm_service  # noqa: E402


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
        odm_service.import_run(db, survey, Path(args.odm_dir) if args.odm_dir else None,
                               tiles=not args.skip_tiles, mesh=not args.skip_mesh)
        if not args.skip_bands:
            # band orthophotos (GPU) on this run's cameras, GCP targets, field boundary
            from app.services.processing_service import build_photogrammetry_products

            db.refresh(survey)
            build_photogrammetry_products(db, survey)
    finally:
        db.close()


if __name__ == "__main__":
    main()
