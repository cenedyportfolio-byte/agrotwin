#!/usr/bin/env python3
"""Creates an account, or sets a new password for an existing one. Needed
once on a new server, for the first admin; after that the admin manages
accounts in the app (Users page).

    python -m scripts.create_user --email you@university.edu --name "Your Name" --role admin
    python -m scripts.create_user --email farmer@example.com --role farmer --assign-unowned

The password is asked for (not shown); --password is for scripts.
--assign-unowned gives a farmer every field that has no owner yet (the
fields made before accounts existed).
"""

import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import auth, models  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--name", default=None)
    ap.add_argument("--role", choices=models.ROLES, default="farmer")
    ap.add_argument("--password", default=None)
    ap.add_argument("--assign-unowned", action="store_true")
    args = ap.parse_args()

    password = args.password or getpass.getpass("Password: ")
    if not args.password and getpass.getpass("Again: ") != password:
        sys.exit("The passwords differ")
    if len(password) < auth.MIN_PASSWORD_LENGTH:
        sys.exit(f"The password needs at least {auth.MIN_PASSWORD_LENGTH} characters")

    init_db()
    db = SessionLocal()
    try:
        email = auth.normalize_email(args.email)
        user = db.query(models.User).filter(models.User.email == email).first()
        if user is None:
            user = models.User(email=email)
            db.add(user)
            print(f"created {email} ({args.role})")
        else:
            auth.end_all_sessions(db, user)
            print(f"updated {email} ({args.role}); signed out everywhere")
        user.name = args.name or user.name
        user.role = args.role
        user.is_active = True
        user.password_hash = auth.hash_password(password)
        db.flush()
        if args.assign_unowned:
            if args.role != "farmer":
                sys.exit("--assign-unowned is for a farmer's account")
            farm = auth.farm_of(db, user)
            moved = 0
            for field in db.query(models.Field).join(models.Farm).filter(models.Farm.owner_id.is_(None)).all():
                field.farm_id = farm.id
                moved += 1
            print(f"gave {moved} unowned field(s) to {email}")
        elif args.role == "farmer":
            auth.farm_of(db, user)
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
