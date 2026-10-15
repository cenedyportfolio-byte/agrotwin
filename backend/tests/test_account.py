"""The data agreement (asked of farmers when AGROTWIN_AGREEMENT_FILE is set,
again when its text changes, never of staff; field data refused until it is
accepted) and deleting an account with all its data (by the farmer, with
their password; by an admin, with the account's email; never while a map is
being made, never the last admin).

Run (from backend/):  python -m tests.test_account
"""

import os
import sys
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="agrotwin-account-test-"))
os.environ["AGROTWIN_DATA_DIR"] = str(_TMP / "data")
os.environ["AGROTWIN_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import HTTPException, Response  # noqa: E402

from app import auth, models, schemas  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.routers import auth as auth_router  # noqa: E402
from app.routers import users as users_router  # noqa: E402
from app.services import account_service, agreement_service, boundary_file_service  # noqa: E402
from app.services import processing_service as ps  # noqa: E402

init_db()
# map tiles and 3D files go to the website's public folder: here, a scratch one
settings.public_tiles_dir = _TMP / "public" / "tiles"
account_service.PUBLIC = _TMP / "public"


def refused(fn, status: int, *words: str):
    try:
        fn()
    except HTTPException as exc:
        assert exc.status_code == status and all(w.lower() in str(exc.detail).lower() for w in words), (exc.status_code, exc.detail)
        return
    raise AssertionError(f"expected HTTP {status}")


def user(db, email: str, role: str = "farmer", password: str = "field-test-123") -> models.User:
    u = models.User(email=email, name=email.split("@")[0], role=role, password_hash=auth.hash_password(password), is_active=True)
    db.add(u)
    db.flush()
    return u


def farm_with_flight(db, owner: models.User) -> tuple[models.Field, models.Survey]:
    farm = auth.farm_of(db, owner)
    field = models.Field(farm_id=farm.id, name="Ditty Road")
    db.add(field)
    db.flush()
    survey = models.Survey(field_id=field.id, name="June", image_count=1)
    db.add(survey)
    db.flush()
    db.add(models.SurveyImage(survey_id=survey.id, filename="p.jpg", file_path=str(_TMP / "drive" / "p.jpg"), band="RGB"))
    db.commit()
    return field, survey


def test_agreement():
    db = SessionLocal()
    try:
        farmer = user(db, "agree@farm.test")
        staff = user(db, "op@agrotwin.test", "operator")
        db.commit()
        assert agreement_service.current() is None and not farmer.consent_required  # none set: nothing asked
        assert auth_router.get_agreement(farmer) is None

        text = _TMP / "agreement.md"
        text.write_text("# AgroTwin data agreement\n\nYour photos stay yours.\n")
        settings.agreement_file = text
        a = agreement_service.current()
        assert a.title == "AgroTwin data agreement" and len(a.version) == 12
        assert farmer.consent_required and not staff.consent_required
        refused(lambda: auth.require_consent(farmer), 403, "data agreement")
        auth.require_consent(staff)
        out = schemas.UserOut.model_validate(farmer)
        assert out.consent_required is True and out.consent_version is None

        refused(lambda: auth_router.accept_agreement(schemas.AgreementAccept(version="old"), farmer, db), 409, "changed")
        auth_router.accept_agreement(schemas.AgreementAccept(version=a.version), farmer, db)
        assert not farmer.consent_required and farmer.consent_at is not None
        assert auth_router.get_agreement(farmer)["accepted"] is True
        auth.require_consent(farmer)

        # an edited agreement is a new version: accepted again
        text.write_text("# AgroTwin data agreement\n\nYour photos stay yours. The university may use them for research.\n")
        assert agreement_service.current().version != a.version and farmer.consent_required

        # a file that cannot be read asks nothing (and says so in the log)
        settings.agreement_file = _TMP / "missing.md"
        assert agreement_service.current() is None and not farmer.consent_required
    finally:
        settings.agreement_file = None
        db.close()


def test_delete_own_account():
    db = SessionLocal()
    try:
        farmer = user(db, "leaving@farm.test")
        other = user(db, "staying@farm.test")
        field, survey = farm_with_flight(db, farmer)
        kept_field, kept_survey = farm_with_flight(db, other)
        auth.create_session(db, farmer)
        db.commit()
        made = [settings.surveys_dir / survey.id / "mosaic.tif", settings.public_tiles_dir / survey.id / "orthomosaic" / "0.png",
                account_service.PUBLIC / "models" / survey.id / "model.glb", boundary_file_service.flight_plan_dir(field.id) / "flight_plan.kmz"]
        kept = [settings.surveys_dir / kept_survey.id / "mosaic.tif", settings.public_tiles_dir / kept_survey.id / "orthomosaic" / "0.png"]
        drive = _TMP / "drive" / "p.jpg"  # the photo read where it is on the drive
        for f in [*made, *kept, drive]:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(b"x")

        refused(lambda: auth_router.delete_account(schemas.AccountDelete(password="field-test-123", confirm="yes"), Response(), farmer, db), 422, "DELETE")
        refused(lambda: auth_router.delete_account(schemas.AccountDelete(password="wrong", confirm="DELETE"), Response(), farmer, db), 400, "password")

        # not while a map is being made
        job = ps.create_job(db, survey, ps.STEPS)
        ps.queue(db, job)
        db.commit()
        refused(lambda: auth_router.delete_account(schemas.AccountDelete(password="field-test-123", confirm="delete"), Response(), farmer, db), 409, "being made")
        ps.mark_failed(db, job, "stopped")
        db.commit()

        ids = (farmer.id, field.id, survey.id)
        res = auth_router.delete_account(schemas.AccountDelete(password="field-test-123", confirm="delete"), Response(), farmer, db)
        assert res == {"deleted": True, "fields": 1, "flights": 1}, res
        db.expire_all()
        assert db.get(models.User, ids[0]) is None and db.get(models.Field, ids[1]) is None and db.get(models.Survey, ids[2]) is None
        assert db.query(models.SurveyImage).filter_by(survey_id=ids[2]).count() == 0
        assert db.query(models.ProcessingJob).filter_by(survey_id=ids[2]).count() == 0
        assert db.query(models.UserSession).filter_by(user_id=ids[0]).count() == 0
        assert not any(f.exists() for f in made), [f for f in made if f.exists()]
        assert all(f.exists() for f in kept) and drive.exists()  # someone else's data, and the drive, untouched
        assert db.get(models.Survey, kept_survey.id) is not None
    finally:
        db.close()


def test_admin_deletes():
    db = SessionLocal()
    try:
        admin = user(db, "boss@agrotwin.test", "admin")
        farmer = user(db, "asked@farm.test")
        farm_with_flight(db, farmer)
        db.commit()
        refused(lambda: users_router.delete_user(admin.id, schemas.AccountDeleteByAdmin(confirm=admin.email), admin, db), 409, "Settings")
        refused(lambda: users_router.delete_user(farmer.id, schemas.AccountDeleteByAdmin(confirm="someone@else.test"), admin, db), 422, "email")
        res = users_router.delete_user(farmer.id, schemas.AccountDeleteByAdmin(confirm=" Asked@Farm.test "), admin, db)
        assert res["flights"] == 1 and db.query(models.User).filter_by(email="asked@farm.test").count() == 0

        # the only admin cannot go
        for other in db.query(models.User).filter(models.User.role == "admin", models.User.id != admin.id):
            other.is_active = False
        db.commit()
        try:
            account_service.check(db, admin)
            raise AssertionError("the last admin could be deleted")
        except account_service.CannotDelete as exc:
            assert "only admin" in str(exc)
        second = user(db, "second@agrotwin.test", "admin")
        db.commit()
        account_service.check(db, admin)  # now there is another
        assert second.id
    finally:
        db.close()


def main():
    test_agreement()
    test_delete_own_account()
    test_admin_deletes()
    print("account: all checks passed")


if __name__ == "__main__":
    main()
