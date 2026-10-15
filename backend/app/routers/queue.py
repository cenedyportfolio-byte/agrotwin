"""The processing queue, for AgroTwin staff: every job running or waiting in
the order they will run, the ones that just finished, the queue settings, and
taking a job out of the queue before it starts (queue_service)."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.database import get_db
from app.services import processing_service, queue_service

router = APIRouter(prefix="/api/queue", tags=["queue"], dependencies=[Depends(auth.require_staff)])


@router.get("", response_model=schemas.QueueOut)
def get_queue(db: Session = Depends(get_db)):
    return queue_service.overview(db)


@router.post("/{job_id}/cancel", response_model=schemas.ProcessingJobOut)
def cancel_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(models.ProcessingJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    try:
        queue_service.cancel(db, job)
    except queue_service.NotWaiting as exc:
        raise HTTPException(409, str(exc)) from exc
    return processing_service.job_to_dict(job)
