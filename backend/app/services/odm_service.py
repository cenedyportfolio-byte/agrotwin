"""The detailed map: OpenDroneMap (true photogrammetry) run in Docker on a
survey's RGB photos, then imported as survey assets that the viewer, the
tiles and the analysis rank above the quick direct-georeferenced mosaics.

ODM (opendronemap/odm) writes into the survey's project folder
(surveys/<id>/odm, mounted as /datasets/code in the container):
    odm_orthophoto/odm_orthophoto.tif     true orthophoto, RGBA, native GSD
    odm_dem/dsm.tif, odm_dem/dtm.tif       surface / bare-earth models
    odm_texturing/odm_textured_model_geo.obj  textured true-3D reality mesh
    odm_georeferencing/odm_georeferenced_model.laz  dense MVS point cloud
    cameras.json, odm_report/shots.geojson  the camera solution the band
                                            orthophotos are built on

The run takes hours on CPU, so it is its own job after the quick map (see
processing_service.run_detailed_pipeline) and the farmer works with the quick
map meanwhile. A run that was interrupted resumes: ODM skips the stages
whose outputs already exist.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

from sqlalchemy.orm import Session

from app import models
from app.config import AGROTWIN_ROOT, settings

log = logging.getLogger(__name__)

SOURCE = "photogrammetry_odm"
PUBLIC_MODELS = AGROTWIN_ROOT / "frontend" / "public" / "models"

# ODM's stages in order, with what a farmer would call them
STAGES = [
    ("dataset", "reading the photos"),
    ("split", "reading the photos"),
    ("merge", "reading the photos"),
    ("opensfm", "matching the photos"),
    ("openmvs", "building the 3D surface"),
    ("odm_filterpoints", "building the 3D surface"),
    ("odm_meshing", "building the 3D surface"),
    ("mvs_texturing", "colouring the surface"),
    ("odm_georeferencing", "placing it on the map"),
    ("odm_dem", "measuring the ground height"),
    ("odm_orthophoto", "drawing the map"),
    ("odm_report", "finishing"),
    ("odm_postprocess", "finishing"),
]
_STAGE_LINE = re.compile(r"Running (\w+) stage")
# what ODM prints when the photos themselves cannot make a map
_NOT_ENOUGH_OVERLAP = ("No reconstructions", "Not enough", "reconstruction.json does not exist", "too few")


class OdmUnavailable(RuntimeError):
    """Docker or the ODM image is missing on this machine."""


def project_dir(survey_id: str) -> Path:
    return settings.surveys_dir / survey_id / "odm"


def has_detailed_map(survey: models.Survey) -> bool:
    return any(a.source == SOURCE and a.asset_type == "orthomosaic" for a in survey.assets)


def photos(survey: models.Survey) -> list[models.SurveyImage]:
    """The RGB photos ODM works on: GPS-tagged and still on disk. Multispectral
    bands are not given to ODM — they are mapped afterwards on its cameras."""
    return [img for img in survey.images if img.band == "RGB" and img.lat is not None and img.path.exists()]


def wants_detailed_map(survey: models.Survey) -> bool:
    return settings.odm_enabled and not has_detailed_map(survey) and len(photos(survey)) >= settings.odm_min_photos


def odm_args(images: list[models.SurveyImage]) -> list[str]:
    """ODM options: those of the Ditty Road run that the band orthophotos were
    validated on, with medium point-cloud quality to halve the meshing time."""
    args = ["--dsm", "--dtm", "--orthophoto-resolution", "1", "--dem-resolution", "5",
            "--feature-quality", "high", "--pc-quality", "medium", "--skip-report", "--optimize-disk-space"]
    if not settings.odm_build_3d:
        args.append("--skip-3dmodel")
    # RTK-fixed positions are good to a few cm: tell ODM, or it treats them as metre-level GPS
    fixed = sum(1 for img in images if img.rtk_fix == "FIXED")
    if images and fixed >= 0.8 * len(images):
        args += ["--gps-accuracy", "0.05"]
    return args


def prepare(survey: models.Survey) -> tuple[Path, list[models.SurveyImage]]:
    """The project folder with the photos in images/ (hard links when the
    survey's files are on the same disk, copies otherwise)."""
    project = project_dir(survey.id)
    images_dir = project / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    chosen = photos(survey)
    wanted = {img.filename for img in chosen}
    for stale in images_dir.iterdir():
        if stale.name not in wanted:
            stale.unlink()
    for img in chosen:
        dst = images_dir / img.filename
        if dst.exists() and dst.stat().st_size == img.path.stat().st_size:
            continue
        dst.unlink(missing_ok=True)
        try:
            os.link(img.path, dst)
        except OSError:
            shutil.copy2(img.path, dst)
    return project, chosen


def docker_command(survey_id: str, project: Path, args: list[str]) -> list[str]:
    cmd = ["docker", "run", "--rm", "--name", f"agrotwin-odm-{survey_id}"]
    if settings.odm_gpus:
        cmd += ["--gpus", "all"]
    return cmd + ["-v", f"{project.resolve()}:/datasets/code", settings.odm_image, "--project-path", "/datasets", *args]


def run(survey: models.Survey, project: Path, args: list[str], on_stage: Callable[[int, int, str], None]) -> None:
    """Runs ODM on the project folder, reporting each stage as (number, of, words).
    Its full output goes to <project>/agrotwin_odm.log. Raises
    processing_service.FlightProblem when the photos cannot make a map."""
    from app.services.processing_service import FlightProblem

    if shutil.which("docker") is None:
        raise OdmUnavailable("Docker is not installed on this server")
    log_path = project / "agrotwin_odm.log"
    cmd = docker_command(survey.id, project, args)
    log.info("odm: %s", " ".join(cmd))
    stage_keys = [k for k, _ in STAGES]
    tail: list[str] = []
    deadline = time.monotonic() + settings.odm_timeout_hours * 3600
    with log_path.open("a") as out:
        out.write(f"\n==== {time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(cmd)}\n")
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                out.write(line)
                tail = (tail + [line.rstrip()])[-40:]
                m = _STAGE_LINE.search(line)
                if m and m.group(1) in stage_keys:
                    i = stage_keys.index(m.group(1))
                    on_stage(i + 1, len(STAGES), STAGES[i][1])
                if time.monotonic() > deadline:
                    _stop(survey.id)
                    raise RuntimeError(f"ODM took longer than {settings.odm_timeout_hours} h and was stopped")
            code = proc.wait()
        finally:
            if proc.poll() is None:
                _stop(survey.id)
                proc.kill()
            _give_back(project)
    if code != 0:
        text = "\n".join(tail)
        if code == 125:  # docker itself failed: no image, no daemon, a bad option
            raise OdmUnavailable(f"docker could not start {settings.odm_image}: {text[-500:]}")
        if any(s in text for s in _NOT_ENOUGH_OVERLAP):
            raise FlightProblem(
                "The photos do not overlap enough to build a detailed map (the quick map is still there). Next time, "
                "fly a mapping mission with 80% front and 75% side overlap — see How to fly.",
                detail=text[-1500:],
            )
        raise RuntimeError(f"ODM exited with {code}: {text[-1500:]}")
    if not (project / "odm_orthophoto" / "odm_orthophoto.tif").exists():
        raise RuntimeError("ODM finished without an orthophoto")


def _stop(survey_id: str) -> None:
    subprocess.run(["docker", "kill", f"agrotwin-odm-{survey_id}"], capture_output=True, timeout=60)


def _give_back(project: Path) -> None:
    """ODM runs as root in its container: hand its files to the server's user,
    so the app can later read, replace and delete them."""
    if os.name != "posix" or not project.exists():
        return
    uid, gid = os.getuid(), os.getgid()
    if uid == 0:
        return
    subprocess.run(["docker", "run", "--rm", "-v", f"{project.resolve()}:/p", "--entrypoint", "chown",
                    settings.odm_image, "-R", f"{uid}:{gid}", "/p"], capture_output=True, timeout=600)


# ---------------------------------------------------------------------------
# importing a finished run
# ---------------------------------------------------------------------------


def _register(db: Session, survey: models.Survey, asset_type: str, path: Path, fmt: str, bounds: dict | None):
    # replace only the same kind of file: a raster's "xyz" tile pyramid is a separate row
    for old in [a for a in survey.assets if a.asset_type == asset_type and a.source == SOURCE and (a.format or "") == fmt]:
        db.delete(old)
    db.flush()
    asset = models.SurveyAsset(
        survey_id=survey.id, asset_type=asset_type, file_path=str(path), format=fmt,
        bounds_geojson=json.dumps(bounds) if bounds else None, source=SOURCE,
    )
    db.add(asset)
    db.flush()
    log.info("odm: registered %s -> %s", asset_type, path)
    return asset


def _ground_h(dtm_path: Path, field: models.Field) -> float | None:
    """Height of the field's ground in the ODM products' own vertical datum:
    median DTM value at the field centre and boundary vertices (the same
    points the viewer samples on the global terrain, so the two heights
    describe the same ground and their difference is the lift to apply)."""
    import numpy as np
    import rasterio
    from rasterio.warp import transform

    pts = [(field.center_lon, field.center_lat)]
    if field.boundary_geojson:
        geom = json.loads(field.boundary_geojson)
        if geom.get("type") == "Polygon":
            pts += [(x, y) for x, y in geom["coordinates"][0]]
    with rasterio.open(dtm_path) as src:
        xs, ys = transform("EPSG:4326", src.crs, [p[0] for p in pts], [p[1] for p in pts])
        vals = [v[0] for v in src.sample(zip(xs, ys))]
        nodata = src.nodata
    vals = [float(v) for v in vals if np.isfinite(v) and (nodata is None or v != nodata)]
    return float(np.median(vals)) if vals else None


def import_run(db: Session, survey: models.Survey, odm: Path | None = None, *, tiles: bool = True,
               mesh: bool = True) -> None:
    """Registers a finished ODM run's orthophoto, DSM and DTM (and, with
    `mesh`, the reality mesh and point cloud tiled for the 3D view), then
    builds the map tile pyramids. The band orthophotos and GCP targets are
    processing_service.build_photogrammetry_products' job."""
    from app.services.orthomosaic_service import extract_bounds_geojson
    from app.services.tile_service import build_survey_tiles

    odm = odm or project_dir(survey.id)
    out = settings.surveys_dir / survey.id / "outputs"
    out.mkdir(parents=True, exist_ok=True)
    rasters = {
        "orthomosaic": odm / "odm_orthophoto" / "odm_orthophoto.tif",
        "dsm": odm / "odm_dem" / "dsm.tif",
        "dtm": odm / "odm_dem" / "dtm.tif",
    }
    for asset_type, src in rasters.items():
        if not src.exists():
            log.warning("odm: missing %s", src)
            continue
        dst = out / f"{asset_type}_odm.tif"
        shutil.copy2(src, dst)
        _register(db, survey, asset_type, dst, "tif", extract_bounds_geojson(dst))

    ground_h = _ground_h(rasters["dtm"], survey.field) if rasters["dtm"].exists() else None
    log.info("odm: ground height in ODM datum: %s", ground_h)
    mesh_ts = PUBLIC_MODELS / survey.id / "odm-model" / "tileset.json"
    if mesh and (odm / "odm_texturing" / "odm_textured_model_geo.obj").exists():
        from scripts.tile_mesh import build as tile_mesh

        mesh_ts = tile_mesh(survey.id, depth=3, tex_px=2048, draco=False, ground_h=ground_h)
    if mesh_ts.exists():
        _register(db, survey, "model3d", mesh_ts, "json", None)
    laz = odm / "odm_georeferencing" / "odm_georeferenced_model.laz"
    if mesh and laz.exists():
        from scripts.tile_points import build as tile_points

        _register(db, survey, "pointcloud", tile_points(survey.id, 5_000_000, ground_h), "json", None)
    if laz.exists():
        _register(db, survey, "pointcloud_laz", laz, "laz", None)

    db.commit()
    db.refresh(survey)
    if tiles:
        build_survey_tiles(db, survey, ("orthomosaic", "dsm", "dtm"))
        db.commit()
