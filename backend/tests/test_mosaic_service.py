"""Synthetic checks of the quick-mosaic geometry: a frame's marker must land
at the right ground position for a plain and a 180°-roll frame, the lens
model must refuse points past its fold-back radius, and overlapping frames
must resolve to the more nadir one instead of averaging.

Run (from backend/):  python -m tests.test_mosaic_service
"""

import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services import mosaic_service as m  # noqa: E402

# 400x300 frame, 10 m above ground, f = 1000 px -> 1 cm/px, principal point at the centre
W_IMG, H_IMG, AGL, FOCAL = 400, 300, 10.0, 1000.0
E0, N0, GSD, GRID = 995.0, 2005.0, 0.01, 1000


def _frame(path: Path, dot_uv=(300, 75), value=255) -> Path:
    img = np.full((H_IMG, W_IMG, 3), 40, np.uint8)
    u, v = dot_uv
    img[v - 1:v + 2, u - 1:u + 2] = value
    Image.fromarray(img).save(path)
    return path


def _render(path: Path, heading: float, east=1000.0, north=2000.0):
    g = m.FrameGeom(east, north, heading, AGL, FOCAL, W_IMG / 2, H_IMG / 2)
    G, gt = m._ground_to_grid(E0, N0, GSD)
    return m._render_frame(g, path, W_IMG, H_IMG, 1, G, gt, GRID, GRID)


def _bright_centre(rendered) -> tuple[float, float]:
    c0, r0, _, _, pix, score = rendered
    ys, xs = np.nonzero((pix[..., 0] > 200) & (score > 0))
    return r0 + ys.mean(), c0 + xs.mean()


def test_heading_from_roll():
    assert m.image_heading_deg(127.0, 0.0) == 127.0
    assert m.image_heading_deg(127.0, 180.0) == 307.0
    assert m.image_heading_deg(-53.0, -180.0) == 127.0
    assert m.image_heading_deg(10.0, None) == 10.0


def _grid_index(east: float, north: float) -> tuple[float, float]:
    """(row, col) index of the grid pixel whose centre is at (east, north)."""
    return (N0 - north) / GSD - 0.5, (east - E0) / GSD - 0.5


def test_marker_lands_on_the_ground_position(tmp: Path):
    path = _frame(tmp / "f.png")
    # dot centre (pixel 300.5, 75.5) is 100.5 px right of and 74.5 px above the
    # principal point -> 1.005 m E, 0.745 m N of the camera
    got = _bright_centre(_render(path, heading=0.0))
    want = _grid_index(1001.005, 2000.745)
    assert np.allclose(got, want, atol=0.6), (got, want)
    # the same frame flown as a 180°-roll return leg: 1.005 m W, 0.745 m S
    got = _bright_centre(_render(path, heading=m.image_heading_deg(0.0, 180.0)))
    want = _grid_index(998.995, 1999.255)
    assert np.allclose(got, want, atol=0.6), (got, want)


def test_lens_fold_back_is_refused():
    d = m.Dewarp(3713.29, 3713.29, 2647.02, 1969.28, -0.11257524, 0.01487443, -8.572e-05, 1e-07, -0.02706411)
    assert abs(m._fold_radius2(d) ** 0.5 - 1.23) < 0.01
    # normalised radius 1.6 folds back onto r = 0.57, a real pixel; it must be marked invalid
    u = np.array([d.cx + 1.6 * d.fx, d.cx + 0.5 * d.fx], np.float32)
    v = np.array([d.cy, d.cy], np.float32)
    su, _, ok = m._distort(d, u, v, 1.0)
    assert not ok[0] and ok[1]
    assert abs((su[0] - d.cx) / d.fx - 0.57) < 0.01  # the alias the guard exists for


def test_overlap_takes_the_nadir_frame(tmp: Path):
    """Two frames see the same ground point; the one that sees it nearer its
    centre wins outright (no blend of the two values)."""
    near = _frame(tmp / "near.png", dot_uv=(210, 150), value=250)  # ~0.1 m from its principal point
    far = _frame(tmp / "far.png", dot_uv=(390, 150), value=120)  # ~1.9 m from its principal point
    canvas = np.zeros((GRID, GRID, 3), np.uint8)
    best = np.zeros((GRID, GRID), np.float32)
    for rendered in (_render(far, 0.0, east=998.2), _render(near, 0.0, east=1000.0)):
        c0, r0, c1, r1, pix, score = rendered
        win = score > best[r0:r1, c0:c1]
        np.copyto(best[r0:r1, c0:c1], score, where=win)
        np.copyto(canvas[r0:r1, c0:c1], pix, where=win[..., None])
    # both dots sit at E = 1000.105; the grid pixel there must hold the near frame's 250
    col = int((1000.105 - E0) / GSD)
    row = int((N0 - 1999.995) / GSD)
    assert canvas[row, col, 0] == 250, canvas[row - 1:row + 2, col - 1:col + 2, 0]


def test_gpu_matches_cpu(tmp: Path) -> bool:
    """The VRAM compositor must produce the CPU path's mosaic. Skipped without CUDA."""
    from app.services import gpu

    if gpu.cuda_torch() is None:
        return False
    rng = np.random.default_rng(0)
    frames = []
    for i, (east, heading) in enumerate([(1000.0, 0.0), (1001.3, 180.0), (999.4, 37.0)]):
        p = tmp / f"tex{i}.png"
        Image.fromarray(rng.integers(0, 256, (H_IMG, W_IMG, 3), dtype=np.uint8)).save(p)
        frames.append((m.FrameGeom(east, 2000.0, heading, AGL, FOCAL, W_IMG / 2, H_IMG / 2), p, W_IMG, H_IMG, p.name))
    G, gt = m._ground_to_grid(E0, N0, GSD)
    cpu, _ = m._composite_cpu(frames, 1, G, gt, GRID, GRID)
    comp = m._GpuCompositor.create(GRID, GRID)
    gpu_out, _ = m._composite_gpu(comp, frames, 1, G, gt)
    covered = (cpu > 0).all(axis=-1) & (gpu_out > 0).all(axis=-1)
    diff = np.abs(cpu.astype(int) - gpu_out.astype(int))[covered]
    # bilinear weights differ slightly (OpenCV 1/32-px fixed point vs float); a
    # different winning frame would show as large errors on this random texture
    assert covered.sum() > 100_000 and np.percentile(diff, 99) <= 8, (covered.sum(), np.percentile(diff, 99))
    assert ((cpu > 0).all(axis=-1) == (gpu_out > 0).all(axis=-1)).mean() > 0.999
    return True


def main():
    test_heading_from_roll()
    test_lens_fold_back_is_refused()
    with tempfile.TemporaryDirectory() as d:
        test_marker_lands_on_the_ground_position(Path(d))
        test_overlap_takes_the_nadir_frame(Path(d))
        ran = test_gpu_matches_cpu(Path(d))
    print("mosaic_service: all checks passed" + ("" if ran else " (GPU parity skipped: no CUDA)"))


if __name__ == "__main__":
    main()
