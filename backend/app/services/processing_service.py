"""Processing job state machine and the pipelines a background worker runs.

The API never processes inside a request: it creates a ProcessingJob row,
hands its id to job_runner, and the frontend polls the row. Each step is
committed as it finishes, so the poller sees real progress. The vocabulary
maps directly onto a future Celery/Redis queue: each pipeline becomes a task,
ProcessingJob stays the row a worker updates, and the status values stay what
the frontend renders.
"""

import json
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app import models

STEPS = [
    "images_uploaded",
    "metadata_extracted",
    "processing_field",
    "generating_orthomosaic",
    "ai_analysis",
    "digital_twin_ready",
]
MOSAIC_STEPS = ["generating_orthomosaic", "ai_analysis"]
ANALYSIS_STEPS = ["ai_analysis"]

STEP_LABELS = {
    "images_uploaded": "Images Uploaded",
    "metadata_extracted": "Metadata Extracted",
    "processing_field": "Processing Field",
    "generating_orthomosaic": "Generating Orthomosaic",
    "ai_analysis": "AI Analysis",
    "digital_twin_ready": "Digital Twin Ready",
}

# The step in progress maps to one of §21's named states.
# generating_orthomosaic is the direct-georeferencing quick mosaic
# (mosaic_service) — a real step, not photogrammetry.
STEP_STATUS = {
    "images_uploaded": "UPLOADING",
    "metadata_extracted": "PROCESSING",
    "processing_field": "PROCESSING",
    "generating_orthomosaic": "GENERATING_ORTHOMOSAIC",
    "ai_analysis": "GENERATING_ANALYSIS",
    "digital_twin_ready": "PROCESSING",
}

# A job in one of these has been handed to the worker; still in one after an
# API restart, it can never finish. UPLOADING is not among them: that is the
# client still sending files, before any worker is involved.
WORKER_STATUSES = {"QUEUED", "PROCESSING", "GENERATING_ORTHOMOSAIC", "GENERATING_ANALYSIS"}


def create_job(db: Session, survey: models.Survey, steps: list[str] = STEPS) -> models.ProcessingJob:
    job = models.ProcessingJob(
        survey_id=survey.id,
        status="PENDING",
        current_step=steps[0],
        steps_json=json.dumps([{"key": s, "label": STEP_LABELS[s], "status": "pending"} for s in steps]),
    )
    db.add(job)
    db.flush()
    return job


def latest_job(survey: models.Survey) -> models.ProcessingJob | None:
    return max(survey.jobs, key=lambda j: j.created_at, default=None)


def is_running(job: models.ProcessingJob | None) -> bool:
    return job is not None and job.status in WORKER_STATUSES


def is_full_pipeline(job: models.ProcessingJob) -> bool:
    return [s["key"] for s in json.loads(job.steps_json or "[]")] == STEPS


def queue(db: Session, job: models.ProcessingJob) -> None:
    job.status = "QUEUED"
    job.error_message = None
    db.flush()


def start(db: Session, job: models.ProcessingJob) -> None:
    step = job.current_step
    job.status = STEP_STATUS[step] if step and step != "images_uploaded" else "PROCESSING"
    db.commit()


def mark_step_complete(db: Session, job: models.ProcessingJob, step_key: str) -> None:
    steps = json.loads(job.steps_json or "[]")
    for step in steps:
        if step["key"] == step_key:
            step["status"] = "complete"

    next_step = next((s["key"] for s in steps if s["status"] == "pending"), None)
    job.current_step = next_step
    job.status = "COMPLETED" if next_step is None else STEP_STATUS[next_step]
    job.steps_json = json.dumps(steps)
    db.flush()


def mark_failed(db: Session, job: models.ProcessingJob, error: str) -> None:
    steps = json.loads(job.steps_json or "[]")
    for step in steps:
        if step["key"] == job.current_step:
            step["status"] = "failed"
    job.steps_json = json.dumps(steps)
    job.status = "FAILED"
    job.error_message = error[:2000]
    db.flush()


def job_to_dict(job: models.ProcessingJob) -> dict:
    return {
        "id": job.id,
        "survey_id": job.survey_id,
        "status": job.status,
        "current_step": job.current_step,
        "steps": json.loads(job.steps_json or "[]"),
        "error_message": job.error_message,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    }


# ---------------------------------------------------------------------------
# Pipelines (run by job_runner on its worker thread, with their own session)
# ---------------------------------------------------------------------------


def _complete(db: Session, job: models.ProcessingJob, step_key: str) -> None:
    mark_step_complete(db, job, step_key)
    db.commit()


def _build_mosaics_and_tiles(db: Session, survey: models.Survey) -> list[models.SurveyAsset]:
    from app.services.mosaic_service import build_quick_mosaics
    from app.services.tile_service import build_survey_tiles

    assets = build_quick_mosaics(db, survey)
    db.commit()
    if assets:
        # the pyramid keeps deep zoom sharp; the viewer falls back to a flat preview without it
        build_survey_tiles(db, survey, layers=tuple(sorted({a.asset_type for a in assets})))
        db.commit()
    build_photogrammetry_products(db, survey)
    return assets


def build_photogrammetry_products(db: Session, survey: models.Survey) -> None:
    """With an imported OpenDroneMap run: the band orthophotos on its camera
    solution (GPU), their tiles, and the GCP targets the field boundary is drawn
    around. Without one, nothing — the quick mosaics stay the products."""
    from app.services import band_ortho_service, gcp_service
    from app.services.survey_service import update_field_boundary_from_images
    from app.services.tile_service import build_survey_tiles

    created = band_ortho_service.build_band_orthos(db, survey)
    if created:
        db.commit()
        db.refresh(survey)
        build_survey_tiles(db, survey, layers=band_ortho_service.TILE_LAYERS)
        db.commit()
    if gcp_service.detect_and_store(db, survey):
        db.flush()
        db.refresh(survey)
        update_field_boundary_from_images(db, survey.field, survey.images, survey.gcps)
        band_ortho_service.update_qa_gcps(survey)
    db.commit()


def run_full_pipeline(db: Session, job: models.ProcessingJob) -> None:
    from app.services.analysis_service import analyze_survey
    from app.services.band_ortho_service import SOURCE as BAND_SOURCE
    from app.services.survey_service import update_field_boundary_from_images

    survey = job.survey
    survey.status = "PROCESSING"
    _complete(db, job, "images_uploaded")
    _complete(db, job, "metadata_extracted")  # EXIF/XMP is read as each file arrives

    update_field_boundary_from_images(db, survey.field, survey.images, survey.gcps)
    _complete(db, job, "processing_field")

    if not any(a.source == "direct_georeferencing" for a in survey.assets):
        _build_mosaics_and_tiles(db, survey)
    elif not any(a.source == BAND_SOURCE for a in survey.assets):
        build_photogrammetry_products(db, survey)
    _complete(db, job, "generating_orthomosaic")

    analyze_survey(db, survey, survey.field)
    _complete(db, job, "ai_analysis")

    captured = [img.captured_at for img in survey.images if img.captured_at]
    survey.survey_date = survey.survey_date or (min(captured) if captured else datetime.now(timezone.utc))
    survey.status = "COMPLETED"
    _complete(db, job, "digital_twin_ready")


def run_mosaic_job(db: Session, job: models.ProcessingJob) -> None:
    from app.services.analysis_service import analyze_survey

    survey = job.survey
    if not _build_mosaics_and_tiles(db, survey):
        raise ValueError("Not enough nadir, GPS-tagged frames to build a mosaic")
    _complete(db, job, "generating_orthomosaic")
    analyze_survey(db, survey, survey.field)
    _complete(db, job, "ai_analysis")


def run_analysis_job(db: Session, job: models.ProcessingJob) -> None:
    from app.services.analysis_service import analyze_survey

    survey = job.survey
    # frames measured by an earlier run keep their stats; only new frames are measured
    if analyze_survey(db, survey, survey.field) is None:
        raise ValueError("Not enough geotagged images to compute an analysis")
    _complete(db, job, "ai_analysis")
