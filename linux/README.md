# AgroTwin — handoff for the Linux machine

Session of **2026-09-28 → 2026-09-29**, worked on the Windows laptop from this
drive (`D:\argoTwinv2`). This file is what you (and Claude Code, if you use it
there) need to pick the project up on Linux: what we did, what changed, what
state the data is in, and how to set the Linux side up.

Detailed engineering notes with measurements: [`fixing/FIXES_NEEDED.md`](../fixing/FIXES_NEEDED.md).

---

## Status at a glance

| Area | Status |
|---|---|
| **Orthophoto (WebODM / OpenDroneMap)** | ✅ **Complete.** ODM processed all 230 captures of both battery flights (missions 012 + 013) into one survey-grade orthophoto: full bundle adjustment, graph-cut seamlines (no averaging → no ghosting), DSM + DTM, 3D textured mesh (800k faces), `feature-quality high`, **1.0 cm/pixel**. It is imported (`scripts/import_odm.py`), tiled down to zoom 24, and is the layer the **Field Map** shows. Checked zoomed in: no ghosting, single soybean leaves sharp. |
| Quick mosaic (fast preview, no ODM) | ✅ Fixed — was ghosted because 101 of 230 photos were placed upside down; now 1 cm, sharp, runs on the GPU. |
| NDVI / NDRE / GNDVI maps + crop-health analysis | ✅ Rebuilt with the corrected photo placement. |
| 3D Twin (terrain, 3D mesh, point cloud) | ✅ Working; the model sits on the terrain. |
| Photorealistic (Gaussian splats) | ✅ Retrained on the GPU with the fixed recipe; tiler colour bug fixed. Limited by the straight-down-only flight (see §6). |
| Zooming (no blur, no seams) | ✅ Zoom stops where real detail ends; dark seam lines removed; zone colours fade close up. |
| GPU processing | ✅ `backend/.venv-gpu` on Windows; build the Linux one with §1. |
| Everything `fixing/` asked for | ✅ Done. One **optional** refinement remains: a 0.8 cm orthophoto instead of 1.0 cm (needs an ODM re-run with Docker — see §6). |

---

## 1. First steps on Linux

The Windows virtual environments on this drive (`backend/.venv`,
`backend/.venv-gpu`, with `Scripts\*.exe`) **do not work on Linux** — build Linux
ones. Everything else (code, database, data, tiles, models, splats) is shared.

```bash
cd /media/<you>/<drive>/argoTwinv2        # or wherever the drive / checkout is

# 1. CPU environment + frontend deps + path relocation (existing script)
./setup.sh

# 2. GPU environment (recommended — the user wants everything GPU-based).
#    Match the torch CUDA build to the machine's driver (cu130 was used on Windows).
python3.11 -m venv backend/.venv-gpu
backend/.venv-gpu/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130
backend/.venv-gpu/bin/pip install -r backend/requirements-gpu.txt
backend/.venv-gpu/bin/pip uninstall -y opencv-python            # ultralytics pulls it in
backend/.venv-gpu/bin/pip install --force-reinstall --no-deps opencv-python-headless
backend/.venv-gpu/bin/python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"

# 3. Check every stored file path resolves here (expect "0 still missing")
( cd backend && .venv-gpu/bin/python -m scripts.relocate_paths --dry-run )
( cd backend && .venv-gpu/bin/python -m scripts.relocate_paths )

# 4. Run (now prefers backend/.venv-gpu automatically)
./run.sh dev          # http://localhost:3000 , API docs http://localhost:8000/docs
```

Notes:
- `setup.sh` builds the venv on the local disk and copies it here because the
  drive is **exFAT** (no symlinks). The GPU venv is ~6 GB; building it on the
  local disk and pointing `backend/.venv-gpu` at it is fine too.
- Raw DJI frames are found automatically in `<project>/Data/DJI_*`. If they
  live elsewhere, set `AGROTWIN_RAW_DATA_ROOT=/path/to/folder-with-DJI_folders`.
- `run_gpu.ps1` is Windows-only. On Linux run the GPU scripts directly:
  `cd backend && CUDA_HOME=/usr/local/cuda .venv-gpu/bin/python -m scripts.build_splats --survey <id>`
  (gsplat compiles its CUDA kernels on first use with gcc + nvcc).
- Headless visual checks (`frontend/scripts/{zoomcheck,seamcheck,modecheck,splatcheck,shot}.mjs`)
  default to the Windows Chrome path: run them with `CHROME=/usr/bin/google-chrome`.
- Line endings: `.gitattributes` is `* text=auto` and the Windows checkout has
  `core.autocrlf=true`. The `.sh` files are LF on the drive now; if a Windows
  `git checkout` ever turns them CRLF they stop running on Linux. Adding
  `*.sh text eol=lf` to `.gitattributes` would prevent that.

---

## 2. Our conversation, in order

Every request from the session and what came of it.

| # | You said / asked | What happened |
|---|---|---|
| 1 | *How much of it have we done?* (pasted the full AgroTwin spec) | Compared the repo against the spec: all 9 phases are implemented (`docs/PHASE_STATUS.md`), plus the mobile app, Gaussian splats and dense 3D. The laptop's database was empty. |
| 2 | *Earlier data is in `D:\Development\Agro\agrotwin\data` — can we use it? Add it.* | Yes, same database schema. Restored the **Ditty Road Soybean Field** survey (June 3 2026, DJI Mavic 3 Multispectral, 230 captures / 1,150 images): DB rows plus 6.4 GB of outputs — **the completed ODM orthophoto**, DSM/DTM, NDVI/NDRE/GNDVI, tile pyramids, 3D mesh and point cloud. Raw frames are read from `Data/` (`config.py` now looks there). Verified through the API. |
| 3 | *So what are the updates?* | Summarised the restore; listed the uncommitted files. |
| 4 | *Some code was commented out earlier — uncomment it.* | Re-enabled the **3D Twin** and **Photorealistic** buttons (`CesiumToolbar.tsx`, hidden on Sept 24). |
| 5 | *Read `D:\argoTwinv2\fixing` and start fixing the code.* | Checked every claim in the docs against the code and data. **The WebODM orthophoto the docs call for was already done** (Sept 12, all 230 captures, 1.0 cm) and already the Field Map layer. The quick-mosaic ghosting had a bigger cause than the docs said: **101 of 230 photos were placed upside down** (DJI's 180° gimbal roll on return passes was ignored; proven against ODM's solved camera headings). |
| 6 | *Why is it taking so long to write the fixing code?* | Explained: the root cause had to be proven first, and this laptop (RTX 3050 6 GB, no PyTorch installed) isn't the workstation the code was written for. |
| 7 | *The whole project will be GPU-based — why is the GPU idle? Finish the fixing code first, then tell me.* | Finished the mosaic rewrite (upright photos, winner-takes-all seams, full-resolution decode, 1 cm grid). The GPU sat idle because `backend/.venv-gpu` didn't exist on this laptop (venvs aren't copied with the drive), so everything ran on the CPU. Created it (CUDA PyTorch) and added a GPU path to the mosaic. Also found `scipy` missing from `requirements.txt` and a truncated raw file (restored). |
| 8 | *What's the code update?* / *How much time will it take?* / *Overall updates and remaining time?* | Listed changes per file; the GPU install finished; GPU mosaic **47 s vs 182 s on CPU**, 99.5 % identical pixels. |
| 9 | *Run the full project so I can analyse.* | `npm start`; backend on the GPU venv; all pages pre-loaded. |
| 10 | *"No photorealistic reconstruction exists…" — what does it mean?* | Photorealistic mode had no splat model; copied the Sept 12 one from the old project. |
| 11 | *Photorealistic looks odd, not like Gaussian splats — check.* | Those were splats, from an early broken run: half of them 10×-stretched "needles". You chose **Retrain now**. |
| 12 | *Isn't everything running on my NVIDIA GPU?* / *6 GB VRAM, why only 1 GB used?* / *Look at my CPU vs GPU usage* / *See my concern* | Training was on the GPU (99 %, `nvidia-smi`). Windows Task Manager on this laptop exposes **no CUDA engine**, so it shows 0 %. VRAM grows with the model (peak ~3 GB at the 1.5 M-splat cap chosen for 6 GB). The high CPU was real waste — PyTorch's CPU threads spin-waiting — fixed (66 % → 9 % of the machine), then training resumed from its checkpoint. |
| 13 | *When will it be complete?* / *Approximate time?* | Estimated ~01:15; it finished **01:10**. |
| 14 | *After completing, recheck everything; check the fixing is completely done; no broken or blurry images when zooming.* | Checked every checklist item (orthophoto complete — see Status at a glance). Headless-browser zoom tests found and fixed: blur from zooming past the photo's detail (zoom limit), **dark terrain seam lines** in the Field Map (flat globe there), zone tints washing out the photo (fade). The new splat model had a **colour bug in the tiler** (scrambled spherical-harmonic order) — fixed and re-tiled — and got its own zoom limit. All tests pass. |
| 15 | *Restart the server.* | Restarted with `npm run stop` / `npm start`. |
| 16 | *Add our conversation to `D:\argoTwinv2\linux` for the Linux machine.* | Wrote this file. Also fixed two Linux blockers: stored file paths had become Windows paths (lookup is now OS-independent, with a test), and `run.sh` now uses `backend/.venv-gpu`. |
| 17 | *Include the whole conversation, and say the orthophoto is complete.* | Added the full log above and the **Status at a glance** table. |

---

## 3. Code changes (all uncommitted)

**Mosaic / metadata (backend)**
- `app/services/mosaic_service.py` — heading = gimbal yaw, +180° when roll is 180°;
  RGB mosaic is winner-takes-all (most nadir frame per pixel), full-resolution
  decode, one interpolation through the DJI lens model, native GSD floored at
  1 cm (was 2 cm), lens fold-back guard; GPU compositor (VRAM canvas) with an
  OpenCV CPU fallback. NDVI/NDRE/GNDVI mosaics get the heading fix (still averaged).
- `app/models.py` (`gimbal_roll_deg` column, auto-migrated), `metadata_service.py`,
  `survey_service.py` (stores roll; back-fills old surveys before a mosaic).
- `app/config.py` — raw DJI folders found in `<project>/Data/`.
- `app/services/storage_service.py` — `resolve_path` works across OSes (Windows
  `\` paths on Linux and back), with the `argoTwinv2` and old `agrotwin` folder
  names, and finds raw `DJI_*/<file>` under the raw-data root.
- `requirements.txt` — added `scipy` (every analysis imported it; CPU setups crashed).

**Splats (backend scripts)**
- `scripts/tile_splats_spz.py` — PLY `f_rest` is channel-major, SPZ is
  coefficient-major: now reordered (was scrambling every splat's colour); records
  `train_gsd_m` in `placement.json`.
- `scripts/build_splats.py` — computes the training pixel size and passes it on.
- `scripts/gsplat_train.py` — PyTorch CPU pool limited (`OMP_NUM_THREADS=2`,
  `KMP_BLOCKTIME=0`: it spun 8 cores at 100 %); strips GCC's `-Wno-attributes`
  that gsplat 1.5.3 passes to MSVC (no-op on Linux).

**Viewer (frontend)**
- `components/cesium/CesiumViewer.tsx` — Field Map uses a flat globe (the global
  terrain's ~1 cm tile gaps showed as dark lines looking straight down); 3D modes
  keep the terrain; ground height always sampled from the global terrain.
- `components/cesium/SurveyImageryLayer.tsx`, `SplatLayer.tsx`, new `lib/zoomFloor.ts` —
  zoom limit from each layer's real resolution (photo: 2× magnification of
  `source_gsd_m`; splats: 1× of `train_gsd_m`).
- `components/cesium/DetectionLayer.tsx` — zone fills fade between 60 m and 15 m,
  35 % strength over the splat model; outlines stay.
- `components/cesium/CesiumToolbar.tsx` — 3D Twin / Photorealistic buttons back.

**Launchers / tests / tools**
- `run.sh` — prefers `backend/.venv-gpu`. `run_gpu.ps1` — auto-detects CUDA/MSVC,
  `/Zc:preprocessor` (Windows only).
- New tests (run from `backend/` with `python -m tests.<name>`):
  `test_mosaic_service`, `test_tile_splats_spz`, `test_storage_paths`
  (plus the existing `test_weed_service`). All pass.
- New headless checks: `frontend/scripts/{zoomcheck,seamcheck,modecheck,splatcheck}.mjs`.

Already uncommitted **before** this session (not ours): `.gitignore`,
`backend/app/database.py`, `frontend/package.json` / `package-lock.json`,
`run.ps1`, `EXTERNAL_HDD_README.md`.

---

## 4. Data state on the drive

| Where | What |
|---|---|
| `data/agrotwin.db` | 1 farm, field **Ditty Road Soybean Field** (`5e72ec710075`), survey `cb0880056259` (230 captures, 1,150 images, gimbal roll back-filled), fresh analysis `ndvi_map`: 19.6 % healthy / 27.9 % attention / 52.5 % problem, 17 zones. |
| `data/surveys/cb0880056259/outputs/` | ODM orthophoto (1 cm), DSM/DTM, new quick mosaic (1 cm) and NDVI/NDRE/GNDVI (5 cm). |
| `data/surveys/cb0880056259/odm/` | ODM run outputs (without its 2.4 GB image copies). |
| `data/splats/cb0880056259/` | SfM workspace, 1200 px training images, `exports/` (trained `splat.ply` 354 MB, `checkpoint.pt` 1 GB, check renders). `images/` (2.4 GB) are copies of the raw frames — safe to delete; rebuilt when needed. |
| `frontend/public/tiles/cb0880056259/` | XYZ tile pyramids (orthomosaic from ODM to z24, NDVI/NDRE/GNDVI, DSM/DTM). |
| `frontend/public/models/cb0880056259/` | 3D mesh + point cloud tilesets. |
| `frontend/public/splats/cb0880056259/` | **New** splat model (1,495,558 splats, 39 MB SPZ, colour-fixed). |
| `Data/DJI_202606031411_012_…`, `Data/DJI_202606031442_013_…` | Raw flights (1,158 files). One truncated file was restored from the original. |
| `D:\Development\Agro\agrotwin\` (= `/media/cdev/Personal1/Development/Agro/agrotwin` on Linux) | Older project copy with the original data; still intact. |

---

## 5. Verified results

- Quick mosaic: ghosted and smeared before; now single, sharp features (checked
  against the ODM orthophoto). GPU and CPU outputs agree on 99.5 % of pixels.
- Field Map zoom: tiles load z20 → z24 with no failed requests; zoom stops at
  ~7 m where single leaves are still sharp; seam line gone (row darkness dip
  28–37 → 3.4 grey levels).
- Splats: median splat length 126 cm → 6.3 cm, needles 49 % → 8.7 %; training
  check L1 0.047; natural colours; zoom stops at ~54 m.
- 3D Twin: terrain returns, ODM model sits on the ground (291.9 m vs 292.6 m).

---

## 6. Open items

1. **Optional: a 0.8 cm orthophoto.** The orthophoto is complete at 1.0 cm/pixel
   (the camera's native detail is ~0.8 cm). The fixing docs suggest 0.8 cm; that
   means re-running ODM with `--orthophoto-resolution 0.8`, which needs Docker
   (not on the Windows laptop — easy on Linux). Flags are in
   `fixing/WEBODM_SETUP_AND_WORKFLOW.md`; import with
   `backend/.venv-gpu/bin/python -m scripts.import_odm --survey cb0880056259 --odm-dir <odm output>`.
2. **Splats on a bigger GPU** — the laptop has 6 GB, so the model was capped at
   1.5 M splats. On the 16 GB workstation `gsplat_train.py` can use its 3 M default.
   Re-tile an existing model any time with `python -m scripts.build_splats --survey <id>`
   (skips SfM/training when done).
3. **Nadir-only capture** — the splat model looks right from above and degrades at
   grazing angles. Add oblique passes to the next flight.
4. **Health numbers changed** from the restored 50/30/20 to 19.6/27.9/52.5 —
   that comes from the newer analysis code (the old run used an older method),
   not from the mosaic fix.
5. **Nothing is committed.** Decide how to split our changes from the older
   uncommitted ones before committing.

---

## 7. For Claude Code on the Linux machine

- The user wants heavy processing on the **NVIDIA GPU** and judges the Digital
  Twin by how it looks when **zooming** — no blur, no seams, no broken imagery.
  Verify visual changes with the headless scripts, not only type checks.
- Keep CPU threads low in GPU jobs; check load with `nvidia-smi`.
- Code comments describe an RTX 4060 Ti 16 GB workstation; the Windows session ran
  on an RTX 3050 6 GB laptop — size VRAM-heavy jobs for the machine you're on.
