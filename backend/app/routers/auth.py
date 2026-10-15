from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.config import settings
from app.database import get_db

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _set_cookie(response: Response, token: str, persistent: bool = True) -> None:
    """`persistent`: kept for session_days; otherwise the browser drops it when it closes."""
    response.set_cookie(
        settings.session_cookie,
        token,
        max_age=settings.session_days * 24 * 3600 if persistent else None,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/login", response_model=schemas.LoginResponse)
def login(payload: schemas.LoginRequest, response: Response, db: Session = Depends(get_db)):
    email = auth.normalize_email(payload.email)
    if auth.too_many_failures(email):
        raise HTTPException(429, "Too many wrong passwords — wait 15 minutes, or ask your AgroTwin contact to reset it")
    user = auth.authenticate(db, email, payload.password)
    if user is None:
        auth.record_failure(email)
        raise HTTPException(401, "Wrong email or password")
    auth.clear_failures(email)
    token = auth.create_session(db, user)
    db.commit()
    _set_cookie(response, token, persistent=payload.remember)
    return {"user": user, "token": token}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = auth.request_token(request)
    if token:
        auth.end_session(db, token)
        db.commit()
    response.delete_cookie(settings.session_cookie, path="/")
    return {"signed_out": True}


# the field data served as files (map tiles, 3D models, splats): /<prefix>/<survey id>/...
FILE_PREFIXES = ("/tiles/", "/models/", "/splats/")


@router.get("/file-access", status_code=204)
def file_access(request: Request, user: models.User = Depends(auth.current_user), db: Session = Depends(get_db)):
    """For the web server (nginx auth_request) before it serves a map file from
    disk: 204 when the signed-in user may see that survey, 403 otherwise (nginx
    turns any other answer into a 500). The file's path comes in X-Original-URI."""
    path = request.headers.get("x-original-uri", "").split("?", 1)[0]
    prefix = next((p for p in FILE_PREFIXES if path.startswith(p)), None)
    survey_id = path[len(prefix):].split("/", 1)[0] if prefix else ""
    try:
        if not survey_id or ".." in path:
            raise HTTPException(403)
        auth.visible_survey(db, user, survey_id)
    except HTTPException as exc:
        raise HTTPException(403, "Not your field") from exc
    return Response(status_code=204)


@router.post("/handoff")
def handoff(user: models.User = Depends(auth.current_user)):
    """A one-time code (valid a minute) for the web viewer the mobile app embeds."""
    return {"code": auth.create_handoff(user), "expires_in": auth.HANDOFF_TTL_S}


@router.post("/handoff/redeem", response_model=schemas.LoginResponse)
def redeem_handoff(payload: schemas.HandoffRedeem, response: Response, db: Session = Depends(get_db)):
    """The web app turns a hand-off code into a session of its own (cookie)."""
    user = auth.redeem_handoff(db, payload.code)
    if user is None:
        raise HTTPException(401, "This sign-in link has expired — open the map again")
    token = auth.create_session(db, user)
    db.commit()
    _set_cookie(response, token)
    return {"user": user, "token": token}


@router.get("/me", response_model=schemas.UserOut)
def me(user: models.User = Depends(auth.current_user)):
    return user


@router.post("/password")
def change_password(payload: schemas.PasswordChange, response: Response,
                    user: models.User = Depends(auth.current_user), db: Session = Depends(get_db)):
    """Changes the user's own password and signs out their other devices."""
    if not auth.verify_password(payload.current_password, user.password_hash):
        raise HTTPException(400, "The current password is wrong")  # 401 would mean "signed out"
    auth.check_password_rules(payload.new_password)
    user.password_hash = auth.hash_password(payload.new_password)
    auth.end_all_sessions(db, user)
    token = auth.create_session(db, user)
    db.commit()
    _set_cookie(response, token)
    return {"changed": True, "token": token}
