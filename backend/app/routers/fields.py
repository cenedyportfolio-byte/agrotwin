import json
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.database import get_db
from app.services import boundary_file_service

FLIGHT_PLAN = "flight_plan"

# every route: signed in, and a {field_id} must be one of the user's fields
router = APIRouter(prefix="/api/fields", tags=["fields"], dependencies=[Depends(auth.path_access), Depends(auth.require_consent)])


def _to_summary(field: models.Field) -> schemas.FieldSummary:
    latest_survey = max(field.surveys, key=lambda s: s.created_at, default=None)
    healthy = attention = problem = None
    is_mock = None
    method = None
    if latest_survey and latest_survey.analysis_results:
        latest_result = max(latest_survey.analysis_results, key=lambda r: r.created_at)
        healthy = latest_result.healthy_area_percent
        attention = latest_result.attention_area_percent
        problem = latest_result.problem_area_percent
        is_mock = latest_result.is_mock
        method = latest_result.method

    owner = field.farm.owner if field.farm else None
    return schemas.FieldSummary(
        id=field.id,
        farm_id=field.farm_id,
        owner_id=owner.id if owner else None,
        owner_name=(owner.name or owner.email) if owner else None,
        name=field.name,
        crop_type=field.crop_type,
        boundary_geojson=field.boundary_geojson,
        area_hectares=field.area_hectares,
        center_lat=field.center_lat,
        center_lon=field.center_lon,
        boundary_source=field.boundary_source,
        boundary_file=field.boundary_file,
        created_at=field.created_at,
        latest_survey_id=latest_survey.id if latest_survey else None,
        latest_survey_status=latest_survey.status if latest_survey else None,
        healthy_area_percent=healthy,
        attention_area_percent=attention,
        problem_area_percent=problem,
        analysis_method=method,
        analysis_is_mock=is_mock,
    )


@router.get("", response_model=list[schemas.FieldSummary])
def list_fields(user: models.User = Depends(auth.current_user), db: Session = Depends(get_db)):
    return [_to_summary(f) for f in auth.visible_fields(db, user).all()]


@router.get("/{field_id}", response_model=schemas.FieldSummary)
def get_field(field_id: str, db: Session = Depends(get_db)):
    field = db.get(models.Field, field_id)
    if not field:
        raise HTTPException(404, "Field not found")
    return _to_summary(field)


@router.post("", response_model=schemas.FieldOut)
def create_field(payload: schemas.FieldCreate, user: models.User = Depends(auth.current_user),
                 db: Session = Depends(get_db)):
    """A farmer's field goes into their own farm; staff name the farmer it is
    for (owner_id), or leave it unassigned (only staff see it)."""
    if not user.is_staff:
        farm_id = auth.farm_of(db, user).id
    elif payload.owner_id:
        farm_id = auth.farm_of(db, _farmer(db, payload.owner_id)).id
    elif payload.farm_id and db.get(models.Farm, payload.farm_id):
        farm_id = payload.farm_id
    else:
        farm = db.query(models.Farm).filter(models.Farm.owner_id.is_(None)).first()
        if not farm:
            farm = models.Farm(name="Unassigned fields")
            db.add(farm)
            db.flush()
        farm_id = farm.id

    field = models.Field(farm_id=farm_id, name=payload.name, crop_type=payload.crop_type)
    db.add(field)
    db.commit()
    db.refresh(field)
    return field


@router.patch("/{field_id}", response_model=schemas.FieldSummary)
def update_field(field_id: str, payload: schemas.FieldUpdate, user: models.User = Depends(auth.current_user),
                 db: Session = Depends(get_db)):
    """Renames the field and/or sets its crop type (ingested surveys default to
    'soybean'); staff can also hand it to a farmer (owner_id)."""
    field = db.get(models.Field, field_id)
    if not field:
        raise HTTPException(404, "Field not found")
    if payload.owner_id is not None:
        if not user.is_staff:
            raise HTTPException(403, "Only AgroTwin staff can move a field to another farmer")
        field.farm_id = auth.farm_of(db, _farmer(db, payload.owner_id)).id
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(422, "Field name cannot be empty")
        field.name = name
    if payload.crop_type is not None:
        crop = payload.crop_type.strip().lower()
        if not crop:
            raise HTTPException(422, "Crop type cannot be empty")
        field.crop_type = crop
    db.commit()
    db.refresh(field)
    return _to_summary(field)


def _farmer(db: Session, user_id: str) -> models.User:
    owner = db.get(models.User, user_id)
    if owner is None or owner.role != "farmer":
        raise HTTPException(422, "Choose a farmer's account as the owner")
    return owner


def _flight_plan_dir(field_id: str) -> Path:
    return boundary_file_service.flight_plan_dir(field_id)


def _photo_points(field: models.Field) -> list[tuple[float, float]]:
    """Where the latest flight with GPS photos was taken (lon, lat)."""
    for survey in sorted(field.surveys, key=lambda s: s.created_at, reverse=True):
        points = [(i.lon, i.lat) for i in survey.images if i.lat is not None and i.lon is not None]
        if points:
            return points
    return []


def _read_flight_plan(raw: bytes, field: models.Field | None) -> boundary_file_service.Boundary:
    try:
        boundary = boundary_file_service.parse(raw)
        if field is not None:
            center = (field.center_lat, field.center_lon) if field.center_lat is not None else None
            boundary_file_service.check_near(boundary, _photo_points(field), center)
    except boundary_file_service.BoundaryFileError as exc:
        raise HTTPException(422, str(exc)) from exc
    return boundary


def _recheck_crop_health(db: Session, field: models.Field) -> int:
    """Analysis keeps the map cells inside the outline: a new outline means new
    shares and spots, so the field's finished flights are checked again."""
    from app.services import job_runner, processing_service

    queued = 0
    for survey in field.surveys:
        if survey.status != "COMPLETED" or not survey.analysis_results:
            continue
        try:
            job_runner.enqueue(db, survey, processing_service.ANALYSIS_STEPS, processing_service.run_analysis_job)
            queued += 1
        except job_runner.JobAlreadyRunning:
            pass  # it is analysed with the new outline when that job gets there
    return queued


@router.post("/boundary-file/check", response_model=schemas.BoundaryFileInfo)
def check_boundary_file(file: UploadFile, field_id: str | None = Form(None),
                        user: models.User = Depends(auth.current_user), db: Session = Depends(get_db)):
    """Reads a flight-plan file (KMZ/KML) before it is attached — the upload page,
    before the flight exists: the outline's size, or why it cannot be used.
    `field_id`: compare it with that field's position."""
    field = auth.visible_field(db, user, field_id) if field_id else None
    boundary = _read_flight_plan(file.file.read(), field)
    return {"filename": file.filename, "kind": boundary.kind, "area_hectares": boundary.area_hectares, "notes": boundary.notes}


@router.post("/{field_id}/boundary-file", response_model=schemas.BoundaryFileResult)
def attach_boundary_file(field_id: str, file: UploadFile, db: Session = Depends(get_db)):
    """The field's outline from the flight plan: the area the pilot drew for the
    mission (DJI Pilot 2 KMZ) or a KML/KMZ outline. Replaces the outline
    estimated from the photos; the file is kept with the field."""
    field = db.get(models.Field, field_id)
    if not field:
        raise HTTPException(404, "Field not found")
    raw = file.file.read()
    boundary = _read_flight_plan(raw, field)

    folder = _flight_plan_dir(field.id)
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    name = Path(file.filename or "flight_plan.kmz").name[:120]
    suffix = ".kmz" if raw[:4] == b"PK\x03\x04" else ".kml"
    (folder / f"flight_plan{suffix}").write_bytes(raw)

    field.boundary_geojson = json.dumps(boundary.geometry)
    field.area_hectares = boundary.area_hectares
    field.center_lat = boundary.center_lat
    field.center_lon = boundary.center_lon
    field.boundary_source = FLIGHT_PLAN
    field.boundary_file = name
    db.commit()
    rechecking = _recheck_crop_health(db, field)
    db.refresh(field)
    return {"field": _to_summary(field), "kind": boundary.kind, "notes": boundary.notes, "rechecking": rechecking}


@router.delete("/{field_id}/boundary-file", response_model=schemas.BoundaryFileResult)
def remove_boundary_file(field_id: str, db: Session = Depends(get_db)):
    """Back to the outline estimated around the photos of the latest flight."""
    from app.services.survey_service import update_field_boundary_from_images

    field = db.get(models.Field, field_id)
    if not field:
        raise HTTPException(404, "Field not found")
    if field.boundary_source != FLIGHT_PLAN:
        return {"field": _to_summary(field)}
    field.boundary_source = None
    field.boundary_file = None
    shutil.rmtree(_flight_plan_dir(field.id), ignore_errors=True)
    latest = next((s for s in sorted(field.surveys, key=lambda s: s.created_at, reverse=True)
                   if any(i.lat is not None for i in s.images)), None)
    if latest is not None:
        update_field_boundary_from_images(db, field, latest.images, latest.gcps)
    else:
        field.boundary_geojson = None
        field.area_hectares = None
    db.commit()
    rechecking = _recheck_crop_health(db, field)
    db.refresh(field)
    return {"field": _to_summary(field), "rechecking": rechecking}


@router.get("/{field_id}/surveys", response_model=list[schemas.SurveyOut])
def list_field_surveys(field_id: str, db: Session = Depends(get_db)):
    field = db.get(models.Field, field_id)
    if not field:
        raise HTTPException(404, "Field not found")
    return field.surveys


@router.delete("/{field_id}")
def delete_field(field_id: str, db: Session = Depends(get_db)):
    """Deletes the field and all of its surveys (see delete_survey for what is removed from disk)."""
    from app.services import processing_service
    from app.services.survey_service import delete_survey_files

    field = db.get(models.Field, field_id)
    if not field:
        raise HTTPException(404, "Field not found")
    if any(processing_service.is_running(processing_service.latest_job(s)) for s in field.surveys):
        raise HTTPException(409, "A survey of this field is being processed — wait for it to finish")
    for survey in field.surveys:
        delete_survey_files(survey)
    shutil.rmtree(_flight_plan_dir(field.id), ignore_errors=True)
    db.delete(field)
    db.commit()
    return {"deleted": field_id}
