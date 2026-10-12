#!/usr/bin/env python3
"""Multispectral orthophotos on the photogrammetric camera solution, on the GPU
(app/services/band_ortho_service.py), then everything that depends on them:

  1. band_green/red/red_edge/nir, ndvi/ndre/gndvi, false_color, alignment_check
     GeoTIFFs + band_ortho_qa.json in data/surveys/<id>/outputs/
  2. their XYZ tile pyramids for the viewer
  3. the GCP targets and the field boundary that takes them in
  4. a fresh analysis on the aligned NDVI, with every frame re-measured
     (the radiometric calibration changed on 2026-10-10)

Needs an imported OpenDroneMap run (scripts/import_odm.py) and the survey's
multispectral frames. Run with the CUDA venv:

    python -m scripts.build_band_orthos --survey <id> [--gsd 0.015] [--skip-tiles] [--skip-analysis] [--reuse]

--reuse keeps band products already built and only redoes steps 2-4.
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import models  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.services import band_ortho_service, gcp_service  # noqa: E402
from app.services.survey_service import update_field_boundary_from_images  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--survey", required=True)
    ap.add_argument("--gsd", type=float, default=band_ortho_service.DEFAULT_GSD_M, help="output m/px")
    ap.add_argument("--skip-tiles", action="store_true")
    ap.add_argument("--skip-analysis", action="store_true")
    ap.add_argument("--reuse", action="store_true", help="keep existing band products, redo tiles/GCPs/analysis")
    args = ap.parse_args()

    init_db()
    db = SessionLocal()
    t0 = time.monotonic()
    try:
        survey = db.get(models.Survey, args.survey)
        if survey is None:
            sys.exit(f"no survey {args.survey}")
        created = [a for a in survey.assets if a.source == band_ortho_service.SOURCE and a.format == "tif"] \
            if args.reuse else band_ortho_service.build_band_orthos(db, survey, args.gsd)
        if not created:
            sys.exit("no band orthophotos: the survey needs an imported ODM run and multispectral frames")
        db.commit()
        db.refresh(survey)

        if not args.skip_tiles:
            from app.services.tile_service import build_survey_tiles

            build_survey_tiles(db, survey, band_ortho_service.TILE_LAYERS)
            db.commit()

        gcps = gcp_service.detect_and_store(db, survey)
        db.flush()
        db.refresh(survey)
        update_field_boundary_from_images(db, survey.field, survey.images, survey.gcps)
        db.commit()
        band_ortho_service.update_qa_gcps(survey)  # the targets as found now
        logging.info("field boundary: %s ha with %d GCP(s)", survey.field.area_hectares, len(gcps))

        if not args.skip_analysis:
            from app.services.analysis_service import analyze_survey

            result = analyze_survey(db, survey, survey.field, remeasure_frames=True)
            db.commit()
            if result is not None:
                logging.info("analysis %s: %.1f%% healthy / %.1f%% attention / %.1f%% problem, %d zones",
                             result.method, result.healthy_area_percent, result.attention_area_percent,
                             result.problem_area_percent, len(result.detections))

        qa = json.loads((Path(created[0].file_path).parent / "band_ortho_qa.json").read_text())
        print(json.dumps({k: qa[k] for k in ("gsd_m", "captures", "seconds", "offsets", "gcps")}, indent=2))
        print(f"done in {time.monotonic() - t0:.0f} s")
    finally:
        db.close()


if __name__ == "__main__":
    main()
