"""The processing queue: the detailed-map hours (AGROTWIN_ODM_HOURS), a
waiting job's place in line and wait estimate, the staff view, cancelling a
job before it starts, and the worker skipping a cancelled job.

Run (from backend/):  python -m tests.test_queue
"""

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="agrotwin-queue-test-"))
os.environ["AGROTWIN_DATA_DIR"] = str(_TMP / "data")
os.environ["AGROTWIN_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import models  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.services import job_runner, queue_service  # noqa: E402
from app.services import processing_service as ps  # noqa: E402

init_db()


def test_hours():
    try:
        settings.odm_hours = "20-6"
        assert queue_service.hours() == (20, 6) and queue_service.hours_text() == "8 pm–6 am"
        day = datetime(2026, 10, 15)
        assert queue_service.in_hours(day.replace(hour=22)) and queue_service.in_hours(day.replace(hour=5, minute=59))
        assert not queue_service.in_hours(day.replace(hour=6)) and not queue_service.in_hours(day.replace(hour=12))
        assert queue_service.next_opening(day.replace(hour=12)) == day.replace(hour=20)
        assert queue_service.next_opening(day.replace(hour=23)) == day.replace(hour=23)  # open now

        settings.odm_hours = "0-12"
        assert queue_service.hours_text() == "midnight–noon"
        assert queue_service.next_opening(day.replace(hour=13)) == day.replace(hour=0) + timedelta(days=1)

        for anything in ("", "night", "25-3", "6-6"):
            settings.odm_hours = anything
            assert queue_service.hours() is None and queue_service.in_hours(day.replace(hour=12)), anything
    finally:
        settings.odm_hours = ""


def _survey(db, name: str, photos: int) -> models.Survey:
    farm = models.Farm(name=f"farm {name}")
    db.add(farm)
    db.flush()
    field = models.Field(farm_id=farm.id, name=f"field {name}")
    db.add(field)
    db.flush()
    survey = models.Survey(field_id=field.id, name=name, image_count=photos)
    db.add(survey)
    db.flush()
    return survey


def _job(db, survey, steps, status, queued_min_ago=None, started_min_ago=None, finished_min_ago=None):
    job = ps.create_job(db, survey, steps)
    now = ps.utcnow()
    job.status = status
    job.queued_at = now - timedelta(minutes=queued_min_ago) if queued_min_ago is not None else None
    job.started_at = now - timedelta(minutes=started_min_ago) if started_min_ago is not None else None
    job.finished_at = now - timedelta(minutes=finished_min_ago) if finished_min_ago is not None else None
    db.flush()
    return job


def test_place_in_line():
    db = SessionLocal()
    try:
        # history: a 200-photo detailed map took 200 minutes (1 min per photo)
        _job(db, _survey(db, "old", 200), ps.DETAILED_STEPS, "COMPLETED", 400, 300, 100)
        running = _job(db, _survey(db, "running", 100), ps.DETAILED_STEPS, "PROCESSING", 90, 30)  # ~70 min to go
        first = _job(db, _survey(db, "first", 50), ps.DETAILED_STEPS, "QUEUED", 20)
        second = _job(db, _survey(db, "second", 80), ps.DETAILED_STEPS, "QUEUED", 10)
        quick = _job(db, _survey(db, "quick", 300), ps.STEPS, "QUEUED", 5)
        db.commit()

        place = queue_service.position(db, second)
        assert place["ahead"] == 2, place
        assert abs(place["wait_minutes"] - (70 + 50)) <= 1, place  # what is left of the running one, then the first
        assert place["hours"] is None and place["starts_at"] is None
        # nothing on the quick queue: next to start; no quick history, so no estimate
        assert queue_service.position(db, quick) == {"ahead": 0, "wait_minutes": 0, "hours": None, "starts_at": None}
        assert queue_service.position(db, running) is None  # not waiting

        # two detailed maps at a time share the work ahead
        settings.odm_workers = 2
        assert abs(queue_service.position(db, second)["wait_minutes"] - 60) <= 1
        settings.odm_workers = 1

        view = queue_service.overview(db)
        rows = {r["survey_name"]: r for r in view["jobs"]}
        assert [r["survey_name"] for r in view["jobs"]][0] == "running"  # running first
        assert rows["first"]["place"] == 1 and rows["second"]["place"] == 2 and rows["quick"]["place"] == 1, rows
        assert rows["second"]["kind"] == "Detailed map" and rows["quick"]["kind"] == "Field map"
        assert [r["survey_name"] for r in view["recent"]] == ["old"]
        assert view["settings"]["detailed_workers"] == 1 and view["settings"]["detailed_open_now"] is True

        # outside the detailed-map hours: it says when they open
        hour = datetime.now().hour
        settings.odm_hours = f"{(hour + 2) % 24}-{(hour + 4) % 24}"
        place = queue_service.position(db, second)
        assert place["starts_at"] and place["hours"] and place["wait_minutes"] >= 60, place
        settings.odm_hours = ""

        # staff take the first one out of the line
        queue_service.cancel(db, first)
        assert first.status == "FAILED" and "Stopped by AgroTwin staff" in first.error_message and first.finished_at
        assert queue_service.position(db, second)["ahead"] == 1
        try:
            queue_service.cancel(db, running)
            raise AssertionError("a running job was cancelled")
        except queue_service.NotWaiting:
            pass
    finally:
        settings.odm_workers, settings.odm_hours = 1, ""
        db.close()


def test_worker_skips_cancelled():
    db = SessionLocal()
    try:
        survey = _survey(db, "worker", 30)
        ran = []
        cancelled = ps.create_job(db, survey, ps.ANALYSIS_STEPS)
        ps.queue(db, cancelled)
        db.commit()
        queue_service.cancel(db, cancelled)
        job_runner._run(cancelled.id, lambda d, j: ran.append(j.id))
        assert ran == []

        waiting = ps.create_job(db, survey, ps.ANALYSIS_STEPS)
        ps.queue(db, waiting)
        db.commit()
        assert waiting.queued_at is not None and waiting.started_at is None

        def pipeline(d, j):
            ran.append(j.id)
            ps.mark_step_complete(d, j, "ai_analysis")

        job_runner._run(waiting.id, pipeline)
        db.expire_all()
        job = db.get(models.ProcessingJob, waiting.id)
        assert ran == [waiting.id] and job.status == "COMPLETED", (ran, job.status)
        assert job.started_at is not None and job.finished_at is not None and job.finished_at >= job.started_at

        # a detailed map outside its hours waits; when the API stops, it stops waiting (and stays queued)
        hour = datetime.now().hour
        settings.odm_hours = f"{(hour + 2) % 24}-{(hour + 4) % 24}"
        detailed = ps.create_job(db, survey, ps.DETAILED_STEPS)
        ps.queue(db, detailed)
        db.commit()
        job_runner.stop()
        job_runner._run(detailed.id, lambda d, j: ran.append(j.id), "detailed")
        db.expire_all()
        assert detailed.id not in ran and db.get(models.ProcessingJob, detailed.id).status == "QUEUED"
    finally:
        settings.odm_hours = ""
        job_runner._stopping.clear()
        db.close()


def test_job_out():
    db = SessionLocal()
    try:
        survey = _survey(db, "api", 40)
        job = ps.create_job(db, survey, ps.STEPS)
        ps.queue(db, job)
        db.commit()
        from app.routers.surveys import get_latest_job

        out = get_latest_job(survey.id, db)
        assert out["status"] == "QUEUED" and out["queue"]["ahead"] >= 0 and out["queued_at"], out
        assert json.loads(job.steps_json)[0]["key"] == ps.STEPS[0]
    finally:
        db.close()


def main():
    test_hours()
    test_place_in_line()
    test_worker_skips_cancelled()
    test_job_out()
    print("queue: all checks passed")


if __name__ == "__main__":
    main()
