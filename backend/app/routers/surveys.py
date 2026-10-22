import json
import mimetypes
import shutil
from pathlib import Path, PurePosixPath, PureWindowsPath

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.database import get_db
from app.services import (
    flight_check_service,
    gcp_service,
    import_service,
    job_runner,
    multispectral_service,
    processing_service,
    queue_service,
    storage_service,
)
from app.services.metadata_service import extract_image_metadata
from app.services.survey_service import camera_fields, classify_uploaded_file

# every route: signed in, and a {survey_id} must be on one of the user's fields
router = APIRouter(prefix="/api/surveys", tags=["surveys"], dependencies=[Depends(auth.path_access), Depends(auth.require_consent)])

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".tif", ".tiff"}
BUSY = "This survey is being processed — wait for the current job to finish"

# 3D Tiles payloads and GeoJSON served from an import folder
ASSET_MEDIA_TYPES = {
    ".json": "application/json",
    ".geojson": "application/geo+json",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".b3dm": "application/octet-stream",
    ".i3dm": "application/octet-stream",
    ".pnts": "application/octet-stream",
    ".cmpt": "application/octet-stream",
    ".subtree": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".ktx2": "image/ktx2",
}


def _get_survey(db: Session, survey_id: str) -> models.Survey:
    survey = db.get(models.Survey, survey_id)
    if not survey:
        raise HTTPException(404, "Survey not found")
    return survey


def _safe_filename(name: str | None) -> str:
    """Base name only — a client-supplied '../../x' or 'C:\\x' never picks the directory."""
    base = PurePosixPath(PureWindowsPath(name or "").name).name
    if base in ("", ".", ".."):
        raise HTTPException(400, f"Invalid file name: {name!r}")
    return base


def _upload_size(upload: UploadFile) -> int:
    if upload.size is not None:
        return upload.size
    upload.file.seek(0, 2)
    size = upload.file.tell()
    upload.file.seek(0)
    return size


@router.get("", response_model=list[schemas.SurveyOut])
def list_surveys(user: models.User = Depends(auth.current_user), db: Session = Depends(get_db)):
    field_ids = auth.visible_fields(db, user).with_entities(models.Field.id)
    return db.query(models.Survey).filter(models.Survey.field_id.in_(field_ids)).all()


@router.post("", response_model=schemas.SurveyOut)
def create_survey(payload: schemas.SurveyCreate, user: models.User = Depends(auth.current_user),
                  db: Session = Depends(get_db)):
    field = auth.visible_field(db, user, payload.field_id)

    survey = models.Survey(
        field_id=field.id,
        name=payload.name,
        drone_model=payload.drone_model,
        status="PENDING",
    )
    db.add(survey)
    db.flush()
    processing_service.create_job(db, survey)
    db.commit()
    db.refresh(survey)
    return survey


@router.post("/{survey_id}/images", response_model=list[schemas.SurveyImageOut])
def upload_survey_images(survey_id: str, files: list[UploadFile], db: Session = Depends(get_db)):
    """Adds drone images to a survey. Send large flights in batches; a file that
    is already registered (same name and size) is skipped, so an interrupted
    upload can simply be retried."""
    survey = _get_survey(db, survey_id)
    if processing_service.is_running(processing_service.latest_job(survey)):
        raise HTTPException(409, BUSY)

    dest_dir = storage_service.survey_dir(survey.id) / "rgb"
    dest_dir.mkdir(parents=True, exist_ok=True)
    registered = {img.filename: img for img in survey.images}

    created: list[models.SurveyImage] = []
    for upload in files:
        name = _safe_filename(upload.filename)
        if Path(name).suffix.lower() not in IMAGE_SUFFIXES:
            raise HTTPException(400, f"{name}: only JPG and TIFF drone images can be uploaded here")
        prior = registered.get(name)
        if prior is not None:
            if prior.path.exists() and prior.path.stat().st_size == _upload_size(upload):
                continue
            dest_path = storage_service.unique_path(dest_dir / name)
        else:
            dest_path = dest_dir / name  # an unregistered file here is a leftover of a failed batch
        with dest_path.open("wb") as f:
            shutil.copyfileobj(upload.file, f)

        try:
            meta = extract_image_metadata(dest_path)
        except (OSError, ValueError, SyntaxError) as exc:
            dest_path.unlink(missing_ok=True)
            raise HTTPException(400, f"{name} is not a readable image: {exc}") from exc
        frame_key, band = classify_uploaded_file(db, survey, dest_path)
        img = models.SurveyImage(
            survey_id=survey.id,
            filename=dest_path.name,
            file_path=str(dest_path),
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
        db.flush()  # later files of this batch pair with it by frame key
        registered[img.filename] = img
        created.append(img)
        if not survey.drone_model and meta.model:
            # farmers need not know their drone's model name: the photos carry it
            survey.drone_model = " ".join(str(v).strip() for v in (meta.make, meta.model) if v).strip() or None

    survey.image_count = db.query(models.SurveyImage).filter_by(survey_id=survey.id).count()
    dates = [img.captured_at for img in created if img.captured_at]
    if survey.survey_date is None and dates:
        survey.survey_date = min(dates)
    if created:
        survey.status = "UPLOADING"
        job = processing_service.latest_job(survey)
        if job is not None and job.status == "PENDING":
            job.status = "UPLOADING"
    db.commit()
    for img in created:
        db.refresh(img)
    return created


@router.post("/{survey_id}/assets", response_model=schemas.SurveyAssetOut, dependencies=[Depends(auth.require_staff)])
def upload_survey_asset(survey_id: str, asset_type: str, file: UploadFile, db: Session = Depends(get_db)):
    """Manual import of processed data — GeoTIFF rasters, GeoJSON, 3D Tiles
    (.zip) and LAS/LAZ point clouds. Only georeferenced files are accepted
    (see import_service); the 422 message says what to export instead."""
    survey = _get_survey(db, survey_id)
    name = _safe_filename(file.filename)
    try:
        asset = import_service.import_asset(db, survey, asset_type, name, file.file)
    except import_service.ImportRejected as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    db.commit()
    db.refresh(asset)
    return asset


@router.post("/{survey_id}/process", response_model=schemas.ProcessingJobOut, status_code=202)
def trigger_processing(survey_id: str, db: Session = Depends(get_db)):
    """Queues the full pipeline (field boundary, quick mosaic + tile pyramid,
    analysis) on the background worker. Poll GET /api/surveys/{id}/job."""
    survey = _get_survey(db, survey_id)
    if not survey.images:
        raise HTTPException(422, "Upload drone images before processing")
    job = processing_service.latest_job(survey)
    unstarted = job is not None and job.status in ("PENDING", "UPLOADING") and processing_service.is_full_pipeline(job)
    try:
        job = job_runner.enqueue(
            db, survey, processing_service.STEPS, processing_service.run_full_pipeline, job if unstarted else None
        )
    except job_runner.JobAlreadyRunning as exc:
        raise HTTPException(409, BUSY) from exc
    return processing_service.job_to_dict(job)


@router.post("/{survey_id}/mosaic", response_model=schemas.ProcessingJobOut, status_code=202,
             dependencies=[Depends(auth.require_staff)])
def rebuild_mosaic(survey_id: str, db: Session = Depends(get_db)):
    """Queues a rebuild of the direct-georeferencing quick mosaics (RGB, plus
    NDVI/NDRE/GNDVI when the bands exist), their tile pyramids, and the analysis."""
    survey = _get_survey(db, survey_id)
    try:
        job = job_runner.enqueue(db, survey, processing_service.MOSAIC_STEPS, processing_service.run_mosaic_job)
    except job_runner.JobAlreadyRunning as exc:
        raise HTTPException(409, BUSY) from exc
    return processing_service.job_to_dict(job)


@router.post("/{survey_id}/detailed", response_model=schemas.ProcessingJobOut, status_code=202)
def make_detailed_map(survey_id: str, db: Session = Depends(get_db)):
    """Queues the detailed map (OpenDroneMap, hours) — again after a failure, or
    for a flight from before it was switched on. It also starts by itself after
    every quick map."""
    from app.config import settings
    from app.services import odm_service

    if not settings.odm_enabled:
        raise HTTPException(409, "Detailed maps are not switched on on this server")
    survey = _get_survey(db, survey_id)
    if len(odm_service.photos(survey)) < settings.odm_min_photos:
        raise HTTPException(422, f"A detailed map needs at least {settings.odm_min_photos} photos with a GPS position")
    try:
        job = job_runner.enqueue_detailed(db, survey)
    except job_runner.JobAlreadyRunning as exc:
        raise HTTPException(409, BUSY) from exc
    return processing_service.job_to_dict(job)


def _flight_centre(survey: models.Survey) -> tuple[float, float] | None:
    pts = [(i.lat, i.lon) for i in survey.images if i.lat is not None and i.lon is not None]
    if pts:
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    f = survey.field
    return (f.center_lat, f.center_lon) if f and f.center_lat is not None else None


@router.post("/gcp-file/check")
def check_gcp_file(file: UploadFile, epsg: str | None = Form(None), field_id: str | None = Form(None),
                   user: models.User = Depends(auth.current_user), db: Session = Depends(get_db)):
    """Reads a GCP file before there is a flight to attach it to (the upload page):
    what it contains, or why it cannot be used. `field_id`: compare with that field."""
    from app.services import gcp_file_service

    near = None
    if field_id:
        field = auth.visible_field(db, user, field_id)
        if field.center_lat is not None:
            near = (field.center_lat, field.center_lon)
    try:
        parsed = gcp_file_service.parse(file.file.read(), epsg, near)
        if near:
            gcp_file_service.check_near(parsed.points, *near)
    except gcp_file_service.GcpFileError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"format": parsed.format, "crs": parsed.crs, "rtk": False, "notes": parsed.notes,
            "odm_observations": parsed.odm_observations,
            "points": [{"name": p.name, "lat": p.lat, "lon": p.lon, "elevation_m": p.elevation_m} for p in parsed.points]}


@router.post("/{survey_id}/gcp-file")
def upload_gcp_file(survey_id: str, file: UploadFile, rtk: bool = Form(False), epsg: str | None = Form(None),
                    dry_run: bool = Form(False), db: Session = Depends(get_db)):
    """The surveyed positions of the flight's ground targets (CSV or
    OpenDroneMap gcp_list.txt — see gcp_file_service). With `dry_run` only
    reads and checks the file. Otherwise replaces the flight's surveyed points
    and, when it has a detailed map, lines that map up with them (RTK) or
    compares (handheld) in a background job."""
    from app.services import gcp_correction_service, gcp_file_service

    survey = _get_survey(db, survey_id)
    near = _flight_centre(survey)
    try:
        parsed = gcp_file_service.parse(file.file.read(), epsg, near)
        if near:
            gcp_file_service.check_near(parsed.points, *near)
    except gcp_file_service.GcpFileError as exc:
        raise HTTPException(422, str(exc)) from exc
    out = {
        "format": parsed.format, "crs": parsed.crs, "rtk": rtk, "notes": parsed.notes,
        "odm_observations": parsed.odm_observations, "queued": False,
        "points": [{"name": p.name, "lat": p.lat, "lon": p.lon, "elevation_m": p.elevation_m} for p in parsed.points],
    }
    if dry_run:
        return out
    if processing_service.is_running(processing_service.latest_job(survey)):
        raise HTTPException(409, BUSY)

    for old in [g for g in survey.gcps if g.source == "surveyed"]:
        db.delete(old)
    for p in parsed.points:
        db.add(models.GroundControlPoint(survey_id=survey.id, name=p.name, lat=p.lat, lon=p.lon,
                                         height_m=p.elevation_m, source="surveyed", rtk=rtk))
    folder = storage_service.survey_dir(survey.id) / "gcp"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    file.file.seek(0)
    (folder / ("gcp_list.txt" if parsed.format == "odm" else _safe_filename(file.filename))).write_bytes(file.file.read())
    (folder / "gcp.json").write_text(json.dumps({k: v for k, v in out.items() if k != "queued"}
                                                | {"filename": file.filename}, indent=2))
    db.commit()
    db.refresh(survey)
    if gcp_correction_service.correctable(survey):
        job_runner.enqueue(db, survey, processing_service.GCP_STEPS, processing_service.run_gcp_job)
        out["queued"] = True
    return out


@router.delete("/{survey_id}/gcp-file")
def delete_gcp_file(survey_id: str, db: Session = Depends(get_db)):
    """Forgets the surveyed points; a map moved onto them goes back to where it was made."""
    from app.services import gcp_correction_service

    survey = _get_survey(db, survey_id)
    if processing_service.is_running(processing_service.latest_job(survey)):
        raise HTTPException(409, BUSY)
    for old in [g for g in survey.gcps if g.source == "surveyed"]:
        db.delete(old)
    folder = storage_service.survey_dir(survey.id) / "gcp"
    if folder.exists():
        shutil.rmtree(folder)
    db.commit()
    db.refresh(survey)
    gcp_correction_service.report_path(survey).unlink(missing_ok=True)
    queued = bool(gcp_correction_service.correctable(survey))
    if queued:
        job_runner.enqueue(db, survey, processing_service.GCP_STEPS, processing_service.run_gcp_job)
    return {"deleted": True, "queued": queued}


@router.get("/{survey_id}/gcp-check")
def get_gcp_check(survey_id: str, db: Session = Depends(get_db)):
    """The flight's GCP file (what was read from it) and how the map compares with it."""
    from app.services import gcp_correction_service

    survey = _get_survey(db, survey_id)
    meta = storage_service.survey_dir(survey.id) / "gcp" / "gcp.json"
    return {
        "file": json.loads(meta.read_text()) if meta.exists() else None,
        "report": gcp_correction_service.load_report(survey),
    }


@router.get("/{survey_id}/flight-check", response_model=schemas.FlightCheckOut)
def get_flight_check(survey_id: str, db: Session = Depends(get_db)):
    """How the flight was flown (height, overlap, camera angle, sun, …) and what
    to change next time. Advice only: it never holds up processing."""
    from app.services import weather_service

    survey = _get_survey(db, survey_id)
    weather, pending = weather_service.flight_weather(survey)
    return {**flight_check_service.check(list(survey.images), survey.field, weather), "pending": pending}


@router.get("/{survey_id}/job", response_model=schemas.ProcessingJobOut | None)
def get_latest_job(survey_id: str, db: Session = Depends(get_db)):
    job = processing_service.latest_job(_get_survey(db, survey_id))
    if job is None:
        return None
    return {**processing_service.job_to_dict(job), "queue": queue_service.position(db, job)}


@router.get("/{survey_id}", response_model=schemas.SurveyOut)
def get_survey(survey_id: str, db: Session = Depends(get_db)):
    return _get_survey(db, survey_id)


@router.delete("/{survey_id}")
def delete_survey(survey_id: str, db: Session = Depends(get_db)):
    """Deletes the survey, its analysis and everything the app generated for
    it. Drone frames registered in place on the user's drive are left alone."""
    from app.services.survey_service import delete_survey_files

    survey = _get_survey(db, survey_id)
    if processing_service.is_running(processing_service.latest_job(survey)):
        raise HTTPException(409, BUSY)
    delete_survey_files(survey)
    db.delete(survey)
    db.commit()
    return {"deleted": survey_id}


@router.get("/{survey_id}/images", response_model=list[schemas.SurveyImageOut])
def list_survey_images(survey_id: str, db: Session = Depends(get_db)):
    return _get_survey(db, survey_id).images


@router.get("/{survey_id}/images/{image_id}/thumbnail")
def get_image_thumbnail(survey_id: str, image_id: str, db: Session = Depends(get_db)):
    image = _get_image(db, survey_id, image_id)
    try:
        thumb_path = storage_service.get_or_create_thumbnail(image.id, image.file_path)
    except OSError as exc:
        raise HTTPException(503, f"Source file unreadable (disk error?): {exc}") from exc
    return FileResponse(thumb_path, media_type="image/jpeg")


def _get_image(db: Session, survey_id: str, image_id: str) -> models.SurveyImage:
    image = db.get(models.SurveyImage, image_id)
    if not image or image.survey_id != survey_id:
        raise HTTPException(404, "Image not found")
    if not storage_service.file_exists(image.file_path):
        raise HTTPException(404, "Source file missing on disk")
    return image


@router.get("/{survey_id}/images/{image_id}/file")
def get_image_file(survey_id: str, image_id: str, db: Session = Depends(get_db)):
    """Original bytes (download). 16-bit band TIFs aren't browser-viewable — use /display."""
    image = _get_image(db, survey_id, image_id)
    is_tif = image.file_path.lower().endswith((".tif", ".tiff"))
    return FileResponse(str(image.path), media_type="image/tiff" if is_tif else "image/jpeg", filename=image.filename)


@router.get("/{survey_id}/images/{image_id}/display")
def get_image_display(survey_id: str, image_id: str, db: Session = Depends(get_db)):
    """Browser-viewable rendition: JPGs pass through; 16-bit band TIFs are
    percentile-stretched to 8-bit grayscale PNG (cached)."""
    image = _get_image(db, survey_id, image_id)
    if not image.file_path.lower().endswith((".tif", ".tiff")):
        return FileResponse(str(image.path), media_type="image/jpeg")

    from app.config import settings

    cache_path = settings.band_display_cache_dir / f"{image.id}.png"
    if not cache_path.exists():
        try:
            storage_service.write_atomic(cache_path, multispectral_service.render_band_display_png(image.path))
        except OSError as exc:
            raise HTTPException(503, f"Source file unreadable (disk error?): {exc}") from exc
    return FileResponse(cache_path, media_type="image/png")


@router.get("/{survey_id}/frames/{frame_key}/index/{index}")
def get_frame_index_preview(survey_id: str, frame_key: str, index: str, db: Session = Depends(get_db)):
    """Colorized NDVI/NDRE/GNDVI computed from the frame's real multispectral
    bands (see multispectral_service). 404 if the frame lacks the bands."""
    survey = _get_survey(db, survey_id)
    if index not in multispectral_service.INDEX_BANDS:
        raise HTTPException(400, f"Unknown index '{index}'")

    from app.config import settings

    # frame keys contain ':' (folder:sequence), which exFAT/NTFS drives reject in filenames
    cache_path = settings.index_preview_cache_dir / f"{survey_id}_{frame_key.replace(':', '_')}_{index}.png"
    if not cache_path.exists():
        bands = multispectral_service.frame_band_paths(survey.images, frame_key)
        try:
            storage_service.write_atomic(cache_path, multispectral_service.render_index_preview_png(bands, index))
        except multispectral_service.BandsUnavailableError as exc:
            raise HTTPException(404, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(503, f"Band file unreadable (disk error?): {exc}") from exc
    return FileResponse(cache_path, media_type="image/png")


@router.get("/{survey_id}/assets", response_model=list[schemas.SurveyAssetOut])
def list_survey_assets(survey_id: str, db: Session = Depends(get_db)):
    return _get_survey(db, survey_id).assets


@router.get("/{survey_id}/assets/{asset_id}/preview")
def get_asset_preview(survey_id: str, asset_id: str, db: Session = Depends(get_db)):
    """Renders a GeoTIFF asset (orthomosaic/NDVI/NDRE/etc.) to a browser-friendly
    PNG covering the exact same bounds as the asset's bounds_geojson, cached on
    first request. Cesium places it with SingleTileImageryProvider + Rectangle."""
    asset = db.get(models.SurveyAsset, asset_id)
    if not asset or asset.survey_id != survey_id:
        raise HTTPException(404, "Asset not found")
    if asset.format not in ("tif", "tiff"):
        raise HTTPException(400, "Preview is only available for GeoTIFF assets")
    if not storage_service.file_exists(asset.file_path):
        raise HTTPException(404, "Source file missing on disk")

    from app.config import settings
    from app.services.orthomosaic_service import RasterioUnavailableError, generate_preview_png

    cache_path = settings.asset_previews_cache_dir / f"{asset.id}.png"
    if not cache_path.exists():
        try:
            png_bytes, _ = generate_preview_png(asset.path, asset.asset_type)
        except RasterioUnavailableError as exc:
            raise HTTPException(500, str(exc)) from exc
        storage_service.write_atomic(cache_path, png_bytes)
    return FileResponse(cache_path, media_type="image/png")


@router.api_route("/{survey_id}/assets/{asset_id}/files/{file_path:path}", methods=["GET", "HEAD"])
def get_asset_file(survey_id: str, asset_id: str, file_path: str, db: Session = Depends(get_db)):
    """Serves a manual import's files — 3D Tiles content (tileset.json and the
    tiles it references) and GeoJSON — so the viewer can stream them."""
    asset = db.get(models.SurveyAsset, asset_id)
    if not asset or asset.survey_id != survey_id:
        raise HTTPException(404, "Asset not found")
    root = storage_service.asset_import_dir(survey_id, asset_id).resolve()
    target = (root / file_path).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(404, "File not found")
    media_type = ASSET_MEDIA_TYPES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0]
    return FileResponse(target, media_type=media_type or "application/octet-stream")


@router.delete("/{survey_id}/assets/{asset_id}", dependencies=[Depends(auth.require_staff)])
def delete_survey_asset(survey_id: str, asset_id: str, db: Session = Depends(get_db)):
    asset = db.get(models.SurveyAsset, asset_id)
    if not asset or asset.survey_id != survey_id:
        raise HTTPException(404, "Asset not found")

    from app.config import settings

    # Only ever delete bytes we copied into our own data dir. Assets registered
    # in place (DJI mission folders, seeded imagery) point at the user's
    # original files — unregister them, never unlink them.
    import_dir = storage_service.asset_import_dir(survey_id, asset_id)
    if import_dir.is_dir():
        shutil.rmtree(import_dir)
    else:
        path = asset.path.resolve()
        if path.is_relative_to(settings.surveys_dir.resolve()):
            path.unlink(missing_ok=True)
    (settings.asset_previews_cache_dir / f"{asset.id}.png").unlink(missing_ok=True)
    db.delete(asset)
    db.commit()
    return {"deleted": asset_id}


@router.get("/{survey_id}/availability", response_model=schemas.SurveyAssetsAvailability)
def get_survey_availability(survey_id: str, db: Session = Depends(get_db)):
    survey = _get_survey(db, survey_id)

    asset_types = {a.asset_type for a in survey.assets}
    bands = {img.band for img in survey.images}
    has_gps = any(img.lat is not None for img in survey.images)

    return schemas.SurveyAssetsAvailability(
        rgb_images=any(img.band == "RGB" for img in survey.images),
        gps_metadata=has_gps,
        multispectral=bool(bands & {"GREEN", "RED", "RED_EDGE", "NIR"}),
        nir="NIR" in bands,
        red_edge="RED_EDGE" in bands,
        thermal="THERMAL" in bands,
        orthomosaic="orthomosaic" in asset_types,
        model_3d=bool(asset_types & {"model3d", "tileset"}),
        pointcloud=bool(asset_types & {"pointcloud", "pointcloud_laz"}),
        gnss_ppk=any(t.startswith("gnss_") for t in asset_types),
        dsm="dsm" in asset_types,
        vector_overlays="geojson" in asset_types,
    )


@router.get("/{survey_id}/gcps", response_model=list[schemas.GroundControlPointOut])
def list_ground_control_points(survey_id: str, db: Session = Depends(get_db)):
    """The survey's ground control targets and markers (found in its photogrammetric orthophoto)."""
    return sorted(_get_survey(db, survey_id).gcps, key=gcp_service.sort_key)


@router.get("/{survey_id}/field-boundary")
def get_field_boundary(survey_id: str, db: Session = Depends(get_db)):
    """Convenience endpoint returning the parent field's boundary for this survey."""
    field = _get_survey(db, survey_id).field
    return {
        "field_id": field.id,
        "boundary": json.loads(field.boundary_geojson) if field.boundary_geojson else None,
        "center_lat": field.center_lat,
        "center_lon": field.center_lon,
        "area_hectares": field.area_hectares,
    }
