"""The processing queue: where a waiting job is in line and about how long
until it starts, the hours detailed maps may start in (AGROTWIN_ODM_HOURS),
and the staff view of every job waiting, running or just finished.

job_runner has two queues: "quick" (quick maps, crop-health checks, lining up;
minutes, one at a time) and "detailed" (OpenDroneMap; hours,
AGROTWIN_ODM_WORKERS at a time). Each runs its jobs in the order they were
queued. The wait is estimated from how long recent jobs of the same kind took
per photo; with no history yet there is no estimate.
"""

from __future__ import annotations

import json
import logging
import re
import statistics
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app import models
from app.config import settings
from app.services import processing_service as ps

log = logging.getLogger(__name__)

HOURS_RE = re.compile(r"^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$")
_warned: set[str] = set()
HISTORY = 20  # recent finished jobs per kind for the estimate
RECENT_DAYS = 3

KIND_LABEL = {
    "full": "Field map",
    "mosaic": "Map rebuild",
    "analysis": "Crop health check",
    "gcp": "Lining up with surveyed points",
    "detailed": "Detailed map",
}


def kind(job: models.ProcessingJob) -> str:
    keys = [s["key"] for s in json.loads(job.steps_json or "[]")]
    if keys == ps.DETAILED_STEPS:
        return "detailed"
    if keys == ps.GCP_STEPS:
        return "gcp"
    if keys == ps.STEPS:
        return "full"
    return "mosaic" if keys == ps.MOSAIC_STEPS else "analysis"


def workers(queue: str) -> int:
    return max(1, settings.odm_workers) if queue == "detailed" else 1


# ── the hours detailed maps may start in ─────────────────────────────────────


def hours() -> tuple[int, int] | None:
    """(first hour, end hour) detailed maps may start in, server time; None: any time."""
    text = (settings.odm_hours or "").strip()
    if not text:
        return None
    m = HOURS_RE.match(text)
    if not m or int(m.group(1)) > 24 or int(m.group(2)) > 24:
        if text not in _warned:
            _warned.add(text)
            log.warning("AGROTWIN_ODM_HOURS=%r is not like 20-6; detailed maps start at any time", text)
        return None
    a, b = int(m.group(1)) % 24, int(m.group(2)) % 24
    return None if a == b else (a, b)


def _hour_text(h: int) -> str:
    return {0: "midnight", 12: "noon"}.get(h, f"{h % 12} {'am' if h < 12 else 'pm'}")


def hours_text() -> str | None:
    w = hours()
    return f"{_hour_text(w[0])}–{_hour_text(w[1])}" if w else None


def in_hours(now: datetime | None = None) -> bool:
    w = hours()
    if w is None:
        return True
    h = (now or datetime.now()).hour
    a, b = w
    return a <= h < b if a < b else (h >= a or h < b)


def next_opening(now: datetime | None = None) -> datetime | None:
    """When detailed maps may next start (now, when they may start now)."""
    now = now or datetime.now()
    w = hours()
    if w is None or in_hours(now):
        return now
    opening = now.replace(hour=w[0], minute=0, second=0, microsecond=0)
    return opening if opening > now else opening + timedelta(days=1)


# ── position and wait ────────────────────────────────────────────────────────


def _order(job: models.ProcessingJob) -> tuple:
    return (job.queued_at or job.updated_at or job.created_at or datetime.min, job.id)


def _active(db: Session) -> list[models.ProcessingJob]:
    return db.query(models.ProcessingJob).filter(models.ProcessingJob.status.in_(ps.WORKER_STATUSES)).all()


def _seconds_per_photo(db: Session) -> dict[str, float]:
    """Median seconds per photo of recent finished jobs, per kind."""
    done = (db.query(models.ProcessingJob)
            .filter(models.ProcessingJob.status == "COMPLETED", models.ProcessingJob.started_at.isnot(None),
                    models.ProcessingJob.finished_at.isnot(None))
            .order_by(models.ProcessingJob.finished_at.desc()).limit(HISTORY * 5).all())
    rates: dict[str, list[float]] = {}
    for j in done:
        k = kind(j)
        if len(rates.setdefault(k, [])) < HISTORY:
            rates[k].append((j.finished_at - j.started_at).total_seconds() / max(1, j.survey.image_count or 1))
    return {k: statistics.median(v) for k, v in rates.items() if v}


def _estimate(job: models.ProcessingJob, rates: dict[str, float]) -> float | None:
    rate = rates.get(kind(job))
    return rate * max(1, job.survey.image_count or 1) if rate is not None else None


def _wait_seconds(job: models.ProcessingJob, active: list[models.ProcessingJob], rates: dict[str, float],
                  now: datetime) -> float | None:
    """Seconds until the job starts: the work ahead of it on its queue shared over the queue's workers."""
    queue = ps.queue_name(job)
    mine = _order(job)
    work = 0.0
    for other in active:
        if other.id == job.id or ps.queue_name(other) != queue:
            continue
        if other.status != "QUEUED":
            est = _estimate(other, rates)
            if est is None:
                return None
            elapsed = (now - other.started_at).total_seconds() if other.started_at else 0.0
            work += max(est - elapsed, 60.0)  # an overrunning job still has a little to go
        elif _order(other) < mine:
            est = _estimate(other, rates)
            if est is None:
                return None
            work += est
    return work / workers(queue)


def position(db: Session, job: models.ProcessingJob, now: datetime | None = None) -> dict | None:
    """Where a waiting job is in line: {ahead, wait_minutes, hours, starts_at}, or None when it is not waiting."""
    if job.status != "QUEUED":
        return None
    now = now or ps.utcnow()
    active = _active(db)
    queue = ps.queue_name(job)
    mine = _order(job)
    same = [j for j in active if j.id != job.id and ps.queue_name(j) == queue]
    ahead = sum(1 for j in same if j.status != "QUEUED" or _order(j) < mine)
    wait = _wait_seconds(job, active, _seconds_per_photo(db), now)
    starts_at = None
    if queue == "detailed" and not in_hours():
        local_now = datetime.now()
        opening = next_opening(local_now)
        starts_at = _hour_text(opening.hour)
        wait = None if wait is None else max(wait, (opening - local_now).total_seconds())
    return {
        "ahead": ahead,
        "wait_minutes": round(wait / 60) if wait is not None else None,
        "hours": hours_text() if queue == "detailed" else None,
        "starts_at": starts_at,
    }


# ── the staff view ───────────────────────────────────────────────────────────


def _row(job: models.ProcessingJob, place: int | None, wait: float | None) -> dict:
    survey = job.survey
    field = survey.field if survey else None
    farm = field.farm if field else None
    owner = farm.owner if farm else None
    steps = json.loads(job.steps_json or "[]")
    step = next((s for s in steps if s["key"] == job.current_step), None)
    return {
        "id": job.id,
        "survey_id": job.survey_id,
        "survey_name": survey.name if survey else None,
        "field_id": field.id if field else None,
        "field_name": field.name if field else None,
        "owner": (owner.name or owner.email) if owner else None,
        "queue": ps.queue_name(job),
        "kind": KIND_LABEL[kind(job)],
        "status": job.status,
        "step": step["label"] if step else None,
        "note": step.get("note") if step else None,
        "photos": survey.image_count if survey else 0,
        "place": place,
        "wait_minutes": round(wait / 60) if wait is not None else None,
        "queued_at": job.queued_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "error_message": job.error_message,
    }


def overview(db: Session) -> dict:
    """Every job running or waiting (in the order they will run), the jobs that
    finished in the last few days, and the queue settings."""
    now = ps.utcnow()
    active = sorted(_active(db), key=lambda j: (j.status == "QUEUED", _order(j)))
    rates = _seconds_per_photo(db)
    rows = []
    places: dict[str, int] = {}
    for job in active:
        place = wait = None
        if job.status == "QUEUED":
            q = ps.queue_name(job)
            places[q] = places.get(q, 0) + 1
            place = places[q]
            wait = _wait_seconds(job, active, rates, now)
        rows.append(_row(job, place, wait))
    recent = (db.query(models.ProcessingJob)
              .filter(models.ProcessingJob.status.in_(("COMPLETED", "FAILED")),
                      models.ProcessingJob.finished_at >= now - timedelta(days=RECENT_DAYS))
              .order_by(models.ProcessingJob.finished_at.desc()).limit(30).all())
    return {
        "jobs": rows,
        "recent": [_row(j, None, None) for j in recent],
        "settings": {
            "detailed_enabled": settings.odm_enabled,
            "detailed_workers": workers("detailed"),
            "detailed_hours": hours_text(),
            "detailed_hours_setting": settings.odm_hours or None,
            "detailed_open_now": in_hours(),
        },
    }


class NotWaiting(ValueError):
    pass


def cancel(db: Session, job: models.ProcessingJob) -> None:
    """Takes a waiting job out of the queue; the farmer sees it stopped and can start it again."""
    if job.status != "QUEUED":
        raise NotWaiting("Only a job that is still waiting can be cancelled — this one has started or finished.")
    ps.mark_failed(db, job, "Stopped by AgroTwin staff before it started. Press Try again to start it again.")
    db.commit()
