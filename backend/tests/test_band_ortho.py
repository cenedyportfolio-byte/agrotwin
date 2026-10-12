"""Synthetic checks of the band-orthophoto geometry and radiometry: a band
camera's attitude is recovered from how its image lines up with a reference
(the per-capture fit and the rig calibration rest on this), a ground point
projects back onto the pixel whose ray found it, the radiometric
balancing recovers per-capture gains from overlaps, and the final
co-registration pulls every band onto the photo.

Run (from backend/):  python -m tests.test_band_ortho
"""

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import band_ortho_service as bo  # noqa: E402
from app.services import camera_model as cm  # noqa: E402

CAM = cm.BrownCamera(1200, 900, 1000.0, 1000.0, 600.0 + 7.0, 450.0 - 5.0, k1=0.004, k2=-0.044, p1=-0.0006, p2=0.0009)
GROUND_RES, GROUND_N = 0.025, 2400  # 60 m square of synthetic texture


def _setup():
    import torch
    from rasterio.transform import from_origin

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    rng = np.random.default_rng(3)
    tex = rng.random((GROUND_N, GROUND_N)).astype(np.float32)
    t = torch.from_numpy(tex).to(dev)[None, None]
    tex = torch.nn.functional.avg_pool2d(t, 5, 1, 2)[0]  # ~12 cm features
    tex = tex + 0.5 * torch.nn.functional.avg_pool2d(t, 41, 1, 20)[0]
    E0, N1 = 627400.0, 3995700.0  # UTM magnitudes, as in the field
    z = np.full((120, 120), 262.0, np.float32)
    z += np.linspace(0, 1.5, 120, dtype=np.float32)[None, :]  # gentle slope
    dsm = cm.SurfaceModel(torch, z, np.ones_like(z, bool), from_origin(E0, N1, 0.5, 0.5), dev)
    gx0, gy1 = E0 - dsm.origin[0], N1 - dsm.origin[1]

    class Texture:  # reference with the same interface as the photo / band references
        def sample(self, x, y, zz=None):
            u = (x - gx0) / GROUND_RES - 0.5
            v = (gy1 - y) / GROUND_RES - 0.5
            return cm.sample_image(torch, tex, u, v)[0], (u > 0) & (u < GROUND_N - 1) & (v > 0) & (v < GROUND_N - 1)

    C = dsm.local([E0 + 30.0, N1 - 30.0, 292.0])
    return torch, dev, dsm, Texture(), C


def _render(torch, dev, dsm, ref, C, R):
    """What the band camera with attitude R records (raw, distorted pixels)."""
    v, u = torch.meshgrid(torch.arange(CAM.height, device=dev, dtype=torch.float32),
                          torch.arange(CAM.width, device=dev, dtype=torch.float32), indexing="ij")
    xn, yn = CAM.undistort(u, v)
    x, y, z = dsm.intersect(C, bo._world_dirs(torch, xn, yn, R))
    return ref.sample(x, y, z)[0]


def test_attitude_is_recovered():
    torch, dev, dsm, ref, C = _setup()
    # a nadir camera, heading 37°, tilted ~7° like the M3M
    R_true = cm.rodrigues([0.0, 0.0, math.radians(37)]) @ np.diag([1.0, -1.0, -1.0])
    R_true = cm.rodrigues([0.09, -0.07, 0.0]) @ R_true
    img = _render(torch, dev, dsm, ref, C, R_true)
    R_start = cm.rodrigues([0.003, -0.004, 0.002]) @ R_true  # ~0.3° off, like the rig prediction
    fit = bo._fit_band_rotation(torch, CAM, img, R_start, C, dsm, ref, dev)
    assert fit is not None
    R, resid, inliers = fit
    err = cm.rotation_angle_deg(R @ R_true.T)
    assert err < 0.01 and resid < 0.5 and inliers >= 12, (err, resid, inliers)


def test_ground_point_projects_back():
    torch, dev, dsm, ref, C = _setup()
    R = cm.rodrigues([0.05, 0.02, 1.0]) @ np.diag([1.0, -1.0, -1.0])
    u = torch.tensor([10.0, 600.0, 1190.0, 300.0], device=dev)
    v = torch.tensor([5.0, 450.0, 890.0, 700.0], device=dev)
    xn, yn = CAM.undistort(u, v)
    x, y, z = dsm.intersect(C, bo._world_dirs(torch, xn, yn, R))
    u2, v2, ok = bo._project(torch, CAM, R, C, x, y, z)
    assert bool(ok.all())
    assert torch.sqrt((u2 - u) ** 2 + (v2 - v) ** 2).max().item() < 0.05


def test_balancing_recovers_gains():
    rng = np.random.default_rng(4)
    n_cap, truth = 12, np.exp(rng.normal(0, 0.3, 12))
    overlaps = []
    ground = rng.uniform(0.5, 1.5, (400, len(bo.BANDS)))
    for i in range(n_cap):
        cells = np.arange(i * 30, i * 30 + 60)  # each capture overlaps the next by half
        m = ground[cells] * truth[i] * rng.normal(1, 0.01, (60, len(bo.BANDS)))
        overlaps.append((i, cells, m.astype(np.float32)))
    gains, info = bo._balance_gains(overlaps, n_cap)
    corrected = truth * gains[0]
    assert np.std(np.log(corrected)) < 0.02, np.std(np.log(corrected))
    assert info["GREEN"]["overlap_disagreement_after_pct"] < info["GREEN"]["overlap_disagreement_before_pct"]


def test_radiometry_matches_dji_formula_on_cpu_and_gpu():
    """(DN - black) x vignetting x SensorGainAdjustment / (gain x exposure x irradiance),
    identical in the per-frame path (numpy) and the orthophoto path (GPU)."""
    import torch

    from app.services import multispectral_service as ms

    xmp = {"BlackLevel": "3200", "SensorGain": "1.021", "ExposureTime": "1232", "Irradiance": "11436.2",
           "SensorGainAdjustment": "0.513075",
           "VignettingCenter": {"Seq": {"li": ["1256.7", "943.9"]}},
           "VignettingPolynomial": {"Seq": {"li": ["1.2e-4", "-2.0e-7", "1.5e-9", "0", "0", "0"]}}}
    dn = np.random.default_rng(7).uniform(3000, 20000, (1944, 2592)).astype(np.float32)
    cpu = ms._radiometric_calibration(dn.copy(), xmp, 1.0)
    cal = ms.band_calibration(xmp)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    gpu = (bo._calibrate(torch, torch.from_numpy(dn).to(dev), cal) / bo.VALUE_SCALE).cpu().numpy()
    assert np.allclose(cpu, gpu, rtol=1e-4, atol=1e-9)
    # one pixel by hand
    y, x = 100, 2000
    r = math.hypot(x - 1256.7, y - 943.9)
    v = 1 + 1.2e-4 * r - 2.0e-7 * r**2 + 1.5e-9 * r**3
    expect = max(dn[y, x] - 3200, 0) * v * 0.513075 / (1.021 * 1232 * 11436.2)
    assert abs(cpu[y, x] - expect) < 1e-6 * expect + 1e-12, (cpu[y, x], expect)


def test_alignment_to_photo_removes_a_local_shift():
    """Green is pulled onto the photo, and a band displaced differently from
    Green (as Red is, in patches) gets its own correction on top."""
    import torch

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    rng = np.random.default_rng(9)
    H = W = 1024
    base = torch.from_numpy(rng.random((H + 64, W + 64)).astype(np.float32)).to(dev)
    tex = torch.nn.functional.avg_pool2d(base[None, None], 3, 1, 1)[0, 0] * 200 + 20
    photo = tex[32:32 + H, 32:32 + W].round().to(torch.uint8)
    # the band maps are the same ground, displaced by up to 3 px east in the right part (as near a coverage
    # edge), and Red by up to 2 px more north-south in the lower part
    yy, xx = torch.meshgrid(torch.arange(H, device=dev, dtype=torch.float32),
                            torch.arange(W, device=dev, dtype=torch.float32), indexing="ij")
    shift_x = 3.0 * torch.clamp((xx - 400) / 300, 0, 1)
    shift_y = 2.0 * torch.clamp((yy - 400) / 300, 0, 1)
    band = cm.sample_image(torch, tex[None], xx + 32 + shift_x, yy + 32)[0]
    red = cm.sample_image(torch, tex[None], xx + 32 + shift_x, yy + 32 + shift_y)[0]
    canvas = torch.stack([red if b == "RED" else band for b in bo.BANDS]).to(torch.float16) * 0.01
    best = torch.zeros((H, W), device=dev, dtype=torch.float16)
    grid = bo.Grid(0.0, 0.0, 0.015, W, H, None)
    info = bo._align_to_photo(torch, canvas, best, photo, torch.ones((H, W), dtype=torch.bool, device=dev), grid)
    assert info["applied"] and info["GREEN_vs_photo"]["shift_max_cm"] > 2.5 * 1.5, info
    assert info["RED_vs_GREEN"]["shift_max_cm"] > 1.5 * 1.5 and info["NIR_vs_GREEN"]["shift_max_cm"] < 0.5 * 1.5, info
    a = cm.gradient_magnitude(torch, photo.float()[None, 720:976, 720:976])
    for b in ("GREEN", "RED", "NIR"):
        g = cm.gradient_magnitude(torch, canvas[bo.BANDS.index(b), 720:976, 720:976].float()[None])
        dx, dy, _ = cm.phase_correlate(torch, a, g)
        assert abs(float(dx)) < 0.3 and abs(float(dy)) < 0.3, (b, float(dx), float(dy))


def test_percentiles_of_a_masked_raster():
    import torch

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    g = torch.Generator(device=dev).manual_seed(5)
    values = torch.rand((5000, 4000), device=dev, generator=g).to(torch.float16)
    mask = torch.zeros_like(values, dtype=torch.bool)
    mask[:, :1000] = True  # a quarter of the raster ...
    values[:, :1000] *= 0.5  # ... holding values in [0, 0.5)
    values[0, 0] = float("nan")
    lo, hi = bo._percentiles(torch, values, [0.1, 0.9], mask)
    assert abs(lo - 0.05) < 0.002 and abs(hi - 0.45) < 0.002, (lo, hi)


def test_alignment_outlier_leaves_no_holes():
    """A window whose offset disagrees with its neighbours in one component only
    (here: a patch displaced 8 px north-south) used to keep the other component,
    leave a NaN in the displacement field, and the smoothing spread it into
    metre-sized holes in every band."""
    import torch

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    rng = np.random.default_rng(11)
    H = W = 1024
    base = torch.from_numpy(rng.random((H + 64, W + 64)).astype(np.float32)).to(dev)
    tex = torch.nn.functional.avg_pool2d(base[None, None], 3, 1, 1)[0, 0] * 200 + 20
    photo = tex[32:32 + H, 32:32 + W].round().to(torch.uint8)
    yy, xx = torch.meshgrid(torch.arange(H, device=dev, dtype=torch.float32),
                            torch.arange(W, device=dev, dtype=torch.float32), indexing="ij")
    patch = (yy >= 512) & (yy < 640) & (xx >= 256) & (xx < 384)
    band = cm.sample_image(torch, tex[None], xx + 32, yy + 32 + 8.0 * patch)[0]
    canvas = torch.stack([band] * len(bo.BANDS)).to(torch.float16) * 0.01
    best = torch.zeros((H, W), device=dev, dtype=torch.float16)
    grid = bo.Grid(0.0, 0.0, 0.015, W, H, None)
    info = bo._align_to_photo(torch, canvas, best, photo, torch.ones((H, W), dtype=torch.bool, device=dev), grid)
    green = info["GREEN_vs_photo"]
    assert info["applied"] and green["dropped"] >= 1, info
    assert np.isfinite([green["shift_median_cm"], green["shift_p90_cm"], green["shift_max_cm"]]).all(), info
    # pixels on the image border may map just outside it and be emptied; inside, nothing may be lost
    assert torch.isfinite(best[16:-16, 16:-16]).all() and torch.isfinite(canvas).all()


def main():
    test_radiometry_matches_dji_formula_on_cpu_and_gpu()
    test_ground_point_projects_back()
    test_attitude_is_recovered()
    test_balancing_recovers_gains()
    test_alignment_to_photo_removes_a_local_shift()
    test_alignment_outlier_leaves_no_holes()
    test_percentiles_of_a_masked_raster()
    print("band_ortho: all checks passed")


if __name__ == "__main__":
    main()
