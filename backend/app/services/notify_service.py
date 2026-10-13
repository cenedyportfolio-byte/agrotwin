"""E-mail to the farmer when a map is ready — only when an SMTP server is
configured (AGROTWIN_SMTP_HOST); otherwise nothing is sent. A failure to send
is logged and never fails the processing job."""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from app import models
from app.config import settings

log = logging.getLogger(__name__)


def _send(to: str, subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=30) as smtp:
        if settings.smtp_starttls:
            smtp.starttls()
        if settings.smtp_user:
            smtp.login(settings.smtp_user, settings.smtp_password or "")
        smtp.send_message(msg)


def map_ready(survey: models.Survey, detailed: bool) -> None:
    owner = survey.field.farm.owner if survey.field and survey.field.farm else None
    if not settings.smtp_host or owner is None or not owner.is_active:
        return
    link = f"{settings.public_url.rstrip('/')}/surveys/{survey.id}"
    name = owner.name.split()[0] if owner.name else "there"
    if detailed:
        subject = f"The detailed map of {survey.field.name} is ready"
        text = (f"Hi {name},\n\nThe detailed map of {survey.field.name} from your flight “{survey.name}” is "
                f"ready, and the crop health was checked on it again.\n\n{link}\n")
    else:
        subject = f"Your map of {survey.field.name} is ready"
        text = (f"Hi {name},\n\nThe map of {survey.field.name} from your flight “{survey.name}” is ready, "
                f"with the spots worth checking.\n\n{link}\n")
        if settings.odm_enabled:
            text += "\nA more detailed map is being made now; we will e-mail you when it is ready (usually a few hours).\n"
    try:
        _send(owner.email, subject, text + "\n— AgroTwin\n")
        log.info("notify: told %s that %s is ready", owner.email, survey.id)
    except (OSError, smtplib.SMTPException) as exc:
        log.warning("notify: could not e-mail %s: %s", owner.email, exc)
