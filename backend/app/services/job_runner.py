"""Background execution of processing jobs.

Two queues of worker threads inside the API process:
- "quick": the upload pipeline (quick map, analysis), rebuilds and
  recomputes — minutes, one at a time, so a farmer's map never waits long;
- "detailed": OpenDroneMap runs (odm_service) — hours, so they queue behind
  each other without holding up anyone's quick map; AGROTWIN_ODM_WORKERS at a
  time, and only starting within AGROTWIN_ODM_HOURS when that is set (a job
  waits for those hours on its worker, still QUEUED). queue_service tells a
  waiting job its place in line.
A successful quick map queues the survey's detailed map by itself (when
AGROTWIN_ODM_ENABLED). SQLite takes one writer at a time; WAL and the busy
timeout make the two workers wait for each other instead of failing.
`submit` is the seam a Celery/RQ queue replaces — callers only create a
ProcessingJob row and hand over its id.
"""

import logging
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy.orm import Session

from app import models
from app.config import settings
from app.database import SessionLocal
from app.services import processing_service, queue_service

log = logging.getLogger(__name__)

Pipeline = Callable[[Session, models.ProcessingJob], None]

_executors = {
    "quick": ThreadPoolExecutor(max_workers=1, thread_name_prefix="agrotwin-job"),
    "detailed": ThreadPoolExecutor(max_workers=max(1, settings.odm_workers), thread_name_prefix="agrotwin-odm"),
}
_stopping = threading.Event()
HOURS_CHECK_S = 60
ENDED = ("COMPLETED", "FAILED")  # e.g. taken out of the queue by staff before its turn


class JobAlreadyRunning(Exception):
    pass


def enqueue(
    db: Session,
    survey: models.Survey,
    steps: list[str],
    pipeline: Pipeline,
    job: models.ProcessingJob | None = None,
) -> models.ProcessingJob:
    """Queues `pipeline` for the survey (on `job` when an unstarted one should be reused)."""
    if processing_service.is_running(processing_service.latest_job(survey)):
        raise JobAlreadyRunning(survey.id)
    job = job or processing_service.create_job(db, survey, steps)
    processing_service.queue(db, job)
    db.commit()
    submit(job.id, pipeline, "detailed" if steps == processing_service.DETAILED_STEPS else "quick")
    return job


def enqueue_detailed(db: Session, survey: models.Survey) -> models.ProcessingJob:
    return enqueue(db, survey, processing_service.DETAILED_STEPS, processing_service.run_detailed_pipeline)


def submit(job_id: str, pipeline: Pipeline, queue: str = "quick") -> None:
    _executors[queue].submit(_run, job_id, pipeline, queue)


def stop() -> None:
    """The API is shutting down: jobs waiting for the detailed-map hours stop
    waiting. They are still QUEUED, so the next start queues them again."""
    _stopping.set()


def _still_waiting(job_id: str) -> bool:
    db = SessionLocal()
    try:
        job = db.get(models.ProcessingJob, job_id)
        return job is not None and job.status not in ENDED
    finally:
        db.close()


def _wait_for_hours(job_id: str) -> bool:
    """Blocks until detailed maps may start. False: the job was cancelled
    meanwhile, or the API is stopping."""
    while not queue_service.in_hours():
        if _stopping.wait(HOURS_CHECK_S) or not _still_waiting(job_id):
            return False
    return True


def _run(job_id: str, pipeline: Pipeline, queue: str = "quick") -> None:
    if queue == "detailed" and not _wait_for_hours(job_id):
        return
    db = SessionLocal()
    try:
        job = db.get(models.ProcessingJob, job_id)
        if job is None or job.status in ENDED:
            return  # cancelled while it waited
        processing_service.start(db, job)
        pipeline(db, job)
        db.commit()
        if processing_service.is_full_pipeline(job):
            _queue_detailed_map(db, job.survey)
    except Exception as exc:
        log.exception("processing job %s failed", job_id)
        db.rollback()
        job = db.get(models.ProcessingJob, job_id)
        if job is not None:
            if isinstance(exc, processing_service.FlightProblem):
                processing_service.mark_failed(db, job, str(exc), exc.detail)
            else:
                plain = (processing_service.DETAILED_FAILURE if processing_service.is_detailed(job)
                         else processing_service.UNEXPECTED_FAILURE)
                processing_service.mark_failed(db, job, plain, f"{type(exc).__name__}: {exc}")
            if processing_service.is_full_pipeline(job):
                job.survey.status = "FAILED"
            db.commit()
    finally:
        db.close()


def _queue_detailed_map(db: Session, survey: models.Survey) -> None:
    from app.services import odm_service

    db.refresh(survey)
    if not odm_service.wants_detailed_map(survey):
        return
    try:
        enqueue_detailed(db, survey)
        log.info("survey %s: detailed map queued", survey.id)
    except JobAlreadyRunning:
        pass


def recover_interrupted_jobs() -> int:
    """Marks jobs a previous API process was running as failed, so the UI stops
    waiting on them and offers to start again — except detailed maps, which
    are queued again (ODM resumes where it stopped)."""
    db = SessionLocal()
    try:
        stale = (
            db.query(models.ProcessingJob)
            .filter(models.ProcessingJob.status.in_(processing_service.WORKER_STATUSES))
            .all()
        )
        resume = []
        for job in stale:
            processing_service.mark_failed(db, job, "The server restarted while this was running — press Try again.")
            if processing_service.is_full_pipeline(job) and job.survey.status == "PROCESSING":
                job.survey.status = "FAILED"
            if processing_service.is_detailed(job):
                resume.append(job.survey)
        if stale:
            db.commit()
        for survey in resume:
            try:
                enqueue_detailed(db, survey)
                log.info("survey %s: detailed map queued again after the restart", survey.id)
            except JobAlreadyRunning:
                pass
        return len(stale)
    finally:
        db.close()
