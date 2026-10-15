"""The data agreement farmers accept before they use AgroTwin: what is done
with their fields' photos and maps (the university's research use, who sees
them, how to have them deleted). Its text is a file the admin keeps on the
server (AGROTWIN_AGREEMENT_FILE); its version is a hash of that text, so an
edited agreement is accepted again. Without the file nothing is asked.

Staff accounts (admin, operator) are not asked: the agreement is between
AgroTwin and the farmers whose data it keeps.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass

from app.config import settings

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Agreement:
    version: str
    title: str
    text: str


_cache: dict[tuple, Agreement] = {}
_reported: set[str] = set()


def current() -> Agreement | None:
    """The agreement in force, or None when there is none (or its file cannot be read)."""
    path = settings.agreement_file
    if not path:
        return None
    try:
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        if key not in _cache:
            text = path.read_text(encoding="utf-8").strip()
            if not text:
                raise ValueError("the file is empty")
            heading = next((line.lstrip("#").strip() for line in text.splitlines() if line.startswith("#")), None)
            _cache.clear()
            _cache[key] = Agreement(hashlib.sha256(text.encode()).hexdigest()[:12], heading or "Data agreement", text)
        return _cache[key]
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        if str(path) not in _reported:
            _reported.add(str(path))
            log.error("AGROTWIN_AGREEMENT_FILE %s cannot be used (%s): no agreement is asked for", path, exc)
        return None


def needs_consent(user) -> bool:
    agreement = current()
    return agreement is not None and user.role == "farmer" and user.consent_version != agreement.version
