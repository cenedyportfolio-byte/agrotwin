"""Frame-camera geometry for orthorectification on the GPU.

Conventions (OpenCV / OpenSfM): camera x right, y down, z forward; a world
point X maps to camera coordinates x = R (X - C), with R the world->camera
rotation and C the camera centre, both in the projected CRS of the survey
products (UTM metres, z up). Pixel coordinates are continuous, with pixel
centres at integer positions.

Everything here is plain arithmetic on torch tensors (or numpy arrays where
noted), so the same code runs on the GPU or, without CUDA, on the CPU.
"""

from __future__ import annotations

import functools
import math
from dataclasses import dataclass, replace

import numpy as np


@dataclass(frozen=True)
class BrownCamera:
    """Pinhole camera with the Brown-Conrady lens model DJI (DewarpData) and
    OpenSfM both use: radial k1 k2 k3, tangential p1 p2, in normalised
    coordinates; pixels = focal * distorted + principal point."""

    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    k1: float = 0.0
    k2: float = 0.0
    k3: float = 0.0
    p1: float = 0.0
    p2: float = 0.0

    @classmethod
    def from_dewarp(cls, d, width: int, height: int) -> "BrownCamera":
        """From mosaic_service.Dewarp (DJI DewarpData, principal point already absolute)."""
        return cls(width, height, d.fx, d.fy, d.cx, d.cy, d.k1, d.k2, d.k3, d.p1, d.p2)

    @classmethod
    def from_opensfm(cls, cam: dict) -> "BrownCamera":
        """From an OpenSfM / ODM cameras.json entry (normalised by the larger image side)."""
        w, h = int(cam["width"]), int(cam["height"])
        s = max(w, h)
        fx = cam["focal_x"] if "focal_x" in cam else cam["focal"]
        return cls(
            w, h, fx * s, cam.get("focal_y", fx) * s,
            cam.get("c_x", 0.0) * s + w / 2 - 0.5, cam.get("c_y", 0.0) * s + h / 2 - 0.5,
            cam.get("k1", 0.0), cam.get("k2", 0.0), cam.get("k3", 0.0), cam.get("p1", 0.0), cam.get("p2", 0.0),
        )

    def scaled(self, s: float) -> "BrownCamera":
        """The same camera for the image resampled by s (pixel centres stay pixel centres)."""
        return replace(self, width=round(self.width * s), height=round(self.height * s), fx=self.fx * s,
                       fy=self.fy * s, cx=(self.cx + 0.5) * s - 0.5, cy=(self.cy + 0.5) * s - 0.5)

    @functools.cached_property
    def fold_r2(self) -> float:
        """Squared normalised radius where the radial polynomial stops increasing:
        past it the model folds back and far-away rays land on real pixels."""
        r = np.linspace(0.0, 3.0, 3001)
        rd = r * (1 + self.k1 * r**2 + self.k2 * r**4 + self.k3 * r**6)
        stop = np.flatnonzero(np.diff(rd) <= 0)
        return float(r[stop[0]] ** 2) if stop.size else 9.0

    def distort(self, xn, yn):
        """Ideal normalised coordinates -> distorted normalised coordinates."""
        r2 = xn * xn + yn * yn
        radial = 1 + r2 * (self.k1 + r2 * (self.k2 + r2 * self.k3))
        xd = xn * radial + 2 * self.p1 * xn * yn + self.p2 * (r2 + 2 * xn * xn)
        yd = yn * radial + self.p1 * (r2 + 2 * yn * yn) + 2 * self.p2 * xn * yn
        return xd, yd

    def project(self, xc, yc, zc):
        """Camera coordinates -> (u, v) pixel coordinates and where that is valid
        (in front of the camera, inside the lens model's monotonic range)."""
        z = zc.clamp(min=1e-6) if hasattr(zc, "clamp") else np.maximum(zc, 1e-6)
        xn, yn = xc / z, yc / z
        xd, yd = self.distort(xn, yn)
        ok = (zc > 1e-6) & (xn * xn + yn * yn < self.fold_r2)
        return self.fx * xd + self.cx, self.fy * yd + self.cy, ok

    def undistort(self, u, v, iterations: int = 10):
        """Pixel coordinates -> ideal normalised coordinates (fixed-point inversion
        of the lens model; converges in a few steps for photogrammetric lenses)."""
        xd, yd = (u - self.cx) / self.fx, (v - self.cy) / self.fy
        xn, yn = xd, yd
        for _ in range(iterations):
            r2 = xn * xn + yn * yn
            radial = 1 + r2 * (self.k1 + r2 * (self.k2 + r2 * self.k3))
            dx = 2 * self.p1 * xn * yn + self.p2 * (r2 + 2 * xn * xn)
            dy = self.p1 * (r2 + 2 * yn * yn) + 2 * self.p2 * xn * yn
            xn, yn = (xd - dx) / radial, (yd - dy) / radial
        return xn, yn

    def inside(self, u, v, margin: float = 0.0):
        return (u >= margin) & (u <= self.width - 1 - margin) & (v >= margin) & (v <= self.height - 1 - margin)


# ---------------------------------------------------------------------------
# rotations (numpy, 3x3)
# ---------------------------------------------------------------------------


def rodrigues(v) -> np.ndarray:
    """Axis-angle vector (OpenSfM shot "rotation") -> rotation matrix."""
    v = np.asarray(v, dtype=np.float64)
    theta = float(np.linalg.norm(v))
    if theta < 1e-12:
        return np.eye(3)
    k = v / theta
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(theta) * K + (1 - math.cos(theta)) * K @ K


def rotation_angle_deg(R: np.ndarray) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, (float(np.trace(R)) - 1) / 2))))


def _quat(R: np.ndarray) -> np.ndarray:
    """Rotation matrix -> unit quaternion (w, x, y, z), w >= 0."""
    m = R
    t = np.trace(m)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    q = np.array(q)
    q /= np.linalg.norm(q)
    return q if q[0] >= 0 else -q


def _rot(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def mean_rotation(Rs: list[np.ndarray], weights=None) -> np.ndarray:
    """Weighted average rotation (principal eigenvector of sum w q q^T)."""
    w = np.ones(len(Rs)) if weights is None else np.asarray(weights, dtype=np.float64)
    M = sum(wi * np.outer(q, q) for wi, q in zip(w, (_quat(R) for R in Rs)))
    vals, vecs = np.linalg.eigh(M)
    return _rot(vecs[:, int(np.argmax(vals))])


def solve_rotation(world_dirs: np.ndarray, cam_dirs: np.ndarray, weights=None) -> np.ndarray:
    """Wahba's problem: the rotation R minimising sum w |cam - R world|^2 for
    unit direction pairs (N, 3). With the camera centre known (RTK), the
    camera's attitude is exactly this rotation."""
    w = np.ones(len(world_dirs)) if weights is None else np.asarray(weights, dtype=np.float64)
    B = (cam_dirs * w[:, None]).T @ world_dirs
    U, _, Vt = np.linalg.svd(B)
    d = np.sign(np.linalg.det(U) * np.linalg.det(Vt))
    return U @ np.diag([1.0, 1.0, d]) @ Vt


def solve_rotation_ransac(world_dirs: np.ndarray, cam_dirs: np.ndarray, weights=None,
                          threshold_rad: float = 0.002, iterations: int = 300, seed: int = 0):
    """solve_rotation with outlier rejection: (R, inlier mask), or (None, None)
    when fewer than 6 pairs agree."""
    n = len(world_dirs)
    if n < 6:
        return None, None
    w = np.ones(n) if weights is None else np.asarray(weights, dtype=np.float64)
    rng = np.random.default_rng(seed)
    best = None
    for _ in range(iterations):
        idx = rng.choice(n, 3, replace=False)
        R = solve_rotation(world_dirs[idx], cam_dirs[idx])
        err = np.linalg.norm(cam_dirs - world_dirs @ R.T, axis=1)
        inl = err < threshold_rad
        score = w[inl].sum()
        if best is None or score > best[0]:
            best = (score, inl)
    inl = best[1]
    if inl.sum() < 6:
        return None, None
    R = solve_rotation(world_dirs[inl], cam_dirs[inl], w[inl])
    err = np.linalg.norm(cam_dirs - world_dirs @ R.T, axis=1)
    inl = err < threshold_rad
    return solve_rotation(world_dirs[inl], cam_dirs[inl], w[inl]), inl


# ---------------------------------------------------------------------------
# GPU helpers (torch)
# ---------------------------------------------------------------------------


def sample_image(torch, img, u, v, mode: str = "bilinear"):
    """Samples img (C, H, W) at continuous pixel coordinates u, v (same shape,
    pixel centres at integers) -> (C, *u.shape); zeros outside."""
    C, H, W = img.shape
    gx = u * (2.0 / max(W - 1, 1)) - 1.0
    gy = v * (2.0 / max(H - 1, 1)) - 1.0
    grid = torch.stack([gx, gy], dim=-1).reshape(1, -1, 1, 2)
    out = torch.nn.functional.grid_sample(img[None], grid, mode=mode, padding_mode="zeros", align_corners=True)
    return out[0, :, :, 0].reshape(C, *u.shape)


class SurfaceModel:
    """A raster surface (DSM) held on the device for height lookups and ray
    casting. Holes are filled from the nearest valid cell so rays near the
    edge of the reconstruction still meet a plausible ground; `valid` keeps
    where the surface was actually measured.

    Horizontal coordinates are local: the projected CRS minus `origin`.
    float32 resolves a UTM northing (~4,000,000 m) only to 0.25 m, but a
    coordinate within a few hundred metres of the origin to micrometres, so
    everything on the device works relative to the origin."""

    def __init__(self, torch, heights: np.ndarray, valid: np.ndarray, transform, device, origin=None):
        from scipy import ndimage

        self.torch, self.device, self.transform = torch, device, transform
        H, W = heights.shape
        if origin is None:
            origin = (round(transform.c + transform.a * W / 2), round(transform.f + transform.e * H / 2))
        self.origin = (float(origin[0]), float(origin[1]))
        if not valid.all():
            idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
            heights = heights[tuple(idx)]
        self.h = torch.from_numpy(np.ascontiguousarray(heights, dtype=np.float32)).to(device)[None]
        self.valid = torch.from_numpy(np.ascontiguousarray(valid)).to(device)
        self.median = float(np.median(heights[valid])) if valid.any() else float(np.median(heights))
        self._a, self._e = transform.a, transform.e
        self._c, self._f = transform.c - self.origin[0], transform.f - self.origin[1]

    @classmethod
    def from_file(cls, torch, path, device) -> "SurfaceModel":
        import rasterio

        with rasterio.open(path) as src:
            z = src.read(1).astype(np.float32)
            valid = np.isfinite(z)
            if src.nodata is not None:
                valid &= z != src.nodata
            valid &= (z > -1000) & (z < 10000)
            return cls(torch, z, valid, src.transform, device)

    def local(self, xyz) -> np.ndarray:
        """Absolute projected (x, y[, z]) -> local, in float64."""
        p = np.array(xyz, dtype=np.float64)
        p[0] -= self.origin[0]
        p[1] -= self.origin[1]
        return p

    def pixel(self, x, y):
        """Local coordinates -> continuous (col, row) with pixel centres at integers."""
        return (x - self._c) / self._a - 0.5, (y - self._f) / self._e - 0.5

    def height(self, x, y):
        col, row = self.pixel(x, y)
        H, W = self.h.shape[-2:]
        return sample_image(self.torch, self.h, col.clamp(0, W - 1), row.clamp(0, H - 1))[0]

    def measured(self, x, y):
        col, row = self.pixel(x, y)
        H, W = self.valid.shape
        c = col.round().long().clamp(0, W - 1)
        r = row.round().long().clamp(0, H - 1)
        inside = (col > -0.5) & (col < W - 0.5) & (row > -0.5) & (row < H - 0.5)
        return self.valid[r, c] & inside

    def intersect(self, centre, dirs, iterations: int = 8):
        """Ray casting: points where rays from `centre` (3,) along unit world
        directions `dirs` (..., 3) meet the surface (local coordinates). Rays
        from a drone are close to vertical and the field is smooth, so a few
        fixed-point steps on the ray's height converge."""
        cz = float(centre[2])
        dz = dirs[..., 2].clamp(max=-1e-3)
        t = (self.median - cz) / dz
        for _ in range(iterations):
            x = float(centre[0]) + t * dirs[..., 0]
            y = float(centre[1]) + t * dirs[..., 1]
            t = (self.height(x, y) - cz) / dz
        x = float(centre[0]) + t * dirs[..., 0]
        y = float(centre[1]) + t * dirs[..., 1]
        return x, y, self.height(x, y)


def gradient_magnitude(torch, img):
    """Sobel gradient magnitude of (B, H, W) -> (B, H, W): edges line up across
    spectral bands even where the brightness itself does not."""
    k = torch.tensor([[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]], device=img.device) / 8
    x = img[:, None]
    gx = torch.nn.functional.conv2d(torch.nn.functional.pad(x, (1, 1, 1, 1), mode="replicate"), k[None, None])
    gy = torch.nn.functional.conv2d(torch.nn.functional.pad(x, (1, 1, 1, 1), mode="replicate"), k.T[None, None])
    return torch.sqrt(gx * gx + gy * gy)[:, 0]


def phase_correlate(torch, a, b):
    """Translation between image windows a, b (B, N, N): returns (dx, dy,
    response) such that b(x) ~ a(x - (dx, dy)), i.e. a feature at p in a sits
    at p + (dx, dy) in b. Sub-pixel by a parabola through the peak."""
    B, N, _ = a.shape
    win = torch.hann_window(N, periodic=False, device=a.device)
    w2 = (win[:, None] * win[None, :])[None]
    a = (a - a.mean(dim=(1, 2), keepdim=True)) * w2
    b = (b - b.mean(dim=(1, 2), keepdim=True)) * w2
    Fa, Fb = torch.fft.fft2(a), torch.fft.fft2(b)
    cross = Fa.conj() * Fb
    r = torch.fft.ifft2(cross / cross.abs().clamp(min=1e-12)).real
    flat = r.reshape(B, -1)
    peak, idx = flat.max(dim=1)
    py, px = idx // N, idx % N

    def at(yy, xx):
        return r[torch.arange(B, device=a.device), yy % N, xx % N]

    def parabola(m, c, p):
        den = m - 2 * c + p
        return torch.where(den.abs() > 1e-9, 0.5 * (m - p) / den, torch.zeros_like(den))

    fx = parabola(at(py, px - 1), peak, at(py, px + 1)).clamp(-0.5, 0.5)
    fy = parabola(at(py - 1, px), peak, at(py + 1, px)).clamp(-0.5, 0.5)
    dx = torch.where(px > N // 2, px - N, px).float() + fx
    dy = torch.where(py > N // 2, py - N, py).float() + fy
    return dx, dy, peak
