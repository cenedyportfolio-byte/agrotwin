"""Sign-in and access rules on a scratch database: passwords, sessions (cookie
and Bearer header, expiry, sign-out), repeated wrong passwords, and that a
farmer sees only their own fields and surveys while staff see all; staff-only
actions; the admin's account rules.

Run (from backend/):  python -m tests.test_auth
"""

import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="agrotwin-auth-test-")
os.environ["AGROTWIN_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402

from app import auth, models, schemas  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402
from app.routers import fields as fields_router  # noqa: E402
from app.routers import surveys as surveys_router  # noqa: E402
from app.routers import users as users_router  # noqa: E402

init_db()


def _request(cookie: str | None = None, bearer: str | None = None, path_params: dict | None = None,
             uri: str | None = None) -> Request:
    headers = []
    if uri:
        headers.append((b"x-original-uri", uri.encode()))
    if cookie:
        headers.append((b"cookie", f"{settings.session_cookie}={cookie}".encode()))
    if bearer:
        headers.append((b"authorization", f"Bearer {bearer}".encode()))
    return Request({"type": "http", "headers": headers, "path_params": path_params or {}})


def _status(fn, *args, **kwargs) -> int:
    try:
        fn(*args, **kwargs)
    except HTTPException as exc:
        return exc.status_code
    return 200


def _user(db, email, role):
    u = models.User(email=email, name=email.split("@")[0], role=role, password_hash=auth.hash_password("secret-pass"),
                    is_active=True)
    db.add(u)
    db.flush()
    return u


def _setup():
    db = SessionLocal()
    admin = _user(db, "admin@uni.edu", "admin")
    operator = _user(db, "op@uni.edu", "operator")
    alice = _user(db, "alice@farm.com", "farmer")
    bob = _user(db, "bob@farm.com", "farmer")
    fields = {}
    for owner in (alice, bob):
        f = models.Field(farm_id=auth.farm_of(db, owner).id, name=f"{owner.name} north")
        db.add(f)
        db.flush()
        s = models.Survey(field_id=f.id, name="June flight")
        db.add(s)
        db.flush()
        fields[owner.name] = (f, s)
    db.commit()
    return db, admin, operator, alice, bob, fields


def test_passwords():
    h = auth.hash_password("correct horse")
    assert auth.verify_password("correct horse", h)
    assert not auth.verify_password("wrong horse", h)
    assert not auth.verify_password("x", None) and not auth.verify_password("x", "garbage")
    assert h != auth.hash_password("correct horse")  # salted


def test_sign_in_and_sessions(db, alice):
    assert auth.authenticate(db, "ALICE@farm.com ", "secret-pass") is alice  # email case and spaces
    assert auth.authenticate(db, "alice@farm.com", "nope") is None
    assert auth.authenticate(db, "nobody@farm.com", "secret-pass") is None

    token = auth.create_session(db, alice)
    db.commit()
    assert auth.current_user(_request(cookie=token), db) is alice
    assert auth.current_user(_request(bearer=token), db) is alice
    assert _status(auth.current_user, _request(), db) == 401
    assert _status(auth.current_user, _request(cookie="forged"), db) == 401

    session = db.query(models.UserSession).filter(models.UserSession.user_id == alice.id).first()
    session.expires_at = auth._now() - timedelta(minutes=1)
    db.commit()
    assert _status(auth.current_user, _request(cookie=token), db) == 401  # expired

    token = auth.create_session(db, alice)
    db.commit()
    auth.end_session(db, token)
    db.commit()
    assert _status(auth.current_user, _request(cookie=token), db) == 401  # signed out

    token = auth.create_session(db, alice)
    alice.is_active = False
    db.commit()
    assert _status(auth.current_user, _request(cookie=token), db) == 401  # switched off
    assert auth.authenticate(db, "alice@farm.com", "secret-pass") is None
    alice.is_active = True
    db.commit()


def test_handoff(db, alice):
    """The mobile app hands its session to the web viewer with a one-time code."""
    code = auth.create_handoff(alice)
    assert auth.redeem_handoff(db, code) is alice
    assert auth.redeem_handoff(db, code) is None  # once only
    assert auth.redeem_handoff(db, "made-up") is None
    old = auth.create_handoff(alice)
    auth._handoffs[old] = (alice.id, auth._handoffs[old][1] - auth.HANDOFF_TTL_S - 1)
    assert auth.redeem_handoff(db, old) is None  # expired


def test_repeated_wrong_passwords():
    email = "guess@farm.com"
    for _ in range(auth.MAX_FAILED_LOGINS):
        assert not auth.too_many_failures(email)
        auth.record_failure(email)
    assert auth.too_many_failures(email)
    auth.clear_failures(email)
    assert not auth.too_many_failures(email)


def test_farmer_sees_only_own(db, admin, operator, alice, bob, fields):
    a_field, a_survey = fields["alice"]
    b_field, b_survey = fields["bob"]
    assert {f.id for f in auth.visible_fields(db, alice)} == {a_field.id}
    assert {f.id for f in auth.visible_fields(db, admin)} >= {a_field.id, b_field.id}
    assert {f.id for f in auth.visible_fields(db, operator)} >= {a_field.id, b_field.id}

    # someone else's field or survey is "not found", whichever router it is asked through
    assert _status(auth.path_access, _request(path_params={"survey_id": b_survey.id}), alice, db) == 404
    assert _status(auth.path_access, _request(path_params={"field_id": b_field.id}), alice, db) == 404
    assert _status(auth.path_access, _request(path_params={"survey_id": a_survey.id}), alice, db) == 200
    assert _status(auth.path_access, _request(path_params={"survey_id": b_survey.id}), operator, db) == 200
    assert _status(auth.path_access, _request(path_params={"survey_id": "nope"}), admin, db) == 404

    assert [s.id for s in surveys_router.list_surveys(alice, db)] == [a_survey.id]
    assert [f.id for f in fields_router.list_fields(alice, db)] == [a_field.id]
    # a survey cannot be started on someone else's field
    payload = schemas.SurveyCreate(field_id=b_field.id, name="sneaky")
    assert _status(surveys_router.create_survey, payload, alice, db) == 404


def test_file_access(db, alice, operator, fields):
    """The web server asks before serving a map tile / 3D model file."""
    from app.routers import auth as auth_router

    a_survey, b_survey = fields["alice"][1], fields["bob"][1]
    ok = lambda user, uri: _status(auth_router.file_access, _request(uri=uri), user, db)  # noqa: E731
    assert ok(alice, f"/tiles/{a_survey.id}/orthomosaic/18/1/2.webp") == 200
    assert ok(alice, f"/models/{a_survey.id}/odm-model/tileset.json?v=2") == 200
    assert ok(alice, f"/tiles/{b_survey.id}/orthomosaic/18/1/2.webp") == 403
    assert ok(operator, f"/splats/{b_survey.id}/scene.spz") == 200
    assert ok(alice, "/tiles/") == 403 and ok(alice, "/etc/passwd") == 403
    assert ok(alice, f"/tiles/{a_survey.id}/../{b_survey.id}/x") == 403


def test_new_fields_and_owners(db, admin, alice, bob):
    made = fields_router.create_field(schemas.FieldCreate(name="Alice south"), alice, db)
    assert made.farm.owner_id == alice.id
    # a farmer cannot place a field elsewhere, even by naming another owner
    made = fields_router.create_field(schemas.FieldCreate(name="Alice east", owner_id=bob.id), alice, db)
    assert made.farm.owner_id == alice.id
    # staff create for a farmer, and move a field to another farmer
    made = fields_router.create_field(schemas.FieldCreate(name="For Bob", owner_id=bob.id), admin, db)
    assert made.farm.owner_id == bob.id
    out = fields_router.update_field(made.id, schemas.FieldUpdate(owner_id=alice.id), admin, db)
    assert out.owner_id == alice.id and out.owner_name == "alice"
    assert _status(fields_router.update_field, made.id, schemas.FieldUpdate(owner_id=bob.id), alice, db) == 403
    assert _status(fields_router.create_field, schemas.FieldCreate(name="x", owner_id=admin.id), admin, db) == 422


def test_staff_only_and_accounts(db, admin, operator, alice):
    assert _status(auth.require_staff, alice) == 403
    assert auth.require_staff(operator) is operator
    assert _status(auth.require_admin, operator) == 403

    carol = users_router.create_user(schemas.UserCreate(email=" Carol@Farm.com", name="Carol", password="long-enough"), db)
    assert carol.email == "carol@farm.com" and carol.role == "farmer"
    assert db.query(models.Farm).filter(models.Farm.owner_id == carol.id).count() == 1
    dup = schemas.UserCreate(email="carol@farm.com", password="long-enough")
    assert _status(users_router.create_user, dup, db) == 409
    assert _status(users_router.create_user, schemas.UserCreate(email="d@farm.com", password="short"), db) == 422
    assert _status(users_router.create_user, schemas.UserCreate(email="e@farm.com", role="boss", password="long-enough"), db) == 422

    # an admin cannot lock themselves out
    assert _status(users_router.update_user, admin.id, schemas.UserUpdate(role="farmer"), admin, db) == 409
    assert _status(users_router.update_user, admin.id, schemas.UserUpdate(is_active=False), admin, db) == 409
    # switching an account off or resetting its password signs it out everywhere
    token = auth.create_session(db, carol)
    db.commit()
    users_router.update_user(carol.id, schemas.UserUpdate(password="new-password-1"), admin, db)
    assert _status(auth.current_user, _request(cookie=token), db) == 401
    assert auth.authenticate(db, "carol@farm.com", "new-password-1") is not None


def main():
    db, admin, operator, alice, bob, fields = _setup()
    try:
        test_passwords()
        test_sign_in_and_sessions(db, alice)
        test_repeated_wrong_passwords()
        test_handoff(db, alice)
        test_farmer_sees_only_own(db, admin, operator, alice, bob, fields)
        test_file_access(db, alice, operator, fields)
        test_new_fields_and_owners(db, admin, alice, bob)
        test_staff_only_and_accounts(db, admin, operator, alice)
    finally:
        db.close()
    print("auth: all checks passed")


if __name__ == "__main__":
    main()
