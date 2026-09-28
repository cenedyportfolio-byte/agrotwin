"""Agricultural analysis generation — computed from the survey's own imagery.

Measurement, chosen per survey by what exists (never mixed in one result):

- method="ndvi_map": a georeferenced NDVI mosaic exists. The field is gridded
  into 5 m cells measured in map space — one measurement per patch of ground,
  so overlapping photos don't over-sample anything and the tier shares are
  true area percentages.
- method="exg_map": an RGB-only survey with an RGB orthomosaic. Same 5 m
  cells, vegetation classified per pixel with the Excess Green Index.
- method="ndvi": multispectral frames but no NDVI mosaic — one sample per frame.
- method="exg": RGB frames but no orthomosaic — one sample per frame.

Per-frame stats are always persisted on the frames (they drive the Crop
Density point layer).

Tiers. Each cell's (or frame's) vegetation cover is compared with the cover
the field's own best-developed ground reaches — its 90th percentile, i.e.
what this crop achieves here at this growth stage and in this light:
    healthy     >= 80 % of that reference
    attention   50–80 %
    problem     <  50 %
A uniform field therefore reads mostly healthy and a patchy one does not; the
shares are measured, not fixed by construction. Because the reference adapts
to growth stage, two surveys are only loosely comparable — the method is
recorded on every result so the UI and assistant can say so.

Nothing here is randomly generated. If there isn't enough real data,
`analyze_survey` returns None and writes nothing.

Neither index identifies weed species, disease, or pest damage. Zones are
labeled only by measurable characteristics (bare soil / low crop density /
patchy vegetation), never by diagnosis.

On top of the tiers, a map-space result also records (result.metrics_json):
- row geometry and canopy closure from weed_service (row spacing/bearing,
  vegetation cover between rows) and, only while rows are separable,
  inter-row vegetation as "weed_candidate" zones for a scout to check;
- what trained detectors (detector_service) ran — none unless a model is
  installed under data/models/;
- a "vegetation_mask" raster asset showing exactly which pixels the
  analysis counted as vegetation.
"""

import json
import logging
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from shapely.geometry import Point, box, mapping, shape
from shapely.ops import unary_union
from sqlalchemy.orm import Session

from app import models
from app.services import gpu, multispectral_service
from app.services.vision_service import VEGETATION_THRESHOLD

# ~5 m square footprint per frame sample (degrees at mid-latitude). Photos on
# the same flight line overlap heavily, so neighbouring flagged frames merge
# into one contiguous zone instead of a scatter of separate dots.
ZONE_BUFFER_DEG = 0.00004

CELL_M = 5.0  # map-space analysis cell size (metres)
MIN_VALID_FRACTION = 0.5  # a cell needs this much raster coverage to count
READ_STRIP_PX = 2048  # rows of raster read at once

REFERENCE_PERCENTILE = 90
HEALTHY_RATIO = 0.8
PROBLEM_RATIO = 0.5
SEVERE_RATIO = 0.25
MIN_REFERENCE_COVER = 0.05  # below this nothing is growing anywhere; don't rescale noise

SAFE_ACTIONS = {
    "bare_soil": "Inspect area for emergence issues",
    "low_crop_density": "Ground inspection recommended",
    "patchy_vegetation": "Uneven vegetation detected — compare with previous survey",
    "weed_candidate": "Scout for weeds — vegetation between crop rows (species not identified)",
}
MODEL_ACTION = "Ground-check this model detection before acting on it"
WEED_CANDIDATE_CONFIDENCE = 0.6  # inter-row vegetation is a candidate, not an identification

SOURCE_RANK = {"photogrammetry_odm": 0, "direct_georeferencing": 1, "manual_import": 2}

log = logging.getLogger(__name__)

Sample = tuple[models.SurveyImage, float]  # (anchor image with GPS, vegetation_fraction)


@dataclass
class Tiers:
    ratio: np.ndarray  # cover / reference cover
    healthy: np.ndarray
    attention: np.ndarray
    problem: np.ndarray


def tier_cover(fractions: np.ndarray) -> Tiers:
    reference = max(float(np.percentile(fractions, REFERENCE_PERCENTILE)), MIN_REFERENCE_COVER)
    ratio = fractions / reference
    healthy = ratio >= HEALTHY_RATIO
    problem = ratio < PROBLEM_RATIO
    return Tiers(ratio, healthy, ~healthy & ~problem, problem)


def _classify_zone_type(vegetation_fraction: float) -> str:
    if vegetation_fraction < 0.15:
        return "bare_soil"
    if vegetation_fraction < 0.35:
        return "low_crop_density"
    return "patchy_vegetation"


def _new_result(db: Session, survey: models.Survey, tiers: Tiers, method: str) -> models.AnalysisResult:
    total = len(tiers.ratio)
    result = models.AnalysisResult(
        survey_id=survey.id,
        healthy_area_percent=round(100 * int(tiers.healthy.sum()) / total, 1),
        attention_area_percent=round(100 * int(tiers.attention.sum()) / total, 1),
        problem_area_percent=round(100 * int(tiers.problem.sum()) / total, 1),
        method=method,
        is_mock=False,
    )
    db.add(result)
    db.flush()
    return result


def _add_zone(db: Session, result: models.AnalysisResult, geometry, members: list[tuple[float, float]], problem: bool) -> None:
    """members: (vegetation cover, cover/reference ratio) of the cells or frames inside the zone."""
    if not members or (not problem and len(members) < 2):
        return  # one slightly-below-reference cell is noise, not an area worth walking to
    worst_cover = min(c for c, _ in members)
    worst_ratio = min(r for _, r in members)
    # how clearly the zone falls short of the field's healthy cover, plus a little for its size
    shortfall = min(max((HEALTHY_RATIO - float(np.mean([r for _, r in members]))) / HEALTHY_RATIO, 0.0), 1.0)
    confidence = round(min(0.95, 0.5 + 0.35 * shortfall + 0.02 * min(len(members), 5)), 2)
    severity = ("high" if worst_ratio < SEVERE_RATIO else "medium") if problem else "low"
    zone_type = _classify_zone_type(worst_cover)
    db.add(
        models.DetectionZone(
            analysis_result_id=result.id,
            type=zone_type,
            severity=severity,
            confidence=confidence,
            geometry_geojson=json.dumps(mapping(geometry)),
            recommended_action=SAFE_ACTIONS[zone_type],
        )
    )


def _parts(geometry) -> list:
    return list(geometry.geoms) if hasattr(geometry, "geoms") else [geometry]


def _group_frames(survey: models.Survey) -> dict[str, list[models.SurveyImage]]:
    frames: dict[str, list[models.SurveyImage]] = defaultdict(list)
    for img in survey.images:
        frames[img.frame_key or img.id].append(img)
    return frames


def _anchor(rows: list[models.SurveyImage]) -> models.SurveyImage | None:
    """The row whose GPS anchors the frame on the map: RGB if present."""
    with_gps = [r for r in rows if r.lat is not None and r.lon is not None]
    if not with_gps:
        return None
    return next((r for r in with_gps if r.band == "RGB"), with_gps[0])


def _measure_frames(frames: dict[str, list[models.SurveyImage]], remeasure: bool) -> tuple[list[Sample], str]:
    """Returns (samples, method). Uses NDVI for every frame when the survey
    has multispectral bands; never mixes the two indices in one analysis.
    Frames measured by an earlier run are reused unless `remeasure`. The
    frames that do need measuring are read on a thread pool (RGB: decoded in
    parallel, index on the GPU); ORM rows are only touched on this thread."""
    from app.services.vision_service import analyze_images_vegetation

    has_ms = any({"NIR", "RED"} <= {r.band for r in rows} for rows in frames.values())
    slots: list[Sample | None] = []  # keeps the frames' original order
    todo: list[tuple[int, list[models.SurveyImage], models.SurveyImage, dict]] = []

    for rows in frames.values():
        anchor = _anchor(rows)
        if anchor is None:
            continue
        if not remeasure and anchor.vegetation_fraction is not None and (anchor.ndvi_mean is not None or not has_ms):
            slots.append((anchor, anchor.vegetation_fraction))
            continue
        bands = {r.band: r.path for r in rows}
        if (has_ms and not {"NIR", "RED"} <= bands.keys()) or (not has_ms and "RGB" not in bands):
            continue
        slots.append(None)
        todo.append((len(slots) - 1, rows, anchor, bands))

    if has_ms:
        def stats_for(bands: dict):
            try:
                return multispectral_service.compute_frame_stats(bands)
            except (OSError, ValueError, multispectral_service.BandsUnavailableError) as exc:
                return exc

        results = (res for _, res in gpu.prefetch([t[3] for t in todo], stats_for))
    else:
        results = (res for _, res in analyze_images_vegetation([t[3]["RGB"] for t in todo]))

    for n, ((slot, rows, anchor, _), res) in enumerate(zip(todo, results), 1):
        if n % 100 == 0:
            log.info("measured %d/%d frames", n, len(todo))
        if isinstance(res, Exception):
            log.warning("skipping frame %s — unreadable %s: %s", anchor.frame_key, "band file" if has_ms else "image", res)
            continue
        if has_ms:
            if res.vegetation_fraction is None:
                continue
            for r in rows:
                r.vegetation_fraction = res.vegetation_fraction
                r.ndvi_mean = res.ndvi_mean
                r.ndre_mean = res.ndre_mean
                r.gndvi_mean = res.gndvi_mean
        else:
            for r in rows:
                r.vegetation_fraction = res.vegetation_fraction
        slots[slot] = (anchor, res.vegetation_fraction)

    return [s for s in slots if s is not None], ("ndvi" if has_ms else "exg")


def analyze_survey(
    db: Session, survey: models.Survey, field: models.Field, remeasure_frames: bool = False
) -> models.AnalysisResult | None:
    samples, frame_method = _measure_frames(_group_frames(survey), remeasure_frames)

    raster = _analysis_raster(survey, multispectral=frame_method == "ndvi")
    if raster is not None:
        result = analyze_from_raster(db, survey, field, *raster)
        if result is not None:
            return result

    if not samples:
        return None

    tiers = tier_cover(np.array([f for _, f in samples]))
    result = _new_result(db, survey, tiers, frame_method)
    for mask, problem in ((tiers.attention, False), (tiers.problem, True)):
        members = [(img, f, float(r)) for (img, f), r, m in zip(samples, tiers.ratio, mask) if m]
        if not members:
            continue
        merged = unary_union([Point(img.lon, img.lat).buffer(ZONE_BUFFER_DEG, cap_style=3) for img, _, _ in members])
        for cluster in _parts(merged):
            inside = [(f, r) for img, f, r in members if cluster.intersects(Point(img.lon, img.lat))]
            _add_zone(db, result, cluster, inside, problem)
    db.flush()
    return result


# ---------------------------------------------------------------------------
# Map-space analysis on a georeferenced raster
# ---------------------------------------------------------------------------


def _analysis_raster(survey: models.Survey, multispectral: bool) -> tuple[Path, str] | None:
    """The raster to measure in map space: the NDVI mosaic for multispectral
    surveys, the RGB orthomosaic for RGB-only ones (photogrammetry preferred)."""
    asset_type, method = ("ndvi", "ndvi_map") if multispectral else ("orthomosaic", "exg_map")
    candidates = [
        a for a in survey.assets
        if a.asset_type == asset_type and (a.format or "").lower() in ("tif", "tiff") and a.path.exists()
    ]
    best = min(candidates, key=lambda a: SOURCE_RANK.get(a.source, 3), default=None)
    return (best.path, method) if best else None


def _ndvi_cover(data: np.ndarray, nodata) -> tuple[np.ndarray, np.ndarray]:
    band = data[0].astype(np.float32)
    valid = ~np.isnan(band)
    if nodata is not None and not np.isnan(nodata):
        valid &= band != nodata
    return valid, valid & (band > multispectral_service.NDVI_VEGETATION_THRESHOLD)


def _exg_cover(data: np.ndarray, nodata) -> tuple[np.ndarray, np.ndarray]:
    if data.shape[0] >= 4:
        valid = data[3] > 0
    elif nodata is not None:
        valid = ~np.all(data[:3] == nodata, axis=0)
    else:
        valid = np.any(data[:3] > 0, axis=0)
    rgb = data[:3].astype(np.float32)
    total = rgb.sum(axis=0)
    total[total == 0] = 1.0
    exg = (2 * rgb[1] - rgb[0] - rgb[2]) / total  # = 2g - r - b on chromaticity coordinates
    return valid, valid & (exg > VEGETATION_THRESHOLD)


def _cover_torch(torch, data: np.ndarray, nodata, method: str):
    """_exg_cover / _ndvi_cover on the GPU: the same float32 arithmetic and
    thresholds, so every cell's pixel counts are identical to the CPU path."""
    d = torch.from_numpy(data).to("cuda")
    if method == "exg_map":
        if d.shape[0] >= 4:
            valid = d[3] > 0
        elif nodata is not None:
            valid = ~torch.all(d[:3] == nodata, dim=0)
        else:
            valid = torch.any(d[:3] > 0, dim=0)
        rgb = d[:3].to(torch.float32)
        total = rgb.sum(dim=0)
        total[total == 0] = 1.0
        exg = (2 * rgb[1] - rgb[0] - rgb[2]) / total
        return valid, valid & (exg > VEGETATION_THRESHOLD)
    band = d[0].to(torch.float32)
    valid = ~torch.isnan(band)
    if nodata is not None and not np.isnan(nodata):
        valid &= band != nodata
    return valid, valid & (band > multispectral_service.NDVI_VEGETATION_THRESHOLD)


def _raster_cells(path: Path, method: str):
    """(cells, transform, crs, cell_px) with cells = (row, col, vegetation cover)
    for every CELL_M square that has enough valid pixels, or None when the
    raster isn't the kind the method measures. Reads strips of cell rows, so a
    multi-gigapixel orthomosaic is never held in memory."""
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(path) as src:
        if method == "exg_map":
            if src.count < 3 or src.dtypes[0] != "uint8":
                return None
            cover_fn, bands = _exg_cover, list(range(1, min(src.count, 4) + 1))
        else:
            if src.count != 1 or not src.dtypes[0].startswith("float"):
                return None
            cover_fn, bands = _ndvi_cover, [1]

        tf, crs = src.transform, src.crs
        cell_px = max(2, int(round(CELL_M / abs(tf.a))))
        rows, cols = src.height // cell_px, src.width // cell_px
        if rows == 0 or cols == 0:
            return None
        strip = max(1, READ_STRIP_PX // cell_px)
        # per-pixel index + per-cell counts on the GPU (~8x faster), numpy without CUDA
        strip_bytes = len(bands) * strip * cell_px * cols * cell_px
        torch = gpu.cuda_torch() if gpu.gpu_can_hold(strip_bytes * 12) else None
        cells: list[tuple[int, int, float]] = []
        for r0 in range(0, rows, strip):
            nr = min(strip, rows - r0)
            data = src.read(bands, window=Window(0, r0 * cell_px, cols * cell_px, nr * cell_px))
            if torch is not None:
                valid, veg = _cover_torch(torch, data, src.nodata, method)
                n_valid = valid.reshape(nr, cell_px, cols, cell_px).sum(dim=(1, 3)).cpu().numpy()
                n_veg = veg.reshape(nr, cell_px, cols, cell_px).sum(dim=(1, 3)).cpu().numpy()
            else:
                valid, veg = cover_fn(data, src.nodata)
                n_valid = valid.reshape(nr, cell_px, cols, cell_px).sum(axis=(1, 3))
                n_veg = veg.reshape(nr, cell_px, cols, cell_px).sum(axis=(1, 3))
            for r, c in zip(*np.nonzero(n_valid >= MIN_VALID_FRACTION * cell_px * cell_px)):
                cells.append((r0 + int(r), int(c), float(n_veg[r, c] / n_valid[r, c])))
    if torch is not None:
        del valid, veg
        gpu.release_gpu_memory()
    return cells, tf, crs, cell_px


def analyze_from_raster(
    db: Session, survey: models.Survey, field: models.Field, path: Path, method: str
) -> models.AnalysisResult | None:
    from rasterio.warp import transform as warp_transform

    measured = _raster_cells(path, method)
    if measured is None:
        return None
    cells, tf, crs, cell_px = measured
    if len(cells) < 10:
        return None

    # cell centres -> lon/lat, keep those inside the field
    xs = [tf.c + (c + 0.5) * cell_px * tf.a for _, c, _ in cells]
    ys = [tf.f + (r + 0.5) * cell_px * tf.e for r, _, _ in cells]
    lons, lats = warp_transform(crs, "EPSG:4326", xs, ys)
    if field.boundary_geojson:
        # camera-position hull + ~8 m: half a frame footprint beyond the outermost cameras
        field_area = shape(json.loads(field.boundary_geojson)).buffer(0.00007)
        keep = [i for i, (lo, la) in enumerate(zip(lons, lats)) if field_area.contains(Point(lo, la))]
        if len(keep) >= 10:
            cells = [cells[i] for i in keep]

    tiers = tier_cover(np.array([f for _, _, f in cells]))
    result = _new_result(db, survey, tiers, method)

    for mask, problem in ((tiers.attention, False), (tiers.problem, True)):
        flagged = [(r, c, f, float(ratio)) for (r, c, f), ratio, m in zip(cells, tiers.ratio, mask) if m]
        if not flagged:
            continue
        x0 = [tf.c + c * cell_px * tf.a for _, c, _, _ in flagged]
        y1 = [tf.f + r * cell_px * tf.e for r, _, _, _ in flagged]
        x1 = [x + cell_px * tf.a for x in x0]
        y0 = [y + cell_px * tf.e for y in y1]
        lo0, la0 = warp_transform(crs, "EPSG:4326", x0, y0)
        lo1, la1 = warp_transform(crs, "EPSG:4326", x1, y1)
        polys = [(box(lo0[i], la0[i], lo1[i], la1[i]), f, ratio) for i, (_, _, f, ratio) in enumerate(flagged)]
        # dilate a little so diagonally-adjacent cells merge into one zone
        eps = abs(polys[0][0].bounds[2] - polys[0][0].bounds[0]) * 0.15
        merged = unary_union([p.buffer(eps, join_style=2) for p, _, _ in polys]).buffer(-eps, join_style=2)
        for cluster in _parts(merged):
            inside = [(f, ratio) for p, f, ratio in polys if cluster.intersects(p.centroid)]
            _add_zone(db, result, cluster.simplify(0.000005), inside, problem)

    result.metrics_json = json.dumps(_extra_measurements(db, survey, field, result, path, method))
    db.flush()
    log.info(
        "%s: %d cells of %.0f m — %.1f%% healthy / %.1f%% attention / %.1f%% problem",
        method, len(cells), CELL_M, result.healthy_area_percent, result.attention_area_percent, result.problem_area_percent,
    )
    return result


# ---------------------------------------------------------------------------
# Row geometry, weed candidates, trained detectors, vegetation mask
# ---------------------------------------------------------------------------


def _extra_measurements(
    db: Session, survey: models.Survey, field: models.Field, result: models.AnalysisResult, path: Path, method: str
) -> dict:
    from app.services import detector_service, weed_service
    from app.services.storage_service import survey_dir

    metrics: dict = {}
    # row analysis needs the RGB orthomosaic; for an NDVI-based analysis look it up separately
    rgb = path if method == "exg_map" else (_analysis_raster(survey, multispectral=False) or (None, None))[0]
    if rgb is None:
        metrics["rows"] = {"status": "no_rgb_orthomosaic", "reason": "row analysis needs an RGB orthomosaic"}
    else:
        try:
            rows = weed_service.analyze_rows(rgb, field.boundary_geojson)
            metrics["rows"] = rows.metrics()
            for cand in rows.candidates:
                db.add(models.DetectionZone(
                    analysis_result_id=result.id,
                    type="weed_candidate",
                    severity="medium" if cand["area_m2"] >= 4 else "low",
                    confidence=WEED_CANDIDATE_CONFIDENCE,
                    geometry_geojson=json.dumps(cand["geometry"]),
                    recommended_action=SAFE_ACTIONS["weed_candidate"],
                ))
        except Exception as exc:  # a failed extra never loses the tier result
            log.exception("row analysis failed")
            metrics["rows"] = {"status": "error", "reason": str(exc)[:200]}
        try:
            mask_path = survey_dir(survey.id) / "outputs" / "vegetation_mask.tif"
            weed_service.write_vegetation_mask(rgb, mask_path)
            _register_output_asset(db, survey, "vegetation_mask", mask_path)
        except Exception as exc:
            log.exception("vegetation mask failed")
            metrics["vegetation_mask"] = {"status": "error", "reason": str(exc)[:200]}

    ran: dict[str, int] = {}
    if rgb is not None:
        for det in detector_service.run_detectors(rgb):
            ran[det.detector] = ran.get(det.detector, 0) + 1
            db.add(models.DetectionZone(
                analysis_result_id=result.id,
                type=f"{det.detector}:{det.type}",
                severity="medium",
                confidence=round(det.confidence, 2),
                geometry_geojson=json.dumps(det.geometry),
                recommended_action=MODEL_ACTION,
            ))
    st = detector_service.status()
    metrics["detectors"] = {"installed": [i["name"] for i in st["installed"]], "ran": ran, "note": st["note"]}
    return metrics


def _register_output_asset(db: Session, survey: models.Survey, asset_type: str, path: Path) -> None:
    from app.services.orthomosaic_service import extract_bounds_geojson

    for old in [a for a in survey.assets if a.asset_type == asset_type and a.source == "analysis"]:
        db.delete(old)
    db.flush()
    db.add(models.SurveyAsset(
        survey_id=survey.id, asset_type=asset_type, file_path=str(path), format="tif",
        bounds_geojson=json.dumps(extract_bounds_geojson(path)), source="analysis",
    ))
    db.flush()
