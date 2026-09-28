"""Crop-row geometry, canopy closure and inter-row vegetation from the orthomosaic.

Classical computer vision on the survey's own pixels — no trained model, and
the method is recorded on every result:

  1. Vegetation mask: Excess Green Index on the RGB orthomosaic (same index and
     threshold as vision_service), at 5 cm/px.
  2. Row orientation: the rotation at which the mean-vegetation column profile
     of the field interior has the strongest variance (rows become vertical).
  3. Row spacing: the first peak of the profile's autocorrelation.
  4. Per-band row lock: in 8 m bands across the field, row centrelines are
     located as peaks in the ExG profile and accepted only where the peak
     count and spacing match the global spacing (curved rows, headlands and
     closed-canopy areas fail the lock and are left out).
  5. Canopy closure: vegetation cover of the mid-row columns vs the row-centre
     columns in the locked area.
  6. Inter-row vegetation ("weed candidates") — vegetation in the columns
     where each gap's ExG profile sits in its trough, i.e. outside the crop
     lines whatever their width — ONLY when the canopy is still open enough
     for rows to be separable (mid-row cover <= CANOPY_OPEN_MAX_MIDROW_COVER).
     Patches spanning several rows are joined back into one polygon.
     With a closed canopy the mid-row vegetation is the crop, so nothing is
     flagged and the status says why.

What this cannot do: identify weed species, disease or pests. Candidates are
labelled as inter-row vegetation for a scout to check, never as a diagnosis.
"""

from __future__ import annotations

import json
import logging
import math
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np
from scipy import ndimage, signal

from app.services.vision_service import VEGETATION_THRESHOLD

log = logging.getLogger(__name__)

GSD_M = 0.05
MAX_WORK_PIXELS = 30_000_000  # coarser GSD beyond this so a huge mosaic still fits in memory
EDGE_ERODE_M = 3.0  # ragged mosaic edge to ignore
ORIENTATION_WINDOW_M = 70.0
ORIENTATION_STEP_DEG = 0.5
MIN_ROW_SPACING_M, MAX_ROW_SPACING_M = 0.15, 1.2
BAND_M = 8.0
LOCK_MIN_COVERAGE, LOCK_MIN_REGULARITY = 0.8, 0.7
MIN_LOCK_FRACTION = 0.25  # of the field area, for canopy / inter-row measurements to be reported
CANOPY_OPEN_MAX_MIDROW_COVER = 0.35  # inter-row candidates need separable rows
INTER_ROW_TROUGH_FRACTION = 0.35  # a column is "between rows" while its profile is this close to the trough
# Columns dropped at each end of a trough interval: the columns touching the crop
# lines carry leaf edges and resampling jitter. On a synthetic 0.5 m-row field
# with one 28 m² patch, trim 0 leaks 12 % of the vegetation into the gaps while
# trim 1 recovers the patch as one 27 m² candidate with 0.2 % leakage.
INTER_ROW_TRIM_PX = 1
SPECK_MIN_M2 = 0.05  # inter-row blobs smaller than this are leaf tips / edge jitter, not a patch
MIN_PATCH_M2 = 0.25
METHOD = "row_interrow_exg"


@dataclass
class RowAnalysis:
    method: str = METHOD
    status: str = "rows_not_found"  # measured | canopy_closed | rows_not_locked | rows_not_found
    reason: str = ""
    row_orientation_deg: float | None = None  # compass bearing of the rows (0 = north, clockwise)
    row_spacing_m: float | None = None
    row_signal: float | None = None  # autocorrelation at the row spacing, 0..1
    lock_fraction: float | None = None  # share of the field area where rows were locked
    row_cover_percent: float | None = None  # vegetation cover on the row centrelines (locked area)
    midrow_cover_percent: float | None = None  # vegetation cover between rows (locked area)
    canopy_closure_percent: float | None = None  # = midrow cover: how much of the inter-row ground the canopy covers
    vegetation_cover_percent: float | None = None
    inter_row_vegetation_percent: float | None = None  # of the vegetation, locked area; only when measured
    candidate_count: int = 0
    candidate_area_m2: float = 0.0
    candidates: list[dict] = field(default_factory=list)  # GeoJSON polygons (EPSG:4326) with properties

    def metrics(self) -> dict:
        d = asdict(self)
        d.pop("candidates")
        return d


_veg_cache: tuple | None = None  # (file identity, result) of the last read
_veg_lock = threading.Lock()


def _load_vegetation(path: Path):
    """(exg, veg, valid, transform, crs, gsd) at ~GSD_M from the orthomosaic.

    The last result is kept (keyed on the file's path, size and mtime, so a
    rebuilt mosaic is re-read): an analysis run calls this for the row
    analysis and again for the vegetation mask. Callers must not modify the
    returned arrays."""
    global _veg_cache
    st = path.stat()
    key = (str(path.resolve()), st.st_size, st.st_mtime_ns)
    with _veg_lock:
        if _veg_cache is not None and _veg_cache[0] == key:
            return _veg_cache[1]
        out = _read_vegetation(path)
        _veg_cache = (key, out)
        return out


def _read_vegetation(path: Path):
    import rasterio
    from rasterio.enums import Resampling

    with rasterio.open(path) as src:
        if src.count < 3 or src.dtypes[0] != "uint8":
            raise ValueError("row analysis needs an RGB (uint8) orthomosaic")
        native = abs(src.transform.a)
        gsd = max(GSD_M, native)
        if (src.width * src.height) * (native / gsd) ** 2 > MAX_WORK_PIXELS:
            gsd = native * math.sqrt(src.width * src.height / MAX_WORK_PIXELS)
        f = gsd / native
        H, W = max(1, int(src.height / f)), max(1, int(src.width / f))
        rgb = src.read([1, 2, 3], out_shape=(3, H, W), resampling=Resampling.average).astype(np.float32)
        tf = src.transform * src.transform.scale(src.width / W, src.height / H)
        crs = src.crs
    valid = np.any(rgb > 0, axis=0)
    valid = ndimage.binary_erosion(valid, iterations=max(1, int(EDGE_ERODE_M / gsd)))
    total = rgb.sum(0)
    total[total == 0] = 1.0
    exg = (2 * rgb[1] - rgb[0] - rgb[2]) / total
    veg = (exg > VEGETATION_THRESHOLD) & valid
    return exg, veg, valid, tf, crs, gsd


def _row_orientation(veg: np.ndarray, valid: np.ndarray, gsd: float) -> tuple[float, float]:
    """(rotation angle that makes rows vertical, contrast) from the field interior."""
    ys, xs = np.nonzero(valid)
    cy, cx = int(ys.mean()), int(xs.mean())
    half = min(int(ORIENTATION_WINDOW_M / gsd / 2), cy, cx, veg.shape[0] - cy - 1, veg.shape[1] - cx - 1)
    crop = veg[cy - half:cy + half, cx - half:cx + half].astype(np.float32)
    cval = valid[cy - half:cy + half, cx - half:cx + half].astype(np.float32)
    angles = np.arange(0, 180, ORIENTATION_STEP_DEG)
    scores = np.zeros(len(angles))
    for i, ang in enumerate(angles):
        M = cv2.getRotationMatrix2D((half, half), float(ang), 1.0)
        r = cv2.warpAffine(crop, M, (2 * half, 2 * half), flags=cv2.INTER_LINEAR)
        rv = cv2.warpAffine(cval, M, (2 * half, 2 * half), flags=cv2.INTER_NEAREST)
        n = rv.sum(0)
        ok = n > half
        if ok.sum() < 100:
            continue
        scores[i] = np.var(r.sum(0)[ok] / n[ok])
    best = int(scores.argmax())
    contrast = float(scores[best] / max(np.median(scores), 1e-9))
    return float(angles[best]), contrast


def _rotate_all(arrays: list[np.ndarray], angle: float, interp: list[int]):
    """Rotates full rasters so rows are vertical; returns rotated arrays and the affine used."""
    H, W = arrays[0].shape[:2]
    M = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nW, nH = int(H * sin + W * cos), int(H * cos + W * sin)
    M[0, 2] += nW / 2 - W / 2
    M[1, 2] += nH / 2 - H / 2
    out = [cv2.warpAffine(a, M, (nW, nH), flags=flag) for a, flag in zip(arrays, interp)]
    return out, M


def _row_spacing(rexg: np.ndarray, rval: np.ndarray, gsd: float) -> tuple[int | None, float]:
    """(spacing in px, autocorrelation at that lag) from the interior ExG profile."""
    ys, xs = np.nonzero(rval)
    cy, cx = int(ys.mean()), int(xs.mean())
    half = min(int(ORIENTATION_WINDOW_M / gsd / 2), cy, cx, rval.shape[0] - cy - 1, rval.shape[1] - cx - 1)
    win = slice(cy - half, cy + half), slice(cx - half, cx + half)
    v = rval[win]
    n = v.sum(0)
    ok = n > half
    prof = np.where(v, rexg[win], 0).sum(0) / np.maximum(n, 1)
    p = prof[ok] - prof[ok].mean()
    if len(p) < 50:
        return None, 0.0
    ac = np.correlate(p, p, mode="full")[len(p) - 1:]
    ac = ac / max(ac[0], 1e-9)
    lo, hi = max(2, int(MIN_ROW_SPACING_M / gsd)), int(MAX_ROW_SPACING_M / gsd)
    peaks, _ = signal.find_peaks(ac[lo:hi], prominence=0.05)
    if not len(peaks):
        return None, 0.0
    lag = int(peaks[0] + lo)
    return lag, float(ac[lag])


def _bearing_of_rows(M: np.ndarray, tf, crs) -> float:
    """Compass bearing (deg, 0 = north, clockwise) of a vertical line in the rotated frame."""
    from rasterio.warp import transform as warp_transform

    inv = cv2.invertAffineTransform(M)
    pts = np.array([[1000.0, 1000.0], [1000.0, 1100.0]])  # vertical in the rotated frame
    orig = np.column_stack([pts, np.ones(2)]) @ inv.T  # -> original pixel coords
    xs, ys = [], []
    for c, r in orig:
        x, y = tf * (float(c), float(r))
        xs.append(x)
        ys.append(y)
    if crs is not None and not crs.is_projected:
        # lon/lat raster: bearing from the geographic offsets
        lons, lats = xs, ys
        dE = (lons[1] - lons[0]) * math.cos(math.radians(lats[0]))
        dN = lats[1] - lats[0]
    else:
        dE, dN = xs[1] - xs[0], ys[1] - ys[0]
    return round(math.degrees(math.atan2(dE, dN)) % 180.0, 1)


def analyze_rows(path: Path, boundary_geojson: str | None = None) -> RowAnalysis:
    """Row geometry, canopy closure and (when valid) inter-row vegetation candidates."""
    from rasterio.warp import transform as warp_transform
    from shapely.geometry import Polygon, mapping, shape

    res = RowAnalysis()
    exg, veg, valid, tf, crs, gsd = _load_vegetation(path)
    if valid.sum() * gsd * gsd < 400:  # < 400 m2 of usable mosaic
        res.reason = "too little usable orthomosaic area"
        return res
    res.vegetation_cover_percent = round(float(veg[valid].mean() * 100), 1)

    angle, contrast = _row_orientation(veg, valid, gsd)
    (rexg, rval), M = _rotate_all(
        [exg, valid.astype(np.uint8)], angle, [cv2.INTER_LINEAR, cv2.INTER_NEAREST],
    )
    rval = rval.astype(bool)
    # threshold the smoothly resampled index rather than rotating the binary
    # mask: nearest-neighbour rotation of a hard-edged mask leaves a jagged,
    # one-pixel-jittered edge along every row that would leak into the gaps
    rveg = (rexg > VEGETATION_THRESHOLD) & rval
    spacing_px, ac = _row_spacing(rexg, rval, gsd)
    if spacing_px is None or ac < 0.3 or contrast < 1.5:
        res.reason = f"no regular row pattern (row signal {ac:.2f}, orientation contrast {contrast:.1f})"
        return res
    res.row_signal = round(ac, 2)
    res.row_spacing_m = round(spacing_px * gsd, 2)
    res.row_orientation_deg = _bearing_of_rows(M, tf, crs)

    # per-band row lock
    nH, nW = rveg.shape
    band = max(20, int(BAND_M / gsd))
    locked = np.zeros_like(rval)
    inter = np.zeros_like(rval)
    row_cover, mid_cover = [], []
    for y0 in range(0, nH, band):
        sl = slice(y0, min(y0 + band, nH))
        vmask = rval[sl]
        n = vmask.sum(0)
        cols_ok = n > band * 0.6
        if cols_ok.sum() < spacing_px * 20:
            continue
        prof = np.where(vmask, rexg[sl], 0).sum(0) / np.maximum(n, 1)
        p = np.where(cols_ok, prof, prof[cols_ok].mean())
        p = ndimage.gaussian_filter1d(p, max(1.0, spacing_px * 0.12))
        pk, _ = signal.find_peaks(p, distance=max(2, int(spacing_px * 0.7)), prominence=0.005)
        pk = pk[cols_ok[pk]]
        if len(pk) < 10:
            continue
        gaps = np.diff(pk)
        coverage = len(pk) / (cols_ok.sum() / spacing_px)
        regular = float(np.mean(np.abs(gaps - spacing_px) <= max(2, spacing_px * 0.25)))
        if coverage < LOCK_MIN_COVERAGE or regular < LOCK_MIN_REGULARITY:
            continue
        mid = (pk[:-1] + pk[1:]) // 2
        row_cover.append(float(rveg[sl][:, pk][vmask[:, pk]].mean()))
        mid_cover.append(float(rveg[sl][:, mid][vmask[:, mid]].mean()))
        # inter-row columns: where each gap's profile sits in its trough, i.e.
        # below INTER_ROW_TROUGH_FRACTION of the way from the trough up to the
        # crop peak. This follows each row's own width instead of assuming one,
        # so the edges of wide or off-centre crop lines are never counted.
        inter_cols = np.zeros(nW, bool)
        for a, b in zip(pk[:-1], pk[1:]):
            seg = p[a:b + 1]
            trough, peak = seg.min(), min(seg[0], seg[-1])
            if peak - trough <= 1e-6:
                continue
            low = np.nonzero(seg < trough + INTER_ROW_TROUGH_FRACTION * (peak - trough))[0]
            if len(low) > 2 * INTER_ROW_TRIM_PX:
                inter_cols[a + low[0] + INTER_ROW_TRIM_PX:a + low[-1] + 1 - INTER_ROW_TRIM_PX] = True
        inter_cols &= cols_ok
        locked[sl] = vmask & cols_ok[None, :]
        inter[sl] = rveg[sl] & inter_cols[None, :] & vmask

    lock_fraction = float(locked.sum() / max(rval.sum(), 1))
    res.lock_fraction = round(lock_fraction, 2)
    if lock_fraction < MIN_LOCK_FRACTION or not row_cover:
        res.status = "rows_not_locked"
        res.reason = (
            f"rows are {res.row_spacing_m} m apart but their centrelines could be followed on only "
            f"{lock_fraction * 100:.0f}% of the field (curved rows, headlands or a closed canopy), too little "
            "to measure the ground between them"
        )
        return res
    res.row_cover_percent = round(float(np.mean(row_cover)) * 100, 1)
    res.midrow_cover_percent = round(float(np.mean(mid_cover)) * 100, 1)
    res.canopy_closure_percent = res.midrow_cover_percent

    if np.mean(mid_cover) > CANOPY_OPEN_MAX_MIDROW_COVER:
        res.status = "canopy_closed"
        res.reason = (
            f"canopy covers {res.midrow_cover_percent:.0f}% of the ground between rows (measured on "
            f"{lock_fraction * 100:.0f}% of the field), so vegetation between rows is the crop itself — "
            "inter-row weed candidates need an earlier-season survey with separable rows"
        )
        return res

    # measured: inter-row vegetation as scout candidates
    veg_locked = int((rveg & locked).sum())
    res.inter_row_vegetation_percent = round(100 * float(inter.sum()) / max(veg_locked, 1), 1)
    # drop specks (leaf tips leaning into the gap, edge jitter) by area, then
    # join the slivers a patch leaves in neighbouring inter-rows back into one
    # patch with a row-spacing-wide closing
    lab0, n0 = ndimage.label(inter)
    if n0:
        sizes0 = ndimage.sum(inter, lab0, range(1, n0 + 1)) * gsd * gsd
        keep = np.zeros(n0 + 1, bool)
        keep[1:] = sizes0 >= SPECK_MIN_M2
        cleaned = keep[lab0]
    else:
        cleaned = inter
    closed = ndimage.binary_closing(cleaned, structure=np.ones((3, spacing_px + 1), bool))
    closed &= locked
    lab, n = ndimage.label(closed)
    if n:
        sizes = ndimage.sum(closed, lab, range(1, n + 1)) * gsd * gsd
        inv = cv2.invertAffineTransform(M)
        field_area = shape(json.loads(boundary_geojson)).buffer(0.00007) if boundary_geojson else None
        for i in np.nonzero(sizes >= MIN_PATCH_M2)[0]:
            comp = (lab == i + 1).astype(np.uint8)
            contours, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            c = max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
            if len(c) < 3:
                continue
            orig = np.column_stack([c, np.ones(len(c))]) @ inv.T
            xs, ys = zip(*[tf * (float(px), float(py)) for px, py in orig])
            if crs is not None and crs.is_projected:
                lons, lats = warp_transform(crs, "EPSG:4326", list(xs), list(ys))
            else:
                lons, lats = list(xs), list(ys)
            poly = Polygon(zip(lons, lats)).buffer(0).simplify(0.000002)
            if poly.is_empty or (field_area is not None and not field_area.intersects(poly)):
                continue
            res.candidates.append({
                "geometry": mapping(poly),
                "area_m2": round(float(sizes[i]), 2),
            })
    res.candidate_count = len(res.candidates)
    res.candidate_area_m2 = round(sum(c["area_m2"] for c in res.candidates), 1)
    res.status = "measured"
    res.reason = (
        f"{res.candidate_count} inter-row vegetation patches ≥ {MIN_PATCH_M2} m² on the {lock_fraction * 100:.0f}% "
        f"of the field where rows were followed ({res.inter_row_vegetation_percent}% of that area's vegetation "
        "sits between rows) — scout them; species are not identified"
    )
    return res


def write_vegetation_mask(path: Path, out_path: Path) -> None:
    """Writes the vegetation mask the analysis counts as crop: 0 outside the
    mosaic, 1 = soil/other, 2 = vegetation (ExG above threshold), at ~5 cm."""
    import rasterio

    _, veg, valid, tf, crs, _ = _load_vegetation(path)
    mask = np.where(veg, 2, np.where(valid, 1, 0)).astype(np.uint8)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path, "w", driver="GTiff", height=mask.shape[0], width=mask.shape[1], count=1, dtype="uint8",
        crs=crs, transform=tf, nodata=0, compress="deflate", tiled=True,
    ) as dst:
        dst.write(mask, 1)
