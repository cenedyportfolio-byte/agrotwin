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

Windows:

```powershell
.\run.ps1          # production: builds the frontend once, then serves it
.\run.ps1 dev      # hot-reloading dev servers
```

Linux / macOS:

```bash
./setup.sh         # one-time: venv, npm ci, Cesium assets
./run.sh           # or ./run.sh dev
```

Open http://localhost:3000 (API docs at http://localhost:8000/docs). Both
launchers keep temp files, package caches and logs inside this folder
(`.cache/`, `logs/`).

Backend Python: `backend/.venv-gpu` (Python 3.11 + CUDA torch, gsplat,
pycolmap — used for everything when present) or `backend/.venv` (CPU only).
Dependencies: `backend/requirements.txt`, `frontend/package.json`.

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
   Click a zone for type, severity, confidence and a safe recommended action.
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
| Map | CesiumJS (2D drapes, 3D terrain/mesh, Gaussian splats) | react-native-maps with the field boundary, zones and the tile pyramids; the Cesium viewer opens in a WebView for 3D |
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
.\run_gpu.ps1 -m scripts.import_odm   --survey <id>   # bring in an OpenDroneMap run
```

Outputs land in `frontend/public/{tiles,models,splats}/<survey_id>/` and are
picked up by the viewer on the next page load.

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
