"""The US county a field lies in ("Putnam County, TN"), from the Census
Bureau's county boundaries kept on this server — no outside service is asked.
scripts/fetch_counties.py downloads them once; without that file, or outside
the US, the county is simply not known.
"""

from __future__ import annotations

import gzip
import json
import logging
import threading
from functools import lru_cache

from shapely import STRtree
from shapely.geometry import Point, shape

from app.config import settings

log = logging.getLogger(__name__)

NEAR_BORDER_DEG = 0.01  # a field just outside a (simplified) county edge still gets that county

_lock = threading.Lock()
_data: tuple | None = None
_mtime: float | None = None


def _loaded():
    """(tree, shapes, names), reloaded when the file changes; None without it."""
    global _data, _mtime
    path = settings.counties_file
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    with _lock:
        if _data is None or mtime != _mtime:
            try:
                with gzip.open(path, "rt", encoding="utf-8") as f:
                    rows = json.load(f)
                shapes = [shape(r["g"]) for r in rows]
                names = [f"{r['n']}, {r['s']}" if r.get("s") else r["n"] for r in rows]
                _data, _mtime = (STRtree(shapes), shapes, names), mtime
            except (OSError, ValueError, KeyError) as exc:
                log.error("county file %s cannot be read: %s", path, exc)
                return None
        return _data


@lru_cache(maxsize=4096)
def _county(lat: float, lon: float, _file_version: float | None) -> str | None:
    """Cached per position and file version: a new file gives fresh answers."""
    data = _loaded()
    if data is None:
        return None
    tree, shapes, names = data
    point = Point(lon, lat)
    hits = tree.query(point, predicate="intersects")
    if len(hits):
        return names[int(hits[0])]
    nearest = tree.nearest(point)
    if nearest is not None and shapes[int(nearest)].distance(point) < NEAR_BORDER_DEG:
        return names[int(nearest)]
    return None


def county_of(lat: float | None, lon: float | None) -> str | None:
    """"Putnam County, TN" for a position, or None."""
    if lat is None or lon is None or _loaded() is None:
        return None
    return _county(round(lat, 4), round(lon, 4), _mtime)
