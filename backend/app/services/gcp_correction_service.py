"""Lining the detailed map up with the farmer's surveyed ground control points.

The targets are already found in the detailed orthophoto (gcp_service). Each
surveyed point is matched to the target it marks, and a similarity transform
(shift, plus a small turn and stretch when the points are spread out) is
fitted from where the map shows the targets to where they were surveyed.
Only RTK-surveyed points move the map: a handheld GPS is metres off, worse
than the map itself, so those points are only compared.

The correction rewrites the georeferencing of every detailed raster
(orthophoto, elevation, band and index maps) — not their pixels, so nothing
is resampled — and moves the detected targets with it. The original
georeferencing is kept in outputs/gcp_correction.json, so the correction is
always computed from, and can be undone to, the map as it was made: replacing
or removing the GCP file, or rebuilding the band maps, starts from there.
The outcome, point by point, goes to outputs/gcp_check.json for the flight page.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sqlalchemy.orm import Session

from app import models
from app.config import settings

log = logging.getLogger(__name__)

CORRECTABLE_SOURCES = ("photogrammetry_odm", "photogrammetry_gpu", "manual_import")
MATCH_RADIUS_M = 30.0  # how far off a map can be and its targets still be paired up
COARSE_TOL_M = 1.0  # first pairing, before turn and stretch are known
FINE_TOL_M = 0.25  # an RTK point and its target after the fit
MIN_SPREAD_M = 20.0  # closer together, points fix the shift only
MAX_SCALE_DEV = 0.01
MAX_ROTATION_DEG = 1.0
MAX_RMS_M = 0.15
NEGLIGIBLE_M = 0.02
M_TO_FT = 3.28084


@dataclass
class Similarity:
    """x' = s·R(θ)·x + t, in a local metric frame (UTM)."""

    s: float = 1.0
    theta: float = 0.0
    tx: float = 0.0
    ty: float = 0.0

    def apply(self, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        c, sn = math.cos(self.theta), math.sin(self.theta)
        return self.s * (c * x - sn * y) + self.tx, self.s * (sn * x + c * y) + self.ty

    def inverse(self) -> "Similarity":
        c, sn = math.cos(-self.theta), math.sin(-self.theta)
        si = 1.0 / self.s
        return Similarity(si, -self.theta, -si * (c * self.tx - sn * self.ty), -si * (sn * self.tx + c * self.ty))

    def as_dict(self) -> dict:
        return {"s": self.s, "theta": self.theta, "tx": self.tx, "ty": self.ty}


def fit(p: np.ndarray, q: np.ndarray) -> Similarity:
    """Least-squares similarity taking points p (N, 2) onto q (N, 2) — Umeyama in
    2D; a pure shift for one point or points too close together to fix a turn."""
    if len(p) == 1 or np.ptp(p, axis=0).max() < MIN_SPREAD_M:
        d = (q - p).mean(axis=0)
        return Similarity(1.0, 0.0, float(d[0]), float(d[1]))
    pc, qc = p.mean(axis=0), q.mean(axis=0)
    a, b = p - pc, q - qc
    num_cos = float((a * b).sum())
    num_sin = float((a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]).sum())
    theta = math.atan2(num_sin, num_cos)
    s = math.hypot(num_cos, num_sin) / float((a**2).sum())
    c, sn = math.cos(theta), math.sin(theta)
    tx = qc[0] - s * (c * pc[0] - sn * pc[1])
    ty = qc[1] - s * (sn * pc[0] + c * pc[1])
    return Similarity(s, theta, float(tx), float(ty))


def acceptable(sim: Similarity, rms_m: float) -> bool:
    """A correction a real map can need: a shift of any size, but hardly any turn or
    stretch, and points that agree with each other after the fit."""
    return abs(sim.s - 1) <= MAX_SCALE_DEV and abs(math.degrees(sim.theta)) <= MAX_ROTATION_DEG and rms_m <= MAX_RMS_M


def _pair(q: np.ndarray, p: np.ndarray, moved: np.ndarray, tol: float) -> list[tuple[int, int]]:
    """Each surveyed point q[i] with the nearest (moved) target within tol, one target per point."""
    pairs, used = [], set()
    order = np.argsort([np.min(np.hypot(*(moved - qi).T)) for qi in q])
    for i in order:
        d = np.hypot(*(moved - q[i]).T)
        for j in np.argsort(d):
            if d[j] > tol:
                break
            if j not in used:
                pairs.append((int(i), int(j)))
                used.add(int(j))
                break
    return sorted(pairs)


def match(q: np.ndarray, p: np.ndarray) -> tuple[list[tuple[int, int]], Similarity | None]:
    """Pairs surveyed points q with map targets p although the map may be off by
    metres: the shift that brings the most points onto a target wins, then turn
    and stretch are fitted and the pairing redone tightly."""
    if len(q) == 0 or len(p) == 0:
        return [], None
    best: list[tuple[int, int]] = []
    best_err = math.inf
    for i in range(len(q)):
        for j in np.flatnonzero(np.hypot(*(p - q[i]).T) <= MATCH_RADIUS_M):
            moved = p + (q[i] - p[j])
            pairs = _pair(q, p, moved, COARSE_TOL_M)
            err = sum(float(np.hypot(*(moved[b] - q[a]))) for a, b in pairs)
            if len(pairs) > len(best) or (len(pairs) == len(best) and err < best_err):
                best, best_err = pairs, err
    if not best:
        return [], None
    for _ in range(2):
        sim = fit(p[[b for _, b in best]], q[[a for a, _ in best]])
        mx, my = sim.apply(p[:, 0], p[:, 1])
        refined = _pair(q, p, np.column_stack([mx, my]), FINE_TOL_M)
        if not refined:
            break
        best = refined
    return best, fit(p[[b for _, b in best]], q[[a for a, _ in best]])


# ---------------------------------------------------------------------------
# where the state lives
# ---------------------------------------------------------------------------


def _outputs(survey: models.Survey) -> Path:
    return settings.surveys_dir / survey.id / "outputs"


def _state_path(survey: models.Survey) -> Path:
    return _outputs(survey) / "gcp_correction.json"


def report_path(survey: models.Survey) -> Path:
    return _outputs(survey) / "gcp_check.json"


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _save(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def correctable(survey: models.Survey) -> list[models.SurveyAsset]:
    return [a for a in survey.assets if a.source in CORRECTABLE_SOURCES and (a.format or "").lower() in ("tif", "tiff")
            and a.path.exists()]


def _local_crs(lat: float, lon: float) -> str:
    zone = int((lon + 180) // 6) + 1
    return f"EPSG:{(32600 if lat >= 0 else 32700) + zone}"


def _move_detected(survey: models.Survey, local_crs: str, sim: Similarity) -> None:
    from rasterio.warp import transform

    rows = [g for g in survey.gcps if g.source == "detected"]
    if not rows:
        return
    xs, ys = transform("EPSG:4326", local_crs, [g.lon for g in rows], [g.lat for g in rows])
    mx, my = sim.apply(np.asarray(xs), np.asarray(ys))
    lons, lats = transform(local_crs, "EPSG:4326", mx.tolist(), my.tolist())
    for g, lo, la in zip(rows, lons, lats):
        g.lon, g.lat = float(lo), float(la)


def _rewrite_georef(path: Path, local_crs: str, sim: Similarity) -> list[float]:
    """Moves the raster by `sim` (defined in local_crs) by rewriting its
    geotransform; returns the original one."""
    import rasterio
    from affine import Affine
    from rasterio.warp import transform

    with rasterio.open(path, "r+") as ds:
        t, w, h, crs = ds.transform, ds.width, ds.height, ds.crs
        corners = [t * (0, 0), t * (w, 0), t * (0, h)]
        lx, ly = transform(crs, local_crs, [c[0] for c in corners], [c[1] for c in corners])
        mx, my = sim.apply(np.asarray(lx), np.asarray(ly))
        (x0, x1, x2), (y0, y1, y2) = transform(local_crs, crs, mx.tolist(), my.tolist())
        ds.transform = Affine((x1 - x0) / w, (x2 - x0) / h, x0, (y1 - y0) / w, (y2 - y0) / h, y0)
        return list(t)[:6]


def _after_move(db: Session, survey: models.Survey, assets: list[models.SurveyAsset]) -> set[str]:
    """New bounds and no stale previews for moved rasters; their layer types."""
    from app.services.orthomosaic_service import extract_bounds_geojson

    for a in assets:
        a.bounds_geojson = json.dumps(extract_bounds_geojson(a.path))
        (settings.asset_previews_cache_dir / f"{a.id}.png").unlink(missing_ok=True)
    db.flush()
    return {a.asset_type for a in assets}


def restore(db: Session, survey: models.Survey) -> set[str]:
    """Puts the detailed rasters and the detected targets back where the map was
    made. Returns the layer types moved (their tiles need rebuilding)."""
    import rasterio
    from affine import Affine

    state = _load(_state_path(survey))
    applied = state.get("applied")
    if not applied:
        return set()
    moved = []
    by_path = {str(a.path): a for a in survey.assets}
    for path, t in state.get("original", {}).items():
        if Path(path).exists():
            with rasterio.open(path, "r+") as ds:
                ds.transform = Affine(*t)
            if path in by_path:
                moved.append(by_path[path])
    _move_detected(survey, applied["local_crs"], Similarity(**applied["sim"]).inverse())
    _save(_state_path(survey), {})
    log.info("gcp: survey %s back to the uncorrected map", survey.id)
    return _after_move(db, survey, moved)


def _ft(m: float) -> str:
    ft = m * M_TO_FT
    return f"{ft * 12:.1f} in" if ft < 1 else f"{ft:.1f} ft"


def align(db: Session, survey: models.Survey, stale_layers: set[str] | frozenset = frozenset()) -> dict:
    """Matches the surveyed points to the detected targets, moves the detailed
    map onto RTK points, writes the report and rebuilds the tiles of every
    layer that moved (now or in an earlier restore: `stale_layers`)."""
    from rasterio.warp import transform

    from app.services.survey_service import update_field_boundary_from_images
    from app.services.tile_service import build_survey_tiles

    surveyed = [g for g in survey.gcps if g.source == "surveyed"]
    detected = [g for g in survey.gcps if g.source == "detected"]
    rasters = correctable(survey)
    rtk = bool(surveyed) and all(g.rtk for g in surveyed)
    report: dict = {"rtk": rtk, "status": "none", "message": "", "model": None, "points": []}
    moved_layers: set[str] = set(stale_layers)

    if not surveyed:
        report["status"] = "none"
    elif not rasters or not any(a.asset_type == "orthomosaic" for a in rasters):
        report["status"] = "waiting"
        report["message"] = "Your points are saved. They are used once the detailed map is made."
    elif not detected:
        report["status"] = "no_match"
        report["message"] = "No targets were found in the detailed map to compare your points with."
    else:
        ref = surveyed[0]
        local = _local_crs(ref.lat, ref.lon)
        qx, qy = transform("EPSG:4326", local, [g.lon for g in surveyed], [g.lat for g in surveyed])
        px, py = transform("EPSG:4326", local, [g.lon for g in detected], [g.lat for g in detected])
        q, p = np.column_stack([qx, qy]), np.column_stack([px, py])
        if rtk:
            pairs, sim = match(q, p)
        else:  # handheld: each point with the nearest target (a big one when there is one)
            pairs, sim = [], None
            big = [j for j, g in enumerate(detected) if (g.size_m or 1.0) >= 0.3]
            for i in range(len(q)):
                for pool in (big, list(range(len(p)))):
                    if not pool:
                        continue
                    d = np.hypot(*(p[pool] - q[i]).T)
                    k = int(np.argmin(d))
                    if d[k] <= MATCH_RADIUS_M:
                        pairs.append((i, pool[k]))
                        break
        matched = dict(pairs)
        after = None
        if rtk and sim is not None and pairs:
            mx, my = sim.apply(p[:, 0], p[:, 1])
            after = np.column_stack([mx, my])
            res = np.array([np.hypot(*(after[j] - q[i])) for i, j in pairs])
            rms = float(np.sqrt((res**2).mean()))
            # how far the map's targets were from the surveyed points (typical)
            shift = float(np.median([np.hypot(*(q[i] - p[j])) for i, j in pairs]))
            sane = acceptable(sim, rms)
            report["model"] = {"shift_m": round(shift, 3), "rotation_deg": round(math.degrees(sim.theta), 4),
                               "scale": round(sim.s, 6), "rms_m": round(rms, 3), "points_used": len(pairs)}
            if not sane:
                report["status"] = "rejected"
                report["message"] = (f"Your surveyed points disagree with each other by up to {_ft(float(res.max()))} after "
                                     "fitting, so the map was not moved. Check that each name belongs to the right target.")
                after = None
            elif shift < NEGLIGIBLE_M:
                report["status"] = "aligned"
                report["message"] = f"The detailed map already matches your {len(pairs)} surveyed points within {_ft(max(shift, rms))}."
                after = p.copy()
            else:
                state = {"applied": {"local_crs": local, "sim": sim.as_dict()}, "original": {}}
                for a in rasters:
                    state["original"][str(a.path)] = _rewrite_georef(a.path, local, sim)
                _save(_state_path(survey), state)
                _move_detected(survey, local, sim)
                moved_layers |= _after_move(db, survey, rasters)
                report["status"] = "applied"
                report["message"] = (f"The detailed map was moved {_ft(shift)} onto your {len(pairs)} surveyed points; "
                                     f"they now agree within {_ft(float(res.max()))}.")
                log.info("gcp: survey %s moved %.3f m (rot %.4f°, scale %.6f, rms %.3f m) onto %d RTK points",
                         survey.id, shift, math.degrees(sim.theta), sim.s, rms, len(pairs))
        elif not pairs:
            report["status"] = "no_match"
            report["message"] = ("None of your points is near a target found in the detailed map. Check that they are "
                                 "this flight's targets and in the right coordinate system.")
        else:
            d = sorted(float(np.hypot(*(q[i] - p[j]))) for i, j in pairs)
            report["status"] = "check_only"
            report["message"] = (f"Your points are within {_ft(d[len(d) // 2])} (typical) of the targets found in the map. "
                                 "They were not measured with RTK, so they were only compared — the map was not moved.")
        now = after if after is not None else p
        for i, g in enumerate(surveyed):
            j = matched.get(i)
            used = j is not None and report["status"] in ("applied", "aligned")
            if j is None:  # left out (or nothing near): say how far the nearest target is, to re-check the point
                d = np.hypot(*(now - q[i]).T)
                k = int(np.argmin(d))
                j = k if d[k] <= MATCH_RADIUS_M else None
            report["points"].append({
                "name": g.name, "lat": g.lat, "lon": g.lon, "used": used,
                "matched": detected[j].name if j is not None else None,
                "before_m": round(float(np.hypot(*(q[i] - p[j]))), 3) if j is not None else None,
                "after_m": round(float(np.hypot(*(q[i] - after[j]))), 3) if j is not None and after is not None else None,
            })

    _save(report_path(survey), report)
    if moved_layers:
        db.commit()
        db.refresh(survey)
        build_survey_tiles(db, survey, tuple(sorted(moved_layers)))
        update_field_boundary_from_images(db, survey.field, survey.images, survey.gcps)
        db.commit()
    return report


def load_report(survey: models.Survey) -> dict | None:
    return _load(report_path(survey)) or None
