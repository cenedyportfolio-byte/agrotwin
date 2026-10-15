"""Sign-in and who may see what.

Three roles (models.ROLES): an admin can do everything, including managing
accounts; an operator sees and works on every farm but cannot manage
accounts; a farmer sees only the fields of the farm they own. A field (and
its surveys) belongs to a farm, a farm to its owner.

A sign-in is a random token: the web app keeps it in an http-only cookie
(sent automatically through the Next.js /api proxy, also for map tiles and
previews), the mobile app sends it as `Authorization: Bearer <token>`. Only
its SHA-256 is stored. Passwords are hashed with scrypt from the standard
library.

Something a user may not see answers 404, as if it did not exist, so a
farmer cannot probe for other farmers' survey ids.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app import models
from app.config import settings
from app.database import get_db

MIN_PASSWORD_LENGTH = 8
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}

# a few wrong passwords are typos; many are someone guessing
MAX_FAILED_LOGINS = 8
FAILED_LOGIN_WINDOW_S = 15 * 60
_failed: dict[str, list[float]] = {}
_failed_lock = threading.Lock()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    try:
        scheme, n, r, p, salt, digest = (stored or "").split("$")
        if scheme != "scrypt":
            return False
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), dklen=32, n=int(n), r=int(r), p=int(p))
    except ValueError:
        return False
    return hmac.compare_digest(actual.hex(), digest)


def check_password_rules(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(422, f"The password needs at least {MIN_PASSWORD_LENGTH} characters")


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    # stored naive in SQLite, as the other timestamps
    return datetime.now(timezone.utc).replace(tzinfo=None)


def too_many_failures(email: str) -> bool:
    cutoff = time.monotonic() - FAILED_LOGIN_WINDOW_S
    with _failed_lock:
        recent = [t for t in _failed.get(email, []) if t > cutoff]
        _failed[email] = recent
        return len(recent) >= MAX_FAILED_LOGINS


def record_failure(email: str) -> None:
    with _failed_lock:
        _failed.setdefault(email, []).append(time.monotonic())


def clear_failures(email: str) -> None:
    with _failed_lock:
        _failed.pop(email, None)


_UNKNOWN_USER_HASH = hash_password(secrets.token_urlsafe(16))


def authenticate(db: Session, email: str, password: str) -> models.User | None:
    user = db.query(models.User).filter(models.User.email == normalize_email(email)).first()
    # check a password even for an unknown address, so both answers take as long
    ok = verify_password(password, user.password_hash if user and user.password_hash else _UNKNOWN_USER_HASH)
    if user is None or not ok or not user.is_active or user.role not in models.ROLES:
        return None
    return user


def create_session(db: Session, user: models.User) -> str:
    token = secrets.token_urlsafe(32)
    db.add(models.UserSession(user_id=user.id, token_hash=_token_hash(token),
                              expires_at=_now() + timedelta(days=settings.session_days)))
    return token


def end_session(db: Session, token: str) -> None:
    db.query(models.UserSession).filter(models.UserSession.token_hash == _token_hash(token)).delete()


def end_all_sessions(db: Session, user: models.User) -> None:
    db.query(models.UserSession).filter(models.UserSession.user_id == user.id).delete()


def request_token(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    return request.cookies.get(settings.session_cookie)


def current_user(request: Request, db: Session = Depends(get_db)) -> models.User:
    """The signed-in user, or 401."""
    token = request_token(request)
    if token:
        session = db.query(models.UserSession).filter(models.UserSession.token_hash == _token_hash(token)).first()
        if session and session.expires_at > _now() and session.user.is_active and session.user.role in models.ROLES:
            return session.user
    raise HTTPException(401, "Please sign in")


CONSENT_REQUIRED = "Accept the data agreement first: it is shown when you sign in."


def require_consent(user: models.User = Depends(current_user)) -> models.User:
    """A farmer must have accepted the current data agreement (when there is one)
    before reading or sending field data."""
    if user.consent_required:
        raise HTTPException(403, CONSENT_REQUIRED)
    return user


def require_staff(user: models.User = Depends(current_user)) -> models.User:
    if not user.is_staff:
        raise HTTPException(403, "Only AgroTwin staff can do this")
    return user


def require_admin(user: models.User = Depends(current_user)) -> models.User:
    if user.role != "admin":
        raise HTTPException(403, "Only an admin can do this")
    return user


def can_see_field(user: models.User, field: models.Field) -> bool:
    return user.is_staff or (field.farm is not None and field.farm.owner_id == user.id)


def visible_fields(db: Session, user: models.User):
    """Query of the fields this user may see."""
    q = db.query(models.Field)
    if user.is_staff:
        return q
    return q.join(models.Farm).filter(models.Farm.owner_id == user.id)


def visible_field(db: Session, user: models.User, field_id: str) -> models.Field:
    field = db.get(models.Field, field_id)
    if field is None or not can_see_field(user, field):
        raise HTTPException(404, "Field not found")
    return field


def visible_survey(db: Session, user: models.User, survey_id: str) -> models.Survey:
    survey = db.get(models.Survey, survey_id)
    if survey is None or not can_see_field(user, survey.field):
        raise HTTPException(404, "Survey not found")
    return survey


def path_access(request: Request, user: models.User = Depends(current_user), db: Session = Depends(get_db)) -> None:
    """Router-wide check: a {field_id} or {survey_id} in the path must be one
    this user may see. Every route of the router is covered, including ones
    added later."""
    if (field_id := request.path_params.get("field_id")) is not None:
        visible_field(db, user, field_id)
    if (survey_id := request.path_params.get("survey_id")) is not None:
        visible_survey(db, user, survey_id)


# One-time codes that hand a signed-in app session to the web viewer it embeds
# (a WebView has its own cookies): the app asks for a code with its token, the
# web app redeems it for a cookie session. In memory — one API process.
HANDOFF_TTL_S = 60
_handoffs: dict[str, tuple[str, float]] = {}


def create_handoff(user: models.User) -> str:
    code = secrets.token_urlsafe(24)
    now = time.monotonic()
    with _failed_lock:
        for stale in [c for c, (_, t) in _handoffs.items() if now - t > HANDOFF_TTL_S]:
            del _handoffs[stale]
        _handoffs[code] = (user.id, now)
    return code


def redeem_handoff(db: Session, code: str) -> models.User | None:
    with _failed_lock:
        entry = _handoffs.pop(code, None)
    if entry is None or time.monotonic() - entry[1] > HANDOFF_TTL_S:
        return None
    user = db.get(models.User, entry[0])
    return user if user is not None and user.is_active and user.role in models.ROLES else None


def farm_of(db: Session, user: models.User) -> models.Farm:
    """The farm a farmer's new fields go into (made on first use)."""
    farm = db.query(models.Farm).filter(models.Farm.owner_id == user.id).order_by(models.Farm.created_at).first()
    if farm is None:
        farm = models.Farm(name=f"{user.name or user.email}'s farm", owner_id=user.id)
        db.add(farm)
        db.flush()
    return farm
