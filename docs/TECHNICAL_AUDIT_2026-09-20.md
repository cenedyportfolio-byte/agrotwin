# AgroTwin — Technical Audit (2026-09-20)

Every claim below is cited to an exact file read for this audit, in this repository, as of `git log` HEAD `c682d83`. Where a question asks about the general research landscape rather than this codebase, it's marked **external reference** — not something implemented here. Several of the questions this audit answers (RT-DETR, ONNX export, Grad-CAM, vector stores) have a straightforward answer of **not present**, stated plainly rather than describing a hypothetical implementation as if it exists.

---

## 1. 3D Gaussian Splatting Implementation

### 1.1 What's actually running

This repo does **not** use the original Inria `gaussian-splatting` repo, Nerfstudio's `splatfacto`, or 3DGS-MCMC as a package. It's a **hand-written trainer built directly on the `gsplat` library's public API**.

| Component | File | What it does |
|---|---|---|
| Orchestrator | `backend/scripts/build_splats.py` | Drives the full pipeline: project staging → COLMAP SfM → geo-alignment → undistortion → train → tile |
| Trainer | `backend/scripts/gsplat_train.py` | The actual 3DGS optimization loop, ~550 lines, built on `gsplat` |
| Tiler | `backend/scripts/tile_splats_spz.py` | Converts the trained `.ply` into SPZ-compressed `KHR_gaussian_splatting` 3D Tiles for Cesium |

Confirmed installed versions (`.venv-gpu`):
```
gsplat    1.5.3
pycolmap  4.2.0
torch     2.14.0+cu130 (CUDA 13.0)
COLMAP    4.2.0 (CUDA build, at tools/colmap/bin)
```
`gsplat` is **not pinned in `backend/requirements.txt`** — it's a GPU-venv-only dependency, installed separately from the CPU-only base requirements (`backend/.venv` has no `gsplat`/`torch`/`pycolmap` at all, per `docs/DEV_NOTES.md`).

The trainer's own docstring (`gsplat_train.py:1-17`) states the design intent directly:

> "Built on gsplat's public API only: rasterization + MCMCStrategy + export_splats. The recipe follows gsplat's reference trainer (`examples/simple_trainer.py`)."

Exact API surface used (`gsplat_train.py:304-307`):
```python
from gsplat.rendering import rasterization
from gsplat.strategy import DefaultStrategy, MCMCStrategy
from gsplat.strategy.ops import remove
from gsplat import export_splats
```

What's custom, not from gsplat's reference trainer:
- **`GroundBand`** (`gsplat_train.py:138-185`) — clamps each Gaussian's height to a per-2m-cell band derived from the SfM point cloud's local median. This exists specifically because a nadir-only aerial capture gives 3DGS almost no depth constraint along the view ray; the code comment documents a real failure (run #5: the point-cloud median drifted from −11.3 m to −6.5 m over 30k steps and the render collapsed to flat color).
- Hand-rolled **SSIM** (`gsplat_train.py:75-88`) and an **L1+SSIM loss** (0.8/0.2 weighting, `gsplat_train.py:410-412`) — gsplat's own example ships an SSIM implementation too, but this one is reimplemented locally.
- A **`render_check`** sanity image (`gsplat_train.py:470-492`) that dumps a photo|render side-by-side crop at every checkpoint and logs L1 against ground truth — this is the closest thing to a quality metric this repo actually computes (see 1.3).
- Extensive tuning documented as inline comments explaining specific numeric choices that differ from gsplat's stock defaults (`grow_scale3d`, `grow_grad2d`, `refine_every`) — these aren't arbitrary; each is annotated with the failure it fixes (e.g., the default `grow_scale3d=0.01` meant "anything under 0.87 m is small" once the scene was normalized to radius 1, so nothing ever split; `0.0005` was substituted).

### 1.2 Photogrammetry pipeline (COLMAP integration)

`build_splats.py` implements SfM itself (not a call-out to ODM for this path — ODM is a separate, alternate ingestion route, see §2.2):

1. **Feature extraction + matching**: if `tools/colmap/bin/colmap.exe` (the CUDA CLI build) is present, it's invoked directly via `subprocess` for GPU SIFT + GPU spatial matching (`build_splats.py:144-161`). Otherwise falls back to `pycolmap` (Python bindings) — but the code explicitly notes the PyPI `pycolmap` wheel has **no CUDA**, so that fallback path runs SIFT on CPU (`build_splats.py:136-141`).
2. **Pairing strategy**: *spatial* matching from each frame's RTK GPS position (`max_num_neighbors=40`, `max_distance=80m`) rather than exhaustive or vocabulary-tree matching — chosen because it scales to 1,378 frames without an O(n²) match graph.
3. **Bundle adjustment**: runs on GPU via COLMAP's CLI `mapper` with `--Mapper.ba_use_gpu 1` when the CUDA binary is present (comment notes the shipped Ceres build has no cuDSS, so BA specifically needs the CLI path, not pycolmap).
4. **Geo-alignment**: `pycolmap.align_reconstruction_to_locations` (Sim3) fits the reconstruction to the frames' RTK positions in a local ENU frame, then a fixed rotation (`_ENU_TO_GLTF`) re-orients it for Cesium's glTF y-up convention (`build_splats.py:244-278`).
5. **Undistortion**: rectifies to an ideal PINHOLE camera at training resolution; has both a CPU path (`pycolmap.undistort_images`) and a hand-written GPU path (`torch.nn.functional.grid_sample` + GPU JPEG encode via `torchvision.io.encode_jpeg`) for speed on 1,378 frames.

Real measured result on this project's own survey (from `docs/PHASE_STATUS.md`, not a claim invented for this audit): **1,378/1,378 frames registered, 770k SfM points, 0.48 m median camera-position residual to RTK, 1.1 px reprojection error**, taking 72 minutes for the mapper stage.

### 1.3 Research paper, official repo, and benchmark metrics — reference material

Marked clearly as **external/literature**, since none of these are numbers this repo has measured.

**Base method — 3D Gaussian Splatting:**
- Paper: Kerbl, Kopanas, Leimkühler, Drettakis. *"3D Gaussian Splatting for Real-Time Radiance Field Rendering."* ACM Transactions on Graphics (SIGGRAPH), 2023.
- Official repo: `github.com/graphdeco-inria/gaussian-splatting`
- Published benchmarks (Mip-NeRF360 / Tanks&Temples / Deep Blending, the paper's own Table 1, on an RTX 3090): PSNR ≈ 27–29 dB, SSIM ≈ 0.81–0.92, LPIPS ≈ 0.15–0.22 (outdoor scenes score lower than indoor), training ≈ 35–45 min at 30k iterations, rendering > 100 FPS at 1080p once trained.

**Library actually used here — `gsplat`:**
- Ye, Li, Kerr, Turkulainen, Yi, Pan, Seiskari, Ye, Hu, Tancik, Kanazawa. *"gsplat: An Open-Source Library for Gaussian Splatting."* JMLR MLOSS, 2025 (arXiv:2409.06765).
- Official repo: `github.com/nerfstudio-project/gsplat`
- This is a rasterization/training **library**, not a fixed pipeline with its own single benchmark table — it reproduces the base 3DGS numbers above and is also what Nerfstudio's `splatfacto` uses internally.

**What this repo actually measured instead of PSNR/SSIM/LPIPS**: no PSNR/SSIM/LPIPS computation exists anywhere in `backend/` (confirmed by grep — the `ssim()` function in `gsplat_train.py` is a *training loss term*, never logged as a validation metric on a held-out view). What's tracked instead, per `render_check()` and `report_geometry()`:
- A single fixed-view **L1** photo-vs-render check at every checkpoint (documented result: `L1 0.071` on the current survey).
- Splat count, opacity distribution, and % of Gaussians within 15 m of the ground plane, as a sanity check against the "splats drifting off the ground" failure mode.
- For the current 1,378-frame survey: 2,999,876 splats, 67.9 MB SPZ tileset, ~10 cm effective resolution over 2.5 ha.

**Real methodological gap worth naming**: there is no held-out-view PSNR/SSIM/LPIPS evaluation split — training and the one qualitative check frame both come from the training set. If a defensible quality number is needed, the first thing to add is holding out ~5% of frames (never trained on), and reporting PSNR/SSIM/LPIPS on those at the final checkpoint.

### 1.4 Alternative 3DGS methods for aerial/drone photogrammetry — external reference

None of these are in this repo; listed because the request asked for the landscape.

| Method | Paper | Repo | Why it's relevant to aerial capture |
|---|---|---|---|
| **VastGaussian** | Lin et al., *"VastGaussian: Vast 3D Gaussians for Large Scene Reconstruction,"* CVPR 2024 | `github.com/kangpeilun/VastGaussian` (community reimpl.; no official release at time of writing) | Explicitly targets large-scale aerial scenes via progressive spatial partitioning + seamless merging — directly relevant if this project ever needs multi-hectare or multi-flight splats instead of one 2.5 ha field. |
| **Scaffold-GS** | Lu et al., *"Scaffold-GS: Structured 3D Gaussians for View-Adaptive Rendering,"* CVPR 2024 | `github.com/city-super/Scaffold-GS` | Anchor-based, view-dependent Gaussian placement; reduces the redundant/floating-Gaussian artifacts this repo currently fights by hand (`GroundBand`, `prune-needles` in `tile_splats_spz.py`) via a structural prior instead of a post-hoc clamp. |
| **2DGS** | Huang et al., *"2D Gaussian Splatting for Geometrically Accurate Radiance Fields,"* SIGGRAPH 2024 | `github.com/hbb1/2d-gaussian-splatting` | Flattens Gaussians to surfels for much better surface/depth accuracy — could plausibly replace the current `build_dense.py`'s separate SfM-cloud-based mesh with a directly renderable surface, since this project's stated limitation is exactly "2.5D heightfield, no overhangs" (`PHASE_STATUS.md`). |
| **Hierarchical 3DGS** | Kerbl et al., *"A Hierarchical 3D Gaussian Representation for Real-Time Rendering of Very Large Datasets,"* SIGGRAPH 2024 | `github.com/graphdeco-inria/hierarchical-3d-gaussians` | From the same group as the base paper; built for city/campus-scale capture with LOD — the natural next step if flights start covering many fields rather than one. |

---

## 2. CLI Commands & Parameter Dictionaries

### 2a. 3D Gaussian Splatting

**`backend/scripts/build_splats.py`** — run via `.\run_gpu.ps1 -m scripts.build_splats --survey <id>`

| Parameter | Default | Range / Options | Engineering impact |
|---|---|---|---|
| `--survey` | *required* | survey ID string | Selects which survey's frames to reconstruct. |
| `--steps` | `30000` | any int | Forwarded to the trainer. Total optimization iterations. |
| `--train-image-size` | `1200` | int (px, longest edge) | Undistorted training-image resolution. gsplat's densification thresholds are tuned for ~1000–1600 px; the project found 2400 px caused catastrophic over-densification. |
| `--max-image-size` | `2000` | int (px) | SIFT feature-extraction resolution — separate knob from training resolution, trades SfM accuracy for speed. |
| `--stop-after` | `None` | `sfm` \| `align` \| `undistort` \| `train` | Debug/checkpoint control — halts the pipeline after a named stage for inspection before spending GPU time on the next one. |
| `--stride` | `1` | int ≥ 1 | Uses every Nth frame. Thins an over-dense flight grid while preserving overlap (unlike `--limit`, doesn't break SfM's need for shared views). |
| `--limit` | `0` (disabled) | int | Uses only the first N frames, contiguous. For smoke tests only — evenly-spread sampling leaves no frame-to-frame overlap and SfM fails to find an initial pair. |
| `--project-suffix` | `""` | string | Appends to the working directory name (`data/splats/<survey><suffix>`) so a smoke test doesn't clobber the real project. |

**`backend/scripts/gsplat_train.py`** — run via `.venv-gpu/Scripts/python.exe -m scripts.gsplat_train --survey <id>` (also invoked internally by `build_splats.py`)

| Parameter | Default | Range / Options | Engineering impact |
|---|---|---|---|
| `--survey` | *required* | survey ID | Which staged project under `data/splats/` to train. |
| `--steps` | `30000` | int | Optimization iteration count; also sets the LR decay schedule end-point (`gamma = 0.01^(1/steps)`). |
| `--sh-degree` | `3` | int 0–3 | Max spherical-harmonics degree for view-dependent color; ramped up 1 degree per 1000 steps during training. |
| `--cap-max` | `3000000` | int | Hard splat-count ceiling. Measured: 2M splats = 3.9 GB VRAM at 2400px with the 1 m scale clamp; unclamped 2.6M hit 19 GB. Primary VRAM-vs-detail knob on a 16 GB card. |
| `--max-scale-m` | `1.0` | float (metres) | Clamps each Gaussian's longest axis. Also bounds the tile-intersection buffer (bloated low-opacity Gaussians drove that buffer to 11 GB at 3M splats before this was added). |
| `--ground-below-m` | `1.0` | float (metres) | How far below the local SfM-derived ground a splat may sit (`GroundBand`). |
| `--ground-above-m` | `1.5` | float; `0` disables the band | How far above ground. Without this, run #5 drifted the whole model 5 m upward off the ground plane. |
| `--save-every` | `2000` | int steps; `0` = only at the end | Checkpoint + `.ply` + render-check interval. |
| `--strategy` | `default` | `default` \| `mcmc` | Densification algorithm. `mcmc` (relocation-based) is documented as **unstable on this project's nadir-only flights** — 75% of the model was relocated every 100 steps for the full 30k-step run with no loss improvement after step 3000. `default` (gradient-driven, classic 3DGS) is what's actually used. |
| `--opacity-reg` | `0.0` | float | Opacity regularization weight; matches gsplat's own reference default (unused in practice). |
| `--scale-reg` | `0.0` | float | Scale regularization weight; same note. |

**`backend/scripts/tile_splats_spz.py`** — internal, invoked by `build_splats.py`; also runnable standalone

| Parameter | Default | Range / Options | Engineering impact |
|---|---|---|---|
| `--ply` | *required* | path | Trained splat file to tile. |
| `--out-dir` | *required* | path | Output 3D Tiles directory (normally `frontend/public/splats/<survey_id>/`). |
| `--lon0` / `--lat0` / `--h0` | *required* | floats | ENU origin (from `build_splats`' `geo.json`) — where the tileset is placed on the globe. |
| `--yaw-deg` | `0.0` | float | Additional yaw applied at placement. |
| `--ground-at-ellipsoid` | `True` | bool flag (`--no-ground-at-ellipsoid` to disable) | Whether the tileset's ground reference is the WGS84 ellipsoid vs. terrain height. |
| `--ground-band` | `15.0` | float (metres) | Height band used by `prune_floaters` to reject stray splats far from the expected ground. |
| `--min-opacity` | `0.05` | float 0–1 | Drops splats fainter than this — floaters tend to be both faint and large. |
| `--max-scale` | `3.0` | float (metres) | Drops splats whose longest axis exceeds this (independent of the training-time clamp — a post-hoc tile-export filter). |
| `--max-radius` | `250.0` | float (metres) | Drops splats beyond this horizontal distance from the ENU origin — bounds the tileset's bounding volume against stray far-out splats. |
| `--prune-needles` | `True` | bool flag (`--no-prune-needles`) | Drops near-vertical, highly elongated Gaussians — the specific artifact shape a nadir-only capture produces along under-constrained view rays. |

### 2b. Orthophoto / photogrammetry (non-splat)

**`backend/scripts/import_odm.py`** — brings in an external OpenDroneMap run

| Parameter | Default | Range / Options | Engineering impact |
|---|---|---|---|
| `--survey` | *required* | survey ID | Target survey to attach the ODM outputs to. |
| `--odm-dir` | `None` | path | Location of the ODM project output; auto-detected if omitted. |
| `--skip-tiles` | `False` (flag) | flag | Skips XYZ tile-pyramid generation for the imported orthophoto. |
| `--skip-mesh` | `False` (flag) | flag | Keeps an existing reality-mesh tileset rather than rebuilding it from ODM's textured mesh output. |

**`backend/scripts/build_tiles.py`** — XYZ tile pyramid generation for any georeferenced raster

| Parameter | Default | Range / Options | Engineering impact |
|---|---|---|---|
| `--survey` | *required* | survey ID | Which survey's rasters to tile. |
| `--layers` | `"orthomosaic,ndvi,ndre,gndvi,dsm"` | comma-separated layer names | Which raster asset types to build pyramids for. |
| `--max-zoom` | `None` (GSD-derived) | int | Overrides the automatically computed deepest zoom level. |

**`backend/scripts/build_dense.py`** — dense point cloud / DSM / terrain mesh

| Parameter | Default | Range / Options | Engineering impact |
|---|---|---|---|
| `--survey` | *required* | survey ID | Target survey. |
| `--source` | `"sparse"` | `sparse` \| `splats` \| `mvs` | Which point source to densify from. `sparse` (SfM triangulated points, ≥3 views) is the project's current default and documented preference over full MVS for this flat-field use case. |
| `--band-m` | `3.0` | float (metres) | Ground-plane tolerance band for classifying points as ground vs. non-ground. |
| `--max-image-size` | `1200` | int (px) | Resolution used if the `mvs` source path re-processes imagery. |
| `--voxel` | `0.10` | float (metres) | Point-cloud thinning voxel size — the "10 cm voxels" cited for the current survey's 509k-point cloud. |
| `--dsm-gsd` | `0.5` | float (metres) | Output DSM ground-sample distance. |
| `--skip-mesh` | `False` (flag) | flag | Produces the point cloud/DSM without building the textured terrain mesh. |
| `--dtm-open-m` | `40.0` | float (metres) | Morphological opening window for deriving the bare-earth DTM from the DSM. |
| `--texture-px` | `4096` | int | Max texture resolution baked onto the terrain mesh. |

**`backend/scripts/tile_mesh.py`** / **`tile_points.py`** — 3D Tiles export for meshes/point clouds

| Parameter | Default | Range / Options | Engineering impact |
|---|---|---|---|
| `--survey` (mesh) | *required* | survey ID | — |
| `--depth` | `3` | int | Tileset LOD tree depth. |
| `--tex` | `2048` | int (px) | Max texture size per tile. |
| `--draco` | `False` (flag) | flag | `KHR_draco_mesh_compression`. **Off by default because Cesium 1.145 failed to render Draco-compressed tiles from this pipeline** — a documented, deliberate non-use of a feature that would otherwise reduce payload size. |
| `--survey` (points) | *required* | survey ID | — |
| `--max-points` | `5,000,000` | int | Caps point-cloud tile size. |

Not CLI tools (no `argparse`, hardcoded one-off scripts): `backend/scripts/ingest_40ft_rgb.py` and `seed_from_real_data.py` — both are fixed data-loading scripts for this project's specific dataset, run with no arguments (`python -m scripts.ingest_40ft_rgb`).

### 2c. Mobile / Web app build & run

**Backend + web launcher — `run.ps1`** (repo root)

| Parameter | Default | Range / Options | Engineering impact |
|---|---|---|---|
| `-Mode` (positional) | `prod` | `prod` \| `dev` | `dev` runs both servers with hot-reload (`watchfiles` supervisor for the backend, `next dev` for the web app); `prod` builds the frontend once and runs `next start`. |
| `-Lan` | off | switch | Binds both servers to `0.0.0.0` instead of `127.0.0.1` so a phone on the LAN/Tailscale can reach them; also prints the machine's LAN IP for use in `mobile/.env`. |

**GPU pipeline wrapper — `run_gpu.ps1`** (repo root): takes no flags of its own — it's a pass-through that sets `CUDA_HOME`, `PATH` (MSVC + CUDA + venv), and `TEMP`/cache env vars, then forwards all its arguments verbatim to `backend/.venv-gpu/Scripts/python.exe`. The actual flags come from whichever `-m scripts.*` module is invoked (documented in 2a above).

**Mobile app — `mobile/package.json`**

| Script | Command | Purpose |
|---|---|---|
| `start` | `expo start` | Metro bundler + QR code, LAN mode. |
| `android` | `expo start --android` | Same, opens an Android emulator/connected device. |
| `android:lan` | `expo start --android --lan` | Forces LAN connection mode explicitly. |
| `tunnel` | `expo start --tunnel` | Routes Metro through an Expo-hosted tunnel for cross-network testing. |
| `web` | `expo start --web` | Browser preview target (react-native-web). |
| `typecheck` | `tsc --noEmit` | Strict TypeScript check, no emit. |
| `test` | `jest` | Runs the Jest suite (36 tests as of this audit). |
| `doctor` | `npx expo-doctor` | Dependency/config sanity check. |
| `export:android` | `expo export --platform android` | Produces a standalone Hermes bundle without a dev server. |

**Web app — `frontend/package.json`**

| Script | Command | Purpose |
|---|---|---|
| `dev` | `copy-cesium && next dev` | Copies Cesium's static assets into `public/cesium/`, then starts the Next.js dev server. |
| `build` | `copy-cesium && next build` | Production build. |
| `start` | `next start` | Serves the production build. |
| `lint` | `eslint` | — |

None of these take CLI flags of their own beyond what Next.js/Expo natively expose (e.g., `next dev -H <host> -p <port>`, used internally by `run.ps1`, not exposed as an npm-script parameter).

---

## 3. Object Detection Pipeline (Aerial/Drone Weed Detection)

### 3.1 Dataset upload/ingestion

Handled entirely through the existing survey pipeline, not a separate "dataset" concept:
- `POST /api/surveys/{id}/images` (`backend/app/routers/surveys.py`) — batched drone-frame upload with GPS/EXIF extraction.
- `POST /api/surveys/{id}/assets` (`import_service.py`) — manual import of processed rasters/vectors/3D Tiles/point clouds.

**There is no dataset ingestion path for training a detector.** A trained model is expected to arrive as a pre-trained weights file dropped manually into `data/models/<name>/`, alongside a hand-written `manifest.json`. There's no upload endpoint, UI, or annotation tooling for building a training set — this project has no labelled imagery of this crop and doesn't attempt to create any (stated explicitly in `detector_service.py:12-14` and in `docs/PHASE_STATUS.md`'s "Still open" section).

### 3.2 YOLO version, and ONNX vs. client-server architecture

**Confirmed: Ultralytics YOLO/YOLO-seg, via the `ultralytics` Python package — but it's not a fixed version, and it's not even an installed dependency of this project.**

- `backend/requirements.txt` contains **no `ultralytics` entry at all** — the full file lists `fastapi`, `uvicorn`, `sqlalchemy`, `pydantic`, `Pillow`, `defusedxml`, `shapely`, `numpy`, `opencv-python-headless`, `rasterio`, `laspy[lazrs]`. Nothing ML/detection-related is a hard dependency.
- `ultralytics_runner.py:24` imports it lazily, inside the class constructor: `from ultralytics import YOLO`. This only executes if a manifest declares `"framework": "ultralytics"` **and** the package happens to be installed in the active venv.
- `detector_service.py:83-90` explicitly checks `framework != "ultralytics"` → unsupported, and wraps the `ultralytics` import in a `try/except ImportError` to report "ultralytics is not installed" as a status message rather than crashing.
- **No specific YOLO version (v8/v9/v11/etc.) is pinned anywhere.** The `ultralytics.YOLO()` class auto-detects architecture from whatever `.pt` weights file the manifest points to — since no model is installed (`data/models/` doesn't currently hold a manifest with a real detector), the version is undetermined; it would be whatever the operator eventually supplies.
- **No RT-DETR or RF-DETR code exists anywhere in this repo** — confirmed by a full-repo case-insensitive grep for those terms, zero matches.

**ONNX export: not implemented.** Grep for `onnx` (case-insensitive) across all backend `.py` files returned **zero matches**. `ultralytics_runner.py` loads `.pt` weights directly via `YOLO(str(info.weights))` and calls `model.predict()` — no `.export(format="onnx")` call, no `onnxruntime` import, anywhere.

**Client-server inference architecture: this is what's actually implemented, and it's the only option that exists.** There is no on-device/edge inference anywhere in `mobile/` or `frontend/` — the mobile client has no ML runtime dependency (no ONNX Runtime Mobile, no TFLite, no CoreML), by design (the mobile app's own constraints state the phone never computes indices, never trains models, never downloads a GeoTIFF). All inference happens in `UltralyticsDetector.detect()` (`backend/app/services/detectors/ultralytics_runner.py:26-70`) inside the FastAPI process:

1. Opens the orthomosaic with `rasterio`, reads it in `1024×1024` px tiles with `128` px overlap (`TILE_PX`, `OVERLAP_PX` constants), resampled to the model's declared `input_gsd_m` so a 2 cm mosaic isn't fed at the wrong scale to a model trained on 5 cm pixels.
2. Runs `model.predict()` per tile (`conf=0.25` minimum, `MIN_CONFIDENCE` constant).
3. Converts pixel-space boxes/masks back to WGS84 polygons via the raster's affine transform + `rasterio.warp.transform` + `shapely`.
4. Results merge into the *same* `DetectionZoneOut` schema and API response as the classical-CV zones (`analysis_service.py:417-428`), typed as `"<detector_name>:<label>"` (e.g., `soy-weeds-v1:waterhemp`) so a model result is structurally distinguishable from a classical-CV zone type only by that colon convention — there's no separate field for "which kind of detection this is."

**Comparison, since there's no deployed on-device alternative to compare against**:

| | Current (server-side PyTorch/Ultralytics) | Hypothetical ONNX-on-device |
|---|---|---|
| Latency | One HTTP round-trip; backend inference time scales with orthomosaic size (tiled, so roughly linear in tile count) — no measured latency exists since no model is installed to time. | Would eliminate the network round-trip but add per-device cold-start (model load) and CPU/NPU inference time on a phone with no GPU access. |
| Memory footprint | Bounded by the backend server's RAM/VRAM; irrelevant to phone constraints. | Would need to fit an INT8-quantized model (~5–25 MB for common YOLO sizes) into mobile RAM alongside the rest of the app. |
| Bandwidth | Only the *result* (small GeoJSON polygons) crosses the network — the orthomosaic itself never leaves the backend/LAN. | Would require shipping the full orthomosaic tile(s) to the device for local inference, which is exactly what this project's architecture is built to avoid. |
| Fits this project? | Yes — matches the stated architecture ("mobile is VIEWER/CLIENT, never a compute node"). | No — would be a deliberate architectural reversal, not a natural next step. |

### 3.3 Grad-CAM / explainability

**Not implemented. Confirmed by grep**: zero matches anywhere in `backend/` for `grad.?cam`, `explainab`, `shap`, or `saliency` (case-insensitive, all `.py` files).

**Exact insertion point, if this were to be added**: `backend/app/services/detectors/ultralytics_runner.py`, inside `UltralyticsDetector.detect()`, right after the `self.model.predict(img, ...)` call (line ~58). Ultralytics models expose their backbone via `self.model.model.model` (the underlying `torch.nn.Sequential`); the conventional approach:

```python
from pytorch_grad_cam import EigenCAM  # or GradCAM
target_layer = self.model.model.model[-2]  # last conv block before detection head
cam = EigenCAM(self.model.model, [target_layer])
heatmap = cam(img_tensor)
```
This would need `grad-cam` (the `pytorch-grad-cam` PyPI package) added to `requirements.txt`, a new field on `ModelDetection` to carry the heatmap (as a base64 PNG or a separate asset), and a new endpoint to serve it — none of that scaffolding exists today.

### 3.4 Public aerial/UAV weed datasets — external reference

Not used in this repo (no training data exists here at all), listed per the request:

| Dataset | Focus | Notes |
|---|---|---|
| **DeepWeeds** (Olsen et al., 2019, *Scientific Reports*) | Ground-level (not aerial) weed classification, 8 species, Australian rangeland | Widely cited but **not aerial** — the most commonly referenced "weed dataset" in the literature; would need re-collection at drone altitude to be useful here. |
| **WeedMap** (Sa et al., 2018, *Remote Sensing*) | UAV multispectral (RGB+NIR) sugar beet fields, pixel-level crop/weed segmentation | Closest published match to this project's own sensor stack (DJI M3M has NIR) and use case (row crop, inter-row weeds). |
| **CottonWeedDet12** (Dang et al., 2023) | UAV/ground cotton-field weed detection, 12 species, bounding boxes | Directly relevant if a future flight targets cotton rather than soybean. |
| **Sugar Beets 2016 / iMap campaign** (Chebrolu et al., 2017, *IJRR*) | UAV + ground robot, sugar beet row crop, multispectral | Good reference for row-crop canopy/weed segmentation methodology, complementary to this repo's own `weed_service.py` row-geometry approach. |
| **CWFID** (Crop/Weed Field Image Dataset, Haug & Ochs, 2015) | Ground-level, carrot fields, pixel-level segmentation | Small (60 images) but commonly used as a segmentation baseline. |

---

## 4. Mobile App Integration & RAG Architecture

### 4.1 3DGS / orthophoto visualization in the mobile app

**The mobile app never renders 3DGS or the orthomosaic natively — it reuses the existing web viewer and native map tiles, per the project's explicit "don't rewrite Cesium" constraint.**

**Digital Twin / Gaussian splats**: `mobile/app/twin/[surveyId].tsx` renders `mobile/components/digitalTwin/DigitalTwinWebView.tsx`, a `react-native-webview` wrapper that loads the *existing* Next.js Cesium page (`frontend/app/fields/[id]/digital-twin/page.tsx`) at `?embed=1`, inside the app. Communication is a small typed message protocol (`mobile/components/digitalTwin/digitalTwinBridge.ts`, protocol tag `agrotwin-bridge/1`) matched by `frontend/lib/hostBridge.ts` on the web side — messages like `SET_MODE`/`FOCUS_ZONE` flow mobile→web, and `VIEWER_READY`/`SPLAT_STATUS`/`ZONE_SELECTED` flow web→mobile. The mobile app checks splat availability *before* opening the WebView with a plain `HEAD` request to `/splats/<survey>/tileset.json` (`mobile/features/digitalTwin/hooks.ts`) so it can show "Available / Processing / Not available" without loading anything.

**Orthomosaic on the map screen**: `mobile/components/map/MapViewer.tsx` uses `react-native-maps`, and `mobile/components/map/OrthomosaicLayer.tsx` draws the raster as a native `<UrlTile>` layer pointed at the **same XYZ tile pyramid** `build_tiles.py` already produces for the web app (`frontend/public/tiles/<survey>/orthomosaic/{z}/{x}/{y}.webp`), selected in `mobile/components/map/mapLayers.ts`'s `selectRasterSources()`. If no tile pyramid exists yet, it falls back to the single flat preview PNG from `GET /api/surveys/{id}/assets/{assetId}/preview`. The phone never downloads a GeoTIFF or computes a reprojection itself.

**Object-detection results on mobile**: there's no separate detection-visualization path — model detections (and `weed_candidate` zones) arrive through the exact same `GET /api/analysis/{surveyId}` call as every other detection zone, and render through the same `mobile/components/analysis/DetectionZoneCard.tsx` / `mobile/components/map/ZoneMarkers.tsx` components. One real, citable gap found while confirming this: `mobile/constants/labels.ts`'s `detectionTypeLabel()` fallback is `type.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase())` — it only prettifies underscores, not colons, so a trained-model detection typed `"soy-weeds-v1:waterhemp"` would render literally as `"Soy-weeds-v1:waterhemp"` rather than something like "Waterhemp (soy-weeds-v1)". Harmless today only because no detector is installed to produce that type string yet.

### 4.2 RAG architecture

**Fully implemented, and precisely as follows** (`backend/app/services/rag_service.py`, 138 lines):

| Aspect | Implementation |
|---|---|
| **Source data** | 8 plain Markdown files under `backend/app/knowledge/`: `drone_survey_practices.md`, `reading_agrotwin_results.md`, `row_geometry_and_canopy.md`, `scouting_flagged_zones.md`, `soybean_growth_stages.md`, `soybean_stress_symptoms.md`, `soybean_weeds.md`, `vegetation_indices.md`. |
| **Chunking** | Structural, not fixed-size: each file is split at `## ` Markdown headings into sections (`_load_sections()`, lines 74–97). No token-count windowing, no overlap — a chunk is exactly one authored section. |
| **Embedding model** | **None.** This is a sparse lexical retriever, not a dense/vector one. |
| **Retrieval algorithm** | Hand-implemented **Okapi BM25** (not the `rank_bm25` PyPI package — the formula is written out directly, lines 111–129), with `k1=1.5, b=0.75`, a `MIN_SCORE=1.0` relevance floor, and a small custom stopword list that additionally excludes `"field"`/`"survey"` as domain-specific noise words (every question mentions them). Includes a crude hand-written stemmer (`-ies→-y`, trailing `-s` removal except `-ss`). |
| **Vector store** | **None** — there's no Chroma/FAISS/LanceDB/Qdrant/pgvector anywhere in `requirements.txt` or the codebase. The "index" is an in-memory Python list of `_Doc` dataclasses with precomputed term frequencies, built once via `@lru_cache(maxsize=1)` and held for the process lifetime (rebuilds only on a backend restart, not on knowledge-file edits at runtime). |
| **Retrieval call** | `search(query, k=3)` returns up to 3 `KnowledgePassage` objects (title, section, full text, BM25 score). |
| **Integration into the LLM** | `llm_service.answer_question()` (`llm_service.py:278-295`) calls `rag_service.search(question, k=3)`, converts them to `sources = [p.as_dict() for p in passages]`, and returns `(answer, responder, sources)` as a 3-tuple. The retrieved passages are handed to the LLM as reference notes when Ollama is running, or folded into the deterministic template otherwise — either way, retrieval happens unconditionally, not only when an LLM is available. |
| **Citations returned to the client** | `AskResponseOut.sources: list[KnowledgeSource]` (`schemas.py:139-150`), each with `title`, `section`, a 420-char `snippet`, and the BM25 `score` — exposed via `POST /api/analysis/{surveyId}/ask`. There's also a standalone `GET /api/analysis/knowledge?q=<query>` endpoint (`k=5`) for browsing the knowledge base directly, and `GET /api/analysis/knowledge` with no query returns the full topic/section index. |

**A real, citable integration gap**: **the web client displays these citations; the mobile client does not.** `frontend/lib/types.ts` and `frontend/app/ask-ai/page.tsx` both carry and render `sources` (`h.sources.map(...)` at `ask-ai/page.tsx:106`). Mobile's own `AskResponse` type (`mobile/types/api.ts:197-203`) was never updated to include the `sources` field the backend has been returning since this feature shipped, `mobile/services/ai.ts` doesn't request it, `mobile/stores/chatStore.ts`'s `ChatMessage` has no `sources` field (only `contextUsed`), and `mobile/components/ai/ChatBubble.tsx` has no rendering path for it. A farmer using the mobile app gets an answer with no visibility into which knowledge-base passage it drew on, while the same question on the web app shows its sources. This is a small, mechanical fix (thread `sources` through the same four files the same way `context_used` already flows) but it is currently missing.

**Proposed architecture for agronomic/aerial querying, if this were being built from scratch** (recommendation, not a description of anything present):

Given this project's stated goals (fully offline, single laptop, no cloud), the natural path is to extend rather than replace the current design:

1. **Keep BM25 as the fast path**, but add a small **local sentence-embedding model** (e.g., `sentence-transformers/all-MiniLM-L6-v2`, ~90 MB, CPU-fast, no GPU required) for semantic recall on paraphrased questions BM25 misses — hybrid BM25+dense retrieval (reciprocal rank fusion) is the standard pattern for exactly this offline-with-a-small-corpus situation.
2. **Vector store**: given the corpus is 8 files / low hundreds of sections, a full vector database is overkill — `numpy`-array cosine similarity in memory (same `lru_cache` pattern already used) is sufficient and keeps the zero-new-infrastructure constraint this project has held to everywhere else.
3. **Chunking**: keep the heading-based structural chunking — it already produces coherent, self-contained passages, which is the hard part; fixed-token windowing would be a regression here, not an improvement.
4. **Extend the knowledge base with structured, per-survey retrieval**: today, RAG only searches the static agronomy Markdown files. The next real gain would be indexing *this survey's own history* (past `AnalysisResult` rows, `DetectionZone` records with their `recommended_action` text) into the same retriever, so "what changed since last month" can cite the actual prior measurement rather than relying purely on `llm_service.build_field_context()`'s hand-assembled prior-survey comparison.
5. **Citations**: keep the same `title/section/snippet/score` shape — it's simple and already correctly wired end-to-end on web; the only actual work needed is closing the mobile gap identified above.

---

## Addendum (same day, after the audit)

Resolved in the repository after this audit was written, so the sections
above describe HEAD `c682d83` and not the current state:

- §3.2 "`ultralytics` is not an installed dependency" — now installed in
  `backend/.venv-gpu` and listed in `backend/requirements-gpu.txt`; the
  detector path was exercised end to end with a throwaway pretrained model
  (see `docs/PHASE_STATUS.md`, "Still open") and the model removed again.
- §4.1 mobile `detectionTypeLabel()` colon convention — handled
  (`mobile/constants/labels.ts`).
- §4.2 "the mobile client does not display citations" — `sources` now flows
  through `mobile/types/api.ts` → `features/ai/hooks.ts` →
  `stores/chatStore.ts` → `components/ai/ChatBubble.tsx`.
- §4.2 "rebuilds only on a backend restart" — the BM25 index now rebuilds
  when a knowledge file's mtime, name set or count changes.

Still as described: no held-out PSNR/SSIM/LPIPS for 3DGS (§1.3), no ONNX
export / Grad-CAM / RT-DETR (§3.2–3.3, not in the project spec), no
training-data ingestion or annotation tooling (§3.1).
