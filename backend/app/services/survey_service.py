"""Survey creation and image ingestion.

Boundary/area math uses a local equirectangular projection centered on the
image centroid. That's accurate enough for a single field (a few hundred
meters across) without pulling in pyproj/GDAL as a hard dependency. It is
approximate and should be replaced by a proper geodesic/UTM calculation
before this is trusted at larger scale.
"""

import json
import math
import re
from datetime import datetime
from pathlib import Path

from shapely.geometry import MultiPoint, Polygon, mapping
from sqlalchemy.orm import Session

from app import models
from app.services.metadata_service import extract_image_metadata

EARTH_RADIUS_M = 6371000.0

# DJI Mavic 3 Multispectral naming: DJI_<YYYYMMDDhhmmss>_<seq>_<D|MS_G|MS_R|MS_RE|MS_NIR>.<JPG|TIF>
# The RGB JPG and the band TIFs of one shutter release can carry timestamps a
# second apart, so the frame key is <mission folder>:<seq>, not the timestamp.
DJI_FRAME_RE = re.compile(r"^DJI_\d{14}_(\d{4})_(D|MS_G|MS_R|MS_RE|MS_NIR)\.(jpe?g|tiff?)$", re.IGNORECASE)
DJI_BAND_BY_SUFFIX = {"D": "RGB", "MS_G": "GREEN", "MS_R": "RED", "MS_RE": "RED_EDGE", "MS_NIR": "NIR"}
DJI_STAMP_RE = re.compile(r"^DJI_(\d{14})_", re.IGNORECASE)
FRAME_PAIR_WINDOW_S = 3  # an M3M release's RGB JPG and band TIFs are stamped up to ~2 s apart

# Non-image files a DJI mission folder ships alongside the frames.
GNSS_ASSET_TYPES = {
    ".mrk": "gnss_timestamp_mrk",  # per-frame RTK positions + fix quality
    ".nav": "gnss_ppk_nav",  # RINEX navigation
    ".obs": "gnss_ppk_obs",  # RINEX observations
    ".bin": "gnss_ppk_raw",  # raw receiver log
}


def camera_fields(meta) -> dict:
    return {
        "gimbal_yaw_deg": meta.gimbal_yaw_deg,
        "gimbal_pitch_deg": meta.gimbal_pitch_deg,
        "gimbal_roll_deg": meta.gimbal_roll_deg,
        "rel_altitude_m": meta.rel_altitude_m,
        "focal_px": meta.focal_px,
        "cx_px": meta.cx_px,
        "cy_px": meta.cy_px,
        "rtk_fix": meta.rtk_fix,
        "rtk_std_m": meta.rtk_std_m,
    }


def backfill_camera_metadata(db: Session, survey: models.Survey) -> int:
    """Fills the XMP-derived columns on rows ingested before they existed."""
    n = 0
    for img in survey.images:
        if img.focal_px is not None:
            continue
        try:
            meta = extract_image_metadata(img.path)
        except OSError:
            continue
        for k, v in camera_fields(meta).items():
            setattr(img, k, v)
        if meta.lat is not None:
            img.lat, img.lon = meta.lat, meta.lon
        n += 1
    db.flush()
    return n


def backfill_gimbal_roll(db: Session, survey: models.Survey) -> int:
    """Reads GimbalRollDegree for frames ingested before it was stored; the
    mosaic needs it to place 180°-roll frames the right way up."""
    from app.services import gpu
    from app.services.metadata_service import read_dji_xmp, xmp_float

    todo = [img for img in survey.images if img.gimbal_yaw_deg is not None and img.gimbal_roll_deg is None]
    paths = [img.path for img in todo]
    n = 0
    for img, (_, xmp) in zip(todo, gpu.prefetch(paths, read_dji_xmp)):
        roll = xmp_float(xmp, "GimbalRollDegree")
        if roll is not None:
            img.gimbal_roll_deg = roll
            n += 1
    db.flush()
    return n


def classify_dji_file(path: Path) -> tuple[str | None, str]:
    """Returns (frame_key, band). Non-DJI names fall back to RGB for JPGs and
    GRAY for single-band TIFs, with no frame grouping."""
    m = DJI_FRAME_RE.match(path.name)
    if m:
        return f"{path.parent.name}:{m.group(1)}", DJI_BAND_BY_SUFFIX[m.group(2).upper()]
    return None, "RGB" if path.suffix.lower() in (".jpg", ".jpeg") else "GRAY"


def _dji_stamp(name: str) -> datetime | None:
    m = DJI_STAMP_RE.match(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%d%H%M%S")
    except ValueError:
        return None


def classify_uploaded_file(db: Session, survey: models.Survey, path: Path) -> tuple[str | None, str]:
    """classify_dji_file for browser uploads. Those all land in one folder, so
    the mission folder can't tell apart sequence numbers that restart with
    every mission (battery swap); a shutter release is instead the same
    sequence number within a few seconds."""
    m = DJI_FRAME_RE.match(path.name)
    if not m:
        return classify_dji_file(path)
    seq, band = m.group(1), DJI_BAND_BY_SUFFIX[m.group(2).upper()]
    stamp = _dji_stamp(path.name)
    if stamp is None:
        return None, band
    rows = (
        db.query(models.SurveyImage.filename, models.SurveyImage.frame_key)
        .filter(models.SurveyImage.survey_id == survey.id, models.SurveyImage.frame_key.like(f"upload:%:{seq}"))
        .all()
    )
    for filename, key in rows:
        other = _dji_stamp(filename)
        if other is not None and abs((other - stamp).total_seconds()) <= FRAME_PAIR_WINDOW_S:
            return key, band
    return f"upload:{stamp:%Y%m%d%H%M%S}:{seq}", band


def _project_flat(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * EARTH_RADIUS_M
    y = math.radians(lat - lat0) * EARTH_RADIUS_M
    return x, y


def _unproject_flat(x: float, y: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Inverse of _project_flat: (lon, lat)."""
    lat = lat0 + math.degrees(y / EARTH_RADIUS_M)
    lon = lon0 + math.degrees(x / (EARTH_RADIUS_M * math.cos(math.radians(lat0))))
    return lon, lat


def compute_boundary_and_area(
    points: list[tuple[float, float]],
    extra_points: list[tuple[float, float]] | tuple = (),
    margin_m: float = 0.0,
) -> tuple[dict | None, float | None, float, float]:
    """points: list of (lon, lat) camera positions. Returns (geojson_polygon,
    area_hectares, center_lat, center_lon). extra_points (ground control
    targets) are included in the outline but not in the centre; margin_m
    widens the outline so the targets sit inside it rather than on its edge."""
    if len(points) < 3:
        lons = [p[0] for p in points]
        lats = [p[1] for p in points]
        center_lon = sum(lons) / len(lons) if lons else 0
        center_lat = sum(lats) / len(lats) if lats else 0
        return None, None, center_lat, center_lon

    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    center_lon = sum(lons) / len(lons)
    center_lat = sum(lats) / len(lats)

    flat_points = [_project_flat(lat, lon, center_lat, center_lon) for lon, lat in [*points, *extra_points]]
    flat_hull = MultiPoint(flat_points).convex_hull
    if margin_m > 0:
        flat_hull = flat_hull.buffer(margin_m, join_style=2, mitre_limit=2.0)
    if not extra_points and margin_m <= 0:
        boundary_geojson = mapping(MultiPoint(points).convex_hull)
    else:
        boundary_geojson = mapping(Polygon([_unproject_flat(x, y, center_lat, center_lon)
                                            for x, y in flat_hull.exterior.coords]))
    area_hectares = flat_hull.area / 10000

    return boundary_geojson, round(area_hectares, 3), center_lat, center_lon


def ingest_images_from_directory(db: Session, survey: models.Survey, directory: Path) -> list[models.SurveyImage]:
    """Registers every frame file in place (no copying). Band and frame
    grouping come from the DJI filename; GPS/time from each file's own EXIF."""
    image_paths = sorted(
        p for p in directory.rglob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".tif", ".tiff")
    )

    created: list[models.SurveyImage] = []
    for path in image_paths:
        meta = extract_image_metadata(path)
        frame_key, band = classify_dji_file(path)
        img = models.SurveyImage(
            survey_id=survey.id,
            filename=path.name,
            file_path=str(path),
            band=band,
            frame_key=frame_key,
            lat=meta.lat,
            lon=meta.lon,
            altitude_m=meta.altitude_m,
            captured_at=meta.captured_at,
            width=meta.width,
            height=meta.height,
            **camera_fields(meta),
        )
        db.add(img)
        created.append(img)

    db.flush()
    survey.image_count = db.query(models.SurveyImage).filter_by(survey_id=survey.id).count()
    db.flush()
    return created


def ingest_gnss_files_from_directory(db: Session, survey: models.Survey, directory: Path) -> list[models.SurveyAsset]:
    """Registers DJI PPK/RTK sidecar files (.MRK/.nav/.obs/.bin) as assets, in
    place. They're kept for a future PPK post-processing step — nothing here
    applies corrections, so image positions stay as the EXIF GPS reported."""
    created: list[models.SurveyAsset] = []
    for path in sorted(directory.iterdir()):
        asset_type = GNSS_ASSET_TYPES.get(path.suffix.lower())
        if not asset_type:
            continue
        asset = models.SurveyAsset(
            survey_id=survey.id,
            asset_type=asset_type,
            file_path=str(path),
            format=path.suffix.lower().lstrip("."),
            source="dji_mission",
        )
        db.add(asset)
        created.append(asset)
    db.flush()
    return created


def delete_survey_files(survey: models.Survey) -> None:
    """Removes what the API wrote for the survey: uploads, quick-mosaic
    outputs, manual imports and caches. Frames and sidecars registered in
    place (DJI mission folders on the user's drive) are never touched, and
    neither are the photogrammetry/splat pipeline outputs under data/splats/
    and frontend/public/{tiles,models,splats}/<survey_id>/ — those are
    managed by the scripts that build them."""
    import shutil

    from app.config import settings

    shutil.rmtree(settings.surveys_dir / survey.id, ignore_errors=True)
    for img in survey.images:
        (settings.thumbs_cache_dir / f"{img.id}.jpg").unlink(missing_ok=True)
        (settings.band_display_cache_dir / f"{img.id}.png").unlink(missing_ok=True)
    for asset in survey.assets:
        (settings.asset_previews_cache_dir / f"{asset.id}.png").unlink(missing_ok=True)
    for p in settings.index_preview_cache_dir.glob(f"{survey.id}_*.png"):
        p.unlink(missing_ok=True)


GCP_MARGIN_M = 2.0  # ground control targets stay this far inside the field outline


def update_field_boundary_from_images(
    db: Session, field: models.Field, images: list[models.SurveyImage], gcps: list[models.GroundControlPoint] = ()
) -> None:
    """Field outline = convex hull of the camera positions, widened to take in
    the survey's ground control targets (with GCP_MARGIN_M) when it has any.
    An outline from the flight plan is the real field: it is left as it is."""
    if field.boundary_source == "flight_plan":
        return
    points = [(img.lon, img.lat) for img in images if img.lat is not None and img.lon is not None]
    if not points:
        return

    # a handheld GPS reading can be metres off: only targets found in the map and RTK points count
    extra = [(g.lon, g.lat) for g in gcps if g.source != "surveyed" or g.rtk]
    boundary, area_ha, center_lat, center_lon = compute_boundary_and_area(
        points, extra, GCP_MARGIN_M if extra else 0.0
    )
    field.boundary_geojson = json.dumps(boundary) if boundary else None
    field.area_hectares = area_ha
    field.center_lat = center_lat
    field.center_lon = center_lon
    db.flush()
