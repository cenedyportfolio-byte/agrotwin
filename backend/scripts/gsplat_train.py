#!/usr/bin/env python3
"""3D Gaussian Splatting trainer — the in-repo replacement for the external
CesiumSplatData/train.py that build_splats.py used to shell out to.

Reads the geo-aligned, undistorted COLMAP workspace produced by build_splats.py
and writes a standard 3DGS ply (f_dc/opacity/scale/rot) that tile_splats_spz.py
and build_dense.py already know how to read.

Built on gsplat's public API only: rasterization + MCMCStrategy + export_splats.
The recipe follows gsplat's reference trainer (examples/simple_trainer.py):
SfM point init, per-parameter Adam, exponential decay on means, L1+SSIM loss,
MCMC densification with a hard splat cap, and scale/opacity regularisers that
keep a nadir-only capture from degenerating into needles.

Run with the GPU venv (needs CUDA toolkit + MSVC on PATH to JIT the kernels):
    .venv-gpu/Scripts/python.exe -m scripts.gsplat_train --survey <id>
"""

import argparse
import json
import math
import os
import random
import time
from pathlib import Path

# Training runs on the GPU; the only CPU work is copying frames into pinned
# memory. With the default OpenMP pool (one thread per core, spinning 200 ms
# after every parallel region) that copy kept 8 laptop cores at 100 % for
# nothing and ate the power budget the GPU shares with the CPU. Set before
# torch loads OpenMP.
os.environ.setdefault("KMP_BLOCKTIME", "0")
os.environ.setdefault("OMP_NUM_THREADS", "2")

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from PIL import Image  # noqa: E402

AGROTWIN = Path(__file__).resolve().parents[2]
SPLATS_DIR = AGROTWIN / "data" / "splats"

SH_C0 = 0.28209479177387814

# gsplat reference learning rates. The world is normalised to camera radius 1,
# so means gets the reference's scene_scale = 1.1 * max camera distance.
BASE_LRS = {
    "means": 1.6e-4 * 1.1,
    "scales": 5e-3,
    "quats": 1e-3,
    "opacities": 5e-2,
    "sh0": 2.5e-3,
    "shN": 2.5e-3 / 20,
}


def log(msg):
    print(msg, flush=True)


def rgb_to_sh(rgb: torch.Tensor) -> torch.Tensor:
    return (rgb - 0.5) / SH_C0


def knn_mean_dist(points: torch.Tensor, k: int = 4, chunk: int = 256) -> torch.Tensor:
    """Mean distance to the k-1 nearest neighbours. chunk x N distances at a
    time: at 770k points a 4096 chunk was a 12.6 GB matrix — the 23.5 GB peak
    seen in the first run was this, not training."""
    out = torch.empty(points.shape[0], device=points.device)
    for i in range(0, points.shape[0], chunk):
        d = torch.cdist(points[i : i + chunk], points)
        vals, _ = torch.topk(d, k, dim=1, largest=False)
        out[i : i + chunk] = vals[:, 1:].mean(dim=1)  # column 0 is the point itself
    return out


def gaussian_window(size: int, sigma: float, device) -> torch.Tensor:
    coords = torch.arange(size, dtype=torch.float32, device=device) - size // 2
    g = torch.exp(-(coords**2) / (2 * sigma**2))
    g = g / g.sum()
    return g[:, None] @ g[None, :]


def ssim(pred: torch.Tensor, target: torch.Tensor, window_size: int = 11) -> torch.Tensor:
    """Mean SSIM over a [1, 3, H, W] pair. Standard Gaussian-window formulation."""
    c = pred.shape[1]
    win = gaussian_window(window_size, 1.5, pred.device).expand(c, 1, window_size, window_size)
    pad = window_size // 2
    mu1 = F.conv2d(pred, win, padding=pad, groups=c)
    mu2 = F.conv2d(target, win, padding=pad, groups=c)
    mu1_sq, mu2_sq, mu1_mu2 = mu1 * mu1, mu2 * mu2, mu1 * mu2
    sigma1 = F.conv2d(pred * pred, win, padding=pad, groups=c) - mu1_sq
    sigma2 = F.conv2d(target * target, win, padding=pad, groups=c) - mu2_sq
    sigma12 = F.conv2d(pred * target, win, padding=pad, groups=c) - mu1_mu2
    c1, c2 = 0.01**2, 0.03**2
    m = ((2 * mu1_mu2 + c1) * (2 * sigma12 + c2)) / ((mu1_sq + mu2_sq + c1) * (sigma1 + sigma2 + c2))
    return m.mean()


def load_workspace(undistorted: Path):
    """Cameras, poses and the SfM point cloud from an undistorted COLMAP model."""
    import pycolmap

    rec = pycolmap.Reconstruction(str(undistorted / "sparse"))
    pts = np.array([p.xyz for p in rec.points3D.values()], dtype=np.float32)
    cols = np.array([p.color for p in rec.points3D.values()], dtype=np.float32) / 255.0

    frames = []
    for img in rec.images.values():
        if not img.has_pose:
            continue
        cam = rec.cameras[img.camera_id]
        if cam.model_name != "PINHOLE":
            raise SystemExit(f"expected an undistorted PINHOLE model, got {cam.model_name}")
        w2c = np.eye(4, dtype=np.float32)
        w2c[:3, :4] = img.cam_from_world().matrix()  # COLMAP stores world->camera
        frames.append(
            {
                "path": undistorted / "images" / img.name,
                "K": cam.calibration_matrix().astype(np.float32),
                "viewmat": w2c,
                "width": cam.width,
                "height": cam.height,
            }
        )
    if not frames:
        raise SystemExit("no posed images in the undistorted model")

    # Normalise the world like gsplat's reference trainer: cameras centred on
    # their centroid and scaled so the farthest sits at radius 1. The MCMC
    # strategy's position noise is calibrated for that scale — trained in raw
    # metres on this 170 m field it flung 99% of the Gaussians kilometres away.
    # Everything exported is mapped back to the geo-aligned metric frame.
    centers = np.array([np.linalg.inv(f["viewmat"])[:3, 3] for f in frames])
    origin = centers.mean(0).astype(np.float32)
    scale = float(np.linalg.norm(centers - origin, axis=1).max())
    for f in frames:
        w2c = f["viewmat"].copy()
        w2c[:3, 3] = (w2c[:3, 3] + w2c[:3, :3] @ origin) / scale  # rotation unchanged
        f["viewmat"] = w2c
    pts = (pts - origin) / scale
    norm = {"origin": origin, "scale": scale}
    log(f"workspace: {len(frames)} posed frames, {len(pts)} SfM points, world scale {scale:.1f} m -> 1.0")
    return pts, cols, frames, norm


class GroundBand:
    """Per-location height limits from the SfM point cloud.

    A nadir-only flight gives 3DGS almost no depth constraint: a splat can slide
    up its view ray toward the camera, where it covers a large part of one frame
    and no other frame sees it. Run #5 did exactly that — the cloud's median
    rose from the ground (-11.3 m) to -6.5 m over 30k steps and the render
    collapsed to an average colour. Everything on a field is within ~1 m of the
    ground, and the multi-view-triangulated SfM points *are* the ground, so each
    splat's height is clamped to [ground - below, ground + above] of the median
    SfM height in its 2 m cell. Trees at the margins are flattened; that is the
    documented 2.5D limitation of this pipeline already.
    """

    def __init__(self, pts: np.ndarray, norm: dict, device, cell_m: float = 2.0, below_m: float = 1.0, above_m: float = 1.5):
        s = norm["scale"]
        self.cell = cell_m / s
        self.below, self.above = below_m / s, above_m / s
        x, y, z = pts[:, 0], pts[:, 1], pts[:, 2]
        self.x0, self.z0 = float(x.min()), float(z.min())
        w = int((x.max() - self.x0) / self.cell) + 1
        h = int((z.max() - self.z0) / self.cell) + 1
        ix = ((x - self.x0) / self.cell).astype(np.int64).clip(0, w - 1)
        iz = ((z - self.z0) / self.cell).astype(np.int64).clip(0, h - 1)
        grid = np.full((h, w), np.nan, np.float32)
        order = np.lexsort((y, iz * w + ix))
        keys = (iz * w + ix)[order]
        ys = y[order]
        starts = np.flatnonzero(np.r_[True, keys[1:] != keys[:-1]])
        for a, b in zip(starts, np.r_[starts[1:], len(keys)]):
            grid.flat[keys[a]] = np.median(ys[a:b])
        # fill empty cells from the nearest sampled cell
        if np.isnan(grid).any():
            from scipy import ndimage

            idx = ndimage.distance_transform_edt(np.isnan(grid), return_distances=False, return_indices=True)
            grid = grid[tuple(idx)]
        self.grid = torch.from_numpy(grid).to(device)
        self.w, self.h = w, h
        log(f"ground band: {w}x{h} cells of {cell_m} m from {len(pts)} SfM points, "
            f"[-{below_m}, +{above_m}] m; ground median {float(np.median(y)) * s:.1f} m")

    @torch.no_grad()
    def clamp_(self, means: torch.Tensor):
        ix = ((means[:, 0] - self.x0) / self.cell).long().clamp_(0, self.w - 1)
        iz = ((means[:, 2] - self.z0) / self.cell).long().clamp_(0, self.h - 1)
        g = self.grid[iz, ix]
        means[:, 1] = torch.maximum(torch.minimum(means[:, 1], g + self.above), g - self.below)


def denormalise(splats, norm):
    """Training-frame parameters -> geo-aligned metric frame (what the ply carries)."""
    with torch.no_grad():
        origin = torch.as_tensor(norm["origin"], device=splats["means"].device)
        out = {k: v.detach() for k, v in splats.items()}
        out["means"] = out["means"] * norm["scale"] + origin
        out["scales"] = out["scales"] + math.log(norm["scale"])
        return out


def init_splats(points, colors, sh_degree, init_opacity, init_scale, device):
    pts = torch.from_numpy(points).to(device)
    rgb = torch.from_numpy(colors).to(device)
    n = pts.shape[0]

    dist = knn_mean_dist(pts, 4).clamp(min=1e-6)
    scales = torch.log(dist * init_scale)[:, None].repeat(1, 3)

    sh = torch.zeros(n, (sh_degree + 1) ** 2, 3, device=device)
    sh[:, 0, :] = rgb_to_sh(rgb)

    splats = torch.nn.ParameterDict(
        {
            "means": torch.nn.Parameter(pts),
            "scales": torch.nn.Parameter(scales),
            "quats": torch.nn.Parameter(torch.rand(n, 4, device=device)),
            "opacities": torch.nn.Parameter(torch.logit(torch.full((n,), init_opacity, device=device))),
            "sh0": torch.nn.Parameter(sh[:, :1, :].contiguous()),
            "shN": torch.nn.Parameter(sh[:, 1:, :].contiguous()),
        }
    ).to(device)

    lrs = dict(BASE_LRS)
    optimizers = {k: torch.optim.Adam([splats[k]], lr=v, eps=1e-15) for k, v in lrs.items()}
    log(f"init: {n} splats, means lr {lrs['means']:.2e} (normalised units)")
    return splats, optimizers


class FramePrefetcher:
    """Decodes upcoming frames on CPU threads so the GPU never waits on JPEG
    entropy decoding, which nvJPEG also runs on the CPU on GeForce cards."""

    def __init__(self, frames, workers: int = 8, ahead: int = 24, cache_limit: int = 8 * 1024**3):
        import collections
        import threading
        from concurrent.futures import ThreadPoolExecutor

        self.frames = frames
        self.pool = ThreadPoolExecutor(max_workers=workers)
        self.ahead = ahead
        self.queue = collections.deque()
        self.order: list[int] = []
        # bytes stay in RAM after the first read: the workspace is on an HDD
        self.cache: dict[int, bytes] = {}
        self.cache_bytes = 0
        self.cache_limit = cache_limit
        self.lock = threading.Lock()

    def _next_index(self) -> int:
        if not self.order:
            self.order = list(range(len(self.frames)))
            random.shuffle(self.order)
        return self.order.pop()

    def _decode(self, idx: int):
        import io

        data = self.cache.get(idx)
        if data is None:
            data = Path(self.frames[idx]["path"]).read_bytes()
            with self.lock:
                if self.cache_bytes + len(data) <= self.cache_limit:
                    self.cache[idx] = data
                    self.cache_bytes += len(data)
        img = np.array(Image.open(io.BytesIO(data)).convert("RGB"))
        return idx, torch.from_numpy(img).pin_memory()

    def next(self, device):
        while len(self.queue) < self.ahead:
            self.queue.append(self.pool.submit(self._decode, self._next_index()))
        idx, pinned = self.queue.popleft().result()
        return self.frames[idx], pinned.to(device, non_blocking=True).float().div_(255.0)


CHECKPOINT = "checkpoint.pt"


def save_checkpoint(path: Path, step: int, splats, optimizers, scheduler, lrs: dict):
    """Everything needed to continue exactly where training stopped. Written
    atomically so a crash mid-write can't leave a corrupt file behind."""
    tmp = path.with_suffix(".pt.tmp")
    torch.save(
        {
            "step": step,
            "splats": {k: v.detach().cpu() for k, v in splats.items()},
            "optimizers": {k: o.state_dict() for k, o in optimizers.items()},
            "scheduler": scheduler.state_dict(),
            "lrs": lrs,
        },
        tmp,
    )
    tmp.replace(path)


def load_checkpoint(path: Path, device):
    ck = torch.load(path, map_location="cpu", weights_only=False)
    splats = torch.nn.ParameterDict({k: torch.nn.Parameter(v.to(device)) for k, v in ck["splats"].items()})
    optimizers = {k: torch.optim.Adam([splats[k]], lr=lr, eps=1e-15) for k, lr in ck["lrs"].items()}
    for k, o in optimizers.items():
        o.load_state_dict(ck["optimizers"][k])
    return ck["step"], splats, optimizers, ck["scheduler"]


def _drop_gcc_flags_for_msvc():
    """gsplat 1.5.3 passes GCC's -Wno-attributes to the host compiler when it
    JIT-builds its kernels; MSVC rejects it (D8021) and the build stops. It
    imports torch's _jit_compile by name, so this has to run before gsplat is."""
    import os

    import torch.utils.cpp_extension as ext

    if os.name != "nt" or getattr(ext._jit_compile, "_msvc_safe", False):
        return
    jit = ext._jit_compile

    def _jit_compile(name, sources, extra_cflags, *args, **kwargs):
        return jit(name, sources, [f for f in extra_cflags or [] if f != "-Wno-attributes"], *args, **kwargs)

    _jit_compile._msvc_safe = True
    ext._jit_compile = _jit_compile


def train(proj: Path, steps: int, sh_degree: int, cap_max: int, device: str, save_every: int, max_scale_m: float,
          strategy_name: str = "default", opacity_reg: float = 0.0, scale_reg: float = 0.0,
          ground_below_m: float = 1.0, ground_above_m: float = 1.5):
    _drop_gcc_flags_for_msvc()
    from gsplat.rendering import rasterization
    from gsplat.strategy import DefaultStrategy, MCMCStrategy
    from gsplat.strategy.ops import remove
    from gsplat import export_splats

    undistorted = proj / "colmap-workspace" / "undistorted"
    points, colors, frames, norm = load_workspace(undistorted)
    exports = proj / "exports"
    exports.mkdir(parents=True, exist_ok=True)
    ckpt_path = exports / CHECKPOINT

    gamma = 0.01 ** (1.0 / steps)  # means lr decays to 1% of base over the full run
    if ckpt_path.exists():
        start, splats, optimizers, _ = load_checkpoint(ckpt_path, device)
        # Re-derive the schedule for *this* run's length rather than inheriting
        # the checkpoint's: a 3000-step probe ends at 1% lr, and carrying that
        # into a 30000-step run would freeze the positions.
        for k, o in optimizers.items():
            o.param_groups[0]["lr"] = BASE_LRS[k] * (gamma**start if k == "means" else 1.0)
        lrs = dict(BASE_LRS)
        log(f"resume: step {start}, {splats['means'].shape[0]} splats from {ckpt_path.name}, "
            f"means lr {optimizers['means'].param_groups[0]['lr']:.2e}")
    else:
        start = 0
        splats, optimizers = init_splats(points, colors, sh_degree, 0.1, 1.0, device)
        lrs = dict(BASE_LRS)
    if start >= steps:
        log(f"training already complete ({start}/{steps}); exporting")
        write_ply(export_splats, denormalise(splats, norm), exports / "splat.ply")
        return

    if strategy_name == "mcmc":
        # MCMC jitters low-opacity Gaussians with random noise. On a flat field
        # seen only from nadir a splat can slide along its view ray unpunished,
        # then render wrongly in the neighbours, die, and be respawned: on this
        # survey 75% of the model was relocated every 100 steps for 30k steps
        # and the loss never moved after step 3000.
        strategy = MCMCStrategy(cap_max=cap_max, refine_stop_iter=int(steps * 0.85), verbose=True)
        state = strategy.initialize_state()
    else:
        # classic 3DGS: grow where image gradients say detail is missing, prune
        # what is transparent, no random motion. absgrad densifies more reliably.
        # grow_grad2d 0.0008 is gsplat's documented value for absgrad; at the
        # non-absgrad default (0.0002) the run over-densified 4x and the cap
        # culled 17M "faintest" (= newest, finest) splats over 30k steps,
        # leaving only the big blurry ones. The pause keeps both the strategy
        # and the cap from judging opacity right after a reset zeroes it.
        # grow_scale3d decides split (shrink) vs duplicate (same size) as a
        # fraction of scene_scale — and this scene normalises 79 m to 1.0, so the
        # default 0.01 meant "anything under 0.87 m is small": every splat was
        # duplicated at its ~18 cm init size and none ever split, which is ~25 px
        # of blur at 2400 px no matter how long it trained. 0.0005 => ~4 cm.
        # Plain reference defaults for the gradient test (absgrad=False, 0.0002):
        # they are tuned for ~1000-1600 px training images. At 2400 px absgrad +
        # 0.0008 still requested +1.4M splats per refine and the cap churned 60%
        # of the model every 100 steps. Train at <=1600 px (build_splats
        # --train-image-size); 3M splats over 2.5 ha is ~10 cm, so 2400 px buys
        # nothing anyway.
        # The grow test is grad2d/count over the refine window. Each frame here
        # covers ~0.9% of the field, so in the default 100-step window a splat is
        # seen ~0.65 times: the "average" is one noisy sample and ~1M splats
        # cleared the threshold every refine, then got culled by the cap (black
        # holes in the render). 500 steps gives ~3 observations per splat.
        split_above_m = 0.04
        strategy = DefaultStrategy(refine_every=500, pause_refine_after_reset=500,
                                   grow_scale3d=split_above_m / norm["scale"] / 1.1,
                                   refine_stop_iter=min(15000, int(steps * 0.5)), verbose=True)
        state = strategy.initialize_state(scene_scale=1.1)
    strategy.check_sanity(splats, optimizers)

    scheduler = torch.optim.lr_scheduler.ExponentialLR(optimizers["means"], gamma=gamma)

    prefetch = FramePrefetcher(frames)
    check_frame = frames[len(frames) // 2]  # same view every checkpoint, so renders are comparable
    max_log_scale = math.log(max_scale_m / norm["scale"])  # metres -> normalised log-scale
    ground = GroundBand(points, norm, device, below_m=ground_below_m, above_m=ground_above_m) if ground_above_m > 0 else None
    if ground is not None:
        ground.clamp_(splats["means"])  # a resumed checkpoint may already have drifted
    torch.cuda.reset_peak_memory_stats()  # report training memory, not the init spike
    t0 = time.time()

    for step in range(start, steps):
        frame, pixels = prefetch.next(device)
        h, w = pixels.shape[:2]
        viewmat = torch.from_numpy(frame["viewmat"]).to(device)[None]
        K = torch.from_numpy(frame["K"]).to(device)[None]

        sh_now = min(step // 1000, sh_degree)
        renders, _, info = rasterization(
            means=splats["means"],
            quats=splats["quats"],
            scales=torch.exp(splats["scales"]),
            opacities=torch.sigmoid(splats["opacities"]),
            colors=torch.cat([splats["sh0"], splats["shN"]], dim=1),
            viewmats=viewmat,
            Ks=K,
            width=w,
            height=h,
            sh_degree=sh_now,
            packed=True,  # the unpacked path peaked at 23.5 GB on a 16 GB card and spilled to system RAM
            absgrad=False,
            rasterize_mode="antialiased",
        )
        strategy.step_pre_backward(params=splats, optimizers=optimizers, state=state, step=step, info=info)

        pred = renders[0].clamp(0, 1)
        l1 = (pred - pixels).abs().mean()
        ssim_loss = 1.0 - ssim(pred.permute(2, 0, 1)[None], pixels.permute(2, 0, 1)[None])
        loss = 0.8 * l1 + 0.2 * ssim_loss
        if opacity_reg:
            loss = loss + opacity_reg * torch.sigmoid(splats["opacities"]).mean()
        if scale_reg:
            loss = loss + scale_reg * torch.exp(splats["scales"]).mean()
        loss.backward()

        for opt in optimizers.values():
            opt.step()
            opt.zero_grad(set_to_none=True)
        scheduler.step()
        with torch.no_grad():
            # Bloated low-opacity Gaussians drove the tile-intersection buffer to
            # 11 GB at 3M splats (hundreds of tiles each). The tiler discards
            # anything over 1.5 m anyway, so capping size during training loses
            # nothing and bounds memory.
            splats["scales"].clamp_(max=max_log_scale)
            if ground is not None:
                ground.clamp_(splats["means"])

        if strategy_name == "mcmc":
            strategy.step_post_backward(params=splats, optimizers=optimizers, state=state, step=step, info=info,
                                        lr=scheduler.get_last_lr()[0])
        else:
            strategy.step_post_backward(params=splats, optimizers=optimizers, state=state, step=step, info=info,
                                        packed=True)
            n = splats["means"].shape[0]
            # right after an opacity reset every splat is equally faint, so
            # "faintest" would be a random cull; wait for the next refine
            if n > cap_max and step % strategy.reset_every >= strategy.pause_refine_after_reset:
                # DefaultStrategy has no cap; drop the faintest to stay inside VRAM
                with torch.no_grad():
                    thresh = torch.kthvalue(splats["opacities"], n - cap_max).values
                    remove(params=splats, optimizers=optimizers, state=state, mask=splats["opacities"] <= thresh)
                log(f"cap: pruned {n - splats['means'].shape[0]} faintest splats -> {splats['means'].shape[0]}")

        if step % 100 == 0 or step == steps - 1:
            mem = torch.cuda.max_memory_allocated() / 1024**3
            elapsed = (time.time() - t0) / 60
            rate = (step - start + 1) / max(elapsed, 1e-6)
            log(
                f"step {step}/{steps} loss {loss.item():.4f} (l1 {l1.item():.4f}) "
                f"splats {splats['means'].shape[0]} sh {sh_now} {mem:.1f} GB "
                f"{elapsed:.1f} min, ~{(steps - step) / rate:.0f} min left"
            )
        if save_every and step > start and step % save_every == 0:
            save_checkpoint(ckpt_path, step, splats, optimizers, scheduler, lrs)
            write_ply(export_splats, denormalise(splats, norm), exports / "splat.ply")
            report_geometry(splats, norm)
            render_check(rasterization, splats, check_frame, device, sh_degree, exports / f"check_step{step:05d}.png")

    save_checkpoint(ckpt_path, steps, splats, optimizers, scheduler, lrs)
    write_ply(export_splats, denormalise(splats, norm), exports / "splat.ply")
    report_geometry(splats, norm)
    render_check(rasterization, splats, check_frame, device, sh_degree, exports / f"check_step{steps:05d}.png")
    log(f"done in {(time.time() - t0) / 60:.1f} min -> {exports / 'splat.ply'}")


@torch.no_grad()
def render_check(rasterization, splats, frame, device, sh_degree, out_png: Path):
    """One fixed training view, photo | render, saved at each checkpoint: the
    sharpness trend over a run is what the loss number does not show (two
    runs reached L1 ~0.11 and one of them was a blur)."""
    from torchvision.io import decode_jpeg, encode_png, read_file

    gt = decode_jpeg(read_file(str(frame["path"])), device=device)  # [3,H,W] uint8
    h, w = gt.shape[1:]
    render, _, _ = rasterization(
        means=splats["means"], quats=splats["quats"], scales=torch.exp(splats["scales"]),
        opacities=torch.sigmoid(splats["opacities"]), colors=torch.cat([splats["sh0"], splats["shN"]], dim=1),
        viewmats=torch.from_numpy(frame["viewmat"]).to(device)[None], Ks=torch.from_numpy(frame["K"]).to(device)[None],
        width=w, height=h, sh_degree=sh_degree, packed=True, rasterize_mode="antialiased",
    )
    pred = render[0].clamp(0, 1).permute(2, 0, 1)
    l1 = (pred - gt.float() / 255).abs().mean().item()
    # centre crop at full resolution so blur is visible; side by side
    c = 400
    cy, cx = h // 2, w // 2
    crop = torch.cat([gt[:, cy - c:cy + c, cx - c:cx + c], (pred * 255).byte()[:, cy - c:cy + c, cx - c:cx + c]], dim=2)
    out_png.write_bytes(encode_png(crop.cpu()).numpy().tobytes())
    log(f"check: {frame['path'].name} L1 {l1:.3f} -> {out_png.name}")


def report_geometry(splats, norm):
    """Sanity line in metres: where the splats sit relative to the cameras
    (y=0) — the ground should be ~12 m below on this flight, not kilometres."""
    with torch.no_grad():
        y = (splats["means"][:, 1] * norm["scale"]).float()
        op = torch.sigmoid(splats["opacities"])
        p = torch.quantile(y, torch.tensor([0.01, 0.5, 0.99], device=y.device)).tolist()
        near = ((y + 12).abs() < 15).float().mean().item() * 100
        log(f"geometry: y(up) p1 {p[0]:.1f} median {p[1]:.1f} p99 {p[2]:.1f} m; "
            f"{near:.0f}% within 15 m of ground; {(op > 0.12).float().mean().item() * 100:.0f}% opacity>0.12")


def write_ply(export_splats, splats, path: Path):
    """The ply carries raw parameters (log scale, logit opacity) — the 3DGS
    convention tile_splats_spz.py and build_dense.py already decode."""
    with torch.no_grad():
        export_splats(
            means=splats["means"],
            scales=splats["scales"],
            quats=splats["quats"],
            opacities=splats["opacities"],
            sh0=splats["sh0"],
            shN=splats["shN"],
            format="ply",
            save_to=str(path),
        )
    log(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB, {splats['means'].shape[0]} splats)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--survey", required=True)
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--sh-degree", type=int, default=3)
    ap.add_argument("--cap-max", type=int, default=3_000_000,
                    help="hard splat cap (measured with the 1 m scale clamp: 2M = 3.9 GB at 2400px; unclamped 2.6M was 19 GB)")
    ap.add_argument("--max-scale-m", type=float, default=1.0, help="clamp each Gaussian's longest axis to this (metres)")
    ap.add_argument("--ground-below-m", type=float, default=1.0, help="splats may sit this far below the local SfM ground")
    ap.add_argument("--ground-above-m", type=float, default=1.5,
                    help="...and this far above it (0 disables the ground band; run #5 drifted 5 m up without it)")
    ap.add_argument("--save-every", type=int, default=2000, help="checkpoint + ply interval; 0 = only at the end")
    ap.add_argument("--strategy", choices=["default", "mcmc"], default="default",
                    help="densification: classic gradient-driven 3DGS (default) or MCMC (unstable on nadir-only flights)")
    ap.add_argument("--opacity-reg", type=float, default=0.0, help="gsplat reference default is 0")
    ap.add_argument("--scale-reg", type=float, default=0.0, help="gsplat reference default is 0")
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("no CUDA device — this trainer needs the GPU")
    log(f"device: {torch.cuda.get_device_name(0)}")
    train(SPLATS_DIR / args.survey, args.steps, args.sh_degree, args.cap_max, "cuda", args.save_every, args.max_scale_m,
          args.strategy, args.opacity_reg, args.scale_reg, args.ground_below_m, args.ground_above_m)


if __name__ == "__main__":
    main()
