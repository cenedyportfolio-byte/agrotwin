"""Checks of the GPU camera geometry used by the band orthophotos: lens model
round trip, rotation fit, phase-correlation sign, ray casting onto a sloped
surface, and that local coordinates keep centimetres at UTM magnitudes.

Run (from backend/):  python -m tests.test_camera_model
"""

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import camera_model as cm  # noqa: E402

# the M3M NIR band's own DewarpData (2592 x 1944)
NIR = cm.BrownCamera(2592, 1944, 2199.84, 2193.24, 1296 + 16.80, 972 - 19.87,
                     k1=0.0021454, k2=-0.0407911, k3=0.0, p1=-0.00105771, p2=0.000477983)


def _torch():
    import torch

    return torch, ("cuda" if torch.cuda.is_available() else "cpu")


def test_lens_round_trip():
    torch, dev = _torch()
    v, u = torch.meshgrid(torch.linspace(0, 1943, 40, device=dev), torch.linspace(0, 2591, 50, device=dev), indexing="ij")
    xn, yn = NIR.undistort(u, v)
    u2, v2, ok = NIR.project(xn, yn, torch.ones_like(xn))
    assert bool(ok.all())
    err = torch.sqrt((u2 - u) ** 2 + (v2 - v) ** 2).max().item()
    assert err < 0.01, err


def test_scaled_camera_keeps_rays():
    half = NIR.scaled(0.5)
    # pixel centre (u, v) full-res sits at ((u + 0.5) / 2 - 0.5) at half resolution
    u, v = 1700.0, 300.0
    a = ((u - NIR.cx) / NIR.fx, (v - NIR.cy) / NIR.fy)
    uh, vh = (u + 0.5) * 0.5 - 0.5, (v + 0.5) * 0.5 - 0.5
    b = ((uh - half.cx) / half.fx, (vh - half.cy) / half.fy)
    assert abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9


def test_rotation_fit_recovers_attitude():
    rng = np.random.default_rng(1)
    R_true = cm.rodrigues([0.03, -0.12, 2.1])
    world = rng.normal(size=(80, 3))
    world[:, 2] = -np.abs(world[:, 2]) - 2
    world /= np.linalg.norm(world, axis=1, keepdims=True)
    cam = world @ R_true.T + rng.normal(scale=2e-4, size=world.shape)
    cam[:10] = rng.normal(size=(10, 3))  # outliers
    cam /= np.linalg.norm(cam, axis=1, keepdims=True)
    R, inl = cm.solve_rotation_ransac(world, cam, threshold_rad=0.002)
    assert inl[10:].mean() > 0.95 and inl[:10].sum() <= 1
    assert cm.rotation_angle_deg(R @ R_true.T) < 0.02


def test_mean_rotation():
    Rs = [cm.rodrigues([0.01 * s, 0.002, -0.004 * s]) for s in (-1, 0, 1)]
    assert cm.rotation_angle_deg(cm.mean_rotation(Rs) @ cm.rodrigues([0.0, 0.002, 0.0]).T) < 1e-3


def test_phase_correlation_sign():
    torch, dev = _torch()
    rng = np.random.default_rng(2)
    base = torch.from_numpy(rng.random((200, 200)).astype(np.float32)).to(dev)
    base = torch.nn.functional.avg_pool2d(base[None, None], 3, 1, 1)[0, 0]
    a = base[40:168, 40:168]
    b = base[40 - 5:168 - 5, 40 + 3:168 + 3]  # b(x) = a(x - (-3, +5)): features move 3 left, 5 down
    dx, dy, resp = cm.phase_correlate(torch, a[None], b[None])
    assert abs(dx.item() + 3) < 0.2 and abs(dy.item() - 5) < 0.2, (dx.item(), dy.item())
    assert resp.item() > 0.3


def test_ray_casting_on_a_slope():
    torch, dev = _torch()
    from rasterio.transform import from_origin

    # 1 m cells, 200 x 200 m, rising 2 m per 100 m eastwards, at UTM magnitudes
    E0, N1 = 627400.0, 3995800.0
    cols = np.arange(200) + 0.5
    z = np.tile(260.0 + 0.02 * cols, (200, 1)).astype(np.float32)
    dsm = cm.SurfaceModel(torch, z, np.ones_like(z, bool), from_origin(E0, N1, 1.0, 1.0), dev)
    centre = dsm.local([E0 + 100.0, N1 - 100.0, 292.0])
    dirs = torch.tensor([[0.0, 0.0, -1.0], [0.3, 0.0, -1.0], [-0.2, 0.25, -1.0]], device=dev)
    dirs = dirs / dirs.norm(dim=-1, keepdim=True)
    x, y, h = dsm.intersect(centre, dirs)
    for i in range(3):
        ground = 260.0 + 0.02 * (x[i].item() + dsm.origin[0] - E0)
        assert abs(h[i].item() - ground) < 1e-3, (h[i].item(), ground)
        # the point lies on the ray
        t = (h[i].item() - centre[2]) / dirs[i, 2].item()
        assert abs(centre[0] + t * dirs[i, 0].item() - x[i].item()) < 1e-3
    # local coordinates keep sub-millimetre resolution at a 4,000 km northing
    yy = torch.tensor([N1 - 100.0123 - dsm.origin[1]], device=dev, dtype=torch.float32)
    assert abs(yy.item() + dsm.origin[1] - (N1 - 100.0123)) < 1e-4


def main():
    test_lens_round_trip()
    test_scaled_camera_keeps_rays()
    test_rotation_fit_recovers_attitude()
    test_mean_rotation()
    test_phase_correlation_sign()
    test_ray_casting_on_a_slope()
    torch, dev = _torch()
    print(f"camera_model: all checks passed ({dev})")


if __name__ == "__main__":
    main()
