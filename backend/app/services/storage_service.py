"""Local filesystem storage abstraction.

Everything goes through this module so the storage backend (local disk today,
S3/blob storage later) can change without touching routers or other services.
Source drone imagery is referenced in place (by absolute path) rather than
copied, since raw survey folders can be tens of gigabytes.
"""

import os
import re
import tempfile
from pathlib import Path

from PIL import Image

from app.config import AGROTWIN_ROOT, settings

THUMBNAIL_SIZE = (480, 360)


def write_atomic(path: Path, data: bytes) -> None:
    """Write via temp file + rename so a concurrent FileResponse never sees a
    half-written cache file (the image grid fires hundreds of requests at once)."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


# Stored paths are absolute and may come from another machine or OS
# (D:\argoTwinv2\…, /media/<user>/…/agrotwin/…). Re-root them: anything under
# the project folder maps onto this checkout, anything under the raw survey
# folder ("Development/Agro/") or inside a DJI mission folder onto
# settings.raw_data_root.
_DJI_TAIL = re.compile(r"/(DJI_[^/]+/[^/]+)$")


def _reroots() -> tuple[tuple[str, Path], ...]:
    return (
        ("/agrotwin/", AGROTWIN_ROOT),
        (f"/{AGROTWIN_ROOT.name}/", AGROTWIN_ROOT),
        ("/Development/Agro/", settings.raw_data_root),
    )


def resolve_path(file_path: str) -> Path:
    """Prefers this checkout's own copy of a file over the stored location, so
    a project copied to another drive or OS uses its local data even while the
    original still exists."""
    s = str(file_path).replace("\\", "/")  # a Windows path is not split on "\" elsewhere
    for marker, base in _reroots():
        if marker in s:
            cand = base / s.split(marker, 1)[1]
            if cand.exists():
                return cand
    m = _DJI_TAIL.search(s)
    if m and (cand := settings.raw_data_root / m.group(1)).exists():
        return cand
    return Path(file_path)


def file_exists(file_path: str) -> bool:
    return resolve_path(file_path).exists()


def get_or_create_thumbnail(image_id: str, source_path: str) -> Path:
    thumb_path = settings.thumbs_cache_dir / f"{image_id}.jpg"
    if thumb_path.exists():
        return thumb_path

    from app.services.multispectral_service import open_image_safely

    src = resolve_path(source_path)
    with open_image_safely(src) as img:
        if img.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
            # 16-bit single-band (DJI multispectral TIF): a plain convert("RGB")
            # would clip everything above 255 to white. Percentile-stretch instead.
            import numpy as np

            arr = np.asarray(img, dtype=np.float32)
            lo, hi = np.percentile(arr, [2, 98])
            if hi <= lo:
                hi = lo + 1.0
            img = Image.fromarray((np.clip((arr - lo) / (hi - lo), 0, 1) * 255).astype("uint8"), mode="L").convert("RGB")
        else:
            img.draft("RGB", THUMBNAIL_SIZE)
            img = img.convert("RGB")
        img.thumbnail(THUMBNAIL_SIZE)
        import io

        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
        write_atomic(thumb_path, buf.getvalue())

    return thumb_path


def survey_dir(survey_id: str) -> Path:
    d = settings.surveys_dir / survey_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def asset_import_dir(survey_id: str, asset_id: str) -> Path:
    """Folder holding a manual import's files; the API serves it to the viewer."""
    return settings.surveys_dir / survey_id / "imports" / asset_id


def unique_path(path: Path) -> Path:
    """path itself if free, else the first free name_1.ext, name_2.ext, …"""
    candidate, n = path, 1
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}_{n}{path.suffix}")
        n += 1
    return candidate
