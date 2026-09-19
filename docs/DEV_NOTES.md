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

## GPU

RTX 3050 6GB laptop GPU is available (confirmed via `nvidia-smi`). Not
needed for the current phases (dashboard, Cesium field map, metadata
extraction all run fine on CPU). It matters starting at:

- Phase 7 (AI analysis) — YOLO/segmentation model inference
- Phase 9 (advanced 3D) — Gaussian splat training, same GPU already used
  successfully by the `CesiumSplatData` project (`gsplat` + CUDA toolchain
  at `~/venvs/splat`, `~/cuda-apt/toolchain`)

No need to route AgroTwin's own venv through that CUDA toolchain until CV
work actually starts.

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
