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
from app.config import settings

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
# a GCP file added, replaced or removed: line the detailed map up again
GCP_STEPS = ["gcp_align", "ai_analysis"]
# the detailed map, after the quick one (odm_service)
DETAILED_STEPS = ["odm_prepare", "odm_reconstruction", "odm_import", "odm_bands", "detailed_analysis", "detailed_ready"]

STEP_LABELS = {
    "images_uploaded": "Photos received",
    "metadata_extracted": "Reading where each photo was taken",
    "processing_field": "Drawing the field outline",
    "generating_orthomosaic": "Building the field map",
    "ai_analysis": "Checking crop health",
    "digital_twin_ready": "Ready",
    "gcp_align": "Lining the map up with your surveyed points",
    "odm_prepare": "Getting the photos ready",
    "odm_reconstruction": "3D reconstruction of the field (the long part)",
    "odm_import": "Drawing the detailed map",
    "odm_bands": "Lining up the crop-health camera",
    "detailed_analysis": "Checking crop health on the detailed map",
    "detailed_ready": "Detailed map ready",
}


class FlightProblem(ValueError):
    """Something about the flight itself that the farmer can fix next time;
    its message is shown to them as it is (`detail`, if any, to staff)."""

    def __init__(self, message: str, detail: str | None = None):
        super().__init__(message)
        self.detail = detail


# shown instead of an unexpected error's text (which staff still see)
UNEXPECTED_FAILURE = ("Something went wrong while making the map. It is not something you did — "
                      "try again later, or ask your AgroTwin contact.")
DETAILED_FAILURE = ("The detailed map could not be made this time — your quick map is still there. "
                    "AgroTwin staff can see why.")

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


def utcnow() -> datetime:
    """Now, in UTC without a time zone — as times come back from the database."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


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


def is_detailed(job: models.ProcessingJob) -> bool:
    return [s["key"] for s in json.loads(job.steps_json or "[]")] == DETAILED_STEPS


def queue_name(job: models.ProcessingJob) -> str:
    """The job_runner queue it runs on: "detailed" (OpenDroneMap, hours) or "quick"."""
    return "detailed" if is_detailed(job) else "quick"


def set_step_note(db: Session, job: models.ProcessingJob, step_key: str, note: str) -> None:
    """A line of progress under a long step ("matching the photos, stage 4 of 13")."""
    steps = json.loads(job.steps_json or "[]")
    for step in steps:
        if step["key"] == step_key:
            step["note"] = note
    job.steps_json = json.dumps(steps)
    db.commit()


def queue(db: Session, job: models.ProcessingJob) -> None:
    job.status = "QUEUED"
    job.error_message = None
    job.queued_at = utcnow()
    job.started_at = job.finished_at = None
    db.flush()


def start(db: Session, job: models.ProcessingJob) -> None:
    step = job.current_step
    job.status = STEP_STATUS.get(step, "PROCESSING") if step and step != "images_uploaded" else "PROCESSING"
    job.started_at = utcnow()
    db.commit()


def mark_step_complete(db: Session, job: models.ProcessingJob, step_key: str) -> None:
    steps = json.loads(job.steps_json or "[]")
    for step in steps:
        if step["key"] == step_key:
            step["status"] = "complete"

    next_step = next((s["key"] for s in steps if s["status"] == "pending"), None)
    job.current_step = next_step
    job.status = "COMPLETED" if next_step is None else STEP_STATUS.get(next_step, "PROCESSING")
    job.steps_json = json.dumps(steps)
    if next_step is None:
        job.finished_at = utcnow()
    db.flush()


def mark_failed(db: Session, job: models.ProcessingJob, error: str, detail: str | None = None) -> None:
    steps = json.loads(job.steps_json or "[]")
    for step in steps:
        if step["key"] == job.current_step:
            step["status"] = "failed"
    job.steps_json = json.dumps(steps)
    job.status = "FAILED"
    job.error_message = error[:2000]
    job.error_detail = detail[:4000] if detail else None
    job.finished_at = utcnow()
    db.flush()


def job_to_dict(job: models.ProcessingJob) -> dict:
    return {
        "id": job.id,
        "survey_id": job.survey_id,
        "status": job.status,
        "current_step": job.current_step,
        "steps": json.loads(job.steps_json or "[]"),
        "error_message": job.error_message,
        "error_detail": job.error_detail,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "queued_at": job.queued_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
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
    solution (GPU), their tiles, the GCP targets the field boundary is drawn
    around, and the map lined up with the farmer's surveyed points (if any).
    Without one, nothing — the quick mosaics stay the products."""
    from app.services import band_ortho_service, gcp_correction_service, gcp_service
    from app.services.survey_service import update_field_boundary_from_images
    from app.services.tile_service import build_survey_tiles

    # the band maps are built on ODM's cameras: start from the map as ODM made it
    stale = gcp_correction_service.restore(db, survey)
    db.commit()
    db.refresh(survey)
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
        db.commit()  # before the slow check below: never hold SQLite's write lock through GPU work
        band_ortho_service.update_qa_gcps(survey)
    db.commit()
    db.refresh(survey)
    gcp_correction_service.align(db, survey, stale - (set(band_ortho_service.TILE_LAYERS) if created else set()))
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
    from app.services import notify_service

    notify_service.map_ready(survey, detailed=False)


def run_mosaic_job(db: Session, job: models.ProcessingJob) -> None:
    from app.services.analysis_service import analyze_survey

    survey = job.survey
    if not _build_mosaics_and_tiles(db, survey):
        raise FlightProblem("Not enough photos were taken straight down with a GPS position to make a map. "
                            "Fly a mapping (grid) mission with the camera pointing straight down — see How to fly.")
    _complete(db, job, "generating_orthomosaic")
    analyze_survey(db, survey, survey.field)
    _complete(db, job, "ai_analysis")


def run_analysis_job(db: Session, job: models.ProcessingJob) -> None:
    from app.services.analysis_service import analyze_survey

    survey = job.survey
    # frames measured by an earlier run keep their stats; only new frames are measured
    if analyze_survey(db, survey, survey.field) is None:
        raise FlightProblem("Too few photos have a GPS position to check the crop. Upload the original photos from "
                            "the drone's memory card — see How to fly.")
    _complete(db, job, "ai_analysis")


def run_detailed_pipeline(db: Session, job: models.ProcessingJob) -> None:
    """OpenDroneMap on the survey's RGB photos (hours), then the same products
    as a hand-imported run: detailed orthophoto, elevation, 3D model, band
    orthophotos on its cameras, GCP targets, and the analysis on the best map.
    The quick results stay in place until this succeeds."""
    from app.services import notify_service, odm_service
    from app.services.analysis_service import analyze_survey

    survey = job.survey
    project, chosen = odm_service.prepare(survey)
    if len(chosen) < settings.odm_min_photos:
        raise FlightProblem(f"Only {len(chosen)} photos have a GPS position — too few for a detailed map.")
    _complete(db, job, "odm_prepare")

    args = odm_service.odm_args(chosen, gcp=(project / "gcp_list.txt").exists())
    odm_service.run(survey, project, args,
                    lambda i, n, words: set_step_note(db, job, "odm_reconstruction", f"{words} (stage {i} of {n})"))
    _complete(db, job, "odm_reconstruction")

    odm_service.import_run(db, survey, project, mesh=settings.odm_build_3d)
    _complete(db, job, "odm_import")

    db.refresh(survey)
    build_photogrammetry_products(db, survey)
    _complete(db, job, "odm_bands")

    db.refresh(survey)
    analyze_survey(db, survey, survey.field)
    _complete(db, job, "detailed_analysis")
    _complete(db, job, "detailed_ready")
    notify_service.map_ready(survey, detailed=True)


def run_gcp_job(db: Session, job: models.ProcessingJob) -> None:
    """A GCP file was added, replaced or removed: from the map as it was made,
    line it up with the surveyed points now on file, then check the crop again."""
    from app.services import gcp_correction_service
    from app.services.analysis_service import analyze_survey

    survey = job.survey
    stale = gcp_correction_service.restore(db, survey)
    db.commit()
    db.refresh(survey)
    gcp_correction_service.align(db, survey, stale)
    _complete(db, job, "gcp_align")
    db.refresh(survey)
    analyze_survey(db, survey, survey.field)
    _complete(db, job, "ai_analysis")
