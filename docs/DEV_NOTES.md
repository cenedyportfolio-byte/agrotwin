# Dev environment notes

## Windows machine (E:\Test1\agrotwin, since 2026-09-13)

- Everything project-related stays on E:\ — temp files, package caches
  (uv/pip), compiled CUDA kernels and logs live under `.cache/` and `logs/`.
  `run.ps1` (servers) and `run_gpu.ps1` (pipeline scripts) set TEMP/TMP,
  UV_CACHE_DIR, PIP_CACHE_DIR and TORCH_EXTENSIONS_DIR accordingly; do the
  same for anything started by hand.
- The backend venv is `backend/.venv-gpu` (Python 3.11, torch cu130, gsplat,
  pycolmap, all backend requirements). Install new packages there:
  `uv pip install --python backend\.venv-gpu\Scripts\python.exe <pkg>`.
  `backend/.venv` (Python 3.14, CPU only) still works for the API alone.
  The venv lives on an HDD: a cold `import torch` can take minutes after the
  OS cache evicts it — that's slow, not hung.
- The GPU is an RTX 4060 Ti 16 GB; CUDA COLMAP 4.2 is unpacked under
  `tools/colmap/` (build_splats.py finds it automatically).
- Raw frames of the current survey are referenced in place under
  `E:\40 ft\RGB Only\Part 1..3` (1,378 DJI `_D.JPG`, RGB only, no bands).

## A stale backend can silently keep port 8000

uvicorn binds with `SO_REUSEADDR`; on Windows that lets a second uvicorn bind
`0.0.0.0:8000` while an older one still listens, and the *old* process keeps
receiving the requests — the new one starts, logs "running", and serves
nothing. Symptom: the API answers with old behaviour after a "restart".
Check `netstat -ano | findstr :8000` — every LISTENING line is a process
that can answer. The stale one is usually an orphan: uvicorn (and uv's
`python.exe` trampoline) spawn the real server as a child, so killing the
PID you started leaves a `python.exe -c "from multiprocessing..."` child
whose parent is gone and which still holds the socket. Find it with
`Get-CimInstance Win32_Process -Filter "Name='python.exe'"` (parent PID no
longer exists) and `taskkill /PID <child> /F`; the netstat owner can even be
the dead parent's PID. This is how the API served 02:30 code until 03:00 on
2026-09-18 despite two "restarts".

## run.ps1 owns both servers

`run.ps1` stops the frontend when the backend exits and vice versa (its
`finally` block, which kills both process *trees*), so never kill one of the
two by PID to "restart" it — the other goes down with it. In `dev` mode the
backend runs under `python -m watchfiles … app`, which restarts the whole
uvicorn process whenever a `.py` file under `backend/app/` changes (edits
under `backend/scripts/` deliberately don't); the frontend hot-reloads too.
uvicorn's own `--reload` was dropped on 2026-09-18: on Windows it restarts
its worker with CTRL_C_EVENT, which never stopped the worker in the hidden
console the backend runs in, and the reloader then waited forever after the
first change. To restart everything, stop the launcher and run
`.\run.ps1 dev -Lan` again.

## exFAT drive can't hold symlinks

The source imagery lives on `/media/cdev/Personal1/...` which is exFAT.
`node_modules` and Python venvs rely on symlinks and will fail there
(`EPERM: operation not permitted, symlink`). That's why this project's code
lives at `~/Development/agrotwin` (ext4) instead of under
`/media/cdev/Personal1/Development/Agro/`. Raw drone images stay on the
external drive and are referenced by absolute path — nothing is duplicated.

This matches the precedent already set by the `CesiumSplatData` project
(same machine, same issue, documented in its own README).

## GPU vs CPU: where each processing stage runs (2026-09-24)

Machine: RTX 4060 Ti 16 GB, i5-13600K (14 cores / 20 threads), survey data
on an HDD. Every heavy stage has the same shape (`app/services/gpu.py`):
read/decode on a pool of CPU threads, per-pixel math on the GPU with torch,
numpy fallback when CUDA is missing (so `backend/.venv`, CPU-only, still
works, only slower). Measured on the 1,378-frame survey `8dab5067ab14`:

| Stage | Runs on | Before | After | Output vs before |
|---|---|---|---|---|
| Quick RGB mosaic (`mosaic_service`) | GPU: undistort, warp, feathered blend on a canvas kept in VRAM; JPEG decode on 16 threads | 14.9 min | 93 s | pixel-identical (max diff 0) |
| Per-frame ExG (new frames only) | GPU math; decode on threads | 3.3 min | 19 s | identical on all 1,378 frames |
| Tile pyramid (`tile_service`) | CPU threads: warp per thread, WebP encode in a pool | 80 s | 7 s | deepest zoom byte-identical; coarser zooms now built from the lossless tiles, not re-decoded WebP (≤1 grey level mean diff) |
| exg_map cells (`analysis_service`) | GPU | 1.8 s | 0.3 s | identical cells |
| Row analysis (`weed_service`) | CPU (OpenCV/scipy) | 3.5 s | 2.8 s | identical metrics |
| Vegetation mask | reuses the row analysis' read | 1.9 s | 0.1 s | identical raster |

What stays on the CPU, and why:

- **JPEG decode**: GeForce cards have no hardware JPEG decoder; nvJPEG
  measured no faster than libjpeg-turbo, which scales ~6x across threads.
- **WebP/PNG encode**: there is no GPU encoder; a thread pool gives ~10x.
- **Disk reads**: the mosaic is now bound by reading 1,378 JPEGs off the
  HDD. An SSD is the next speed-up there, not more GPU.
- **Row geometry** (OpenCV rotations, scipy labelling): a few seconds,
  multi-threaded already; porting would change results for little gain.
- **API, SQLite, GeoJSON**: I/O-bound, milliseconds per request.

Knobs: `GDAL_NUM_THREADS=ALL_CPUS` is set in `app/config.py` (multi-threaded
deflate decode/encode, lossless; a full orthomosaic read went 1.0 s →
0.12 s). `gpu.GPU_HEADROOM_BYTES` keeps 1.5 GB of VRAM free and falls back
to the CPU otherwise. Ollama's model takes ~9.5 GB while loaded, so a mosaic
started right after a chat can land on the CPU path.
`tile_service.PYRAMID_RAM_BYTES` (3 GB) caps the deepest zoom kept in RAM;
past it, tiles are re-read from disk.
The Ollama LLM already runs 100% on the GPU. Gaussian-splat training
(gsplat) and COLMAP dense/matching use CUDA; bundle adjustment would need a
CUDA Ceres build (postponed with the rest of the 3D pipeline).

## Cesium: no Ion token

`components/cesium/CesiumViewer.tsx` intentionally uses no
`Cesium.Ion.defaultAccessToken`. Basemap is Esri World Imagery (aerial,
free, no key) via `UrlTemplateImageryProvider`; terrain is
`EllipsoidTerrainProvider` (flat). This mirrors the working pattern already
proven in the `Cesium tech` reference project on this machine — reuse that
pattern rather than reaching for Ion-gated features (World Terrain, OSM
Buildings, Google 3D Tiles) unless a token is explicitly provisioned later.

## The external drive has bad sectors (found 2026-09-12)

While seeding the multispectral survey, three band TIFs in
`DJI_202606031442_013_DittyRoadSoybeanfield/` were unreadable at the
hardware level — `dmesg` reported `critical medium error, dev sda` and even
`md5sum` returned `Input/output error`:

- `DJI_20260603144600_0025_MS_NIR.TIF`
- `DJI_20260603144620_0029_MS_G.TIF`
- `DJI_20260603144630_0031_MS_R.TIF`

Their sizes are correct (the copy "succeeded"), the sectors just don't read
back. PIL memory-maps uncompressed TIFFs, so a failed page-in was a SIGBUS
that killed the whole seed process with no traceback. Every image open now
goes through `multispectral_service.open_image_safely` (a plain `read()`
into memory), which turns that into a catchable `OSError`; the analysis
skips such frames and logs them, and the image endpoints return 503.

Action for the user: back up the drive and check it (`smartctl`, or at
minimum re-copy those three files from the drone's SD card). The three
frames are still registered; they just have no NDVI stats and their
band/index previews can't be rendered until the files are readable.

## Ollama model choice (2026-09-19)

Ollama was already installed on this machine (`C:\Users\Admin\AppData\Local\Programs\Ollama`),
running on its default port **11434** — the backend's config previously pointed at **11435**,
a mismatch that meant the assistant could never reach it even once a model was pulled. Fixed
in `backend/app/config.py`.

Model: **`qwen2.5:14b-instruct-q4_K_M`** (9.0 GB, pulled via `ollama pull`), chosen for this
machine's specs — RTX 4060 Ti (16GB VRAM, ~14GB free at idle), 32GB RAM, i5-13600K (14C/20T):
- ~9GB VRAM at Q4 leaves headroom even if a gsplat/COLMAP job is holding a few GB of the GPU.
- Qwen2.5 stays noticeably more faithful to the retrieved knowledge-base passages and the
  structured field JSON (`llm_service.build_field_context`) than smaller models — important
  since the whole point of grounding is not to have the model drift into generic answers.
- The RAG context sent per question is small (BM25 top-3 passages from an ~3,000-word
  knowledge base + compact JSON field summary), so context-window size was never the
  constraint — model quality/groundedness was, which is why 14B was worth the extra VRAM over
  8B.
- `ollama_timeout_s` raised 60s -> 90s: measured generation time for a 512-token answer on
  this model/GPU is a few seconds, well inside either value, but 90s gives margin if the GPU
  is also busy training.
- Verified end-to-end against the live survey: `POST /api/analysis/{id}/ask` returns
  `"responder": "ollama:qwen2.5:14b-instruct-q4_K_M"` with a grounded answer.

If the GPU is heavily loaded by a training job and Ollama needs to fall back to CPU, a lighter
`qwen2.5:7b-instruct-q4_K_M` or `llama3.1:8b` is the documented fallback (not installed by
default — pull it only if you hit timeouts during a long training run).

## Ultralytics (YOLO) in the GPU venv (2026-09-20)

`ultralytics` is installed in `backend/.venv-gpu` for the trained-detector
plug-in (`detector_service.py`); `requirements-gpu.txt` lists it with the
other GPU extras. Two things to know:

- It depends on `opencv-python`, which installs a second `cv2` on top of the
  `opencv-python-headless` the API uses. Keep only headless (commands in
  `requirements-gpu.txt`); both work for Ultralytics, two at once can corrupt
  `cv2`.
- It writes `settings.json` under the user profile on C: by default.
  `detector_service.py` sets `YOLO_CONFIG_DIR` to `.cache/ultralytics/`
  (and creates it — if the directory is missing Ultralytics silently falls
  back to the current working directory) before the package is first
  imported, so nothing lands on C:. Pretrained weights, if ever downloaded
  by name, go to the current working directory — download them into
  `.cache/` explicitly.
