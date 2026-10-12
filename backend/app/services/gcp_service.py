"""Ground control targets: 2x2 black-and-white checkerboards found in the
survey's photogrammetric orthophoto.

A target looks the same at any rotation: around its centre the brightness is
a square wave in angle — two bright and two dark 90° sectors. Each candidate
centre is sampled on rings inside the target, the best-fitting orientation is
read off the second angular harmonic, and the score is the correlation with
that square wave. A target must also look like printed plastic: both white
sectors near-white and colourless, both black sectors clearly darker, and all
four sectors flat. Plants on bright soil, straw and stones can make a fair
four-sector pattern, but not flat, near-white, colourless squares (measured
on the Ditty Road field: real targets 249+ grey, flatness 0.12-0.21; the best
look-alikes 144-173 grey, flatness 0.47-0.56). The whole orthophoto is scanned
on the GPU every 10 cm for that pattern (no seeding from white blobs: a target
laid on bright bare soil merges with it into one blob, which is how the fifth
Ditty Road target was first missed); the local peaks are refined, then
re-measured at the orthophoto's native resolution.

Two kinds of target are searched for. The GCPs proper (60 or 40 cm, red corner
pins) are scanned at DETECT_GSD_M. The small ~17 cm markers (66 of them on the
Ditty Road field, most within a few metres of each other) are only ~7 px wide
at that resolution, so they get a second, tiled scan at the orthophoto's own
resolution. Straw crossings are their look-alikes at that size: real markers
measured 227+ grey (dimmer white sector), straw 197-210.

Only photogrammetric orthophotos are searched: the quick mosaic can place a
target metres off, or twice (see fixing/FIXES_NEEDED.md). GCPs are named by
compass direction from the survey's centre ("GCP N", "GCP SE", …), markers are
numbered north to south ("M1", "M2", …); both are stored as GroundControlPoint
rows with their size, and the field boundary is drawn to include them.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import numpy as np
from sqlalchemy.orm import Session

from app import models
from app.services import gpu
from app.services.camera_model import sample_image

log = logging.getLogger(__name__)

PHOTOGRAMMETRIC_SOURCES = ("photogrammetry_odm", "manual_import")
DETECT_GSD_M = 0.025
RING_FRACTIONS = (0.2, 0.35, 0.5, 0.65, 0.8)  # of the half side: inside the target's inscribed circle
N_ANGLES = 32
CANDIDATE_CORR = 0.45  # a scan point this good (it can sit off-centre) gets a closer look
COMPASS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


@dataclass(frozen=True)
class TargetKind:
    half_sides_m: tuple[float, ...]
    scan_step_m: float  # dense pattern scan spacing
    peak_m: float  # candidates are the best scan point within this radius
    nms_m: float  # two targets of this kind are never closer
    min_corr: float
    # grey levels (0-255): the dimmer white sector, and its margin over the
    # brighter black sector (glossy black plastic reflecting the sky reads mid-grey)
    min_white: float
    min_contrast: float
    max_flatness: float  # mean within-sector std / contrast
    max_white_saturation: float


# 60 cm and 40 cm GCPs: a centre is never more than 3.5 cm from a scan point
GCP = TargetKind((0.30, 0.20), 0.05, 0.3, 1.0, 0.8, 200.0, 50.0, 0.35, 0.15)
# ~17 cm markers: their glossy black squares can read nearly white (contrast
# down to 31), so the whites' level and flatness do the work
MARKER = TargetKind((0.085,), 0.025, 0.05, 0.3, 0.75, 220.0, 25.0, 0.38, 0.10)
MARKER_MAX_GSD_M = 0.012  # coarser orthophotos cannot show a marker's pattern
MARKER_TILE_PX, MARKER_TILE_OVERLAP_PX = 3000, 128
GCP_CLEARANCE_M = 0.5  # a GCP's centre also looks like a marker


def _score(torch, img, pu, pv, radius_px: float, sat=None):
    """Pattern statistics of candidate centres (pu, pv) in a (H, W) image tensor:
    (N, 6) = square-wave correlation, orientation, dimmer-white mean,
    brighter-black mean, flatness, white-sector saturation (0 without `sat`)."""
    dev = img.device
    phi = (torch.arange(N_ANGLES, device=dev, dtype=torch.float32) + 0.5) * (2 * math.pi / N_ANGLES)
    rings = torch.tensor(RING_FRACTIONS, device=dev, dtype=torch.float32) * radius_px
    du = (rings[:, None] * torch.cos(phi)[None, :]).reshape(-1)
    dv = (-rings[:, None] * torch.sin(phi)[None, :]).reshape(-1)
    su, sv = pu[:, None] + du[None, :], pv[:, None] + dv[None, :]
    V = sample_image(torch, img[None], su, sv)[0].reshape(len(pu), len(RING_FRACTIONS), N_ANGLES)
    Vc = V - V.mean(dim=(1, 2), keepdim=True)
    s2, c2 = torch.sin(2 * phi), torch.cos(2 * phi)
    A = (Vc * s2).sum(dim=(1, 2))
    B = (Vc * c2).sum(dim=(1, 2))
    theta = 0.5 * torch.atan2(-B, A)
    sq = torch.sign(torch.sin(2 * (phi[None, :] - theta[:, None])))  # (N, A)
    norm = Vc.flatten(1).norm(dim=1).clamp(min=1e-6) * math.sqrt(len(RING_FRACTIONS) * N_ANGLES)
    corr = (Vc * sq[:, None, :]).sum(dim=(1, 2)) / norm
    # the four 90° sectors separately (0 and 2 are the bright ones by construction of theta)
    quad = torch.floor(torch.remainder(phi[None, :] - theta[:, None], 2 * math.pi) / (math.pi / 2)).long().clamp(0, 3)
    S = sample_image(torch, sat[None], su, sv)[0].reshape(V.shape) if sat is not None else None
    means, stds, sats = [], [], []
    for q in range(4):
        m = (quad == q).float()[:, None, :]  # (N, 1, A)
        cnt = (m.sum(dim=2) * len(RING_FRACTIONS)).sum(dim=1).clamp(min=1)
        mu = (V * m).sum(dim=(1, 2)) / cnt
        means.append(mu)
        stds.append(torch.sqrt((((V - mu[:, None, None]) ** 2) * m).sum(dim=(1, 2)) / cnt))
        sats.append((S * m).sum(dim=(1, 2)) / cnt if S is not None else torch.zeros_like(mu))
    white = torch.minimum(means[0], means[2])
    black = torch.maximum(means[1], means[3])
    flat = torch.stack(stds, dim=1).mean(dim=1) / (white - black).clamp(min=1)
    white_sat = torch.maximum(sats[0], sats[2])
    return torch.stack([corr, theta, white, black, flat, white_sat], dim=1)


def _accept(stats, kind: TargetKind = GCP) -> bool:
    corr, _, white, black, flat, white_sat = (float(v) for v in stats)
    return (corr >= kind.min_corr and white >= kind.min_white and white - black >= kind.min_contrast
            and flat <= kind.max_flatness and white_sat <= kind.max_white_saturation)


def _search(torch, img, cu, cv, half_px: float, step_px: float, radius_px: float, sat=None):
    """Best (by correlation) candidate centre in a square of +-half_px around each
    (cu, cv): (N, 8) = u, v and the six _score statistics."""
    offs = torch.arange(-half_px, half_px + 1e-6, step_px, device=img.device, dtype=torch.float32)
    gy, gx = torch.meshgrid(offs, offs, indexing="ij")
    n = gx.numel()
    best = []
    for i in range(0, len(cu), 64):
        u = (cu[i:i + 64, None] + gx.reshape(1, -1)).reshape(-1)
        v = (cv[i:i + 64, None] + gy.reshape(1, -1)).reshape(-1)
        st = _score(torch, img, u, v, radius_px, sat)
        k = st[:, 0].reshape(-1, n).argmax(dim=1)
        flat_idx = torch.arange(len(k), device=img.device) * n + k
        best.append(torch.cat([u[flat_idx, None], v[flat_idx, None], st[flat_idx]], dim=1))
    return torch.cat(best) if best else torch.zeros((0, 8), device=img.device)


def _scan(torch, gray, valid, step: int, radius_px: float):
    """Pattern correlation on a coarse grid (every `step` pixels) over the whole image."""
    H, W = gray.shape
    vs = torch.arange(step / 2, H, step, device=gray.device, dtype=torch.float32)
    us = torch.arange(step / 2, W, step, device=gray.device, dtype=torch.float32)
    score = torch.full((len(vs), len(us)), -1.0, device=gray.device)
    rows = max(1, 120_000 // len(us))
    for r0 in range(0, len(vs), rows):
        gv, gu = torch.meshgrid(vs[r0:r0 + rows], us, indexing="ij")
        inside = valid[gv.long().clamp(0, H - 1), gu.long().clamp(0, W - 1)]
        if not bool(inside.any()):
            continue
        block = score[r0:r0 + rows]
        block[inside] = _score(torch, gray, gu[inside], gv[inside], radius_px)[:, 0]
    return vs, us, score


def _gray_and_saturation(rgb):
    """(gray, saturation) of an RGB tensor (3, H, W)."""
    mx, mn = rgb.max(dim=0).values, rgb.min(dim=0).values
    return rgb.mean(dim=0), (mx - mn) / mx.clamp(min=1)


def _nms(found: list[dict], res: float, nms_m: float) -> list[dict]:
    picked = []
    for f in sorted(found, key=lambda f: -f["score"]):
        if all(math.hypot(f["u"] - p["u"], f["v"] - p["v"]) * res > nms_m for p in picked):
            picked.append(f)
    return picked


def find_targets(torch, rgb: np.ndarray, res: float, kind: TargetKind = GCP) -> list[dict]:
    """Targets in an RGB uint8 image (3, H, W) at `res` m/px: pixel centre and score."""
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    t = torch.from_numpy(np.ascontiguousarray(rgb)).to(dev).float()
    gray, sat = _gray_and_saturation(t)
    valid = t.max(dim=0).values > 0
    if not bool(valid.any()):
        return []
    step = max(1, round(kind.scan_step_m / res))
    pool = 2 * max(1, round(kind.peak_m / (step * res))) + 1
    found = []
    for half_side in kind.half_sides_m:
        vs, us, score = _scan(torch, gray, valid, step, half_side / res)
        # off-centre scan points lose contrast quickly, so only the pattern score
        # picks candidates; the other tests come after refinement
        masked = torch.where(score >= CANDIDATE_CORR, score, torch.full_like(score, -1.0))
        peak = masked == torch.nn.functional.max_pool2d(masked[None, None], pool, 1, pool // 2)[0, 0]
        iv, iu = torch.nonzero((score >= CANDIDATE_CORR) & peak, as_tuple=True)
        if len(iv) == 0:
            continue
        for row in _search(torch, gray, us[iu], vs[iv], float(step), 0.5, half_side / res, sat).cpu().numpy():
            if _accept(row[2:], kind):
                found.append({"u": float(row[0]), "v": float(row[1]), "score": float(row[2]), "half_side_m": half_side})
    return _nms(found, res, kind.nms_m)


def refine_target(torch, img, x0: float, y1: float, res: float, x: float, y: float, search_m: float = 0.1,
                  half_side_m: float = 0.30):
    """Best target centre within search_m of (x, y) in a single-channel image
    tensor (H, W) whose top-left corner is (x0, y1) at `res` m/px: (x, y, score)
    in the same projected coordinates, or None. Works on any channel (photo
    grey, a reflectance band): only the shape of the pattern is scored."""
    u0, v0 = (x - x0) / res - 0.5, (y1 - y) / res - 0.5
    cu = torch.tensor([u0], device=img.device, dtype=torch.float32)
    cv = torch.tensor([v0], device=img.device, dtype=torch.float32)
    r = _search(torch, img, cu, cv, search_m / res, 0.25, half_side_m / res)
    if r.shape[0] == 0 or float(r[0, 2]) < 0.5:
        return None
    u, v, corr = float(r[0, 0]), float(r[0, 1]), float(r[0, 2])
    return x0 + (u + 0.5) * res, y1 - (v + 0.5) * res, corr


def _find_markers(torch, src) -> list[dict]:
    """MARKER targets over a whole raster at its own resolution, tile by tile
    (the overlap is wider than a marker, so each is seen whole by some tile):
    projected x, y and score."""
    from rasterio.windows import Window

    res = abs(src.res[0])
    step = MARKER_TILE_PX - MARKER_TILE_OVERLAP_PX
    found = []
    for r0 in range(0, src.height, step):
        for c0 in range(0, src.width, step):
            win = Window(c0, r0, min(MARKER_TILE_PX, src.width - c0), min(MARKER_TILE_PX, src.height - r0))
            rgb = src.read([1, 2, 3], window=win)
            if not rgb.any():
                continue
            found += [{**f, "u": f["u"] + c0, "v": f["v"] + r0} for f in find_targets(torch, rgb, res, MARKER)]
    out = []
    for f in _nms(found, res, MARKER.nms_m):
        x, y = src.transform * (f["u"] + 0.5, f["v"] + 0.5)
        out.append({"x": x, "y": y, "score": f["score"], "size_m": 2 * f["half_side_m"], "crs": src.crs})
    return out


def detect_in_orthophoto(path) -> list[dict]:
    """Targets in a georeferenced RGB orthophoto: projected x, y (raster CRS),
    score and side length, re-measured and re-tested at the raster's own
    resolution. GCPs first, then markers."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.vrt import WarpedVRT
    from rasterio.windows import from_bounds

    torch = gpu.cuda_torch()
    if torch is None:
        import torch  # noqa: PLC0415 — CPU fallback
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    with rasterio.open(path) as src:
        if src.count < 3 or src.dtypes[0] != "uint8":
            return []
        x0, y0, x1, y1 = src.bounds
        res = max(DETECT_GSD_M, abs(src.res[0]))
        w, h = int((x1 - x0) / res), int((y1 - y0) / res)
        with WarpedVRT(src, crs=src.crs, transform=from_origin(x0, y1, res, res), width=w, height=h,
                       resampling=Resampling.average) as vrt:
            rgb = vrt.read([1, 2, 3])
        coarse = find_targets(torch, rgb, res)
        out = []
        native = abs(src.res[0])
        for f in coarse:
            cx, cy = x0 + (f["u"] + 0.5) * res, y1 - (f["v"] + 0.5) * res
            win = from_bounds(cx - 0.5, cy - 0.5, cx + 0.5, cy + 0.5, src.transform).round_offsets().round_lengths()
            wx0, wy1 = src.transform * (win.col_off, win.row_off)
            gray, sat = _gray_and_saturation(torch.from_numpy(src.read([1, 2, 3], window=win).astype(np.float32)).to(dev))
            u0 = torch.tensor([(cx - wx0) / native - 0.5], device=dev)
            v0 = torch.tensor([(wy1 - cy) / native - 0.5], device=dev)
            row = _search(torch, gray, u0, v0, 2 * res / native, 0.25, f["half_side_m"] / native, sat)[0].cpu().numpy()
            # at the orthophoto's own resolution a real target stays a clean,
            # flat, white-and-black pattern; look-alikes from the coarse scan do not
            if not _accept(row[2:]):
                continue
            out.append({"x": wx0 + (float(row[0]) + 0.5) * native, "y": wy1 - (float(row[1]) + 0.5) * native,
                        "score": float(row[2]), "size_m": 2 * f["half_side_m"], "crs": src.crs})
        if native <= MARKER_MAX_GSD_M:
            gcps = list(out)
            out += [m for m in _find_markers(torch, src)
                    if all(math.hypot(m["x"] - g["x"], m["y"] - g["y"]) > GCP_CLEARANCE_M for g in gcps)]
        else:
            log.info("gcp: %s is %.1f cm/px, too coarse to find the small markers", path, native * 100)
    if dev == "cuda":
        gpu.release_gpu_memory()
    return out


def _compass_names(points: list[tuple[float, float]], centre: tuple[float, float]) -> list[str]:
    """'GCP N', 'GCP SE', … by bearing from the centre; repeats get a number."""
    lat0 = math.radians(centre[1])
    raw = []
    for lon, lat in points:
        de = (lon - centre[0]) * math.cos(lat0)
        dn = lat - centre[1]
        raw.append(COMPASS[int(((math.degrees(math.atan2(de, dn)) % 360) + 22.5) // 45) % 8])
    names, seen = [], {}
    for r in raw:
        seen[r] = seen.get(r, 0) + 1
        names.append(f"GCP {r}" if raw.count(r) == 1 else f"GCP {r}{seen[r]}")
    return names


def _names(points: list[tuple[float, float]], sizes: list[float], centre: tuple[float, float]) -> list[str]:
    """GCPs by compass direction from the centre, markers numbered north to south."""
    big = [i for i, s in enumerate(sizes) if s > 2 * max(MARKER.half_sides_m)]
    names = [""] * len(points)
    for i, n in zip(big, _compass_names([points[i] for i in big], centre)):
        names[i] = n
    small = sorted((i for i in range(len(points)) if i not in big), key=lambda i: (-points[i][1], points[i][0]))
    for k, i in enumerate(small, 1):
        names[i] = f"M{k}"
    return names


def sort_key(g: models.GroundControlPoint) -> tuple:
    """GCPs by name, then markers in number order (M2 before M10)."""
    if g.name.startswith("M") and g.name[1:].isdigit():
        return (1, int(g.name[1:]), "")
    return (0, 0, g.name)


def detect_and_store(db: Session, survey: models.Survey) -> list[models.GroundControlPoint]:
    """Finds the survey's targets in its photogrammetric orthophoto and stores
    them (replacing earlier detections). [] when there is no such orthophoto."""
    from rasterio.warp import transform as warp

    orthos = [a for a in survey.assets if a.asset_type == "orthomosaic" and a.source in PHOTOGRAMMETRIC_SOURCES
              and (a.format or "").lower() in ("tif", "tiff") and a.path.exists()]
    if not orthos:
        log.info("gcp: survey %s has no photogrammetric orthophoto, skipped", survey.id)
        return []
    ortho = min(orthos, key=lambda a: PHOTOGRAMMETRIC_SOURCES.index(a.source))
    found = detect_in_orthophoto(ortho.path)
    for old in [g for g in survey.gcps if g.source == "detected"]:
        db.delete(old)
    db.flush()
    if not found:
        log.info("gcp: no targets found in %s", ortho.path.name)
        return []
    crs = found[0]["crs"]
    lons, lats = warp(crs, "EPSG:4326", [f["x"] for f in found], [f["y"] for f in found])
    heights = _heights(survey, crs, [(f["x"], f["y"]) for f in found])
    anchors = [(i.lon, i.lat) for i in survey.images if i.lat is not None and i.band == "RGB"] or \
              [(i.lon, i.lat) for i in survey.images if i.lat is not None]
    centre = (float(np.mean([a[0] for a in anchors])), float(np.mean([a[1] for a in anchors]))) if anchors \
        else (float(np.mean(lons)), float(np.mean(lats)))
    names = _names(list(zip(lons, lats)), [f["size_m"] for f in found], centre)
    rows = []
    for f, lon, lat, h, name in zip(found, lons, lats, heights, names):
        g = models.GroundControlPoint(survey_id=survey.id, name=name, lat=float(lat), lon=float(lon),
                                      height_m=h, source="detected", score=round(f["score"], 3),
                                      size_m=round(f["size_m"], 3))
        db.add(g)
        rows.append(g)
    db.flush()
    rows.sort(key=sort_key)
    log.info("gcp: %d target(s) in %s: %s", len(rows), ortho.path.name,
             ", ".join(f"{g.name} ({g.lat:.7f}, {g.lon:.7f}, score {g.score})" for g in rows))
    return rows


def _heights(survey: models.Survey, crs, xy: list[tuple[float, float]]) -> list[float | None]:
    """Surface height under each point from the photogrammetric DSM (its own datum)."""
    import rasterio
    from rasterio.warp import transform as warp

    dsms = [a for a in survey.assets if a.asset_type == "dsm" and a.source in PHOTOGRAMMETRIC_SOURCES
            and (a.format or "").lower() in ("tif", "tiff") and a.path.exists()]
    if not dsms:
        return [None] * len(xy)
    with rasterio.open(dsms[0].path) as src:
        xs, ys = warp(crs, src.crs, [p[0] for p in xy], [p[1] for p in xy])
        vals = [float(v[0]) for v in src.sample(zip(xs, ys))]
        nodata = src.nodata
    return [round(v, 3) if np.isfinite(v) and (nodata is None or v != nodata) else None for v in vals]
