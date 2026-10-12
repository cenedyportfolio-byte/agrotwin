#!/usr/bin/env python3
"""Photorealistic pipeline: survey RGB frames -> COLMAP SfM -> 3DGS -> 3D Tiles.

Runs with the GPU venv (backend/.venv-gpu); on Windows go through run_gpu.ps1,
which puts CUDA + MSVC on PATH and keeps caches/temp/logs on E:
    .\run_gpu.ps1 -m scripts.build_splats --survey <id> [--steps 30000]

Stages (each resumable — existing outputs are reused):
  1. project dir  data/splats/<survey_id>/{images,colmap-workspace,exports}
                  images/ are links to the survey's RGB JPGs (no copies)
  2. SfM          CUDA COLMAP CLI when tools/colmap is present (GPU SIFT +
                  GPU matching; the PyPI pycolmap wheel has no CUDA), *spatial*
                  pair selection from the frames' RTK GPS, then mapping
                  (bundle adjustment stays on CPU: the shipped Ceres has no
                  cuDSS). A global_mapper run is a good alternative for a
                  dense grid: 1378 frames registered in 72 min.
  3. geo-align    Sim3 alignment of the reconstruction to the RTK camera
                  positions (ENU metres about the field centre) so the model
                  has true scale and orientation, then a fixed rotation so
                  that Cesium's glTF y-up->z-up conversion lands it back in
                  ENU (see _ENU_TO_GLTF below)
  4. undistort    GPU warp to PINHOLE at the training resolution
  5. train        scripts/gsplat_train.py (gsplat, in-repo)
  6. tile         scripts/tile_splats_spz.py -> frontend/public/splats/<survey_id>/

Everything here is derived from the real frames; nothing is synthesised.
"""

import argparse
import json
import math
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import numpy as np

AGROTWIN = Path(__file__).resolve().parents[2]
DB_PATH = AGROTWIN / "data" / "agrotwin.db"
SPLATS_DIR = AGROTWIN / "data" / "splats"
PUBLIC_SPLATS = AGROTWIN / "frontend" / "public" / "splats"

# After geo-alignment the model is ENU (x=E, y=N, z=U). glTF is y-up and
# Cesium rotates glTF content +90° about X, (x, y, z) -> (x, -z, y). Storing
# (E, U, -N) therefore renders as (E, N, U).
_ENU_TO_GLTF = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])

EARTH_A = 6378137.0
EARTH_E2 = 6.69437999014e-3


def geodetic_to_ecef(lat, lon, h):
    lat, lon = math.radians(lat), math.radians(lon)
    n = EARTH_A / math.sqrt(1 - EARTH_E2 * math.sin(lat) ** 2)
    return np.array(
        [
            (n + h) * math.cos(lat) * math.cos(lon),
            (n + h) * math.cos(lat) * math.sin(lon),
            (n * (1 - EARTH_E2) + h) * math.sin(lat),
        ]
    )


def enu_matrix(lat, lon):
    lat, lon = math.radians(lat), math.radians(lon)
    return np.array(
        [
            [-math.sin(lon), math.cos(lon), 0],
            [-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat)],
            [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)],
        ]
    )


def enu_to_geodetic(e, n, u, lat0, lon0, h0):
    ecef = geodetic_to_ecef(lat0, lon0, h0) + enu_matrix(lat0, lon0).T @ np.array([e, n, u])
    x, y, z = ecef
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - EARTH_E2))
    for _ in range(5):
        nn = EARTH_A / math.sqrt(1 - EARTH_E2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - nn
        lat = math.atan2(z, p * (1 - EARTH_E2 * nn / (nn + h)))
    return math.degrees(lat), math.degrees(lon), h


def load_frames(survey_id: str, stride: int = 1, limit: int = 0):
    """stride thins the flight while keeping frame-to-frame overlap (a 40 ft
    grid has far more than SfM needs); limit takes a contiguous block, which is
    what a smoke test wants — evenly spreading a handful of frames over the
    whole flight leaves no overlap at all and SfM finds no initial pair."""
    con = sqlite3.connect(DB_PATH)
    rows = con.execute(
        "SELECT filename, file_path, lat, lon, altitude_m FROM survey_images "
        "WHERE survey_id=? AND band='RGB' AND lat IS NOT NULL ORDER BY filename",
        (survey_id,),
    ).fetchall()
    con.close()
    if not rows:
        sys.exit(f"no geotagged RGB frames for survey {survey_id}")
    if stride > 1:
        rows = rows[::stride]
    if limit:
        rows = rows[:limit]
    if stride > 1 or limit:
        print(f"frames: {len(rows)} selected (stride {stride}, limit {limit or 'none'})")
    return rows


def stage_project(survey_id: str, rows, suffix: str = ""):
    proj = SPLATS_DIR / (survey_id + suffix)
    img_dir = proj / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    (proj / "colmap-workspace").mkdir(exist_ok=True)
    (proj / "exports").mkdir(exist_ok=True)
    for name, path, *_ in rows:
        link = img_dir / name
        if link.exists():
            continue
        # Windows symlinks need Developer Mode/admin; a hardlink works on the
        # same volume without either, and a copy is the last resort.
        try:
            link.symlink_to(path)
        except OSError:
            try:
                os.link(path, link)
            except OSError:
                shutil.copy2(path, link)
    return proj


def colmap_cuda_exe() -> Path | None:
    """The CUDA COLMAP CLI, if it has been unpacked under tools/. The PyPI
    pycolmap wheel is built without CUDA (pycolmap.has_cuda is False), so its
    SIFT extraction and matching run on the CPU — on a 1378-frame flight that
    is the difference between minutes and hours."""
    return next((p for p in (AGROTWIN / "tools").rglob("colmap.exe")), None)


def run_sfm_gpu(exe: Path, proj: Path, db: Path, max_image_size: int, rows):
    """Feature extraction + spatial matching on the GPU via the COLMAP CLI."""
    # COLMAP 4.x renamed these from the old SiftExtraction./SiftMatching. prefixes
    print(f"SfM 1/3: SIFT features (max {max_image_size}px, GPU) for {len(rows)} frames")
    subprocess.run(
        [str(exe), "feature_extractor", "--database_path", str(db), "--image_path", str(proj / "images"),
         "--ImageReader.single_camera", "1", "--FeatureExtraction.max_image_size", str(max_image_size),
         "--FeatureExtraction.use_gpu", "1"],
        check=True,
    )
    print("SfM 2/3: spatial matching (GPS neighbours, GPU)")
    subprocess.run(
        [str(exe), "spatial_matcher", "--database_path", str(db),
         "--SpatialMatching.max_num_neighbors", "40",
         "--SpatialMatching.max_distance", "80",  # metres; ~2 frame footprints at 30 m AGL
         "--SpatialMatching.ignore_z", "1", "--FeatureMatching.use_gpu", "1"],
        check=True,
    )


def run_sfm(proj: Path, rows, max_image_size: int):
    import pycolmap

    work = proj / "colmap-workspace"
    db = work / "database.db"
    sparse = work / "sparse"
    existing = sorted(p for p in sparse.glob("*/cameras.bin")) if sparse.exists() else []
    if existing:
        # the mapper may split a flight into several models; keep the largest
        best = max((pycolmap.Reconstruction(str(p.parent)) for p in existing), key=lambda r: r.num_reg_images())
        model_dir = next(p.parent for p in existing if pycolmap.Reconstruction(str(p.parent)).num_reg_images() == best.num_reg_images())
        print(f"SfM: existing sparse model {model_dir.name} ({best.num_reg_images()} frames, {best.num_points3D()} points), skipping")
        if model_dir.name != "0":
            (sparse / "0").mkdir(exist_ok=True)
            best.write(str(sparse / "0"))
        return sparse / "0"

    if not db.exists():
        exe = colmap_cuda_exe()
        if exe:
            run_sfm_gpu(exe, proj, db, max_image_size, rows)
        else:
            device = pycolmap.Device.auto
            print(f"SfM 1/3: SIFT features (max {max_image_size}px, CPU — no CUDA colmap) for {len(rows)} frames")
            opts = pycolmap.FeatureExtractionOptions()
            opts.max_image_size = max_image_size
            pycolmap.extract_features(
                str(db), str(proj / "images"), camera_mode=pycolmap.CameraMode.SINGLE,
                extraction_options=opts, device=device,
            )
            print("SfM 2/3: spatial matching (GPS neighbours)")
            pairing = pycolmap.SpatialPairingOptions()
            pairing.max_num_neighbors = 40
            pairing.max_distance = 80
            pairing.ignore_z = True
            pycolmap.match_spatial(str(db), pairing_options=pairing, device=device)

    exe = colmap_cuda_exe()
    if exe:
        # Ceres in the CUDA build solves the bundle-adjustment normal equations on
        # the GPU, but COLMAP leaves it off by default (Mapper.ba_use_gpu=0). BA
        # dominates incremental mapping, and 1378 images sits inside the GPU
        # sparse solver's range. The registration loop itself stays sequential.
        print("SfM 3/3: incremental mapping (bundle adjustment on GPU)")
        sparse.mkdir(exist_ok=True)
        subprocess.run(
            [str(exe), "mapper", "--database_path", str(db), "--image_path", str(proj / "images"),
             "--output_path", str(sparse), "--Mapper.ba_use_gpu", "1"],
            check=True,
        )
        best_id, best = None, None
        for d in sorted(p for p in sparse.iterdir() if p.is_dir()):
            rec = pycolmap.Reconstruction(str(d))
            if best is None or rec.num_reg_images() > best.num_reg_images():
                best_id, best = d.name, rec
        if best is None:
            sys.exit("SfM failed: no model")
        print(f"SfM: {best.num_reg_images()}/{len(rows)} frames registered, {best.num_points3D()} points")
        if best_id != "0":
            (sparse / "0").mkdir(exist_ok=True)
            best.write(str(sparse / "0"))
        return sparse / "0"

    print("SfM 3/3: incremental mapping")
    sparse.mkdir(exist_ok=True)
    maps = pycolmap.incremental_mapping(str(db), str(proj / "images"), str(sparse))
    if not maps:
        sys.exit("SfM failed: no model")
    best_id = max(maps, key=lambda k: maps[k].num_reg_images())
    best = maps[best_id]
    print(f"SfM: {best.num_reg_images()}/{len(rows)} frames registered, {best.num_points3D()} points")
    model_dir = sparse / str(best_id)
    if best_id != 0:
        # train.py picks the biggest model itself, but keep the canonical path simple
        (sparse / "0").mkdir(exist_ok=True)
        best.write(str(sparse / "0"))
        model_dir = sparse / "0"
    return model_dir


def geo_align(model_dir: Path, rows):
    import pycolmap

    rec = pycolmap.Reconstruction(str(model_dir))
    lat0 = float(np.mean([r[2] for r in rows]))
    lon0 = float(np.mean([r[3] for r in rows]))
    h0 = float(np.mean([r[4] or 0.0 for r in rows]))
    R = enu_matrix(lat0, lon0)
    origin = geodetic_to_ecef(lat0, lon0, h0)

    names, locs = [], []
    for name, _, lat, lon, alt in rows:
        names.append(name)
        locs.append(R @ (geodetic_to_ecef(lat, lon, alt or h0) - origin))
    locs = np.array(locs)

    print("Geo-align: Sim3 to RTK camera positions (ENU metres)")
    sim3 = pycolmap.align_reconstruction_to_locations(rec, names, locs, 3, pycolmap.RANSACOptions())
    if sim3 is None:
        sys.exit("geo-alignment failed")
    rec.transform(sim3)

    # residual check — how far are the reconstructed cameras from the RTK positions?
    res = []
    for img in rec.images.values():
        if img.name in names and img.has_pose:
            i = names.index(img.name)
            res.append(np.linalg.norm(img.projection_center() - locs[i]))
    print(f"Geo-align: median camera residual {np.median(res):.2f} m over {len(res)} frames (scale {sim3.scale:.4f})")

    rec.transform(pycolmap.Sim3d(1.0, pycolmap.Rotation3d(_ENU_TO_GLTF), np.zeros(3)))
    rec.write(str(model_dir))
    meta = {"lat0": lat0, "lon0": lon0, "h0": h0, "median_residual_m": float(np.median(res)), "registered": len(res)}
    (model_dir.parent.parent / "geo.json").write_text(json.dumps(meta, indent=2))
    return meta


def undistort(proj: Path, model_dir: Path, max_image_size: int):
    """Rectifies the frames to an ideal PINHOLE camera at the training
    resolution (max_image_size), intrinsics rescaled to match."""
    import pycolmap

    work = proj / "colmap-workspace" / "undistorted"
    if (work / "sparse" / "cameras.bin").exists():
        print("Undistort: existing undistorted workspace, skipping")
        return work
    opts = pycolmap.UndistortCameraOptions()
    opts.max_image_size = max_image_size
    try:
        import torch

        gpu = torch.cuda.is_available()
    except ImportError:
        gpu = False
    if gpu:
        undistort_gpu(proj, model_dir, work, opts)
    else:
        print(f"Undistort: rectifying to PINHOLE at max {max_image_size}px (CPU)")
        pycolmap.undistort_images(str(work), str(model_dir), str(proj / "images"), undistort_options=opts)
    return work


def _undistort_grid(cam, full_cam):
    """grid_sample grid from each full-resolution undistorted pixel to the
    distorted frame, through COLMAP's own camera model."""
    import torch

    fx, fy, cx, cy = full_cam.params
    us = (np.arange(full_cam.width) + 0.5 - cx) / fx  # COLMAP samples at pixel centres
    mx = np.empty((full_cam.height, full_cam.width), np.float32)
    my = np.empty_like(mx)
    for r in range(0, full_cam.height, 256):
        vs = (np.arange(r, min(r + 256, full_cam.height)) + 0.5 - cy) / fy
        gx, gy = np.meshgrid(us, vs)
        p = np.asarray(cam.img_from_cam(np.stack([gx.ravel(), gy.ravel(), np.ones(gx.size)], 1)))
        mx[r : r + len(vs)] = (p[:, 0] - 0.5).reshape(gx.shape)
        my[r : r + len(vs)] = (p[:, 1] - 0.5).reshape(gx.shape)
    gx = torch.from_numpy(mx).cuda() / (cam.width - 1) * 2 - 1
    gy = torch.from_numpy(my).cuda() / (cam.height - 1) * 2 - 1
    return torch.stack([gx, gy], dim=-1)[None]


def undistort_gpu(proj: Path, model_dir: Path, work: Path, opts):
    """Warp at full resolution, then antialiased resize, JPEG-encoded on the GPU:
    mean 0.58 grey levels from COLMAP's own undistorter on a real frame."""
    import collections
    import time
    from concurrent.futures import ThreadPoolExecutor

    import pycolmap
    import torch
    import torch.nn.functional as F
    from PIL import Image
    from torchvision.io import encode_jpeg

    rec = pycolmap.Reconstruction(str(model_dir))
    grids, sizes = {}, {}
    for cid in list(rec.cameras.keys()):
        cam = rec.cameras[cid]
        full = pycolmap.undistort_camera(pycolmap.UndistortCameraOptions(), cam)
        out = pycolmap.undistort_camera(opts, cam)
        grids[cid] = _undistort_grid(cam, full)
        sizes[cid] = (out.height, out.width)
        cam.model, cam.width, cam.height, cam.params = out.model, out.width, out.height, out.params

    frames = [(img.name, img.camera_id) for img in rec.images.values() if img.has_pose]
    (work / "images").mkdir(parents=True, exist_ok=True)
    print(f"Undistort: {len(frames)} frames to PINHOLE at max {opts.max_image_size}px (GPU warp + encode)")

    def decode(name):
        return torch.from_numpy(np.array(Image.open(proj / "images" / name).convert("RGB"))).pin_memory()

    t0 = time.time()
    todo = iter(frames)
    window = collections.deque()
    writes = collections.deque()
    with ThreadPoolExecutor(max_workers=8) as decoders, ThreadPoolExecutor(max_workers=4) as writers:
        def refill():
            while len(window) < 16:
                nxt = next(todo, None)
                if nxt is None:
                    return
                window.append((nxt, decoders.submit(decode, nxt[0])))

        refill()
        done = 0
        while window:
            (name, cid), fut = window.popleft()
            refill()
            src = fut.result().cuda(non_blocking=True).permute(2, 0, 1).float()[None]
            warped = F.grid_sample(src, grids[cid], mode="bilinear", padding_mode="zeros", align_corners=True)
            small = F.interpolate(warped, size=sizes[cid], mode="bilinear", antialias=True)[0]
            jpeg = encode_jpeg(small.clamp(0, 255).round().byte(), quality=95).cpu().numpy().tobytes()
            writes.append(writers.submit((work / "images" / name).write_bytes, jpeg))
            while len(writes) > 32:
                writes.popleft().result()
            done += 1
            if done % 100 == 0 or done == len(frames):
                rate = done / (time.time() - t0)
                print(f"Undistort: {done}/{len(frames)} ({rate:.1f} frames/s)", flush=True)
        for w in writes:
            w.result()

    # 2D observations keep distorted coordinates and no stereo/ is written:
    # build_dense --source mvs still needs COLMAP's own undistorter
    (work / "sparse").mkdir(parents=True, exist_ok=True)
    rec.write(str(work / "sparse"))  # last, so the resume check only passes once all images exist
    print(f"Undistort: done in {(time.time() - t0) / 60:.1f} min")


def run_train(proj: Path, steps: int):
    ply = proj / "exports" / "splat.ply"
    ckpt = proj / "exports" / "checkpoint.pt"
    if ckpt.exists():
        import torch

        done = torch.load(ckpt, map_location="cpu", weights_only=False)["step"]
        if done >= steps and ply.exists():
            print(f"Train: complete checkpoint ({done} steps) and splat.ply exist, skipping")
            return ply
        print(f"Train: resuming from step {done}")
    elif ply.exists():
        # a ply without a checkpoint is a partial save from an interrupted run
        print("Train: splat.ply exists but no checkpoint — retraining from scratch")
    # Regularised recipe (see gsplat_train.py): SSIM, scale/opacity penalties,
    # MCMC densification with a hard cap, anti-aliased rasterisation. This is
    # what keeps a nadir-only capture from turning into needles and streaks.
    cmd = [sys.executable, "-m", "scripts.gsplat_train", "--survey", proj.name, "--steps", str(steps)]
    print("Train:", " ".join(cmd))
    subprocess.run(cmd, check=True, cwd=str(AGROTWIN / "backend"))
    return ply


def training_gsd_m(proj: Path) -> float | None:
    """Ground size of one training-image pixel at the flight's median height:
    the finest detail the model was fitted to. The viewer stops zooming there."""
    import statistics

    import pycolmap

    cams = pycolmap.Reconstruction(str(proj / "colmap-workspace" / "undistorted" / "sparse")).cameras
    con = sqlite3.connect(DB_PATH)
    agl = [r[0] for r in con.execute(
        "SELECT rel_altitude_m FROM survey_images WHERE survey_id=? AND band='RGB' AND rel_altitude_m > 0",
        (proj.name,),
    )]
    con.close()
    if not cams or not agl:
        return None
    return statistics.median(agl) / next(iter(cams.values())).focal_length_x


def run_tile(proj: Path, ply: Path, meta: dict):
    out = PUBLIC_SPLATS / proj.name
    cmd = [
        sys.executable, str(Path(__file__).parent / "tile_splats_spz.py"),
        "--ply", str(ply), "--out-dir", str(out),
        "--lon0", f"{meta['lon0']:.8f}", "--lat0", f"{meta['lat0']:.8f}", "--h0", f"{meta['h0']:.2f}",
        "--yaw-deg", "0", "--min-opacity", "0.12", "--max-scale", "1.5", "--max-radius", "100",
    ]
    gsd = training_gsd_m(proj)
    if gsd:
        cmd += ["--train-gsd-m", f"{gsd:.4f}"]
    print("Tile:", " ".join(cmd))
    subprocess.run(cmd, check=True)
    print(f"Tileset ready: {out / 'tileset.json'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--survey", required=True)
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--train-image-size", type=int, default=1200,
                    help="longest edge of the undistorted training images (VRAM/time knob; gsplat densification defaults are tuned for ~1000-1600 px)")
    ap.add_argument("--max-image-size", type=int, default=2000, help="SIFT feature extraction size")
    ap.add_argument("--stop-after", choices=["sfm", "align", "undistort", "train"], default=None)
    ap.add_argument("--stride", type=int, default=1, help="use every Nth frame (keeps overlap; thins a dense grid)")
    ap.add_argument("--limit", type=int, default=0, help="use only the first N frames (contiguous; for smoke tests)")
    ap.add_argument("--project-suffix", default="", help="work in data/splats/<survey><suffix> (smoke tests)")
    args = ap.parse_args()

    rows = load_frames(args.survey, args.stride, args.limit)
    proj = stage_project(args.survey, rows, args.project_suffix)
    model_dir = run_sfm(proj, rows, args.max_image_size)
    if args.stop_after == "sfm":
        return
    geo_path = next((p for p in (proj / "geo.json", proj / "colmap-workspace" / "geo.json") if p.exists()), None)
    meta = json.loads(geo_path.read_text()) if geo_path else geo_align(model_dir, rows)
    if args.stop_after == "align":
        return
    undistort(proj, model_dir, args.train_image_size)
    if args.stop_after == "undistort":
        return
    ply = run_train(proj, args.steps)
    if args.stop_after == "train":
        return
    run_tile(proj, ply, meta)


if __name__ == "__main__":
    main()
