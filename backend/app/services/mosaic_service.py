"""Quick mosaics by direct georeferencing — real, georeferenced GeoTIFFs
built from the frames' own RTK positions and camera geometry.

Each DJI frame is nadir (gimbal pitch ≈ -90°) and carries, in XMP, its
RTK-fixed position (σ ≈ 2 cm here), altitude above takeoff, gimbal yaw and
the calibrated focal length / optical centre. Under a flat-ground, nadir
assumption a frame's pixel → ground mapping is a similarity transform:

    ground = camera_position + (AGL / f) · [ (u − cx)·right + (cy − v)·up ]
    up    = heading(yaw)        = (sin yaw, cos yaw)   in (E, N)
    right = heading(yaw + 90°)  = (cos yaw, −sin yaw)

Each RGB frame is first undistorted with DJI's DewarpData (Brown model:
fx, fy, principal-point offset, k1 k2 p1 p2 k3 — the M3M RGB lens has ≈ −11 %
radial distortion, over a metre of error at frame corners if ignored), then
warped into a UTM grid and blended with strong centre weighting: only the
inner ~70 % of each frame contributes (the flight's ~80 % overlap still
covers everything) and weight falls off cubically towards it, so the nadir
centre — the most accurate part of a frame — dominates. This is the same
idea as DJI's "2D quick map": a continuous, correctly-placed field map that
lines up with the RTK positions, without the terrain modelling, bundle
adjustment and seam optimisation of true photogrammetry. Documented limits:
- flat-ground assumption: relief and crop height shift pixels slightly and
  seams show where adjacent frames disagree
- AGL is altitude above the takeoff point, so a sloping field scales frames
  slightly differently across the field
- RGB is blended photometrically only (no colour balancing across frames)

Outputs (registered as SurveyAssets, source="direct_georeferencing"):
  orthomosaic  uint8 RGB, nodata 0            data/surveys/<id>/outputs/orthomosaic_quick.tif
  ndvi/ndre/gndvi float32 index, nodata NaN   data/surveys/<id>/outputs/<index>_quick.tif
"""

import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path

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
    """torch on a CUDA device, or None. Both hot loops here (lens undistortion
    and the warp-and-accumulate) are per-pixel gathers — grid_sample on the GPU
    does them far faster than the numpy/PIL path, which stays as the fallback
    for machines without a GPU."""
    try:
        import torch
    except ImportError:
        return None
    return torch if torch.cuda.is_available() else None


RGB_GSD_M = 0.02  # output ground sample distance (metres/pixel); native ≈ 0.8 cm at 30 m AGL
INDEX_GSD_M = 0.05  # MS bands are 2592 px across ~45 m → ≈ 1.7 cm native
RGB_DRAFT_MAX = 2640  # decode RGB JPGs at 1/2 (≈ 1.6 cm), enough to fill a 2 cm grid
INDEX_MAX_DIM = 1296
MIN_WEIGHT = 1e-3


@dataclass
class FrameGeom:
    east: float
    north: float
    yaw_deg: float
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


_REMAP_CACHE: dict[tuple, tuple[np.ndarray, np.ndarray]] = {}


def _undistort_maps(d: Dewarp, w: int, h: int, scale: float):
    """For each undistorted (output) pixel of the downsampled frame, where to
    sample in the distorted (source) frame. Cached per camera + size."""
    key = (d, w, h, round(scale, 6))
    if key in _REMAP_CACHE:
        return _REMAP_CACHE[key]
    fx, fy, cx, cy = d.fx * scale, d.fy * scale, d.cx * scale, d.cy * scale
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    x = (xs - cx) / fx
    y = (ys - cy) / fy
    r2 = x * x + y * y
    radial = 1 + d.k1 * r2 + d.k2 * r2**2 + d.k3 * r2**3
    xd = x * radial + 2 * d.p1 * x * y + d.p2 * (r2 + 2 * x * x)
    yd = y * radial + d.p1 * (r2 + 2 * y * y) + 2 * d.p2 * x * y
    maps = ((xd * fx + cx).astype(np.float32), (yd * fy + cy).astype(np.float32))
    _REMAP_CACHE[key] = maps
    return maps


def _remap_bilinear_gpu(torch, img: np.ndarray, map_x: np.ndarray, map_y: np.ndarray):
    """grid_sample equivalent of _remap_bilinear. Same zero-outside-source
    semantics, same float32 output."""
    h, w = img.shape[:2]
    dev = "cuda"
    t = torch.from_numpy(np.ascontiguousarray(img)).to(dev, torch.float32)
    t = t.permute(2, 0, 1)[None] if t.ndim == 3 else t[None, None]
    gx = torch.from_numpy(map_x).to(dev, torch.float32)
    gy = torch.from_numpy(map_y).to(dev, torch.float32)
    inside = (gx >= 0) & (gx < w - 1) & (gy >= 0) & (gy < h - 1)
    # grid_sample wants normalised [-1, 1] coordinates
    grid = torch.stack([gx / max(w - 1, 1) * 2 - 1, gy / max(h - 1, 1) * 2 - 1], dim=-1)[None]
    out = torch.nn.functional.grid_sample(t, grid, mode="bilinear", padding_mode="zeros", align_corners=True)
    out = out[0].permute(1, 2, 0) if img.ndim == 3 else out[0, 0]
    out = torch.where(inside[..., None] if img.ndim == 3 else inside, out, torch.zeros((), device=dev))
    return out.cpu().numpy(), inside.cpu().numpy()


def _remap_bilinear(img: np.ndarray, map_x: np.ndarray, map_y: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    x0 = np.floor(map_x).astype(np.int32)
    y0 = np.floor(map_y).astype(np.int32)
    fx = (map_x - x0)[..., None] if img.ndim == 3 else (map_x - x0)
    fy = (map_y - y0)[..., None] if img.ndim == 3 else (map_y - y0)
    inside = (x0 >= 0) & (x0 < w - 1) & (y0 >= 0) & (y0 < h - 1)
    x0c, y0c = np.clip(x0, 0, w - 2), np.clip(y0, 0, h - 2)
    out = (
        img[y0c, x0c] * (1 - fx) * (1 - fy)
        + img[y0c, x0c + 1] * fx * (1 - fy)
        + img[y0c + 1, x0c] * (1 - fx) * fy
        + img[y0c + 1, x0c + 1] * fx * fy
    )
    out[~inside] = 0
    return out.astype(np.float32), inside


def undistort(img: np.ndarray, d: Dewarp, scale: float) -> tuple[np.ndarray, np.ndarray]:
    h, w = img.shape[:2]
    map_x, map_y = _undistort_maps(d, w, h, scale)
    torch = _torch_cuda()
    if torch is not None:
        return _remap_bilinear_gpu(torch, img, map_x, map_y)
    return _remap_bilinear(img, map_x, map_y)


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
        r.frame_key or r.id: FrameGeom(x, y, r.gimbal_yaw_deg, r.rel_altitude_m, r.focal_px, r.cx_px, r.cy_px)
        for r, x, y in zip(usable, xs, ys)
    }


def _with_dewarp(g: FrameGeom, xmp: dict, width: int, height: int) -> FrameGeom:
    """After undistortion the frame is an ideal pinhole with the DewarpData
    intrinsics, so georeference with those rather than the Calibrated* pair."""
    d = parse_dewarp(xmp, width, height)
    if d is None:
        return g
    return FrameGeom(g.east, g.north, g.yaw_deg, g.agl_m, (d.fx + d.fy) / 2, d.cx, d.cy, d)


def _pixel_to_ground_affine(g: FrameGeom, scale: float):
    """Affine (2x2 M, 2 t) mapping *downsampled* pixel (u, v) -> (E, N)."""
    gsd = g.agl_m / (g.focal_px * scale)  # metres per downsampled pixel
    yaw = math.radians(g.yaw_deg)
    up = np.array([math.sin(yaw), math.cos(yaw)])
    right = np.array([math.cos(yaw), -math.sin(yaw)])
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
    E0, N0, W, H = _grid_for(geoms, 1.0, RGB_GSD_M)
    G, gt = _ground_to_grid(E0, N0, RGB_GSD_M)
    by_key = {(r.frame_key or r.id): r for r in survey.images if r.band == "RGB"}
    # plain values only: the decode workers run on other threads
    jobs = [(key, g, by_key[key].path, by_key[key].width, by_key[key].height, by_key[key].filename)
            for key, g in geoms.items()]

    acc = _GpuMosaic.create(H, W, 3) or _CpuMosaic(H, W, 3)
    log.info("rgb mosaic: %d frames into %dx%d @ %.0f cm on %s", len(jobs), W, H, RGB_GSD_M * 100, acc.device)
    used = 0
    for (key, g, path, width, height, filename), decoded in gpu.prefetch(jobs, lambda j: _decode_rgb_frame(j[2], j[3])):
        if isinstance(decoded, OSError):
            log.warning("mosaic: skipping %s (%s)", filename, decoded)
            continue
        img, scale, xmp = decoded
        g = _with_dewarp(g, xmp, width or img.shape[1], height or img.shape[0])
        M, t = _pixel_to_ground_affine(g, scale)
        acc.add(img, M, t, G, gt, g.dewarp, scale)
        used += 1
        if used % 100 == 0:
            log.info("rgb mosaic: %d/%d frames", used, len(geoms))

    out = acc.result_uint8()
    _write_geotiff(out_path, out, E0, N0, RGB_GSD_M, epsg, nodata=0)
    return {"frames": used, "width": W, "height": H, "gsd_m": RGB_GSD_M, "device": acc.device}


def _decode_rgb_frame(path: Path, width: int | None):
    """(uint8 HxWx3 frame at ~half resolution, scale vs full-res, DJI XMP), or the
    OSError. Runs on a worker thread: the file is read once and the XMP comes
    from the same open image."""
    try:
        with ms.open_image_safely(path) as im:
            xmp = dji_xmp_from_image(im)
            # the draft target must keep the frame's aspect: PIL only takes a
            # 1/2 scale when *both* dimensions still cover the request, so a
            # square target silently decodes 4:3 frames at full resolution
            im.draft("RGB", (RGB_DRAFT_MAX, round(RGB_DRAFT_MAX * im.height / im.width)))
            im = im.convert("RGB")
            scale = im.size[0] / (width or im.size[0])
            return np.array(im), scale, xmp  # writable copy for torch.from_numpy
    except OSError as exc:
        return exc


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


class _CpuMosaic:
    """Accumulator in host memory (the original path; per-frame work still
    uses the GPU helpers when CUDA exists). Used when the canvas doesn't fit
    in free GPU memory."""

    def __init__(self, H: int, W: int, C: int):
        self.device = "cpu canvas" + (" + gpu warp" if _torch_cuda() else "")
        self.canvas = np.zeros((H, W, C), np.float32)
        self.wsum = np.zeros((H, W), np.float32)

    def add(self, img_u8, M, t, G, gt, dewarp, scale):
        img = img_u8.astype(np.float32)
        valid_src = None
        if dewarp is not None:
            img, valid_src = undistort(img, dewarp, scale)
        _paste(self.canvas, self.wsum, img, M, t, G, gt, RGB_GSD_M, valid_src)

    def result_uint8(self) -> np.ndarray:
        valid = self.wsum > MIN_WEIGHT
        out = np.zeros(self.canvas.shape, np.uint8)
        out[valid] = np.clip(self.canvas[valid] / self.wsum[valid][:, None], 1, 255).astype(np.uint8)  # 0 = nodata
        return out


class _GpuMosaic:
    """Canvas and weight sum live on the GPU for the whole build: each frame is
    uploaded once (uint8), undistorted, weighted, warped and accumulated
    there, and the finished mosaic is downloaded once. Same arithmetic as
    _CpuMosaic (same grid_sample calls, same float32 weights)."""

    def __init__(self, torch, H: int, W: int, C: int):
        self.torch, self.H, self.W, self.C = torch, H, W, C
        self.device = f"gpu ({torch.cuda.get_device_name(0)})"
        self.canvas = torch.zeros((C, H, W), device="cuda", dtype=torch.float32)
        self.wsum = torch.zeros((H, W), device="cuda", dtype=torch.float32)
        self._maps: dict = {}
        self._weights: dict = {}

    @classmethod
    def create(cls, H: int, W: int, C: int) -> "_GpuMosaic | None":
        torch = gpu.cuda_torch()
        if torch is None or not gpu.gpu_can_hold((C + 1) * H * W * 4):
            return None
        try:
            return cls(torch, H, W, C)
        except torch.cuda.OutOfMemoryError:
            gpu.release_gpu_memory()
            return None

    def _undistort(self, t, d: Dewarp, scale: float):
        torch = self.torch
        h, w = t.shape[1:]
        key = (d, w, h, round(scale, 6))
        if key not in self._maps:
            map_x, map_y = _undistort_maps(d, w, h, scale)
            gx = torch.from_numpy(map_x).to("cuda")
            gy = torch.from_numpy(map_y).to("cuda")
            inside = (gx >= 0) & (gx < w - 1) & (gy >= 0) & (gy < h - 1)
            grid = torch.stack([gx / max(w - 1, 1) * 2 - 1, gy / max(h - 1, 1) * 2 - 1], dim=-1)[None]
            self._maps[key] = (grid, inside)
        grid, inside = self._maps[key]
        out = torch.nn.functional.grid_sample(t[None], grid, mode="bilinear", padding_mode="zeros", align_corners=True)[0]
        return torch.where(inside, out, torch.zeros((), device="cuda")), inside

    def _weight(self, w: int, h: int, inside):
        if (w, h) not in self._weights:
            self._weights[(w, h)] = self.torch.from_numpy(_weight_image(w, h)).to("cuda")
        base = self._weights[(w, h)]
        return base if inside is None else self.torch.where(inside, base, self.torch.zeros((), device="cuda"))

    def add(self, img_u8, M, t, G, gt, dewarp, scale):
        torch = self.torch
        h, w = img_u8.shape[:2]
        bounds = _patch_bounds(w, h, M, t, G, gt, self.H, self.W)
        if bounds is None:
            return
        c0, r0, c1, r1, (a, b, c, d, e, f) = bounds
        img = torch.from_numpy(np.ascontiguousarray(img_u8)).to("cuda").permute(2, 0, 1).to(torch.float32)
        inside = None
        if dewarp is not None:
            img, inside = self._undistort(img, dewarp, scale)
        weight = self._weight(w, h, inside)

        ys, xs = torch.meshgrid(
            torch.arange(r1 - r0, device="cuda", dtype=torch.float32),
            torch.arange(c1 - c0, device="cuda", dtype=torch.float32),
            indexing="ij",
        )
        u = a * xs + b * ys + c
        v = d * xs + e * ys + f
        grid = torch.stack([u / max(w - 1, 1) * 2 - 1, v / max(h - 1, 1) * 2 - 1], dim=-1)[None]
        stack = torch.cat([img, weight[None]], dim=0)[None]
        warped = torch.nn.functional.grid_sample(stack, grid, mode="bilinear", padding_mode="zeros", align_corners=True)[0]
        patch, wpatch = warped[:-1], warped[-1]
        wpatch = torch.where(wpatch > MIN_WEIGHT, wpatch, torch.zeros((), device="cuda"))
        self.canvas[:, r0:r1, c0:c1] += patch * wpatch
        self.wsum[r0:r1, c0:c1] += wpatch

    def result_uint8(self) -> np.ndarray:
        torch = self.torch
        valid = self.wsum > MIN_WEIGHT
        out = torch.zeros((self.H, self.W, self.C), device="cuda", dtype=torch.uint8)
        for ch in range(self.C):  # one channel at a time keeps the temporaries small
            val = (self.canvas[ch] / self.wsum).clamp(1, 255).to(torch.uint8)  # 0 = nodata
            out[..., ch] = torch.where(valid, val, torch.zeros((), device="cuda", dtype=torch.uint8))
        result = out.cpu().numpy()
        del self.canvas, self.wsum, self._maps, self._weights, out
        gpu.release_gpu_memory()
        return result


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

    anchors = [r for r in survey.images if r.lat is not None and r.lon is not None]
    if not anchors:
        return []
    lon0 = float(np.mean([r.lon for r in anchors]))
    lat0 = float(np.mean([r.lat for r in anchors]))
    epsg = utm_epsg_for(lon0, lat0)
    out_dir = storage_service.survey_dir(survey.id) / "outputs"

    for old in [a for a in survey.assets if a.source == "direct_georeferencing"]:
        db.delete(old)
    db.flush()

    created = []
    rgb = build_rgb_mosaic(survey, out_dir / "orthomosaic_quick.tif", epsg)
    if rgb:
        created.append(_register(db, survey, "orthomosaic", out_dir / "orthomosaic_quick.tif", extract_bounds_geojson))
        log.info("rgb mosaic done: %s", rgb)
    for idx, info in build_index_mosaics(survey, out_dir, epsg).items():
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
