"""Accounts, managed by an admin: create farmers / operators / admins, rename,
change role, switch off, set a new password. Switching an account off keeps
its farms and flights; deleting it (when a farmer asks for their data to be
removed) takes them away for good. Operators may list the farmers (to give a
field to one), nothing else here."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.database import get_db
from app.services import account_service

router = APIRouter(prefix="/api/users", tags=["users"])
ADMIN = [Depends(auth.require_admin)]


def _check_role(role: str) -> str:
    if role not in models.ROLES:
        raise HTTPException(422, f"Role must be one of: {', '.join(models.ROLES)}")
    return role


@router.get("/farmers", response_model=list[schemas.UserOut], dependencies=[Depends(auth.require_staff)])
def list_farmers(db: Session = Depends(get_db)):
    """Active farmers' accounts, for choosing a field's owner."""
    return (db.query(models.User).filter(models.User.role == "farmer", models.User.is_active.is_(True))
            .order_by(models.User.name, models.User.email).all())


@router.get("", response_model=list[schemas.UserOut], dependencies=ADMIN)
def list_users(db: Session = Depends(get_db)):
    return db.query(models.User).filter(models.User.role.in_(models.ROLES)).order_by(models.User.created_at).all()


@router.post("", response_model=schemas.UserOut, dependencies=ADMIN)
def create_user(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    email = auth.normalize_email(payload.email)
    if "@" not in email:
        raise HTTPException(422, "Enter a valid email address")
    if db.query(models.User).filter(models.User.email == email).first():
        raise HTTPException(409, "There is already an account with this email")
    auth.check_password_rules(payload.password)
    user = models.User(email=email, name=(payload.name or "").strip() or None, role=_check_role(payload.role),
                       password_hash=auth.hash_password(payload.password), is_active=True)
    db.add(user)
    db.flush()
    if user.role == "farmer":
        auth.farm_of(db, user)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: str, payload: schemas.UserUpdate, admin: models.User = Depends(auth.require_admin),
                db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    if user is None or user.role not in models.ROLES:
        raise HTTPException(404, "Account not found")
    if user.id == admin.id and ((payload.role and payload.role != "admin") or payload.is_active is False):
        raise HTTPException(409, "You cannot remove your own admin access — ask another admin")
    if payload.name is not None:
        user.name = payload.name.strip() or None
    if payload.role is not None:
        user.role = _check_role(payload.role)
        if user.role == "farmer":
            auth.farm_of(db, user)
    if payload.is_active is not None:
        user.is_active = payload.is_active
        if not payload.is_active:
            auth.end_all_sessions(db, user)
    if payload.password is not None:
        auth.check_password_rules(payload.password)
        user.password_hash = auth.hash_password(payload.password)
        auth.end_all_sessions(db, user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/{user_id}/delete", dependencies=ADMIN)
def delete_user(user_id: str, payload: schemas.AccountDeleteByAdmin, admin: models.User = Depends(auth.require_admin),
                db: Session = Depends(get_db)):
    """Deletes an account with all its fields, flights, maps and results
    (account_service). The account's email, typed, confirms it."""
    user = db.get(models.User, user_id)
    if user is None or user.role not in models.ROLES:
        raise HTTPException(404, "Account not found")
    if user.id == admin.id:
        raise HTTPException(409, "Delete your own account under Settings")
    if auth.normalize_email(payload.confirm) != user.email:
        raise HTTPException(422, "Type the account's email to confirm")
    try:
        return account_service.delete(db, user)
    except account_service.CannotDelete as exc:
        raise HTTPException(409, str(exc)) from exc
