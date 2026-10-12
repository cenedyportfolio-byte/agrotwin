"""Multispectral index computation (NDVI / NDRE / GNDVI) on real DJI M3M frames.

The Mavic 3 Multispectral writes one 16-bit TIF per band per shutter release:
    DJI_<datetime>_<seq>_MS_G.TIF    Green    (560 nm)
    DJI_<datetime>_<seq>_MS_R.TIF    Red      (650 nm)
    DJI_<datetime>_<seq>_MS_RE.TIF   Red Edge (730 nm)
    DJI_<datetime>_<seq>_MS_NIR.TIF  NIR      (860 nm)
All bands of a frame are looked up by frame_key and the indices are computed
pixel-by-pixel from the raw digital numbers.

Calibration and registration, both from DJI's own XMP metadata:
- Radiometric: DJI's documented M3M workflow, as OpenDroneMap implements it
  (opendm/multispectral.py): black-level subtraction, vignetting correction
  with the per-band polynomial about VignettingCenter, normalisation by
  SensorGain × ExposureTime, the per-band SensorGainAdjustment, and the
  sun-sensor Irradiance recorded at exposure. The result is relative
  reflectance: what is left out (π, the DN bit depth, µs vs s) is one
  constant shared by all bands, so it cancels in normalized-difference
  indices. SensorGainAdjustment does not cancel — it differs per band
  (0.51 Green … 0.91 NIR on the M3M) — and before 2026-10-10 it was missing,
  as was the black-level-before-vignetting order, which biased NDVI.
- Geometric: each band is warped by its CalibratedHMatrix into the common
  reference frame. Measured on this dataset: NIR↔RedEdge gradient
  correlation 0.21 → 0.59, NIR↔Red 0.12 → 0.20 — the MS lenses sit a few
  cm apart and this removes that parallax.
- Per-frame indices live in frame space. The map-space products come from
  mosaic_service (direct georeferencing), not from photogrammetry.

No fake values are produced — if a band is missing, the function raises.
"""

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from app import models

INDEX_BANDS = {
    "ndvi": ("NIR", "RED"),
    "ndre": ("NIR", "RED_EDGE"),
    "gndvi": ("NIR", "GREEN"),
}

# Common working threshold for "live vegetation" on NDVI.
NDVI_VEGETATION_THRESHOLD = 0.3

STATS_MAX_DIM = 648  # means are resolution-insensitive; keeps a 60-frame survey under a minute
PREVIEW_MAX_DIM = 1024


class BandsUnavailableError(Exception):
    pass


@dataclass
class FrameIndexStats:
    ndvi_mean: float | None = None
    ndre_mean: float | None = None
    gndvi_mean: float | None = None
    vegetation_fraction: float | None = None  # share of pixels with NDVI > threshold


def _safe_normalized_difference(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    denom = a + b
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(denom == 0, 0.0, (a - b) / denom)


def compute_ndvi(nir: np.ndarray, red: np.ndarray) -> np.ndarray:
    return _safe_normalized_difference(nir, red)


def compute_ndre(nir: np.ndarray, red_edge: np.ndarray) -> np.ndarray:
    return _safe_normalized_difference(nir, red_edge)


def compute_gndvi(nir: np.ndarray, green: np.ndarray) -> np.ndarray:
    return _safe_normalized_difference(nir, green)


def open_image_safely(path: Path) -> Image.Image:
    """Reads the whole file into memory first. PIL memory-maps uncompressed
    TIFFs, and on a disk with bad sectors a failed page-in is a SIGBUS that
    kills the process — a plain read() surfaces it as a catchable OSError."""
    with open(path, "rb") as f:
        data = f.read()
    return Image.open(io.BytesIO(data))


def load_band(path: Path, max_dim: int | None = None, calibrate: bool = True, register: bool = True) -> np.ndarray:
    """Band TIF -> float32 array (downsampled to max_dim), radiometrically
    calibrated and warped into the frame's common reference when the DJI
    XMP fields are present. Falls back to raw DN when they aren't."""
    from app.services.metadata_service import read_dji_xmp, xmp_float

    with open_image_safely(path) as im:
        full_w, full_h = im.size
        if max_dim and max(im.size) > max_dim:
            scale = max_dim / max(im.size)
            im = im.resize((round(full_w * scale), round(full_h * scale)), Image.BILINEAR)
        else:
            scale = 1.0
        arr = np.asarray(im, dtype=np.float32)

    xmp = read_dji_xmp(path) if (calibrate or register) else {}
    if calibrate and xmp_float(xmp, "BlackLevel") is not None:
        arr = _radiometric_calibration(arr, xmp, scale)
    if register and xmp.get("CalibratedHMatrix"):
        arr = _register_band(arr, xmp, scale)
    return arr


@dataclass(frozen=True)
class BandCalibration:
    """DJI M3M per-image radiometric calibration (XMP drone-dji tags)."""

    black: float
    gain: float
    exposure: float  # µs; a constant factor shared by all bands
    irradiance: float  # sun-sensor reading at exposure
    gain_adjustment: float  # per-band responsivity (SensorGainAdjustment)
    vignetting_center: tuple[float, float] | None = None  # full-resolution pixels
    vignetting_coeffs: tuple[float, ...] = ()  # V(r) = 1 + k1 r + k2 r² + …

    @property
    def factor(self) -> float:
        """(DN - black) × V × factor = relative reflectance."""
        return self.gain_adjustment / (self.gain * self.exposure * self.irradiance)


def band_calibration(xmp: dict) -> BandCalibration | None:
    """The calibration terms of a band image, or None when its XMP lacks them."""
    from app.services.metadata_service import xmp_float

    if not xmp or xmp_float(xmp, "BlackLevel") is None:
        return None
    cal = BandCalibration(
        black=xmp_float_or(xmp, "BlackLevel", 0.0),
        gain=xmp_float_or(xmp, "SensorGain", 1.0),
        exposure=xmp_float_or(xmp, "ExposureTime", 1.0),
        irradiance=xmp_float_or(xmp, "Irradiance", 1.0),
        gain_adjustment=xmp_float_or(xmp, "SensorGainAdjustment", 1.0),
    )
    if cal.gain <= 0 or cal.exposure <= 0 or cal.irradiance <= 0 or cal.gain_adjustment <= 0:
        return None
    try:
        coeffs = tuple(float(c) for c in xmp["VignettingPolynomial"]["Seq"]["li"])
        cx, cy = (float(c) for c in xmp["VignettingCenter"]["Seq"]["li"])
    except (KeyError, TypeError, ValueError):
        return cal
    return BandCalibration(cal.black, cal.gain, cal.exposure, cal.irradiance, cal.gain_adjustment, (cx, cy), coeffs)


def _radiometric_calibration(arr: np.ndarray, xmp: dict, scale: float) -> np.ndarray:
    cal = band_calibration(xmp)
    if cal is None:
        return arr
    arr = np.clip(arr - cal.black, 0.0, None)
    if cal.vignetting_coeffs and cal.vignetting_center:
        h, w = arr.shape
        ys, xs = np.mgrid[0:h, 0:w]
        cx, cy = cal.vignetting_center
        # polynomial is in full-res pixels; (x + 0.5) / scale - 0.5 maps a resampled pixel centre back
        r = np.hypot((xs + 0.5) / scale - 0.5 - cx, (ys + 0.5) / scale - 0.5 - cy)
        v = np.ones_like(arr)
        for i, k in enumerate(cal.vignetting_coeffs, start=1):
            v += k * r**i
        arr = arr * v
    return arr * cal.factor


def _register_band(arr: np.ndarray, xmp: dict, scale: float) -> np.ndarray:
    try:
        H = np.array([float(v) for v in str(xmp["CalibratedHMatrix"]).split(",")]).reshape(3, 3)
    except (ValueError, KeyError):
        return arr
    S = np.diag([scale, scale, 1.0])
    Hs = S @ H @ np.linalg.inv(S)  # homography given in full-res pixels
    inv = np.linalg.inv(Hs)
    inv = inv / inv[2, 2]
    im = Image.fromarray(arr)
    warped = im.transform(im.size, Image.PERSPECTIVE, data=inv.flatten()[:8].tolist(), resample=Image.BILINEAR)
    return np.asarray(warped, dtype=np.float32)


def xmp_float_or(xmp: dict, key: str, default: float) -> float:
    from app.services.metadata_service import xmp_float

    v = xmp_float(xmp, key)
    return default if v is None else v


def frame_band_paths(images: list[models.SurveyImage], frame_key: str) -> dict[str, Path]:
    return {img.band: img.path for img in images if img.frame_key == frame_key}


def compute_index_for_frame(bands: dict[str, Path], index: str, max_dim: int | None = None) -> np.ndarray:
    if index not in INDEX_BANDS:
        raise ValueError(f"Unknown index {index}")
    a_name, b_name = INDEX_BANDS[index]
    if a_name not in bands or b_name not in bands:
        raise BandsUnavailableError(f"{index.upper()} needs {a_name} and {b_name} bands")
    a = load_band(bands[a_name], max_dim)
    b = load_band(bands[b_name], max_dim)
    if a.shape != b.shape:
        raise BandsUnavailableError(f"{a_name}/{b_name} band sizes differ ({a.shape} vs {b.shape})")
    return _safe_normalized_difference(a, b)


def compute_frame_stats(bands: dict[str, Path]) -> FrameIndexStats:
    stats = FrameIndexStats()
    loaded: dict[str, np.ndarray] = {}  # each band decoded once per frame

    def band(name: str) -> np.ndarray:
        if name not in loaded:
            loaded[name] = load_band(bands[name], STATS_MAX_DIM)
        return loaded[name]

    for index, (a_name, b_name) in INDEX_BANDS.items():
        if a_name not in bands or b_name not in bands:
            continue
        a, b = band(a_name), band(b_name)
        if a.shape != b.shape:
            continue
        arr = _safe_normalized_difference(a, b)
        setattr(stats, f"{index}_mean", float(arr.mean()))
        if index == "ndvi":
            stats.vegetation_fraction = float((arr > NDVI_VEGETATION_THRESHOLD).mean())
    return stats


def render_index_preview_png(bands: dict[str, Path], index: str) -> bytes:
    """Colorizes a frame's index on the app's red/amber/green scale."""
    from app.services.orthomosaic_service import _colorize_index

    arr = compute_index_for_frame(bands, index, max_dim=PREVIEW_MAX_DIM)
    rgba = _colorize_index(arr, np.ones(arr.shape, dtype=bool))
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    return buf.getvalue()


def render_band_display_png(path: Path, max_dim: int = 1600) -> bytes:
    """16-bit single-band TIF -> browser-viewable 8-bit grayscale PNG via a
    2-98 percentile stretch of the raw DN (no calibration)."""
    arr = load_band(path, max_dim)
    lo, hi = np.percentile(arr, [2, 98])
    if hi <= lo:
        hi = lo + 1.0
    out = (np.clip((arr - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(out, mode="L").save(buf, format="PNG")
    return buf.getvalue()
