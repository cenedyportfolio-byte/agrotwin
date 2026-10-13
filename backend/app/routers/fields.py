from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.database import get_db

# every route: signed in, and a {field_id} must be one of the user's fields
router = APIRouter(prefix="/api/fields", tags=["fields"], dependencies=[Depends(auth.path_access)])


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
    db.delete(field)
    db.commit()
    return {"deleted": field_id}
