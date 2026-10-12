"""Multispectral orthophotos on the photogrammetric camera solution, on the GPU.

The quick index mosaics (mosaic_service) place every band frame from its GPS
position and the gimbal's reported attitude onto a flat plane. Measured
against the OpenDroneMap reconstruction of the Ditty Road flight that is
2-4 m off (the M3M camera looks ~7° away from the reported -90°, and the error
flips between flight lines), and overlaps are averaged, so features smear.

This module builds the band products on the geometry ODM solved instead:
camera centres within ~2 cm of the RTK positions, attitudes from bundle
adjustment (~4 px reprojection on the survey's GCP targets), and the DSM.

1. Rig calibration. The M3M's four band cameras sit beside its RGB camera on
   one gimbal, so each band camera's rotation relative to the RGB camera is a
   fixed property of the drone. It is measured from the survey itself: for a
   spread of captures, the band image (through its own DewarpData lens model)
   is compared with what that camera should see — the ODM orthophoto for
   Green and Red, the already-calibrated Green band for Red Edge and NIR —
   by phase correlation of gradient magnitudes in a grid of windows; with the
   camera centre known, the attitude that explains those offsets is a
   rotation fit (Wahba). The average over captures is the rig rotation.
2. Orthorectification. Every output pixel (UTM grid at ~native GSD) takes its
   height from the DSM, is projected into each capture's four band cameras,
   and takes all four bands from the one capture that sees it closest to
   vertical — winner-takes-all, never averaged, so nothing is drawn twice and
   the bands of a pixel always come from the same exposure.
3. Radiometry: multispectral_service.BandCalibration (DJI's M3M workflow as
   ODM implements it), applied on the GPU.

Outputs (SurveyAssets, source=SOURCE), data/surveys/<id>/outputs/:
  band_green|band_red|band_red_edge|band_nir  uint16 relative reflectance (scale tag), 0 = nodata
  ndvi|ndre|gndvi                             float32 index, NaN = nodata
  false_color                                 uint8 colour-infrared (NIR, Red, Green -> R, G, B)
  alignment_check                             uint8 (NIR band -> R, photo green -> G and B): coloured
                                              fringes wherever the band map and the photo disagree
  band_ortho_qa.json                          rig, band-to-band and band-to-photo offsets, GCP check
"""

from __future__ import annotations

import json
import logging
import math
import time
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from sqlalchemy.orm import Session

from app import models
from app.config import settings
from app.services import gpu
from app.services import multispectral_service as ms
from app.services.camera_model import (
    BrownCamera,
    SurfaceModel,
    gradient_magnitude,
    mean_rotation,
    phase_correlate,
    rodrigues,
    rotation_angle_deg,
    sample_image,
    solve_rotation_ransac,
)
from app.services.metadata_service import dji_xmp_from_image
from app.services.mosaic_service import parse_dewarp

log = logging.getLogger(__name__)

SOURCE = "photogrammetry_gpu"
BANDS = ("GREEN", "RED", "RED_EDGE", "NIR")
BAND_ASSET = {"GREEN": "band_green", "RED": "band_red", "RED_EDGE": "band_red_edge", "NIR": "band_nir"}
INDEX_ASSETS = tuple(ms.INDEX_BANDS)  # ndvi, ndre, gndvi
COMPOSITE_ASSETS = ("false_color", "alignment_check")
TILE_LAYERS = (*BAND_ASSET.values(), *INDEX_ASSETS, *COMPOSITE_ASSETS)

DEFAULT_GSD_M = 0.015  # M3M bands resolve ~1.35 cm at 29 m above the crop
VALUE_SCALE = 1000.0  # relative reflectance (~1e-3) -> ~1 on the float16 canvas
RIG_SAMPLES = 24
RIG_WORK_SCALE = 0.5  # rig calibration runs on half-resolution renders
RIG_WINDOW = 128  # px at work scale (~3.4 m)
RIG_STEP = 96
RIG_REFERENCE = {"GREEN": "ortho", "RED": "ortho", "RED_EDGE": "GREEN", "NIR": "GREEN"}
ORTHO_CHANNEL = {"GREEN": (0.0, 1.0, 0.0), "RED": (1.0, 0.0, 0.0)}  # weights of the photo's R, G, B
EDGE_MARGIN_PX = 4  # band pixels this close to the image border are not used
REFINE_MAX_DEG = 0.3  # a per-capture fit further than this from the rig prediction is not trusted
BALANCE_CELL_M = 1.0  # radiometric balancing compares overlapping captures in cells this size
BALANCE_MAX_TAN = 0.35  # ... using only what each capture sees within ~19° of vertical
REFERENCE_GSD_M = 0.025
ALIGN_WINDOW = 128  # px: final co-registration windows (~1.9 m at 1.5 cm)
ALIGN_STEP = 64  # px between them (~1 m)
ALIGN_MAX_M = 0.25  # a local offset larger than this is a mismatch, not an error of the camera model
WORKSET_BYTES = 700_000_000  # one capture's four bands + a 2 M-pixel strip of projections
QA_WINDOW = 256
UINT16_TOP = 60000  # the band's 99.9th percentile lands here


@dataclass
class Shot:
    centre: np.ndarray  # (3,) projected CRS
    R: np.ndarray  # world -> RGB camera


@dataclass
class OdmGeometry:
    shots: dict[str, Shot]
    rgb_camera: BrownCamera
    dsm_path: Path
    ortho_path: Path


@dataclass
class Capture:
    key: str
    rgb_filename: str
    shot: Shot
    bands: dict[str, Path]


@dataclass
class Grid:
    x0: float
    y1: float
    gsd: float
    width: int
    height: int
    crs: object

    @property
    def transform(self):
        from rasterio.transform import from_origin

        return from_origin(self.x0, self.y1, self.gsd, self.gsd)


@dataclass
class RigResult:
    rotation: np.ndarray  # RGB camera -> band camera
    captures: int
    residual_px: float  # median reprojection residual of the fit, full-resolution band pixels
    spread_deg: float  # how much the per-capture estimates disagree
    per_capture: list = field(default_factory=list)
    to_green: np.ndarray = field(default_factory=lambda: np.eye(3))  # Green band camera -> this band camera


def odm_geometry(survey: models.Survey) -> OdmGeometry | None:
    """ODM's camera solution for the survey (shots + lens) and its DSM and
    orthophoto, or None when the survey has no imported ODM run."""
    odm = settings.surveys_dir / survey.id / "odm"
    shots_path, cams_path = odm / "odm_report" / "shots.geojson", odm / "cameras.json"
    if not shots_path.exists() or not cams_path.exists():
        return None

    def asset(kind: str) -> Path | None:
        found = [a for a in survey.assets if a.asset_type == kind and a.source == "photogrammetry_odm"
                 and (a.format or "").lower() in ("tif", "tiff") and a.path.exists()]
        return found[0].path if found else None

    dsm, ortho = asset("dsm"), asset("orthomosaic")
    if dsm is None or ortho is None:
        return None
    shots = {}
    for f in json.loads(shots_path.read_text())["features"]:
        p = f["properties"]
        shots[p["filename"]] = Shot(np.asarray(p["translation"], dtype=np.float64), rodrigues(p["rotation"]))
    cam = BrownCamera.from_opensfm(next(iter(json.loads(cams_path.read_text()).values())))
    return OdmGeometry(shots, cam, dsm, ortho)


def captures_for(survey: models.Survey, geom: OdmGeometry) -> list[Capture]:
    """Captures with an ODM-solved RGB shot and all four band files, in capture order."""
    frames: dict[str, dict[str, models.SurveyImage]] = {}
    for img in survey.images:
        frames.setdefault(img.frame_key or img.id, {})[img.band] = img
    out = []
    for key, rows in frames.items():
        rgb = rows.get("RGB")
        if rgb is None or rgb.filename not in geom.shots or not set(BANDS) <= rows.keys():
            continue
        out.append(Capture(key, rgb.filename, geom.shots[rgb.filename], {b: rows[b].path for b in BANDS}))
    return sorted(out, key=lambda c: c.rgb_filename)


# ---------------------------------------------------------------------------
# loading and radiometry
# ---------------------------------------------------------------------------


def _load_capture(cap: Capture):
    """{band: (DN array, BandCalibration | None, xmp)} decoded on a worker thread, or the OSError."""
    out = {}
    try:
        for band, path in cap.bands.items():
            with ms.open_image_safely(path) as im:
                xmp = dji_xmp_from_image(im)
                out[band] = (np.asarray(im, dtype=np.float32), ms.band_calibration(xmp), xmp)
    except OSError as exc:
        return exc
    return out


def _calibrate(torch, dn, cal: ms.BandCalibration | None):
    """DN (H, W) on the device -> relative reflectance × VALUE_SCALE."""
    if cal is None:
        return dn * 1e-3
    x = (dn - cal.black).clamp(min=0)
    if cal.vignetting_coeffs and cal.vignetting_center:
        H, W = x.shape
        ys = torch.arange(H, device=x.device, dtype=torch.float32)[:, None] - cal.vignetting_center[1]
        xs = torch.arange(W, device=x.device, dtype=torch.float32)[None, :] - cal.vignetting_center[0]
        r = torch.sqrt(xs * xs + ys * ys)
        v = torch.ones_like(x)
        rp = torch.ones_like(x)
        for k in cal.vignetting_coeffs:
            rp = rp * r
            v = v + k * rp
        x = x * v
    return x * float(cal.factor * VALUE_SCALE)


def band_cameras(cap: Capture, loaded: dict) -> dict[str, BrownCamera]:
    cams = {}
    for band, (dn, _, xmp) in loaded.items():
        h, w = dn.shape
        d = parse_dewarp(xmp, w, h)
        if d is None:
            raise ValueError(f"{cap.bands[band].name} has no DewarpData lens model")
        cams[band] = BrownCamera.from_dewarp(d, w, h)
    return cams


# ---------------------------------------------------------------------------
# rig calibration
# ---------------------------------------------------------------------------


def _ideal_grid(torch, cam: BrownCamera, device):
    """Normalised ideal-pinhole coordinates of every pixel of `cam` (a work-scale camera)."""
    v, u = torch.meshgrid(torch.arange(cam.height, device=device, dtype=torch.float32),
                          torch.arange(cam.width, device=device, dtype=torch.float32), indexing="ij")
    return (u - cam.cx) / cam.fx, (v - cam.cy) / cam.fy


def _world_dirs(torch, xn, yn, R: np.ndarray):
    """Camera rays (x, y, 1) -> unit world directions, as (..., 3)."""
    d = torch.stack([xn, yn, torch.ones_like(xn)], dim=-1)
    d = d / d.norm(dim=-1, keepdim=True)
    Rt = torch.as_tensor(R, dtype=torch.float32, device=xn.device)
    return d @ Rt  # (R^T d)^T = d^T R


def _project(torch, cam: BrownCamera, R: np.ndarray, C: np.ndarray, x, y, z, margin: float = 0.0):
    """World points -> pixel (u, v) of a full-resolution camera, and validity."""
    dx, dy, dz = x - float(C[0]), y - float(C[1]), z - float(C[2])
    xc = R[0, 0] * dx + R[0, 1] * dy + R[0, 2] * dz
    yc = R[1, 0] * dx + R[1, 1] * dy + R[1, 2] * dz
    zc = R[2, 0] * dx + R[2, 1] * dy + R[2, 2] * dz
    u, v, ok = cam.project(xc, yc, zc)
    return u, v, ok & cam.inside(u, v, margin)


class FieldReference:
    """The photogrammetric orthophoto of the whole field at REFERENCE_GSD_M,
    held on the device (red and green channels + coverage), local coordinates.
    Read once, so every capture can be checked against it without touching disk."""

    def __init__(self, torch, path: Path, origin, device, res: float = 0.025):
        import rasterio
        from rasterio.enums import Resampling
        from rasterio.transform import from_origin
        from rasterio.vrt import WarpedVRT

        with rasterio.open(path) as src:
            x0, y0, x1, y1 = src.bounds
            w, h = int(math.ceil((x1 - x0) / res)), int(math.ceil((y1 - y0) / res))
            with WarpedVRT(src, crs=src.crs, transform=from_origin(x0, y1, res, res), width=w, height=h,
                           resampling=Resampling.average) as vrt:
                a = vrt.read()
        alpha = a[3] > 0 if a.shape[0] >= 4 else np.any(a[:3] > 0, axis=0)
        self.torch, self.res = torch, res
        self.x0, self.y1 = x0 - origin[0], y1 - origin[1]
        self.rgb = torch.from_numpy(np.ascontiguousarray(a[:3])).to(device).to(torch.float16)
        self.valid = torch.from_numpy(alpha.astype(np.float32)).to(device)[None]  # shared by every channel

    def channel(self, weights) -> "_ReferenceChannel":
        return _ReferenceChannel(self, weights)


class _ReferenceChannel:
    """One weighted combination of the photo's channels, built once on the device."""

    def __init__(self, field_ref: FieldReference, weights):
        self.ref = field_ref
        self.img = sum(w * field_ref.rgb[i:i + 1].float() for i, w in enumerate(weights) if w)
        self.valid = field_ref.valid

    def sample(self, x, y, z=None):
        r = self.ref
        u = (x - r.x0) / r.res - 0.5
        v = (r.y1 - y) / r.res - 0.5
        return sample_image(r.torch, self.img, u, v)[0], sample_image(r.torch, self.valid, u, v)[0] > 0.99


class _BandReference:
    """Another band camera of the same capture (already calibrated) as the reference."""

    def __init__(self, torch, img, cam: BrownCamera, R: np.ndarray, C: np.ndarray):
        self.torch, self.img, self.cam, self.R, self.C = torch, img, cam, R, C

    def sample(self, x, y, z):
        u, v, ok = _project(self.torch, self.cam, self.R, self.C, x, y, z, EDGE_MARGIN_PX)
        return sample_image(self.torch, self.img, u, v)[0], ok


def _footprint(torch, cam: BrownCamera, R, C, dsm: SurfaceModel, device, margin_m: float = 0.0):
    """(x0, y0, x1, y1) of the ground the camera's image border sees."""
    n = 24
    t = torch.linspace(0, 1, n, device=device)
    W, H = cam.width - 1, cam.height - 1
    u = torch.cat([t * W, torch.full_like(t, W), (1 - t) * W, torch.zeros_like(t)])
    v = torch.cat([torch.zeros_like(t), t * H, torch.full_like(t, H), (1 - t) * H])
    xn, yn = cam.undistort(u, v)
    x, y, _ = dsm.intersect(C, _world_dirs(torch, xn, yn, R))
    return (float(x.min()) - margin_m, float(y.min()) - margin_m, float(x.max()) + margin_m, float(y.max()) + margin_m)


def _fit_band_rotation(torch, cam_full: BrownCamera, img_full, R_init: np.ndarray, C: np.ndarray,
                       dsm: SurfaceModel, reference, device, window: int = RIG_WINDOW, step: int = RIG_STEP):
    """World->band-camera rotation for one capture that best explains how the
    band image lines up with the reference. Returns (R, residual_px, inliers) or None."""
    cam = cam_full.scaled(RIG_WORK_SCALE)
    xn, yn = _ideal_grid(torch, cam, device)
    # what the band camera recorded, resampled onto an ideal pinhole grid
    xd, yd = cam_full.distort(xn, yn)
    uf, vf = cam_full.fx * xd + cam_full.cx, cam_full.fy * yd + cam_full.cy
    obs = sample_image(torch, img_full[None], uf, vf)[0]
    obs_ok = cam_full.inside(uf, vf, EDGE_MARGIN_PX)
    # what it should see from R_init: rays onto the DSM, then the reference
    x, y, z = dsm.intersect(C, _world_dirs(torch, xn, yn, R_init))
    syn, syn_ok = reference.sample(x, y, z)
    ok = (obs_ok & syn_ok).float()

    def norm(img):
        g = gradient_magnitude(torch, torch.log1p(img.clamp(min=0) / img[ok > 0].median().clamp(min=1e-6))[None])[0]
        return g

    go, gs = norm(obs), norm(syn)
    H, W = go.shape
    ys = list(range(0, H - window + 1, step))
    xs = list(range(0, W - window + 1, step))
    boxes = [(r, c) for r in ys for c in xs if ok[r:r + window, c:c + window].mean() > 0.98]
    if len(boxes) < 8:
        return None
    A = torch.stack([go[r:r + window, c:c + window] for r, c in boxes])
    B = torch.stack([gs[r:r + window, c:c + window] for r, c in boxes])
    dx, dy, resp = phase_correlate(torch, A, B)
    dx, dy, resp = dx.cpu().numpy(), dy.cpu().numpy(), resp.cpu().numpy()
    keep = resp > max(0.02, 0.25 * float(np.median(resp)))
    if keep.sum() < 8:
        return None
    centres = np.array([(c + window / 2 - 0.5, r + window / 2 - 0.5) for r, c in boxes])[keep]
    shifted = centres + np.stack([dx[keep], dy[keep]], axis=1)
    # camera ray of the window centre in the band image ...
    cn = np.stack([(centres[:, 0] - cam.cx) / cam.fx, (centres[:, 1] - cam.cy) / cam.fy, np.ones(len(centres))], axis=1)
    cn /= np.linalg.norm(cn, axis=1, keepdims=True)
    # ... and the ground point the reference shows there
    su = torch.as_tensor(shifted[:, 0], dtype=torch.float32, device=device)
    sv = torch.as_tensor(shifted[:, 1], dtype=torch.float32, device=device)
    pts = sample_image(torch, torch.stack([x, y, z]), su, sv).T.cpu().numpy().astype(np.float64)
    wd = pts - C[None, :]
    wd /= np.linalg.norm(wd, axis=1, keepdims=True)
    R, inl = solve_rotation_ransac(wd, cn, resp[keep], threshold_rad=2.5 / cam.fx)
    if R is None:
        return None
    err = np.linalg.norm(cn[inl] - wd[inl] @ R.T, axis=1) * cam_full.fx
    return R, float(np.median(err)), int(inl.sum())


def calibrate_rig(torch, device, captures: list[Capture], field_ref: FieldReference, dsm: SurfaceModel,
                  samples: int = RIG_SAMPLES) -> tuple[dict[str, RigResult], dict[str, BrownCamera]]:
    """Each band camera's rotation relative to the RGB camera and to the Green
    band camera, measured on a spread of captures (two passes: the second
    starts from the first)."""
    picks = [captures[int(i)] for i in np.linspace(0, len(captures) - 1, min(samples, len(captures)))]
    rig = {b: np.eye(3) for b in BANDS}
    cams: dict[str, BrownCamera] = {}
    results: dict[str, RigResult] = {}
    channels = {b: field_ref.channel(ORTHO_CHANNEL[b]) for b in BANDS if RIG_REFERENCE[b] == "ortho"}
    for pass_no in (1, 2):
        solved_all: list[tuple[str, np.ndarray, dict]] = []  # (capture, R_rgb, {band: (R, resid, inliers)})
        for cap, loaded in gpu.prefetch(picks, _load_capture, workers=4, ahead=4):
            if isinstance(loaded, OSError):
                log.warning("rig: skipping %s (%s)", cap.key, loaded)
                continue
            if not cams:
                cams = band_cameras(cap, loaded)
            imgs = {b: _calibrate(torch, torch.from_numpy(loaded[b][0]).to(device), loaded[b][1]) for b in BANDS}
            C, R_rgb = dsm.local(cap.shot.centre), cap.shot.R
            solved: dict[str, tuple] = {}
            for band in BANDS:  # Green first: Red Edge and NIR are fitted against it
                ref_kind = RIG_REFERENCE[band]
                if ref_kind == "ortho":
                    reference = channels[band]
                elif ref_kind in solved:
                    reference = _BandReference(torch, imgs[ref_kind][None], cams[ref_kind], solved[ref_kind][0], C)
                else:
                    continue
                fit = _fit_band_rotation(torch, cams[band], imgs[band], rig[band] @ R_rgb, C, dsm, reference, device)
                if fit is not None:
                    solved[band] = fit
            solved_all.append((cap.key, R_rgb, solved))

        def robust_mean(est):
            Q = mean_rotation([e[0] for e in est], [e[2] for e in est])
            dev = np.array([rotation_angle_deg(e[0] @ Q.T) for e in est])
            good = dev <= max(0.05, 3 * float(np.median(dev)))
            Q = mean_rotation([e[0] for e, g in zip(est, good) if g], [e[2] for e, g in zip(est, good) if g])
            return Q, dev, good

        green = [(s["GREEN"][0] @ R.T, s["GREEN"][1], s["GREEN"][2], k) for k, R, s in solved_all if "GREEN" in s]
        if len(green) < 3:
            raise RuntimeError(f"rig calibration failed for the Green band ({len(green)} usable captures)")
        Q_green, _, _ = robust_mean(green)
        for band in BANDS:
            if band == "GREEN":
                est = green
                to_green = np.eye(3)
            else:
                pairs = [(s[band][0] @ s["GREEN"][0].T, s[band][1], s[band][2], k)
                         for k, R, s in solved_all if band in s and "GREEN" in s]
                if len(pairs) < 3:
                    raise RuntimeError(f"rig calibration failed for the {band} band ({len(pairs)} usable captures)")
                to_green, _, _ = robust_mean(pairs)
                est = [(s[band][0] @ R.T, s[band][1], s[band][2], k) for k, R, s in solved_all if band in s]
            Q, dev, good = robust_mean(est)
            if band != "GREEN":
                Q = to_green @ Q_green  # consistent with the Green camera the bands are tied to
            rig[band] = Q
            results[band] = RigResult(Q, int(good.sum()), float(np.median([e[1] for e in est])),
                                      float(np.median(dev)),
                                      [{"capture": e[3], "residual_px": round(e[1], 2), "inliers": e[2],
                                        "deviation_deg": round(float(d), 4)} for e, d in zip(est, dev)],
                                      to_green)
            log.info("rig pass %d %s: %.3f deg from the RGB camera (%.3f from Green), %d/%d captures agree "
                     "(spread %.3f deg), fit residual %.2f px", pass_no, band, rotation_angle_deg(Q),
                     rotation_angle_deg(to_green), good.sum(), len(est), np.median(dev), results[band].residual_px)
    return results, cams


# ---------------------------------------------------------------------------
# orthorectification
# ---------------------------------------------------------------------------


def _output_grid(dsm: SurfaceModel, crs, gsd: float) -> Grid:
    valid = dsm.valid.cpu().numpy()
    rows, cols = np.nonzero(valid.any(axis=1))[0], np.nonzero(valid.any(axis=0))[0]
    tf = dsm.transform
    x0, x1 = tf.c + cols[0] * tf.a, tf.c + (cols[-1] + 1) * tf.a
    y1, y0 = tf.f + rows[0] * tf.e, tf.f + (rows[-1] + 1) * tf.e
    x0, y1 = math.floor(x0 / gsd) * gsd, math.ceil(y1 / gsd) * gsd
    return Grid(x0, y1, gsd, int(math.ceil((x1 - x0) / gsd)), int(math.ceil((y1 - y0) / gsd)), crs)


def _orthorectify(torch, device, captures, cams, rig: dict[str, RigResult], dsm: SurfaceModel, grid: Grid,
                  field_ref: FieldReference):
    """Winner-takes-all band canvas (4, H, W) float16, the off-nadir tan of the
    winner (H, W), and per-capture refinement stats.

    Each capture's Green camera is first fitted against the photo (the rig
    prediction from ODM's RGB pose is the start; ODM's own pose error is a
    few cm, so the fit takes it out), and the other bands follow the Green
    camera through the rig — they come from the same exposure."""
    H, W = grid.height, grid.width
    canvas = torch.zeros((len(BANDS), H, W), dtype=torch.float16, device=device)
    best = torch.full((H, W), float("inf"), dtype=torch.float16, device=device)
    winner = torch.full((H, W), -1, dtype=torch.int16, device=device)  # capture index of every pixel
    cell_px = max(1, round(BALANCE_CELL_M / grid.gsd))
    n_cell_cols = -(-W // cell_px)
    overlaps = []  # (capture index, cell ids, per-band mean over the cell) for the balancing
    green_ref = field_ref.channel(ORTHO_CHANNEL["GREEN"])
    used, refined, residuals, corrections = 0, 0, [], []
    for i, (cap, loaded) in enumerate(gpu.prefetch(captures, _load_capture, workers=6, ahead=6), 1):
        if isinstance(loaded, OSError):
            log.warning("band ortho: skipping %s (%s)", cap.key, loaded)
            continue
        imgs = {b: _calibrate(torch, torch.from_numpy(loaded[b][0]).to(device), loaded[b][1])[None] for b in BANDS}
        C = cap.shot.centre  # absolute
        C_loc = dsm.local(C)
        R_green = rig["GREEN"].rotation @ cap.shot.R
        fit = _fit_band_rotation(torch, cams["GREEN"], imgs["GREEN"][0], R_green, C_loc, dsm, green_ref, device)
        if fit is not None and rotation_angle_deg(fit[0] @ R_green.T) <= REFINE_MAX_DEG:
            corrections.append(rotation_angle_deg(fit[0] @ R_green.T))
            R_green = fit[0]
            residuals.append(fit[1])
            refined += 1
        Rb = {b: rig[b].to_green @ R_green for b in BANDS}
        fx0, fy0, fx1, fy1 = None, None, None, None
        for b in BANDS:
            x0, y0, x1, y1 = _footprint(torch, cams[b], Rb[b], C_loc, dsm, device, margin_m=0.5)
            fx0 = x0 if fx0 is None else min(fx0, x0)
            fy0 = y0 if fy0 is None else min(fy0, y0)
            fx1 = x1 if fx1 is None else max(fx1, x1)
            fy1 = y1 if fy1 is None else max(fy1, y1)
        ox, oy = dsm.origin
        c0 = max(0, int((fx0 + ox - grid.x0) / grid.gsd))
        c1 = min(W, int(math.ceil((fx1 + ox - grid.x0) / grid.gsd)))
        r0 = max(0, int((grid.y1 - (fy1 + oy)) / grid.gsd))
        r1 = min(H, int(math.ceil((grid.y1 - (fy0 + oy)) / grid.gsd)))
        if c1 <= c0 or r1 <= r0:
            continue
        # pixel centres relative to the camera: float64 for the subtraction, float32 after
        xs = (grid.x0 - C[0]) + (torch.arange(c0, c1, device=device, dtype=torch.float64) + 0.5) * grid.gsd
        strip = max(64, 2_000_000 // (c1 - c0))
        cr0, cc0 = r0 // cell_px, c0 // cell_px
        ncr, ncc = (r1 - 1) // cell_px - cr0 + 1, (c1 - 1) // cell_px - cc0 + 1
        cell_sum = torch.zeros((len(BANDS), ncr * ncc), dtype=torch.float32, device=device)
        cell_cnt = torch.zeros(ncr * ncc, dtype=torch.float32, device=device)
        col_cell = (torch.arange(c0, c1, device=device) // cell_px - cc0)[None, :]
        for s0 in range(r0, r1, strip):
            s1 = min(s0 + strip, r1)
            ys = (grid.y1 - C[1]) - (torch.arange(s0, s1, device=device, dtype=torch.float64) + 0.5) * grid.gsd
            X = xs[None, :].float().expand(s1 - s0, -1)
            Y = ys[:, None].float().expand(-1, c1 - c0)
            Z = dsm.height(X + float(C_loc[0]), Y + float(C_loc[1])) - float(C[2])
            tan_off = torch.sqrt(X * X + Y * Y) / (-Z).clamp(min=1e-3)
            ok = Z < 0
            uv = {}
            for b in BANDS:
                R = Rb[b]
                xc = R[0, 0] * X + R[0, 1] * Y + R[0, 2] * Z
                yc = R[1, 0] * X + R[1, 1] * Y + R[1, 2] * Z
                zc = R[2, 0] * X + R[2, 1] * Y + R[2, 2] * Z
                u, v, okb = cams[b].project(xc, yc, zc)
                ok &= okb & cams[b].inside(u, v, EDGE_MARGIN_PX)
                uv[b] = (u, v)
            cur = best[s0:s1, c0:c1]
            win = ok & (tan_off < cur.float())
            seen = ok & (tan_off < BALANCE_MAX_TAN)  # well-seen ground, for the radiometric balancing
            any_win, any_seen = bool(win.any()), bool(seen.any())
            if not any_win and not any_seen:
                continue
            cell = ((torch.arange(s0, s1, device=device) // cell_px - cr0)[:, None] * ncc + col_cell)[seen]
            for k, b in enumerate(BANDS):
                val = sample_image(torch, imgs[b], *uv[b])[0]
                if any_seen:
                    cell_sum[k].index_add_(0, cell, val[seen])
                if any_win:
                    dst = canvas[k, s0:s1, c0:c1]
                    dst.copy_(torch.where(win, val.to(torch.float16), dst))
            if any_seen:
                cell_cnt.index_add_(0, cell, torch.ones_like(cell, dtype=torch.float32))
            if any_win:
                cur.copy_(torch.where(win, tan_off.to(torch.float16), cur))
                wdst = winner[s0:s1, c0:c1]
                wdst.copy_(torch.where(win, torch.full_like(wdst, i - 1), wdst))
        full = cell_cnt >= 0.5 * cell_px * cell_px
        if bool(full.any()):
            local = torch.nonzero(full)[:, 0]
            ids = (local // ncc + cr0) * n_cell_cols + (local % ncc + cc0)
            means = (cell_sum[:, local] / cell_cnt[local]).T
            overlaps.append((i - 1, ids.cpu().numpy(), means.cpu().numpy()))
        used += 1
        if i % 25 == 0:
            log.info("band ortho: %d/%d captures", i, len(captures))
    stats = {"captures": used, "refined_against_photo": refined,
             "median_fit_residual_px": round(float(np.median(residuals)), 2) if residuals else None,
             "median_correction_deg": round(float(np.median(corrections)), 4) if corrections else None}
    gains, stats["balancing"] = _balance_gains(overlaps, len(captures))
    _apply_gains(torch, canvas, winner, gains)
    del winner
    return canvas, best, stats


def _clip_to_photo(torch, best, grid: Grid, field_ref: FieldReference, origin) -> None:
    """Marks pixels outside the photogrammetric orthophoto's coverage as empty,
    so every layer shares the photo's outline: past it the DSM is extrapolated
    (no measured ground height) and the band coverage ends in single-capture
    sawteeth."""
    W = grid.width
    xs = (grid.x0 - origin[0]) + (torch.arange(W, device=best.device, dtype=torch.float64) + 0.5) * grid.gsd
    for r0 in range(0, grid.height, 1024):
        r1 = min(r0 + 1024, grid.height)
        ys = (grid.y1 - origin[1]) - (torch.arange(r0, r1, device=best.device, dtype=torch.float64) + 0.5) * grid.gsd
        X = xs[None, :].float().expand(r1 - r0, -1)
        Y = ys[:, None].float().expand(-1, W)
        u = (X - field_ref.x0) / field_ref.res - 0.5
        v = (field_ref.y1 - Y) / field_ref.res - 0.5
        inside = sample_image(torch, field_ref.valid, u, v)[0] > 0.5
        dst = best[r0:r1]
        dst.copy_(torch.where(inside, dst, torch.full_like(dst, float("inf"))))


def _balance_gains(overlaps, n_captures: int):
    """One brightness gain per capture and band so overlapping captures agree.

    The sun sensor normalises the light each exposure saw, but under passing
    cloud the field and the drone are not always in the same light: on the
    Ditty Road flight neighbouring captures still differed by up to ~2x, which
    shows as hard steps in a winner-takes-all mosaic. Each capture's mean in
    1 m cells it shares with others is compared in log space; the gains (robust,
    iterated) make the shared cells agree, normalised so their median is 1 —
    the calibrated level is kept, only the differences are removed."""
    if not overlaps:
        return np.ones((len(BANDS), n_captures), np.float32), {}
    cap = np.concatenate([np.full(len(o[1]), o[0]) for o in overlaps])
    cells = np.concatenate([o[1] for o in overlaps])
    means = np.concatenate([o[2] for o in overlaps])
    _, cell_idx = np.unique(cells, return_inverse=True)
    shared = np.bincount(cell_idx)[cell_idx] >= 2
    gains = np.ones((len(BANDS), n_captures), np.float32)
    info = {}
    for k, band in enumerate(BANDS):
        ok = shared & (means[:, k] > 0)
        c, ci, l = cap[ok], cell_idx[ok], np.log(means[ok, k])
        x = np.zeros(n_captures)
        w = np.ones(len(l))
        has = np.bincount(c, minlength=n_captures) > 0

        def disagreement(xv):
            v = l + xv[c]
            L = np.bincount(ci, weights=v, minlength=ci.max() + 1) / np.maximum(np.bincount(ci, minlength=ci.max() + 1), 1)
            return float(np.median(np.abs(v - L[ci])))

        before = disagreement(x)
        for _ in range(40):
            v = l + x[c]
            nw = np.bincount(ci, weights=w, minlength=ci.max() + 1)
            L = np.bincount(ci, weights=w * v, minlength=ci.max() + 1) / np.maximum(nw, 1e-9)
            r = L[ci] - v
            w = 1.0 / (1.0 + (r / 0.15) ** 2)
            dx = np.bincount(c, weights=w * r, minlength=n_captures) / np.maximum(np.bincount(c, weights=w, minlength=n_captures), 1e-9)
            x[has] += dx[has]
            x -= np.median(x[has])
        x = np.clip(x, math.log(1 / 3), math.log(3))
        gains[k] = np.exp(x).astype(np.float32)
        info[band] = {"overlap_disagreement_before_pct": round(100 * (math.exp(before) - 1), 1),
                      "overlap_disagreement_after_pct": round(100 * (math.exp(disagreement(x)) - 1), 1),
                      "gain_min": round(float(gains[k][has].min()), 3), "gain_max": round(float(gains[k][has].max()), 3)}
    log.info("band ortho balancing: %s", info)
    return gains, info


def _apply_gains(torch, canvas, winner, gains: np.ndarray) -> None:
    g = torch.as_tensor(gains, device=canvas.device)
    for r0 in range(0, winner.shape[0], 1024):
        w = winner[r0:r0 + 1024].long()
        has = w >= 0
        idx = w.clamp(min=0)
        for k in range(len(BANDS)):
            dst = canvas[k, r0:r0 + 1024]
            dst.copy_(torch.where(has, (dst.float() * g[k][idx]).to(torch.float16), dst))


# ---------------------------------------------------------------------------
# products
# ---------------------------------------------------------------------------


def _percentiles(torch, values, qs, mask=None):
    """Quantiles of the finite values (where mask), from a random sample of a
    large raster: sampling before masking spares the int64 index of every
    selected pixel that boolean indexing builds (1.5 GB on a 1.5 cm field)."""
    flat = values.reshape(-1)
    keep = mask.reshape(-1) if mask is not None else None
    if flat.numel() > 16_000_000:
        idx = torch.randint(0, flat.numel(), (16_000_000,), device=flat.device)
        flat = flat[idx]
        keep = keep[idx] if keep is not None else None
    ok = torch.isfinite(flat) if keep is None else keep & torch.isfinite(flat)
    v = flat[ok].float()
    if v.numel() > 8_000_000:
        v = v[torch.randint(0, v.numel(), (8_000_000,), device=v.device)]
    return [float(x) for x in torch.quantile(v, torch.tensor(qs, device=v.device))]


def _read_photo_green(torch, ortho_path: Path, grid: Grid, device):
    """The photo's green channel and its coverage on the band grid, on the device."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT

    with rasterio.open(ortho_path) as src, WarpedVRT(src, crs=grid.crs, transform=grid.transform, width=grid.width,
                                                      height=grid.height, resampling=Resampling.bilinear) as vrt:
        a = vrt.read([2, 4] if src.count >= 4 else [2])
    green = torch.from_numpy(np.ascontiguousarray(a[0])).to(device)
    valid = torch.from_numpy(a[1] > 0 if a.shape[0] > 1 else a[0] > 0).to(device)
    return green, valid


def _offset_field(torch, ref, img, valid, grid: Grid):
    """Local offsets of img against ref, in pixels, on the window grid (nr, nc, 2),
    such that img(x + d(x)) ~ ref(x): phase correlation of gradient magnitude
    (insensitive to the bands' different brightness) in ALIGN_WINDOW windows
    every ALIGN_STEP, weak or implausible ones dropped, then ones that disagree
    with their neighbours (3x3 median), the gaps filled from the nearest
    measurement and the field smoothed. Returns (field, summary), field None
    when too few windows measure."""
    from scipy import ndimage

    N, step = ALIGN_WINDOW, ALIGN_STEP
    frac = torch.nn.functional.avg_pool2d(valid.float()[None, None], N, step)[0, 0].cpu().numpy()
    nr, nc = frac.shape
    field = np.full((nr, nc, 2), np.nan, np.float32)
    for i in range(nr):
        js = np.nonzero(frac[i] > 0.999)[0]
        if not len(js):
            continue
        r = i * step
        a = torch.stack([ref[r:r + N, j * step:j * step + N] for j in js]).float()
        b = torch.stack([img[r:r + N, j * step:j * step + N] for j in js]).float()
        dx, dy, resp = phase_correlate(torch, gradient_magnitude(torch, torch.log1p(a.clamp(min=0))),
                                       gradient_magnitude(torch, torch.log1p(b.clamp(min=0))))
        dx, dy, resp = dx.cpu().numpy(), dy.cpu().numpy(), resp.cpu().numpy()
        good = (resp > 0.05) & (np.hypot(dx, dy) * grid.gsd <= ALIGN_MAX_M)
        field[i, js[good], 0] = dx[good]
        field[i, js[good], 1] = dy[good]
    measured = np.isfinite(field[..., 0])
    if measured.sum() < 20:
        return None, {"reason": f"only {int(measured.sum())} usable windows"}
    outlier = np.zeros(measured.shape, bool)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-empty neighbourhoods
        for c in range(2):
            med = ndimage.generic_filter(field[..., c], np.nanmedian, size=3, mode="nearest")
            outlier |= np.abs(field[..., c] - med) > 1.5
    field[outlier] = np.nan  # both components: a window half-dropped would leave a NaN for the smoothing to spread
    kept = np.isfinite(field).all(-1)
    if kept.sum() < 20:
        return None, {"reason": f"only {int(kept.sum())} consistent windows"}
    idx = ndimage.distance_transform_edt(~kept, return_distances=False, return_indices=True)
    field = field[idx[0], idx[1]]
    for c in range(2):
        field[..., c] = ndimage.gaussian_filter(field[..., c], 1.0, mode="nearest")
    mag = np.hypot(field[..., 0], field[..., 1])[measured] * grid.gsd * 100
    return field, {"windows": int(measured.sum()), "dropped": int(outlier.sum()),
                   "shift_median_cm": round(float(np.median(mag)), 2),
                   "shift_p90_cm": round(float(np.percentile(mag, 90)), 2), "shift_max_cm": round(float(mag.max()), 2)}


def _align_to_photo(torch, canvas, best, photo, photo_valid, grid: Grid) -> dict:
    """Final co-registration of the band maps onto the photo.

    The camera solution leaves ~1.3 cm (median) between the band maps and the
    photo inside the field, but 3-6 cm within a few metres of the band
    coverage's edge, where the ground is only seen by the corners of the
    outer flight line's images (steep views, where small errors in the lens
    model, the attitude and the DSM add up). And each band's own camera model
    leaves smooth patches of its own: Red, the band with the largest rig fit
    residual, sat 1-3 cm off Green over a quarter of the field.

    So the Green band's local offsets are measured against the photo, every
    other band's against Green, and each band is resampled once through the
    sum of the two fields (Green's offset plus its own against Green; the
    fields are smooth and a few pixels at most, so summing instead of
    composing them is exact to well under a pixel). A pixel stays covered
    only where every band's source pixel is."""
    H, W = best.shape
    N, step = ALIGN_WINDOW, ALIGN_STEP
    covered = torch.isfinite(best)
    k_green = BANDS.index("GREEN")
    green, summary = _offset_field(torch, photo, canvas[k_green], covered & photo_valid, grid)
    if green is None:
        return {"applied": False, **summary}
    out = {"applied": True, "window_m": round(N * grid.gsd, 2), "GREEN_vs_photo": summary}
    fields = []
    for k, b in enumerate(BANDS):
        if k == k_green:
            fields.append(green)
            continue
        own, out[f"{b}_vs_GREEN"] = _offset_field(torch, canvas[k_green], canvas[k], covered, grid)
        fields.append(green if own is None else green + own)

    # resample every band through its field, strip by strip, and the coverage through all of them
    nr, nc = green.shape[:2]
    centre0 = N / 2 - 0.5  # pixel position of the first window's centre
    device = best.device

    def coords(disp, r0, r1):
        rows = torch.arange(r0, r1, device=device, dtype=torch.float32)[:, None].expand(-1, W)
        cols = torch.arange(W, device=device, dtype=torch.float32)[None, :].expand(r1 - r0, -1)
        gu = ((cols - centre0) / step).clamp(0, nc - 1)  # beyond the outermost windows: their value
        gv = ((rows - centre0) / step).clamp(0, nr - 1)
        d = sample_image(torch, disp, gu, gv)  # (2, h, W)
        return cols + d[0], rows + d[1]

    def clamp_coords(u, v):
        return u.clamp(0, W - 1), v.clamp(0, H - 1)

    disps = [torch.from_numpy(np.ascontiguousarray(np.moveaxis(f, -1, 0))).to(device) for f in fields]  # (2, nr, nc)
    for k, disp in enumerate(disps):
        src = canvas[k].float()[None]
        res = torch.empty_like(canvas[k])
        for r0 in range(0, H, 1024):
            r1 = min(r0 + 1024, H)
            u, v = clamp_coords(*coords(disp, r0, r1))
            res[r0:r1] = sample_image(torch, src, u, v)[0].to(torch.float16)
        canvas[k].copy_(res)
        del src, res
    empty_src = (~covered).float()[None]
    for r0 in range(0, H, 1024):
        r1 = min(r0 + 1024, H)
        lost = torch.zeros((r1 - r0, W), dtype=torch.bool, device=device)
        for disp in disps:
            u, v = coords(disp, r0, r1)
            lost |= (u < 0) | (u > W - 1) | (v < 0) | (v > H - 1)
            lost |= sample_image(torch, empty_src, *clamp_coords(u, v), mode="nearest")[0] > 0.5
        dst = best[r0:r1]
        dst.copy_(torch.where(lost, torch.full_like(dst, float("inf")), torch.zeros_like(dst)))
    return out


def _write_products(torch, canvas, best, grid: Grid, out_dir: Path, photo, photo_valid) -> tuple[dict[str, Path], dict]:
    import rasterio
    from rasterio.windows import Window

    out_dir.mkdir(parents=True, exist_ok=True)
    valid = torch.isfinite(best)
    stats = {}
    for k, b in enumerate(BANDS):
        lo, hi, top = _percentiles(torch, canvas[k], [0.02, 0.98, 0.999], valid)
        stats[b] = {"p2": lo, "p98": hi, "p999": top, "uint16_per_unit": UINT16_TOP / max(top, 1e-6)}

    # the photo's green channel, stretched over its own field coverage, for the alignment check
    g_lo, g_hi = _percentiles(torch, photo, [0.02, 0.98], photo_valid)

    common = dict(driver="GTiff", width=grid.width, height=grid.height, crs=grid.crs, transform=grid.transform,
                  tiled=True, blockxsize=512, blockysize=512, compress="deflate", BIGTIFF="IF_SAFER")
    paths = {asset: out_dir / f"{asset}.tif" for asset in TILE_LAYERS}
    dsts = {}
    for b in BANDS:
        d = rasterio.open(paths[BAND_ASSET[b]], "w", count=1, dtype="uint16", nodata=0, predictor=2, **common)
        d.scales = (1.0 / (stats[b]["uint16_per_unit"] * VALUE_SCALE),)
        d.set_band_description(1, f"{b.lower()} relative reflectance")
        dsts[BAND_ASSET[b]] = d
    for idx in INDEX_ASSETS:
        dsts[idx] = rasterio.open(paths[idx], "w", count=1, dtype="float32", nodata=float("nan"), predictor=3, **common)
    for comp in COMPOSITE_ASSETS:
        dsts[comp] = rasterio.open(paths[comp], "w", count=3, dtype="uint8", nodata=0, photometric="RGB", **common)

    def stretch(x, lo, hi):
        return ((x - lo) / max(hi - lo, 1e-6)).clamp(0, 1) * 254 + 1

    try:
        STRIP = 1024
        for r0 in range(0, grid.height, STRIP):
            r1 = min(r0 + STRIP, grid.height)
            win = Window(0, r0, grid.width, r1 - r0)
            v = valid[r0:r1]
            bands = {b: canvas[k, r0:r1].float() for k, b in enumerate(BANDS)}
            for b in BANDS:
                q = (bands[b] * stats[b]["uint16_per_unit"]).round().clamp(1, 65535)
                dsts[BAND_ASSET[b]].write(torch.where(v, q, torch.zeros_like(q)).cpu().numpy().astype(np.uint16), 1, window=win)
            for idx, (a_name, b_name) in ms.INDEX_BANDS.items():
                a, bb = bands[a_name], bands[b_name]
                den = a + bb
                val = torch.where(v & (den > 0), (a - bb) / den.clamp(min=1e-9), torch.full_like(a, float("nan")))
                dsts[idx].write(val.cpu().numpy().astype(np.float32), 1, window=win)
            vz = v.cpu().numpy()
            cir = [stretch(bands[b], stats[b]["p2"], stats[b]["p98"]) for b in ("NIR", "RED", "GREEN")]
            cir = np.stack([torch.where(v, c, torch.zeros_like(c)).cpu().numpy() for c in cir]).astype(np.uint8)
            dsts["false_color"].write(cir, window=win)
            nir = torch.where(v, stretch(bands["NIR"], stats["NIR"]["p2"], stats["NIR"]["p98"]),
                              torch.zeros_like(bands["NIR"])).cpu().numpy()
            g = photo[r0:r1].float().cpu().numpy()
            gs = np.clip((g - g_lo) / max(g_hi - g_lo, 1e-6), 0, 1) * 254 + 1
            both = vz & photo_valid[r0:r1].cpu().numpy()
            chk = np.stack([np.where(both, nir, 0), np.where(both, gs, 0), np.where(both, gs, 0)]).astype(np.uint8)
            dsts["alignment_check"].write(chk, window=win)
    finally:
        for d in dsts.values():
            d.close()
    return paths, stats


# ---------------------------------------------------------------------------
# quality checks
# ---------------------------------------------------------------------------


def _qa_shifts(torch, canvas, valid, grid: Grid, check_path: Path) -> dict:
    """Local offsets, in cm, of each band against Green and of Green against the photo."""
    import rasterio
    from rasterio.windows import Window

    H, W = valid.shape
    N, step = QA_WINDOW, QA_WINDOW * 2
    boxes = [(r, c) for r in range(0, H - N + 1, step) for c in range(0, W - N + 1, step)
             if bool(valid[r:r + N, c:c + N].all())]
    out: dict = {"windows": len(boxes), "window_m": round(N * grid.gsd, 2)}
    if len(boxes) < 4:
        return out

    def stats(dx, dy, resp):
        m = (resp > 0.03).cpu().numpy()
        d = torch.sqrt(dx * dx + dy * dy).cpu().numpy()[m] * grid.gsd * 100
        if d.size == 0:
            return {"n": 0}
        return {"n": int(d.size), "median_cm": round(float(np.median(d)), 2), "p90_cm": round(float(np.percentile(d, 90)), 2)}

    def windows(k):
        img = torch.stack([canvas[k, r:r + N, c:c + N].float() for r, c in boxes])
        return gradient_magnitude(torch, torch.log1p(img.clamp(min=0)))

    ref = windows(BANDS.index("GREEN"))
    for k, b in enumerate(BANDS):
        if b == "GREEN":
            continue
        out[f"{b.lower()}_vs_green"] = stats(*phase_correlate(torch, ref, windows(k)))
    with rasterio.open(check_path) as src:
        photo = np.stack([src.read(2, window=Window(c, r, N, N)) for r, c in boxes]).astype(np.float32)
    photo_t = gradient_magnitude(torch, torch.log1p(torch.from_numpy(photo).to(canvas.device)))
    out["green_vs_photo"] = stats(*phase_correlate(torch, photo_t, ref))
    return out


def check_gcps_in_bands(survey: models.Survey, paths: dict[str, Path] | None = None) -> list[dict]:
    """Where each ground control target found in the photo sits in the band
    orthophotos (Green and NIR GeoTIFFs): offset in cm and pattern score."""
    import rasterio
    from rasterio.warp import transform as warp
    from rasterio.windows import from_bounds

    from app.services import gcp_service

    if paths is None:
        paths = {a.asset_type: a.path for a in survey.assets if a.source == SOURCE and a.format == "tif"}
    bands = {k: paths.get(f"band_{k}") for k in ("green", "nir")}
    if not all(bands.values()):
        return []
    torch = gpu.cuda_torch()
    if torch is None:
        import torch  # noqa: PLC0415 — CPU fallback
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    out = []
    for g in sorted(survey.gcps, key=gcp_service.sort_key):
        row: dict = {"name": g.name}
        for key, path in bands.items():
            with rasterio.open(path) as src:
                (x,), (y,) = warp("EPSG:4326", src.crs, [g.lon], [g.lat])
                win = from_bounds(x - 1.0, y - 1.0, x + 1.0, y + 1.0, src.transform).round_offsets().round_lengths()
                a = src.read(1, window=win, boundless=True, fill_value=0).astype(np.float32)
                wx0, wy1 = src.transform * (win.col_off, win.row_off)
                res = abs(src.res[0])
            if not (a > 0).all():
                row[key] = {"status": "outside the band maps"}
                continue
            # a 17 cm marker is only ~11 px wide in a 1.5 cm band map, and straw or
            # shadow 20-30 cm away can match its pattern better than the marker
            # itself (seen in Green): search no further than the marker's own half
            # side — the bands sit ~0.1 cm from the photo, so that is ample
            half_side = (g.size_m or 0.6) / 2
            found = gcp_service.refine_target(torch, torch.from_numpy(a).to(dev), wx0, wy1, res, x, y,
                                              search_m=0.6 if half_side >= 0.2 else 0.08, half_side_m=half_side)
            if found is None:
                row[key] = {"status": "target not recognisable"}
                continue
            fx, fy, score = found
            row[key] = {"offset_cm": round(math.hypot(fx - x, fy - y) * 100, 1), "east_cm": round((fx - x) * 100, 1),
                        "north_cm": round((fy - y) * 100, 1), "score": round(score, 2)}
        out.append(row)
    return out


def update_qa_gcps(survey: models.Survey) -> list[dict] | None:
    """Re-checks the GCPs in the existing band orthophotos and rewrites that
    part of band_ortho_qa.json (after the targets were detected again)."""
    from app.services.storage_service import survey_dir

    qa_path = survey_dir(survey.id) / "outputs" / "band_ortho_qa.json"
    if not qa_path.exists():
        return None
    checks = check_gcps_in_bands(survey)
    qa = json.loads(qa_path.read_text())
    qa["gcps"] = checks
    qa_path.write_text(json.dumps(qa, indent=2))
    return checks


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------


def build_band_orthos(db: Session, survey: models.Survey, gsd_m: float = DEFAULT_GSD_M) -> list[models.SurveyAsset] | None:
    """Builds and registers the band, index and composite orthophotos. None when
    the survey has no imported ODM run or no multispectral frames."""
    import rasterio

    from app.services.orthomosaic_service import extract_bounds_geojson
    from app.services.storage_service import survey_dir

    geom = odm_geometry(survey)
    if geom is None:
        log.info("band ortho: no ODM camera solution for survey %s, skipped", survey.id)
        return None
    captures = captures_for(survey, geom)
    if len(captures) < 3:
        log.info("band ortho: %d captures with an ODM shot and all four bands, skipped", len(captures))
        return None

    torch_mod = gpu.cuda_torch()
    if torch_mod is None:
        import torch as torch_mod  # noqa: PLC0415 — CPU fallback, slow
        device = "cpu"
        log.warning("band ortho: CUDA is not available, running on the CPU (slow)")
    else:
        device = "cuda"
    torch = torch_mod
    t0 = time.monotonic()
    with rasterio.open(geom.dsm_path) as src:
        crs = src.crs
    dsm = SurfaceModel.from_file(torch, geom.dsm_path, device)
    field_ref = FieldReference(torch, geom.ortho_path, dsm.origin, device, REFERENCE_GSD_M)

    rig, cams = calibrate_rig(torch, device, captures, field_ref, dsm)
    t_rig = time.monotonic() - t0
    gpu.release_gpu_memory()  # the calibration's reference channels and renders

    gsd = max(gsd_m, 0.005)
    grid = _output_grid(dsm, crs, gsd)
    # canvas (4 x f16) + off-nadir (f16) + winner (i16) + the photo's green and coverage on the grid
    while device == "cuda" and not gpu.gpu_can_hold(14 * grid.width * grid.height + WORKSET_BYTES):
        gsd *= 1.25
        grid = _output_grid(dsm, crs, gsd)
    log.info("band ortho: %d captures onto %dx%d @ %.1f cm on %s", len(captures), grid.width, grid.height,
             grid.gsd * 100, torch.cuda.get_device_name(0) if device == "cuda" else "cpu")
    canvas, best, ortho_stats = _orthorectify(torch, device, captures, cams, rig, dsm, grid, field_ref)
    _clip_to_photo(torch, best, grid, field_ref, dsm.origin)
    del field_ref
    gpu.release_gpu_memory()
    photo, photo_valid = _read_photo_green(torch, geom.ortho_path, grid, device)
    alignment = _align_to_photo(torch, canvas, best, photo, photo_valid, grid)
    log.info("band ortho: aligned to the photo: %s", alignment)
    t_ortho = time.monotonic() - t0 - t_rig

    out_dir = survey_dir(survey.id) / "outputs"
    paths, stats = _write_products(torch, canvas, best, grid, out_dir, photo, photo_valid)
    valid = torch.isfinite(best)
    qa = {
        "survey": survey.id,
        "built": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "device": torch.cuda.get_device_name(0) if device == "cuda" else "cpu",
        "gsd_m": grid.gsd,
        "captures": ortho_stats,
        "alignment_to_photo": alignment,
        "seconds": {"rig": round(t_rig, 1), "orthorectify": round(t_ortho, 1),
                    "total": round(time.monotonic() - t0, 1)},
        "rig": {b: {"deg_from_rgb_camera": round(rotation_angle_deg(r.rotation), 4),
                    "deg_from_green_camera": round(rotation_angle_deg(r.to_green), 4),
                    "rotation": [[round(v, 8) for v in row] for row in r.rotation.tolist()],
                    "captures_agreeing": r.captures, "fit_residual_px": round(r.residual_px, 2),
                    "spread_deg": round(r.spread_deg, 4), "per_capture": r.per_capture} for b, r in rig.items()},
        "radiometry": {b: {k: round(v, 6) for k, v in s.items()} for b, s in stats.items()},
        "offsets": _qa_shifts(torch, canvas, valid, grid, paths["alignment_check"]),
        "gcps": check_gcps_in_bands(survey, paths),
    }
    (out_dir / "band_ortho_qa.json").write_text(json.dumps(qa, indent=2))
    log.info("band ortho QA: %s", json.dumps({"offsets": qa["offsets"], "gcps": qa["gcps"]}))
    del canvas, best, valid, dsm, photo, photo_valid
    gpu.release_gpu_memory()

    created = []
    for asset_type, path in paths.items():
        for old in [a for a in survey.assets if a.asset_type == asset_type and a.source == SOURCE]:
            db.delete(old)
        db.flush()
        asset = models.SurveyAsset(survey_id=survey.id, asset_type=asset_type, file_path=str(path), format="tif",
                                   bounds_geojson=json.dumps(extract_bounds_geojson(path)), source=SOURCE)
        db.add(asset)
        created.append(asset)
    db.flush()
    log.info("band ortho: %d products in %.0f s", len(created), time.monotonic() - t0)
    return created
