#!/usr/bin/env python3
"""Finds a survey's ground control targets in its photogrammetric orthophoto
(app/services/gcp_service.py), stores them, redraws the field boundary to
take them in (camera-position hull + targets, 2 m margin), and re-checks them
in the band orthophotos when those exist (band_ortho_qa.json).

    python -m scripts.detect_gcps --survey <id> [--readings ../cordinate/gcp_readings.csv]

--readings: field GPS readings of the targets (CSV with target, device, lat,
lon in decimal degrees); prints how far each lies from the detected target.
Handheld GPS is metre-level, so this is a sanity check, not control.
"""

import argparse
import csv
import logging
import math
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="  %(message)s")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import models  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.services import band_ortho_service, gcp_service  # noqa: E402
from app.services.survey_service import update_field_boundary_from_images  # noqa: E402


def _metres(lat1, lon1, lat2, lon2) -> float:
    dn = math.radians(lat2 - lat1) * 6371000.0
    de = math.radians(lon2 - lon1) * 6371000.0 * math.cos(math.radians(lat1))
    return math.hypot(de, dn)


def compare_readings(gcps: list[models.GroundControlPoint], path: Path) -> None:
    rows = list(csv.DictReader(path.open()))
    print(f"\n{len(rows)} field readings vs detected targets:")
    for r in rows:
        lat, lon = float(r["lat"]), float(r["lon"])
        near = min(gcps, key=lambda g: _metres(lat, lon, g.lat, g.lon))
        print(f"  {r['target']:<6} {r['device']:<24} {_metres(lat, lon, near.lat, near.lon):5.1f} m from {near.name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--survey", required=True)
    ap.add_argument("--readings", type=Path, default=None)
    args = ap.parse_args()
    init_db()
    db = SessionLocal()
    try:
        survey = db.get(models.Survey, args.survey)
        if survey is None:
            sys.exit(f"no survey {args.survey}")
        before = survey.field.area_hectares
        gcps = gcp_service.detect_and_store(db, survey)
        db.flush()
        db.refresh(survey)
        update_field_boundary_from_images(db, survey.field, survey.images, survey.gcps)
        db.commit()
        print(f"{len(gcps)} target(s); field boundary {before} ha -> {survey.field.area_hectares} ha")
        for g in gcps:
            print(f"  {g.name:<8} {g.lat:.7f}, {g.lon:.7f}  height {g.height_m}  score {g.score}")
        checks = band_ortho_service.update_qa_gcps(survey)
        if checks:
            print("in the band orthophotos (offset from the photo's target):")
            for c in checks:
                print("  " + c["name"].ljust(8) + "  ".join(
                    f"{k} {v['offset_cm']} cm" if "offset_cm" in v else f"{k}: {v.get('status')}"
                    for k, v in c.items() if k != "name"))
        if args.readings and gcps:
            compare_readings(gcps, args.readings)
    finally:
        db.close()


if __name__ == "__main__":
    main()
