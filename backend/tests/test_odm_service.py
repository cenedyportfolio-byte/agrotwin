"""The detailed-map job without running Docker: which photos ODM gets and with
which options, the project folder, stage progress and failures read from
ODM's output (a fake `docker` process), and that a successful quick map
queues the detailed one on its own worker while a failed one does not.

Run (from backend/):  python -m tests.test_odm_service
"""

import io
import os
import sys
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="agrotwin-odm-test-"))
os.environ["AGROTWIN_DATA_DIR"] = str(_TMP / "data")
os.environ["AGROTWIN_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["AGROTWIN_EXTERNAL_DATA"] = "false"  # no weather / soil / satellite lookups from tests
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import models  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.services import job_runner, odm_service, processing_service  # noqa: E402

init_db()


def _survey(db, n_rgb=25, rtk="FIXED"):
    farm = models.Farm(name="f")
    db.add(farm)
    db.flush()
    field = models.Field(farm_id=farm.id, name="North 40", center_lat=36.0, center_lon=-85.0)
    db.add(field)
    db.flush()
    survey = models.Survey(field_id=field.id, name="June")
    db.add(survey)
    db.flush()
    src = _TMP / "photos" / survey.id
    src.mkdir(parents=True)
    for i in range(n_rgb):
        p = src / f"DJI_{i:04d}_D.JPG"
        p.write_bytes(b"jpg" * (i + 1))
        db.add(models.SurveyImage(survey_id=survey.id, filename=p.name, file_path=str(p), band="RGB",
                                  lat=36.0, lon=-85.0, rtk_fix=rtk))
    # a band image and a photo without GPS: neither goes to ODM
    for name, band, lat in (("DJI_0000_MS_NIR.TIF", "NIR", 36.0), ("DJI_9999_D.JPG", "RGB", None)):
        p = src / name
        p.write_bytes(b"x")
        db.add(models.SurveyImage(survey_id=survey.id, filename=name, file_path=str(p), band=band, lat=lat, lon=lat))
    db.commit()
    db.refresh(survey)
    return survey


def test_photos_args_and_project(db):
    survey = _survey(db)
    assert len(odm_service.photos(survey)) == 25
    args = odm_service.odm_args(odm_service.photos(survey))
    assert "--gps-accuracy" in args and args[args.index("--gps-accuracy") + 1] == "0.05"
    assert "--dsm" in args and "--dtm" in args and "--skip-3dmodel" not in args
    plain = _survey(db, n_rgb=25, rtk=None)
    assert "--gps-accuracy" not in odm_service.odm_args(odm_service.photos(plain))

    project, chosen = odm_service.prepare(survey)
    assert project == settings.surveys_dir / survey.id / "odm"
    names = sorted(p.name for p in (project / "images").iterdir())
    assert len(names) == 25 and "DJI_9999_D.JPG" not in names and not any(n.endswith(".TIF") for n in names)
    (project / "images" / "leftover.JPG").write_bytes(b"old")
    odm_service.prepare(survey)  # again: stale files go, the others stay
    assert not (project / "images" / "leftover.JPG").exists()

    cmd = odm_service.docker_command(survey.id, project, args)
    assert cmd[:2] == ["docker", "run"] and f"{project.resolve()}:/datasets/code" in cmd and "--gpus" not in cmd
    settings.odm_gpus = True
    assert "--gpus" in odm_service.docker_command(survey.id, project, args)
    settings.odm_gpus = False


def test_wants_detailed_map(db):
    survey = _survey(db)
    settings.odm_enabled = False
    assert not odm_service.wants_detailed_map(survey)
    settings.odm_enabled = True
    assert odm_service.wants_detailed_map(survey)
    small = _survey(db, n_rgb=5)
    assert not odm_service.wants_detailed_map(small)
    db.add(models.SurveyAsset(survey_id=survey.id, asset_type="orthomosaic", file_path="x.tif", format="tif",
                              source=odm_service.SOURCE))
    db.commit()
    db.refresh(survey)
    assert not odm_service.wants_detailed_map(survey)  # already has one


class _FakeProc:
    def __init__(self, lines, code):
        self.stdout = io.StringIO("".join(f"{line}\n" for line in lines))
        self._code = code

    def wait(self):
        return self._code

    def poll(self):
        return self._code

    def kill(self):
        pass


def _fake_docker(lines, code, make_ortho=None):
    def popen(cmd, **kwargs):
        if make_ortho is not None:
            (make_ortho / "odm_orthophoto").mkdir(parents=True, exist_ok=True)
            (make_ortho / "odm_orthophoto" / "odm_orthophoto.tif").write_bytes(b"tif")
        return _FakeProc(lines, code)
    return popen


def test_run_progress_and_failures(db):
    survey = _survey(db)
    project, chosen = odm_service.prepare(survey)
    args = odm_service.odm_args(chosen)
    real_popen, real_which, real_give = odm_service.subprocess.Popen, odm_service.shutil.which, odm_service._give_back
    odm_service.shutil.which = lambda _: "/usr/bin/docker"
    odm_service._give_back = lambda _p: None
    try:
        seen = []
        odm_service.subprocess.Popen = _fake_docker(
            ["[INFO] Running dataset stage", "[INFO] Running opensfm stage", "noise", "[INFO] Running odm_orthophoto stage"],
            0, make_ortho=project)
        odm_service.run(survey, project, args, lambda i, n, words: seen.append((i, n, words)))
        assert [s[0] for s in seen] == [1, 4, 11] and seen[1][2] == "matching the photos" and seen[0][1] == 13
        assert "Running opensfm stage" in (project / "agrotwin_odm.log").read_text()

        (project / "odm_orthophoto" / "odm_orthophoto.tif").unlink()
        odm_service.subprocess.Popen = _fake_docker(["[ERROR] No reconstructions available"], 1)
        try:
            odm_service.run(survey, project, args, lambda *a: None)
            raise AssertionError("should fail")
        except processing_service.FlightProblem as exc:
            assert "overlap" in str(exc) and "No reconstructions" in exc.detail

        odm_service.subprocess.Popen = _fake_docker(["docker: Error response from daemon"], 125)
        try:
            odm_service.run(survey, project, args, lambda *a: None)
            raise AssertionError("should fail")
        except odm_service.OdmUnavailable:
            pass

        odm_service.subprocess.Popen = _fake_docker(["[INFO] all fine"], 0)  # but no orthophoto written
        try:
            odm_service.run(survey, project, args, lambda *a: None)
            raise AssertionError("should fail")
        except RuntimeError as exc:
            assert "without an orthophoto" in str(exc)
    finally:
        odm_service.subprocess.Popen, odm_service.shutil.which, odm_service._give_back = real_popen, real_which, real_give


def test_quick_map_queues_detailed(db):
    settings.odm_enabled = True
    survey = _survey(db)
    submitted = []
    real_submit = job_runner.submit
    job_runner.submit = lambda job_id, pipeline, queue="quick": submitted.append((job_id, pipeline, queue))
    try:
        # a quick pipeline that succeeds: the detailed map follows, on its own worker
        job = processing_service.create_job(db, survey)
        db.commit()
        job_runner._run(job.id, lambda db_, job_: [processing_service.mark_step_complete(db_, job_, s)
                                                  for s in processing_service.STEPS])
        assert len(submitted) == 1 and submitted[0][2] == "detailed"
        assert submitted[0][1] is processing_service.run_detailed_pipeline
        detailed = db.get(models.ProcessingJob, submitted[0][0])
        assert processing_service.is_detailed(detailed)

        # a detailed job failing for an unexpected reason: the farmer gets plain words, staff the cause
        db.refresh(detailed)

        def boom(db_, job_):
            raise KeyError("odm_orthophoto")
        job_runner._run(detailed.id, boom)
        db.expire_all()
        detailed = db.get(models.ProcessingJob, detailed.id)
        assert detailed.status == "FAILED" and detailed.error_message == processing_service.DETAILED_FAILURE
        assert "KeyError" in detailed.error_detail
        assert db.get(models.Survey, survey.id).status != "FAILED"  # the quick results stay

        # a quick pipeline that fails: no detailed map
        other = _survey(db)
        submitted.clear()
        job = processing_service.create_job(db, other)
        db.commit()

        def flight_problem(db_, job_):
            raise processing_service.FlightProblem("Too few photos")
        job_runner._run(job.id, flight_problem)
        assert submitted == []
        db.expire_all()
        failed = db.get(models.ProcessingJob, job.id)
        assert failed.error_message == "Too few photos" and failed.error_detail is None
    finally:
        job_runner.submit = real_submit


def main():
    db = SessionLocal()
    try:
        test_photos_args_and_project(db)
        test_wants_detailed_map(db)
        test_run_progress_and_failures(db)
        test_quick_map_queues_detailed(db)
    finally:
        db.close()
    print("odm_service: all checks passed")


if __name__ == "__main__":
    main()
