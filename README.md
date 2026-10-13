# AgroTwin

Your Field. Your Digital Twin. Your Insights.

A local-first agricultural digital twin: drone survey frames (DJI Mavic 3
Multispectral) in, an interactive 2D/3D twin of the field out — orthomosaic,
vegetation indices, measured crop-health zones, terrain, Gaussian splats and
a farmer-friendly assistant — all on one laptop, no cloud.

```
frontend/   Next.js 16 (App Router) + TypeScript + Tailwind v4 + shadcn/ui + CesiumJS
mobile/     Expo (React Native) farmer app — same FastAPI backend, Cesium twin via WebView
backend/    FastAPI + SQLAlchemy (SQLite) + rasterio / shapely / numpy / OpenCV / PyTorch
data/       local storage: uploads, quick-mosaic outputs, manual imports, caches, splat workspaces
docs/       PHASE_STATUS.md (what is real, what is not), DEV_NOTES.md (environment quirks)
scripts/    (in backend/scripts) photogrammetry, splat training, tiling, ingestion
```

## Run it

Windows, from this folder:

```powershell
npm start          # backend + frontend (dev servers); Ctrl-C stops both
npm run start:lan  # same, reachable from phones on the LAN (mobile app)
npm run stop       # stops them, even if started from another window
```

`npm start` says so and exits if AgroTwin is already running. These call
`run.ps1`, which also runs directly: `.\run.ps1 dev`, or `.\run.ps1` for a
production build served once built.

Linux / macOS:

```bash
./setup.sh         # one-time: venv, npm ci, Cesium assets
./run.sh           # or ./run.sh dev
```

Open http://localhost:3000 (API docs at http://localhost:8000/docs). Both
launchers keep temp files, package caches and logs inside this folder
(`.cache/`, `logs/`).

Backend Python: the launchers use the first Python whose torch sees a CUDA
GPU — `AGROTWIN_PYTHON` if set, then `backend/.venv-gpu`, `~/.venvs/agrotwin`
(the Linux CUDA venv when the drive's own venvs are Windows builds), then
`backend/.venv` — and say so loudly if processing would fall back to the CPU.
Dependencies: `backend/requirements.txt` (+ `requirements-gpu.txt`), `frontend/package.json`.

**On the university server** (https, sign-in, automatic detailed maps, the
offline assistant, nightly backups): follow [deploy/README.md](deploy/README.md).

## Detailed maps

Every upload first gets a **quick map** (minutes): each photo placed by its
GPS position, good enough to read the crop's health, but up to a few metres
off. With `AGROTWIN_ODM_ENABLED=true` the server then makes the **detailed
map** by itself: OpenDroneMap rebuilds the field in 3D from all the photos
in Docker (hours on CPU, less with `opendronemap/odm:gpu`), and its
orthophoto, elevation model, 3D model, the crop-health bands aligned on its
cameras, any ground targets and a fresh crop-health check replace the quick
ones. A second worker runs these one at a time, so they never hold up anyone's
quick map; an interrupted run resumes after a restart. Staff can start one
by hand (a flight's **Detailed Map** button); without Docker the quick map
is the result. Optional e-mail when a map is ready: `AGROTWIN_SMTP_*`.

## Accounts and sign-in

Everyone signs in. Three roles:

| Role | Sees | Can also |
|---|---|---|
| **Farmer** | only the fields of their own farm | upload flights, rename their fields, change their password |
| **Operator** | every farm | give a field to a farmer, rebuild mosaics, recompute analyses, import processed data |
| **Admin** | every farm | everything an operator can, plus create / switch off accounts and set new passwords (Users page) |

On a new server, create the first admin once, from `backend/` (the password
is asked for):

```bash
python -m scripts.create_user --email you@university.edu --name "Your Name" --role admin
```

Then sign in and add the farmers on the **Users** page; each gets a
temporary password to change under Settings. Fields made before accounts
existed belong to nobody (only staff see them): open the field and choose
its farmer, or create that farmer with `--assign-unowned`.

Sessions last 60 days (`AGROTWIN_SESSION_DAYS`). Behind https, set
`AGROTWIN_COOKIE_SECURE=true` so the sign-in cookie is never sent in clear.
The mobile app (`mobile/`) signs in with the same accounts: it sends its
session as a Bearer token, and hands it to the web map it embeds with a
one-time code (`POST /api/auth/handoff` → `/auth/handoff?code=…`).

## What you can do

1. **Upload a flight** (`/upload`): create a field + survey, select the
   DJI JPG/TIF files of a flight. They upload in batches (resumable), then the
   backend worker computes the field boundary, builds a georeferenced quick
   mosaic + tile pyramid and analyses vegetation. The survey page shows the
   live step-by-step progress and any failure with a retry button.
2. **Browse frames** (`/surveys/<id>`): thumbnails, full-size viewer with
   zoom/pan/fullscreen, EXIF/XMP metadata (GPS, RTK fix quality, AGL, gimbal),
   per-frame NDVI/NDRE/GNDVI previews when the multispectral bands exist.
3. **Import processed data** (same page): GeoTIFF orthomosaic / NDVI / NDRE /
   GNDVI / DSM, GeoJSON boundaries or zones, Cesium 3D Tiles (.zip) models,
   LAS/LAZ point clouds. Only georeferenced files are accepted; the error
   message says what to export instead.
4. **Digital Twin** (`/fields/<id>/digital-twin`): Field Map (2D drapes),
   3D Twin (terrain / reality mesh / imported 3D Tiles / point cloud) and
   Photorealistic (Gaussian splats) modes; simple layer names by default,
   Advanced View for NDVI/NDRE/GNDVI, elevation, point cloud, coordinates.
   With an imported OpenDroneMap run it also has the four multispectral band
   orthophotos (Green, Red, Red Edge, NIR), a false-colour (NIR·R·G) layer and
   an alignment check (NIR band over the photo) to see that they line up, and
   the ground control targets, which the field boundary is drawn around: the
   40–60 cm GCPs ("GCP N", …) and the small ~17 cm markers ("M1", "M2", …,
   labelled once you zoom in).
   Click a zone for type, severity, confidence and a safe recommended action.
   It opens on the whole globe, which turns to the field and flies down to it
   (a click skips ahead; a `?cam=` link opens straight at its view).
   Click or tap a GCP or marker for its coordinates (latitude/longitude,
   degrees-minutes-seconds, elevation) with a copy button — on a phone there
   is no cursor readout.
5. **Ask AI** (`/ask-ai`): questions answered from the survey's measured
   numbers — through a local Ollama model when one is running, otherwise by a
   template responder. The answer says which.

## Mobile application

AgroTwin has three parts: the **Python backend** (all processing), the
**web client** and the **mobile client**. Both clients read the same
`/api/*` endpoints and the same SQLite data; nothing is duplicated.

| | Web client (`frontend/`) | Mobile client (`mobile/`) |
|---|---|---|
| Audience | agronomists, GIS users, operators | farmers in the field |
| Best for | advanced visualisation, desktop workflows, large survey uploads (thousands of frames), Cesium Digital Twin | farmer dashboard, field monitoring, health analysis and attention zones, survey results, alerts-style overview, AI assistant, mobile map, Digital Twin viewing |
| Map | CesiumJS (2D drapes, 3D terrain/mesh, Gaussian splats) | the same Cesium viewer in a WebView (embedded mode hides the site chrome); the app draws its own controls over it and drives layers/camera through a message bridge — no native map SDK, no map API key |
| Uploads | batched, resumable, any size | small batches, single images, imported results; points to the web app for full flights |

Run it (details, LAN/emulator networking and troubleshooting in
[`mobile/README.md`](mobile/README.md)):

```powershell
cd mobile
copy .env.example .env      # set EXPO_PUBLIC_API_URL / EXPO_PUBLIC_WEB_VIEWER_URL to the laptop's LAN IP
npm install
npm start                   # scan the QR code with Expo Go on Android
```

For a phone to reach the servers they must listen on the LAN: start them with
`.\run.ps1 -Lan` (or `.\run.ps1 dev -Lan`), which binds `0.0.0.0` and prints
the laptop's LAN URLs to put in `mobile/.env` — see the mobile README,
section 4, for the firewall rule and emulator addresses.

## How the analysis works (and what it is not)

Vegetation cover is measured from the survey's own pixels: NDVI from the
calibrated, registered multispectral bands when they exist, the RGB Excess
Green Index otherwise. With a georeferenced mosaic the field is measured in
5 m map cells (true area shares); without one, per photo. Each cell is
compared with the cover the field's own best-developed ground reaches
(90th percentile): ≥ 80 % healthy, 50–80 % needs attention, < 50 % problem.
Zones are merged from the flagged cells and labelled only by what was
measured — bare soil, low crop density, patchy vegetation. The method is
recorded on every result and shown in the UI.

On top of the tiers, the orthomosaic is analysed for **crop rows and canopy
closure** (row spacing, bearing, share of the inter-row ground covered by
leaves). While the canopy is open enough for rows to be separable, vegetation
growing between rows is flagged as **weed candidates** for scouting; once the
canopy has closed the app says so instead of guessing. A **vegetation mask**
layer shows exactly which pixels were counted.

It is classical computer vision on real imagery, **not** a trained model:
it cannot identify weed species, disease or pests, and it never recommends
pesticides. Trained detectors plug in as manifests under `data/models/`
(Ultralytics YOLO/YOLO-seg, installed in `.venv-gpu`; see Settings) — none
ships, because that needs labelled imagery of this crop. To add one:

```
data/models/soy-weeds-v1/
    manifest.json   {"name": "soy-weeds-v1", "task": "weed_detection",
                     "framework": "ultralytics", "weights": "best.pt",
                     "labels": ["waterhemp", "palmer_amaranth"],
                     "trained_on": "…", "input_gsd_m": 0.02}
    best.pt
```

It runs on the orthomosaic during the next analysis (tiled at its own GSD,
results georeferenced and typed `soy-weeds-v1:waterhemp`). See
`docs/PHASE_STATUS.md` for the full list of what is real, what is
approximate, and what is still open.

## Assistant and knowledge base

`/ask-ai` answers from the survey's measured numbers plus a local agronomy
knowledge base (`backend/app/knowledge/*.md`: growth stages, indices,
scouting, weeds, survey practice, stress symptoms) retrieved with BM25 —
fully offline, no embedding model. A local Ollama model
(`qwen2.5:14b-instruct-q4_K_M`, see `docs/DEV_NOTES.md`) writes the answer
when one is running; otherwise a template responder does, and every answer
says which and lists its sources (web and mobile). Add or edit a Markdown
file to extend it — the index rebuilds on the next question, no restart.

## Map sources and licensing

The Cesium viewer's basemap defaults to **open data**: USGS "Imagery Only"
(USDA NAIP aerial photography, public domain) over the United States, with
EOX Sentinel-2 cloudless (CC BY 4.0) as the per-tile fallback everywhere
else. Esri World Imagery is available as an opt-in (`NEXT_PUBLIC_BASEMAP=esri`)
but its terms require an ArcGIS licence for sustained or commercial use, so it
is off by default. The global 3D terrain is Esri World Elevation 3D
(`NEXT_PUBLIC_TERRAIN=ellipsoid` disables it; the survey's own reconstructed
terrain still renders). Your own products — orthomosaic, indices, 3D
models, splats — are always served locally. Settings shows what is active.

## Heavy pipelines (GPU, run from `backend/`)

```powershell
.\run_gpu.ps1 -m scripts.build_splats --survey <id>   # SfM -> geo-align -> 3DGS -> SPZ 3D Tiles
.\run_gpu.ps1 -m scripts.build_dense  --survey <id>   # dense cloud, DSM, textured terrain mesh
.\run_gpu.ps1 -m scripts.build_tiles  --survey <id>   # XYZ tile pyramids for the rasters
.\run_gpu.ps1 -m scripts.import_odm   --survey <id>   # bring in an OpenDroneMap run (+ the two below)
.\run_gpu.ps1 -m scripts.build_band_orthos --survey <id>  # band/index orthophotos on the ODM cameras, tiles, GCPs, analysis
.\run_gpu.ps1 -m scripts.detect_gcps --survey <id> [--readings ../cordinate/gcp_readings.csv]
```

On Linux run the same modules with the CUDA venv, e.g.
`~/.venvs/agrotwin/bin/python -m scripts.build_band_orthos --survey <id>`.

Outputs land in `frontend/public/{tiles,models,splats}/<survey_id>/` and are
picked up by the viewer on the next page load.

**Why the band orthophotos exist.** The quick mosaics place every frame from
its GPS position and the gimbal's reported attitude on flat ground. Checked
against OpenDroneMap on the Ditty Road flight, that is 2–4 m off (the M3M
camera looks ~7° away from the reported −90°, and the error flips between
flight lines, so a target can even appear twice). `build_band_orthos` instead
places each band frame with ODM's bundle-adjusted cameras and surface model:
it measures the band cameras' fixed rotations relative to the RGB camera
from the data, fits every capture against the photo, takes each pixel from
the one most vertical exposure (no averaging), balances brightness between
captures taken under passing cloud, then co-registers the bands onto the
photo locally (Green against the photo, each other band against Green), and
writes `band_ortho_qa.json` with the measured band-to-band, band-to-photo and
GCP offsets (bands ~0.1 cm apart, ~0.1 cm from the photo, GCPs within
1.4 cm and the small markers within 2.7 cm here).
The NDVI/NDRE/GNDVI the analysis uses then come from these bands. The
radiometry follows DJI's M3M workflow as OpenDroneMap implements it,
including the per-band `SensorGainAdjustment` (fixed 2026-10-10; NDVI was
biased before).

## Architecture notes

- The frontend never processes imagery; every heavy step is Python behind
  `POST /api/surveys/{id}/process|mosaic` and `POST /api/analysis/{id}/recompute`,
  which return `202` with a `ProcessingJob` that `GET /api/surveys/{id}/job`
  reports on. Jobs run on an in-process worker thread (`services/job_runner.py`);
  swapping in Celery/RQ means replacing `submit()`.
- Storage is local disk through `services/storage_service.py`; the database is
  SQLite (WAL) through SQLAlchemy with GeoJSON in text columns — the service
  layer is the seam for PostgreSQL/PostGIS and object storage later.
- Raw survey frames are referenced in place (absolute paths, re-rooted when
  the checkout moves); only uploads, outputs and imports live under `data/`.
- No Cesium Ion token anywhere: Esri World Imagery + Esri Terrain3D are the
  free basemap/terrain; every survey product is served locally.
