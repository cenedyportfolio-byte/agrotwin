"""Deleting an account and everything AgroTwin keeps for it: the farms the
user owns, with their fields (and flight plans) and flights — uploaded photos,
maps, map tiles, 3D models, crop-health results, ground control points — and
the account's sign-ins. Photos registered in place on a drive (DJI mission
folders read where they are) were never uploaded and are not touched.

Refused while a map is being made for one of the user's flights, and for the
last admin (no one could manage accounts any more).
"""

from __future__ import annotations

import shutil
from pathlib import Path

from sqlalchemy.orm import Session

from app import auth, models
from app.config import AGROTWIN_ROOT, settings
from app.services import boundary_file_service, processing_service
from app.services.survey_service import delete_survey_files

PUBLIC = AGROTWIN_ROOT / "frontend" / "public"


class CannotDelete(Exception):
    """The account cannot be deleted now; the message says why."""


def owned_surveys(user: models.User) -> list[models.Survey]:
    return [s for farm in user.farms for field in farm.fields for s in field.surveys]


def _generated(survey_id: str) -> list[Path]:
    """Files made for a flight outside its own folder: map tiles, 3D models, splats."""
    return [settings.public_tiles_dir / survey_id, PUBLIC / "models" / survey_id, PUBLIC / "splats" / survey_id,
            settings.data_dir / "splats" / survey_id]


def check(db: Session, user: models.User) -> None:
    """Raises CannotDelete when the account cannot be deleted now."""
    if any(processing_service.is_running(processing_service.latest_job(s)) for s in owned_surveys(user)):
        raise CannotDelete("A map is being made for one of the flights. Wait until it is done, "
                           "or ask AgroTwin staff to stop it in the queue, then delete the account.")
    if user.role == "admin":
        others = (db.query(models.User)
                  .filter(models.User.role == "admin", models.User.is_active.is_(True), models.User.id != user.id).count())
        if not others:
            raise CannotDelete("This is the only admin account: make another admin first, so someone can still manage accounts.")


def delete(db: Session, user: models.User) -> dict:
    """Deletes the account and its data. Returns what was deleted (counts)."""
    check(db, user)
    farms = list(user.farms)
    fields = [field for farm in farms for field in farm.fields]
    surveys = owned_surveys(user)
    # the files first: reading the rows takes no write lock, and a database
    # error afterwards leaves the rows, never rows pointing at nothing
    for survey in surveys:
        delete_survey_files(survey)
        for folder in _generated(survey.id):
            shutil.rmtree(folder, ignore_errors=True)
    for field in fields:
        shutil.rmtree(boundary_file_service.flight_plan_dir(field.id), ignore_errors=True)
    for farm in farms:
        db.delete(farm)
    auth.end_all_sessions(db, user)
    db.delete(user)
    db.commit()
    return {"deleted": True, "fields": len(fields), "flights": len(surveys)}
