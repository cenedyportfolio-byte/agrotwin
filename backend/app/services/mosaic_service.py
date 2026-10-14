"""Quick mosaics by direct georeferencing — real, georeferenced GeoTIFFs
built from the frames' own RTK positions and camera geometry.

Each DJI frame is nadir (gimbal pitch ≈ -90°) and carries, in XMP, its
RTK-fixed position (σ ≈ 2 cm here), altitude above takeoff, gimbal yaw/roll
and the calibrated focal length / optical centre. Under a flat-ground, nadir
assumption a frame's pixel → ground mapping is a similarity transform:

    ground = camera_position + (AGL / f) · [ (u − cx)·right + (cy − v)·up ]
    up    = heading             = (sin h, cos h)   in (E, N)
    right = heading + 90°       = (cos h, −sin h)

The heading is the gimbal yaw, turned 180° when the gimbal reports a 180°
roll (see image_heading_deg): DJI flies the return legs of a mission that way.

RGB frames are decoded at full resolution and sampled once per output pixel
through DJI's DewarpData lens model (Brown: fx, fy, principal-point offset,
k1 k2 p1 p2 k3 — the M3M RGB lens has ≈ −11 % radial distortion, over a metre
at frame corners if ignored), so there is a single interpolation between the
photo and the map. Overlaps are resolved winner-takes-all: every map pixel
comes from the one frame that saw it closest to its principal point (the
most nadir view, least relief displacement). Averaging overlapping frames
instead draws every feature once per frame wherever the flat-ground
placement disagrees, which reads as ghosting and blur. This is the same idea
as DJI's "2D quick map": a continuous, correctly-placed field map that lines
up with the RTK positions, without the terrain modelling, bundle adjustment
and seam optimisation of true photogrammetry (scripts/import_odm.py brings
that in). Documented limits:
- flat-ground assumption: relief and crop height shift pixels slightly, so
  features can break at the seam between two frames
- AGL is altitude above the takeoff point, so a sloping field scales frames
  slightly differently across the field
- no colour balancing across frames
- the NDVI/NDRE/GNDVI mosaics still blend overlaps (centre-weighted average):
  the analysis reads them in 5 m cells, where averaging is the intent

Outputs (registered as SurveyAssets, source="direct_georeferencing"):
  orthomosaic  uint8 RGB, nodata 0            data/surveys/<id>/outputs/orthomosaic_quick.tif
  ndvi/ndre/gndvi float32 index, nodata NaN   data/surveys/<id>/outputs/<index>_quick.tif
"""

import functools
import json
import logging
import math
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from sqlalchemy.orm import Session

from app import models
from app.services import gpu
from app.services import multispectral_service as ms
from app.services import storage_service
from app.services.metadata_service import dji_xmp_from_image

log = logging.getLogger(__name__)


def _torch_cuda():
    """torch on a CUDA device, or None. The index mosaics' warp-and-accumulate
    is a per-pixel gather — grid_sample on the GPU does it far faster than the
    PIL path, which stays as the fallback for machines without a GPU."""
    try:
        import torch
    except ImportError:
        return None
    return torch if torch.cuda.is_available() else None


# The RGB grid follows the camera's native GSD (≈ 0.8 cm at 30 m AGL), floored
# at 1 cm and coarsened further if the canvas would pass RGB_MAX_PIXELS
# (uint8 RGB + float32 score = 7 bytes/pixel, ≈ 3.5 GB). The ODM orthophoto is
# the full-detail product; this bound keeps a quick map of a big field in RAM.
RGB_MIN_GSD_M = 0.01
RGB_MAX_PIXELS = 500_000_000
RENDER_STRIP_ROWS = 512  # rows of a frame's map window computed at once (bounds per-thread temporaries)
INDEX_GSD_M = 0.05  # MS bands are 2592 px across ~45 m → ≈ 1.7 cm native
INDEX_MAX_DIM = 1296
MIN_WEIGHT = 1e-3


def image_heading_deg(yaw_deg: float, roll_deg: float | None) -> float:
    """Compass bearing of the image's top edge. Looking straight down, gimbal
    roll and yaw turn the image about the same axis (gimbal lock), and DJI
    reports the return legs of a mission as the outbound yaw with a 180° roll:
    on the Ditty Road M3M flight all 101 roll-180° frames have their SfM-solved
    heading ≈ yaw + 180°, the 129 roll-0° frames ≈ yaw."""
    if roll_deg is not None and abs(roll_deg) > 90:
        return (yaw_deg + 180.0) % 360.0
    return yaw_deg


@dataclass
class FrameGeom:
    east: float
    north: float
    heading_deg: float
    agl_m: float
    focal_px: float
    cx: float
    cy: float
    dewarp: "Dewarp | None" = None


@dataclass(frozen=True)
class Dewarp:
    fx: float
    fy: float
    cx: float  # absolute principal point, full-res pixels
    cy: float
    k1: float
    k2: float
    p1: float
    p2: float
    k3: float


def parse_dewarp(xmp: dict, width: int, height: int) -> "Dewarp | None":
    """DJI DewarpData: '<date>;fx,fy,cx_off,cy_off,k1,k2,p1,p2,k3' (offsets from image centre)."""
    raw = xmp.get("DewarpData")
    if not raw:
        return None
    try:
        vals = [float(v) for v in str(raw).split(";")[1].split(",")]
        fx, fy, cxo, cyo, k1, k2, p1, p2, k3 = vals[:9]
    except (IndexError, ValueError):
        return None
    return Dewarp(fx, fy, width / 2 + cxo, height / 2 + cyo, k1, k2, p1, p2, k3)


@functools.lru_cache(maxsize=16)
def _fold_radius2(d: Dewarp) -> float:
    """Squared normalised radius where the radial polynomial stops increasing.
    Past it the model folds back and ideal points far outside the frame land
    on real pixels (DJI M3M RGB: 1.23, vs 0.89 at the frame corner)."""
    r = np.linspace(0.0, 3.0, 3001)
    rd = r * (1 + d.k1 * r**2 + d.k2 * r**4 + d.k3 * r**6)
    stop = np.flatnonzero(np.diff(rd) <= 0)
    return float(r[stop[0]] ** 2) if stop.size else 9.0


def _distort(d: Dewarp, u: np.ndarray, v: np.ndarray, scale: float):
    """Ideal-pinhole frame coordinates -> where the lens actually imaged them
    (both in scaled continuous pixel coordinates), and where that is valid."""
    fx, fy, cx, cy = d.fx * scale, d.fy * scale, d.cx * scale, d.cy * scale
    x = (u - cx) / fx
    y = (v - cy) / fy
    r2 = x * x + y * y
    radial = 1 + r2 * (d.k1 + r2 * (d.k2 + r2 * d.k3))
    xd = x * radial + 2 * d.p1 * x * y + d.p2 * (r2 + 2 * x * x)
    yd = y * radial + d.p1 * (r2 + 2 * y * y) + 2 * d.p2 * x * y
    return xd * fx + cx, yd * fy + cy, r2 < _fold_radius2(d)


def utm_epsg_for(lon: float, lat: float) -> int:
    zone = int((lon + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def _to_utm(lons, lats, epsg: int):
    from rasterio.warp import transform

    xs, ys = transform("EPSG:4326", f"EPSG:{epsg}", list(lons), list(lats))
    return np.array(xs), np.array(ys)


def _frame_geometry(rows: list[models.SurveyImage], epsg: int, band: str) -> dict[str, FrameGeom]:
    """One geometry per frame for the given camera (RGB or a MS band — they
    have different focal lengths/centres)."""
    usable = [
        r for r in rows
        if r.band == band and r.lat is not None and r.lon is not None
        and r.focal_px and r.cx_px is not None and r.cy_px is not None
        and r.rel_altitude_m and r.gimbal_yaw_deg is not None
        and (r.gimbal_pitch_deg is None or r.gimbal_pitch_deg < -80)  # nadir only
    ]
    if not usable:
        return {}
    xs, ys = _to_utm([r.lon for r in usable], [r.lat for r in usable], epsg)
    return {
        r.frame_key or r.id: FrameGeom(
            x, y, image_heading_deg(r.gimbal_yaw_deg, r.gimbal_roll_deg),
            r.rel_altitude_m, r.focal_px, r.cx_px, r.cy_px,
        )
        for r, x, y in zip(usable, xs, ys)
    }


def _with_dewarp(g: FrameGeom, xmp: dict, width: int, height: int) -> FrameGeom:
    """Once the lens distortion is modelled the frame is an ideal pinhole with
    the DewarpData intrinsics, so georeference with those rather than the
    Calibrated* pair."""
    d = parse_dewarp(xmp, width, height)
    if d is None:
        return g
    return FrameGeom(g.east, g.north, g.heading_deg, g.agl_m, (d.fx + d.fy) / 2, d.cx, d.cy, d)


def _pixel_to_ground_affine(g: FrameGeom, scale: float):
    """Affine (2x2 M, 2 t) mapping *downsampled* pixel (u, v) -> (E, N)."""
    gsd = g.agl_m / (g.focal_px * scale)  # metres per downsampled pixel
    heading = math.radians(g.heading_deg)
    up = np.array([math.sin(heading), math.cos(heading)])
    right = np.array([math.cos(heading), -math.sin(heading)])
    cx, cy = g.cx * scale, g.cy * scale
    M = gsd * np.column_stack([right, -up])  # columns: d/du, d/dv
    t = np.array([g.east, g.north]) - M @ np.array([cx, cy])
    return M, t


def _ground_to_grid(E0: float, N0: float, gsd: float):
    """(E, N) -> (col, row) of the output raster (north-up)."""
    return np.array([[1 / gsd, 0], [0, -1 / gsd]]), np.array([-E0 / gsd, N0 / gsd])


CENTRAL_FRACTION = 0.7


def _weight_image(w: int, h: int, valid: np.ndarray | None = None) -> np.ndarray:
    ys, xs = np.mgrid[0:h, 0:w]
    nx = np.abs((xs - w / 2) / (w / 2))
    ny = np.abs((ys - h / 2) / (h / 2))
    inner = (nx < CENTRAL_FRACTION) & (ny < CENTRAL_FRACTION)
    wgt = ((1 - nx / CENTRAL_FRACTION) * (1 - ny / CENTRAL_FRACTION)).clip(0, 1) ** 3
    wgt = np.where(inner, wgt, 0)
    if valid is not None:
        wgt = np.where(valid, wgt, 0)
    return wgt.astype(np.float32)


def _paste(canvas: np.ndarray, wsum: np.ndarray, img: np.ndarray, M: np.ndarray, t: np.ndarray,
           G: np.ndarray, gt: np.ndarray, out_gsd: float, valid_src: np.ndarray | None = None) -> None:
    """Warp `img` (H,W[,C] float32) through pixel->ground->grid and accumulate."""
    h, w = img.shape[:2]
    A = G @ M  # pixel -> grid
    b = G @ t + gt
    corners = np.array([[0, 0], [w, 0], [w, h], [0, h]]) @ A.T + b
    c0, r0 = np.floor(corners.min(axis=0)).astype(int)
    c1, r1 = np.ceil(corners.max(axis=0)).astype(int)
    H, W = wsum.shape
    c0, r0 = max(c0, 0), max(r0, 0)
    c1, r1 = min(c1, W), min(r1, H)
    if c1 <= c0 or r1 <= r0:
        return

    # PIL wants output(x,y) -> input(u,v): invert, with the patch's own origin
    inv = np.linalg.inv(A)
    a, bb = inv[0]
    d, e = inv[1]
    off = inv @ (np.array([c0, r0]) - b)
    coeffs = [a, bb, off[0], d, e, off[1]]
    size = (c1 - c0, r1 - r0)

    weight = _weight_image(w, h, valid_src)
    torch = _torch_cuda()
    if torch is not None:
        # one grid_sample for all channels + the weight, instead of a PIL
        # transform per channel
        _paste_gpu(torch, canvas, wsum, img, weight, coeffs, size, c0, r0, c1, r1)
        return

    wpatch = np.asarray(Image.fromarray(weight).transform(size, Image.AFFINE, coeffs, Image.BILINEAR), dtype=np.float32)
    valid = wpatch > MIN_WEIGHT
    if img.ndim == 2:
        patch = np.asarray(Image.fromarray(img).transform(size, Image.AFFINE, coeffs, Image.BILINEAR), dtype=np.float32)
        canvas[r0:r1, c0:c1] += np.where(valid, patch * wpatch, 0)
    else:
        for ch in range(img.shape[2]):
            patch = np.asarray(Image.fromarray(np.ascontiguousarray(img[..., ch])).transform(size, Image.AFFINE, coeffs, Image.BILINEAR), dtype=np.float32)
            canvas[r0:r1, c0:c1, ch] += np.where(valid, patch * wpatch, 0)
    wsum[r0:r1, c0:c1] += np.where(valid, wpatch, 0)


def _paste_gpu(torch, canvas, wsum, img, weight, coeffs, size, c0, r0, c1, r1) -> None:
    """Same affine warp + weighted accumulation as the PIL path, on the GPU.

    PIL's AFFINE coeffs map output (x, y) -> source (u, v):
        u = a·x + b·y + c,  v = d·x + e·y + f
    """
    dev = "cuda"
    a, b, c, d, e, f = coeffs
    out_w, out_h = size
    h, w = img.shape[:2]

    ys, xs = torch.meshgrid(
        torch.arange(out_h, device=dev, dtype=torch.float32),
        torch.arange(out_w, device=dev, dtype=torch.float32),
        indexing="ij",
    )
    u = a * xs + b * ys + c
    v = d * xs + e * ys + f
    grid = torch.stack([u / max(w - 1, 1) * 2 - 1, v / max(h - 1, 1) * 2 - 1], dim=-1)[None]

    src = np.ascontiguousarray(img if img.ndim == 3 else img[..., None])
    t = torch.from_numpy(src).to(dev, torch.float32).permute(2, 0, 1)[None]
    wt = torch.from_numpy(weight).to(dev, torch.float32)[None, None]
    stack = torch.cat([t, wt], dim=1)  # channels + weight warped together

    warped = torch.nn.functional.grid_sample(
        stack, grid, mode="bilinear", padding_mode="zeros", align_corners=True
    )[0]
    patch, wpatch = warped[:-1], warped[-1]
    valid = wpatch > MIN_WEIGHT
    wpatch = torch.where(valid, wpatch, torch.zeros((), device=dev))

    dst = torch.from_numpy(canvas[r0:r1, c0:c1]).to(dev, torch.float32)
    contrib = (patch * wpatch).permute(1, 2, 0)
    dst += contrib if canvas.ndim == 3 else contrib[..., 0]
    canvas[r0:r1, c0:c1] = dst.cpu().numpy()

    ws = torch.from_numpy(wsum[r0:r1, c0:c1]).to(dev, torch.float32) + wpatch
    wsum[r0:r1, c0:c1] = ws.cpu().numpy()


def _grid_for(geoms: dict[str, FrameGeom], footprint_scale: float, gsd: float):
    """Output extent covering every frame footprint (+ margin)."""
    es, ns, half = [], [], 0.0
    for g in geoms.values():
        es.append(g.east)
        ns.append(g.north)
        half = max(half, g.agl_m / g.focal_px * max(g.cx, g.cy) * 1.5)
    E0, N0 = min(es) - half, max(ns) + half
    W = int(math.ceil((max(es) + half - E0) / gsd))
    H = int(math.ceil((N0 - (min(ns) - half)) / gsd))
    return E0, N0, W, H


def _write_geotiff(path: Path, data: np.ndarray, E0: float, N0: float, gsd: float, epsg: int, nodata) -> None:
    import rasterio
    from rasterio.transform import from_origin

    path.parent.mkdir(parents=True, exist_ok=True)
    count = 1 if data.ndim == 2 else data.shape[2]
    with rasterio.open(
        path, "w", driver="GTiff", height=data.shape[0], width=data.shape[1], count=count,
        dtype=data.dtype, crs=f"EPSG:{epsg}", transform=from_origin(E0, N0, gsd, gsd),
        nodata=nodata, compress="deflate", tiled=True,
    ) as dst:
        if count == 1:
            dst.write(data, 1)
        else:
            for i in range(count):
                dst.write(data[..., i], i + 1)


def build_rgb_mosaic(survey: models.Survey, out_path: Path, epsg: int) -> dict | None:
    geoms = _frame_geometry(survey.images, epsg, "RGB")
    if len(geoms) < 3:
        return None
    native = float(np.median([g.agl_m / g.focal_px for g in geoms.values()]))
    gsd = max(native, RGB_MIN_GSD_M)
    E0, N0, W, H = _grid_for(geoms, 1.0, gsd)
    if W * H > RGB_MAX_PIXELS:
        gsd *= math.sqrt(W * H / RGB_MAX_PIXELS)
        E0, N0, W, H = _grid_for(geoms, 1.0, gsd)
    # JPEG decodes at 1/2, 1/4, 1/8 for free: take the smallest that still resolves the grid
    reduce = max(k for k in (1, 2, 4, 8) if native * k <= gsd)
    G, gt = _ground_to_grid(E0, N0, gsd)
    by_key = {(r.frame_key or r.id): r for r in survey.images if r.band == "RGB"}
    # plain values only: the render workers run on other threads
    jobs = [(g, by_key[key].path, by_key[key].width, by_key[key].height, by_key[key].filename)
            for key, g in geoms.items()]

    t0 = time.monotonic()
    comp = _GpuCompositor.create(H, W)
    device = comp.device if comp else "cpu (opencv)"
    log.info("rgb mosaic: %d frames into %dx%d @ %.2f cm (native %.2f cm, decode 1/%d) on %s",
             len(jobs), W, H, gsd * 100, native * 100, reduce, device)
    if comp:
        canvas, used = _composite_gpu(comp, jobs, reduce, G, gt)
    else:
        canvas, used = _composite_cpu(jobs, reduce, G, gt, H, W)
    composite_s = time.monotonic() - t0
    _write_geotiff(out_path, canvas, E0, N0, gsd, epsg, nodata=0)
    log.info("rgb mosaic: composited in %.0f s, written in %.0f s", composite_s, time.monotonic() - t0 - composite_s)
    return {"frames": used, "width": W, "height": H, "gsd_m": gsd, "native_gsd_m": native,
            "decode_reduction": reduce, "device": device}


def _composite_gpu(comp: "_GpuCompositor", jobs, reduce: int, G, gt) -> tuple[np.ndarray, int]:
    """Frames are decoded on worker threads and resampled + merged in VRAM."""
    used = 0
    for job, decoded in gpu.prefetch(jobs, lambda j: _decode_rgb_frame(j[1], j[2], reduce)):
        if isinstance(decoded, OSError):
            log.warning("mosaic: skipping %s (%s)", job[4], decoded)
            continue
        img, scale, xmp = decoded
        g = _with_dewarp(job[0], xmp, job[2] or img.shape[1], job[3] or img.shape[0])
        comp.add(img, g, scale, G, gt)
        used += 1
        if used % 100 == 0:
            log.info("rgb mosaic: %d/%d frames", used, len(jobs))
    return comp.result(), used


def _composite_cpu(jobs, reduce: int, G, gt, H: int, W: int) -> tuple[np.ndarray, int]:
    """Frames are decoded and resampled (OpenCV) on worker threads, merged here."""
    def render(job):
        g, path, width, height, _ = job
        return _render_frame(g, path, width, height, reduce, G, gt, H, W)

    canvas = np.zeros((H, W, 3), np.uint8)  # 0 = nodata
    best = np.zeros((H, W), np.float32)  # nadir score of the frame each pixel came from
    used = 0
    workers = gpu.default_workers()
    for job, rendered in gpu.prefetch(jobs, render, workers=workers, ahead=workers):
        if isinstance(rendered, OSError):
            log.warning("mosaic: skipping %s (%s)", job[4], rendered)
            continue
        used += 1
        if rendered is not None:
            c0, r0, c1, r1, pix, score = rendered
            win = score > best[r0:r1, c0:c1]
            np.copyto(best[r0:r1, c0:c1], score, where=win)
            np.copyto(canvas[r0:r1, c0:c1], pix, where=win[..., None])
        if used % 100 == 0:
            log.info("rgb mosaic: %d/%d frames", used, len(jobs))
    return canvas, used


class _GpuCompositor:
    """Winner-takes-all canvas in VRAM: uint8 RGB + float16 nadir score
    (5 bytes/pixel, ≈ 2.2 GB for a 1 cm map of a 2 ha field). Same geometry and
    selection as _render_frame + _composite_cpu, with grid_sample for the lookup."""

    STRIP_ROWS = 1024
    WORKSET_BYTES = 1_000_000_000  # one full-res frame as float32 + a strip of coordinate maps

    def __init__(self, torch, H: int, W: int):
        self.torch, self.H, self.W = torch, H, W
        self.device = f"gpu ({torch.cuda.get_device_name(0)})"
        self.canvas = torch.zeros((3, H, W), device="cuda", dtype=torch.uint8)
        self.best = torch.zeros((H, W), device="cuda", dtype=torch.float16)

    @classmethod
    def create(cls, H: int, W: int) -> "_GpuCompositor | None":
        torch = gpu.cuda_torch()
        if torch is None or not gpu.gpu_can_hold(5 * H * W + cls.WORKSET_BYTES):
            return None
        try:
            return cls(torch, H, W)
        except torch.cuda.OutOfMemoryError:
            gpu.release_gpu_memory()
            return None

    def add(self, img_u8: np.ndarray, g: FrameGeom, scale: float, G, gt) -> None:
        torch = self.torch
        ih, iw = img_u8.shape[:2]
        M, t = _pixel_to_ground_affine(g, scale)
        bounds = _patch_bounds(iw, ih, M, t, G, gt, self.H, self.W)
        if bounds is None:
            return
        c0, r0, c1, r1, coeffs = bounds
        a, b, c, d, e, f = (float(k) for k in coeffs)
        src = torch.from_numpy(np.ascontiguousarray(img_u8)).to("cuda").permute(2, 0, 1)[None].float()
        pcx, pcy = float(g.cx) * scale, float(g.cy) * scale
        inv_half_diag = 1.0 / math.hypot(iw / 2, ih / 2)
        xs = torch.arange(c1 - c0, device="cuda", dtype=torch.float32) + 0.5
        for s0 in range(r0, r1, self.STRIP_ROWS):
            s1 = min(s0 + self.STRIP_ROWS, r1)
            ys = (torch.arange(s0 - r0, s1 - r0, device="cuda", dtype=torch.float32) + 0.5)[:, None]
            u = a * xs + b * ys + c
            v = d * xs + e * ys + f
            sc = 2.0 - torch.hypot(u - pcx, v - pcy) * inv_half_diag
            if g.dewarp is not None:
                su, sv, ok = _distort(g.dewarp, u, v, scale)
            else:
                su, sv, ok = u, v, torch.ones_like(u, dtype=torch.bool)
            su = su - 0.5
            sv = sv - 0.5
            ok = ok & (su >= 0) & (su <= iw - 1) & (sv >= 0) & (sv <= ih - 1)
            grid = torch.stack([su * (2 / (iw - 1)) - 1, sv * (2 / (ih - 1)) - 1], dim=-1)[None]
            pix = torch.nn.functional.grid_sample(src, grid, mode="bilinear", padding_mode="border",
                                                  align_corners=True)[0]
            pix = pix.round_().clamp_(1, 255).to(torch.uint8)  # 0 is nodata
            best = self.best[s0:s1, c0:c1]
            win = ok & (sc > best)
            best.copy_(torch.where(win, sc, best.float()))
            dst = self.canvas[:, s0:s1, c0:c1]
            dst.copy_(torch.where(win, pix, dst))

    def result(self) -> np.ndarray:
        out = np.empty((self.H, self.W, 3), np.uint8)
        for ch in range(3):  # one channel at a time keeps the host copy simple
            out[..., ch] = self.canvas[ch].cpu().numpy()
        del self.canvas, self.best
        gpu.release_gpu_memory()
        return out


def _decode_rgb_frame(path: Path, width: int | None, reduce: int):
    """(uint8 HxWx3 frame decoded at 1/reduce, scale vs full-res, DJI XMP), or
    the OSError. The file is read once and the XMP comes from the same open image."""
    try:
        with ms.open_image_safely(path) as im:
            xmp = dji_xmp_from_image(im)
            if reduce > 1:
                # keep the frame's aspect: PIL only takes a 1/k scale when
                # *both* dimensions still cover the request
                im.draft("RGB", (im.width // reduce, im.height // reduce))
            im = im.convert("RGB")
            scale = im.size[0] / (width or im.size[0])
            return np.array(im), scale, xmp  # writable copy for torch.from_numpy
    except OSError as exc:
        return exc


def _render_frame(g: FrameGeom, path: Path, width: int | None, height: int | None, reduce: int,
                  G, gt, H: int, W: int):
    """One frame resampled into its window of the output grid, on a worker
    thread: (c0, r0, c1, r1, uint8 pixels, nadir score — 0 where the frame has
    no data), None if it misses the grid, or the OSError."""
    decoded = _decode_rgb_frame(path, width, reduce)
    if isinstance(decoded, OSError):
        return decoded
    img, scale, xmp = decoded
    ih, iw = img.shape[:2]
    g = _with_dewarp(g, xmp, width or iw, height or ih)
    M, t = _pixel_to_ground_affine(g, scale)
    bounds = _patch_bounds(iw, ih, M, t, G, gt, H, W)
    if bounds is None:
        return None
    c0, r0, c1, r1, coeffs = bounds
    a, b, c, d, e, f = (float(k) for k in coeffs)  # python floats keep the maps float32
    h, w = r1 - r0, c1 - c0
    pix = np.empty((h, w, 3), np.uint8)
    score = np.empty((h, w), np.float32)
    pcx, pcy = float(g.cx) * scale, float(g.cy) * scale
    inv_half_diag = 1.0 / math.hypot(iw / 2, ih / 2)
    xs = np.arange(w, dtype=np.float32) + 0.5  # map pixel centres
    for s0 in range(0, h, RENDER_STRIP_ROWS):
        ys = (np.arange(s0, min(s0 + RENDER_STRIP_ROWS, h), dtype=np.float32) + 0.5)[:, None]
        u = a * xs + b * ys + c  # ideal-pinhole frame coordinates of each map pixel
        v = d * xs + e * ys + f
        sc = 2.0 - np.hypot(u - pcx, v - pcy) * inv_half_diag  # higher = nearer the principal point
        if g.dewarp is not None:
            su, sv, ok = _distort(g.dewarp, u, v, scale)
        else:
            su, sv, ok = u, v, True
        su = su - 0.5  # continuous coordinates -> pixel indices
        sv = sv - 0.5
        ok = ok & (su >= 0) & (su <= iw - 1) & (sv >= 0) & (sv <= ih - 1)
        rows = slice(s0, s0 + ys.shape[0])
        pix[rows] = cv2.remap(img, su, sv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        score[rows] = np.where(ok, sc, 0)
    np.maximum(pix, 1, out=pix)  # 0 is nodata
    return c0, r0, c1, r1, pix, score


def _patch_bounds(img_w: int, img_h: int, M, t, G, gt, H: int, W: int):
    """Grid window a frame lands in, and PIL-style AFFINE coefficients mapping
    that window's (x, y) back to frame pixels; None if it misses the grid."""
    A = G @ M  # pixel -> grid
    b = G @ t + gt
    corners = np.array([[0, 0], [img_w, 0], [img_w, img_h], [0, img_h]]) @ A.T + b
    c0, r0 = np.floor(corners.min(axis=0)).astype(int)
    c1, r1 = np.ceil(corners.max(axis=0)).astype(int)
    c0, r0 = max(c0, 0), max(r0, 0)
    c1, r1 = min(c1, W), min(r1, H)
    if c1 <= c0 or r1 <= r0:
        return None
    inv = np.linalg.inv(A)
    off = inv @ (np.array([c0, r0]) - b)
    coeffs = [inv[0, 0], inv[0, 1], off[0], inv[1, 0], inv[1, 1], off[1]]
    return c0, r0, c1, r1, coeffs


def build_index_mosaics(survey: models.Survey, out_dir: Path, epsg: int) -> dict[str, dict]:
    geoms = _frame_geometry(survey.images, epsg, "NIR")
    if len(geoms) < 3:
        return {}
    E0, N0, W, H = _grid_for(geoms, 1.0, INDEX_GSD_M)
    canvases = {idx: np.zeros((H, W), np.float32) for idx in ms.INDEX_BANDS}
    wsum = np.zeros((H, W), np.float32)
    G, gt = _ground_to_grid(E0, N0, INDEX_GSD_M)
    frames: dict[str, dict[str, models.SurveyImage]] = {}
    for r in survey.images:
        frames.setdefault(r.frame_key or r.id, {})[r.band] = r

    used = 0
    for key, g in geoms.items():
        bands = {b: r.path for b, r in frames[key].items()}
        if not {"NIR", "RED", "RED_EDGE", "GREEN"} <= bands.keys():
            continue
        try:
            loaded = {b: ms.load_band(bands[b], INDEX_MAX_DIM) for b in ("NIR", "RED", "RED_EDGE", "GREEN")}
        except OSError as exc:
            log.warning("index mosaic: skipping %s (%s)", key, exc)
            continue
        nir = loaded["NIR"]
        scale = nir.shape[1] / (frames[key]["NIR"].width or nir.shape[1])
        M, t = _pixel_to_ground_affine(g, scale)
        for idx, (a_name, b_name) in ms.INDEX_BANDS.items():
            arr = ms._safe_normalized_difference(loaded[a_name], loaded[b_name])
            # accumulate index * weight; all three share one weight canvas, so add it once
            _paste_shared(canvases[idx], wsum if idx == "ndvi" else None, arr, M, t, G, gt)
        used += 1
        if used % 50 == 0:
            log.info("index mosaics: %d/%d frames", used, len(geoms))

    results = {}
    valid = wsum > MIN_WEIGHT
    for idx, canvas in canvases.items():
        out = np.full((H, W), np.nan, np.float32)
        out[valid] = canvas[valid] / wsum[valid]
        path = out_dir / f"{idx}_quick.tif"
        _write_geotiff(path, out, E0, N0, INDEX_GSD_M, epsg, nodata=np.nan)
        results[idx] = {"path": str(path), "frames": used, "width": W, "height": H, "gsd_m": INDEX_GSD_M}
    return results


def _paste_shared(canvas, wsum, img, M, t, G, gt):
    """Like _paste but lets three index canvases share one weight accumulation."""
    dummy = np.zeros_like(canvas) if wsum is None else wsum
    _paste(canvas, dummy, img, M, t, G, gt, INDEX_GSD_M)


def build_quick_mosaics(db: Session, survey: models.Survey) -> list[models.SurveyAsset]:
    """Builds the RGB and NDVI/NDRE/GNDVI quick mosaics and registers them as
    assets (replacing earlier direct_georeferencing outputs)."""
    from app.services.orthomosaic_service import extract_bounds_geojson
    from app.services.survey_service import backfill_gimbal_roll

    if n := backfill_gimbal_roll(db, survey):
        log.info("mosaic: read gimbal roll for %d frames ingested before it was stored", n)
    anchors = [r for r in survey.images if r.lat is not None and r.lon is not None]
    if not anchors:
        return []
    lon0 = float(np.mean([r.lon for r in anchors]))
    lat0 = float(np.mean([r.lat for r in anchors]))
    epsg = utm_epsg_for(lon0, lat0)
    out_dir = storage_service.survey_dir(survey.id) / "outputs"

    db.commit()  # the gimbal backfill: nothing may hold SQLite's write lock during the GPU work

    # build first, then swap the assets: deleting the old ones first would hold
    # the write lock (and leave the survey without a map) for the whole build
    rgb = build_rgb_mosaic(survey, out_dir / "orthomosaic_quick.tif", epsg)
    if rgb:
        log.info("rgb mosaic done: %s", rgb)
    indices = build_index_mosaics(survey, out_dir, epsg)
    for old in [a for a in survey.assets if a.source == "direct_georeferencing"]:
        db.delete(old)
    created = []
    if rgb:
        created.append(_register(db, survey, "orthomosaic", out_dir / "orthomosaic_quick.tif", extract_bounds_geojson))
    for idx, info in indices.items():
        created.append(_register(db, survey, idx, Path(info["path"]), extract_bounds_geojson))
        log.info("%s mosaic done: %s", idx, info)
    db.flush()
    return created


def _register(db, survey, asset_type, path, extract_bounds_geojson):
    asset = models.SurveyAsset(
        survey_id=survey.id, asset_type=asset_type, file_path=str(path), format="tif",
        bounds_geojson=json.dumps(extract_bounds_geojson(path)), source="direct_georeferencing",
    )
    db.add(asset)
    return asset
