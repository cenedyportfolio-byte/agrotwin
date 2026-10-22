"""Outside data AgroTwin looks up for a field or a flight: the weather
(Open-Meteo), the soil (USDA Soil Data Access) and the satellite passes
(Sentinel-2, through Element 84's Earth Search). Every lookup runs in the
background, once, and its answer is kept with the field or flight — an upload
or a page never waits on another server. When the internet or a service is
down the lookup is noted as unavailable and tried again later.

Only what a lookup needs leaves the server: the weather gets the field's
position rounded to about 5 km; the soil and the satellites get a box a little
larger than the field — never its outline, its name or its farmer's.
AGROTWIN_EXTERNAL_DATA=false switches all of it off.
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from app.config import settings

log = logging.getLogger(__name__)

USER_AGENT = "AgroTwin/1.1 (drone crop maps for farmers)"
RETRY_AFTER = timedelta(hours=6)  # a lookup that failed is tried again after this

_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="agrotwin-lookup")
_running: set[str] = set()
_lock = threading.Lock()


class LookupFailed(Exception):
    """The service could not be reached or did not answer usefully."""


def enabled() -> bool:
    return settings.external_data


def now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def stamp() -> str:
    return now().isoformat(timespec="seconds")


def stale(checked_at: str | None, after: timedelta) -> bool:
    if not checked_at:
        return True
    try:
        return now() - datetime.fromisoformat(checked_at) > after
    except ValueError:
        return True


def get_json(url: str, params: dict | None = None, body: dict | None = None, timeout: float = 30.0):
    """GET (or POST `body` as JSON) and parse the JSON answer. Raises LookupFailed."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300].decode("utf-8", "replace")
        raise LookupFailed(f"{urllib.parse.urlsplit(url).netloc} answered {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise LookupFailed(f"{urllib.parse.urlsplit(url).netloc}: {exc}") from exc


def start(key: str, fn: Callable, *args) -> bool:
    """Runs fn(*args) in the background unless the same lookup (key) is already
    running. False when outside data is switched off."""
    if not enabled():
        return False
    with _lock:
        if key in _running:
            return True
        _running.add(key)

    def run():
        try:
            fn(*args)
        except Exception:
            log.exception("lookup %s failed", key)
        finally:
            with _lock:
                _running.discard(key)

    _pool.submit(run)
    return True


def running(key: str) -> bool:
    with _lock:
        return key in _running
