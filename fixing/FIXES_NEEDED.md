# AgroTwin - Engineering Fixes & Technical Roadmap
## Focus: Solution B (WebODM / OpenDroneMap Photogrammetry)

This document details the critical technical issues identified in **AgroTwin v2**—specifically **mosaic ghosting/double imaging** and **zoom-in blurriness**—and outlines the definitive implementation of **Solution B (WebODM / OpenDroneMap)** as the primary engine for survey-grade 2D orthomosaics and 3D Digital Twins.

---

## 1. Executive Summary: The Chosen Architecture

To achieve commercial-grade quality, AgroTwin adopts a **Two-Stage Processing Architecture**:

```
Raw Drone Images (Missions 012 & 013, 230 Captures)
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
  STAGE 1: FAST PREVIEW   STAGE 2: DEFINITIVE SOLUTION (Solution B)
  (Local Quick Mosaic)    (WebODM / OpenDroneMap Engine)
  • 90 seconds            • 25–40 minutes
  • Winner-takes-all      • Full Bundle Adjustment & SfM
  • Instant in-field map  • True 3D Elevation Model (DSM)
                          • Graph-Cut Seamline Optimization
                          • Native 0.75 cm/px resolution
                          • 100% Zero Ghosting & 100% Zero Blur
                          • True 3D Textured Mesh for Cesium
                                 │
                                 ▼
                    [AgroTwin Automated Ingest]
                    `python -m scripts.import_odm --survey <id>`
```

---

## 2. Problem Deep-Dive: Why the Current Mosaic Fails

> **Historical section.** This describes the mosaic as it was before the 2026-09-28
> fixes (see "Status update (2026-09-28)" below). The RGB quick mosaic no longer
> averages overlapping frames and no longer decodes at half resolution; the
> flat-ground/no-bundle-adjustment limits below still apply to it.

### A. The Ghosting / Double Target Problem
* **Symptom**: Ground Control Point (GCP) checkerboard targets and field boundaries appear twice—one sharp instance and one semi-transparent duplicate displaced horizontally by ~1 to 1.5 meters.
* **Root Cause**:
  1. `backend/app/services/mosaic_service.py` uses direct georeferencing under a flat-ground assumption (still true).
  2. Overlapping passes (flight pass 1 heading 126° vs. return pass 2 heading -53°) place targets at slightly different coordinates $(X_1, Y_1)$ and $(X_2, Y_2)$ due to terrain slope and gimbal roll flips ($0^\circ$ vs $180^\circ$).
  3. *(Before 2026-09-28)* Overlapping pixels were combined using **weighted-average blending**
     (now only the NDVI/NDRE/GNDVI index mosaics still do this, deliberately):
     $$\text{Canvas Pixel} = \frac{\sum (\text{Frame Pixel} \times \text{Weight})}{\sum \text{Weight}}$$
  4. Both projected targets are drawn with opacity on top of each other.
  5. The largest single cause turned out to be gimbal roll: 101 of 230 frames report roll 180° and
     were pasted upside down (fixed by `image_heading_deg`, see the 2026-09-28 status update).

### B. The Zoom-In Blurriness Problem
* **Symptom**: The raw drone photos are crystal-clear (20 MP 4/3 CMOS at $5280 \times 3956$), but zooming into the mosaic in Cesium makes plants and targets look blurry.
* **Root Cause**:
  1. **Draft Decoding** *(fixed)*: `im.draft()` used to cut every frame to half resolution. It is now applied
     only when `reduce > 1`, i.e. when the output grid is coarser than native
     (`_decode_rgb_frame`, `mosaic_service.py`); at the default grid frames decode at full resolution.
  2. **Coarse Output Grid** *(fixed)*: the grid was locked at `RGB_GSD_M = 0.02` (2 cm/pixel). It now follows
     the camera's native GSD (~0.8 cm at 30 m AGL), floored at `RGB_MIN_GSD_M = 0.01` (1 cm) and coarsened
     only if the canvas would exceed `RGB_MAX_PIXELS` (500 M).
  3. **Multi-Image Smearing** *(fixed for RGB)*: Blending 3 to 4 overlapping frames that are misaligned by even 1–2 pixels acts as an unintended **Gaussian low-pass blur filter** over the field.

---

## 3. Why Solution B (WebODM / OpenDroneMap) is the Definitive Fix

WebODM eliminates both problems at their mathematical roots:

1. **Eliminating Ghosting via Graph-Cut Seamlines**:
   - WebODM never transparently averages overlapping frames.
   - It computes an optimal seamline through natural boundaries (row troughs, shadows) and takes **100% of the pixels from the single sharpest, most nadir image**.
   - Dual projections cannot occur; the target is rendered **exactly once**.
2. **Eliminating Blurriness via Full Native GSD**:
   - WebODM processes the full 20MP resolution without draft downsampling.
   - Outputs an orthomosaic at true camera GSD ($\le 0.8\text{ cm/pixel}$), making individual soybean leaves and soil cracks crisp.
3. **True Elevation Modeling (DSM & DTM)**:
   - Structure from Motion (SfM) creates thousands of 3D tie points, modeling the true slope and elevation profile of the field.
   - Every ray is orthorectified onto the terrain, eliminating perspective distortion.
4. **True 3D Reality Mesh for Cesium**:
   - WebODM generates a textured 3D mesh (`.obj` / `.glb` / 3D Tiles) that loads directly into Cesium’s `ModelLayer.tsx`.
   - The user can tilt the camera and fly through the field in true 3D without flat distortion.

---

## 4. Multi-Battery Flight Merging (Missions 012 + 013)

Large agricultural fields cannot be captured on a single drone battery. In our test data:
- `DJI_202606031411_012`: 38 frames (Pass 1).
- `DJI_202606031442_013`: 192 frames (Pass 2 & 3).

### Solution with WebODM:
1. Provide all 230 image pairs from **both Mission 012 and Mission 013** simultaneously into a single WebODM task.
2. WebODM automatically identifies tie-points connecting the two flights, bundle-adjusting both passes into **one seamless field orthomosaic**.

---

## 5. WebODM Recommended Execution Parameters

When running WebODM on this DJI Mavic 3M dataset, use these optimal agricultural flags:

| Parameter | Value | Purpose |
| :--- | :--- | :--- |
| `dsm` | `true` | Computes surface elevation model for terrain orthorectification |
| `orthophoto-resolution` | `0.8` | Native sub-centimeter resolution (0.8 cm/px). Ingested since 2026-09-29; the earlier `1.0` run (2026-09-12) is kept in `odm/odm_orthophoto_1cm/` |
| `feature-quality` | `high` | Extracts maximum SIFT features across uniform soybean rows |
| `pc-quality` | `high` | Denser point cloud for the mesh and DSM |
| `mesh-size` | `800000` | Detailed 3D reality mesh for Cesium (the runs so far used 800000, not 200000) |
| `radiometric-calibration` | `camera` | Uses DJI Mavic 3M sunshine sensor and vignetting tags for calibrated reflectance |
| `crop` | `0` | Keeps full field coverage |

---

## 6. AgroTwin Integration Blueprint

AgroTwin is already pre-wired for Solution B:

### Step 1: Export Assets from WebODM
Once WebODM finishes processing, export:
- `odm_orthophoto.tif` (2D Orthomosaic)
- `dsm.tif` (Surface Model)
- `odm_texturing/` (3D Mesh)

### Step 2: Ingest via AgroTwin's Importer
Run the existing AgroTwin import command:
```bash
cd backend && python -m scripts.import_odm --survey <survey_id> --odm-dir <path_to_odm_output>
```
(`--odm-dir` defaults to `data/surveys/<id>/odm`; add `--skip-mesh` to keep the existing reality-mesh tileset.)
Files live in `backend/scripts/import_odm.py` and `backend/app/services/tile_service.py`.

### Step 3: Automatic Tile Generation & Serving
1. `import_odm.py` registers the GeoTIFF as a `SurveyAsset` with `source="photogrammetry_odm"`.
2. `backend/app/services/tile_service.py` automatically detects the new asset and prioritizes it:
   ```python
   SOURCE_RANK = {"photogrammetry_odm": 0, "direct_georeferencing": 1}
   ```
3. A multi-threaded WebP tile pyramid is built down to the zoom matching the raster's GSD, capped at
   `MAX_ZOOM_CAP = 24` (a 1.0 cm or 0.8 cm source both give z24, ~0.75 cm/px on the ground at this latitude).
4. The Cesium viewer instantly displays the razor-sharp, ghost-free digital twin.

---

## 7. Fast Preview Fallback (Stage 1 Enhancement)

**Done (2026-09-28).** The RGB quick preview in `mosaic_service.py` uses **Winner-Takes-All (Nadir-Priority)**
instead of weighted-sum averaging, decodes at full resolution (`im.draft()` only when the grid is coarser than native),
and corrects the gimbal-roll heading. Only the index mosaics still average.

---

## Summary Action Checklist

- [x] Identify root causes of ghosting and blur in direct georeferencing.
- [x] Verify image dataset details for Mission 012 and 013.
- [x] Select **Solution B (WebODM / OpenDroneMap)** as the definitive engineering solution.
- [x] Process combined Missions 012 + 013 through WebODM (already done 2026-09-12: all 230 captures, `feature-quality high`, DSM + DTM, `orthophoto-resolution 1.0`, `mesh-size 800000`).
- [x] Ingest the resulting orthophoto and 3D mesh via `scripts/import_odm.py` (orthophoto tiled to z24 at 1 cm, ranked above the quick mosaic).
- [x] Verify zero-ghosting and leaf clarity in CesiumJS at zoom 21+ (2026-09-29, headless
      checks): the Field Map shows the ODM orthophoto (graph-cut seamlines, no averaging),
      tiles load z20→z24 as you zoom with no failed requests, and at the zoom limit single
      soybean leaves and residue straws are sharp.
- [x] Sub-centimetre orthophoto (2026-09-29): plain ODM 3.6.2 in Docker (not the WebODM UI),
      re-run from the 2026-09-12 SfM (`--rerun-from openmvs`, same flags plus
      `--orthophoto-resolution 0.8 --skip-3dmodel`), imported with `import_odm --skip-mesh`:
      23385×22808 px at 0.80 cm, 13,790 tiles z14–z24, zoom floor 6.9 m → 5.5 m. It is **not
      visibly sharper** than the 1.0 cm run (Laplacian detail ratio 0.87–1.12 at three spots):
      the camera resolves ~0.82 cm at 30 m AGL, so 1.0 cm already held nearly all the detail.
      The 1.0 cm run is kept in `data/surveys/cb0880056259/odm/odm_orthophoto_1cm/`. Densify ran
      on the CPU: Docker here has no NVIDIA Container Toolkit yet (then `--gpus all
      opendronemap/odm:gpu`).
- [x] Stage 1 quick mosaic fixed (2026-09-28) — see below.
- [x] Viewer zoom fixes (2026-09-29) — see "Zooming" below.

## Status update (2026-09-28): the main ghosting cause was gimbal roll

Checked against the ODM run's solved camera orientations: **101 of the 230 RGB
frames (and 111 of each multispectral band) report gimbal roll 180°**. Looking
straight down, that turns the image 180°, but `mosaic_service.py` placed every
frame by gimbal yaw alone, so 44 % of the photos were pasted upside down around
their own centres. That, not only the flat-ground assumption, is what drew each
target and track several times. The SfM headings: roll-0° frames ≈ yaw (median
−2°), roll-180° frames ≈ yaw + 180° (median +177°).

Fixed in `backend/app/services/mosaic_service.py`:
- heading = yaw, + 180° when |roll| > 90° (`image_heading_deg`); roll is now
  stored per image (`gimbal_roll_deg`) and back-filled from XMP for old surveys
- RGB: winner-takes-all (most-nadir frame per pixel), full-resolution decode,
  one interpolation through the DJI lens model, grid at native GSD floored at
  1 cm (was 2 cm); runs on the GPU when CUDA torch is installed, OpenCV otherwise
- lens-model fold-back guard (the M3M polynomial turns back at r = 1.23)
- NDVI/NDRE/GNDVI mosaics use the same heading fix (still centre-weighted
  averages — the analysis reads them in 5 m cells)

Remaining limits of the quick map (ODM stays the survey-grade layer): seams
where adjacent frames disagree — measured on 2026-10-10 at 2.6 m median and up
to 8.6 m, not the ~1–2 m first estimated (see the status update below) — and
brightness steps between flight passes (no colour balancing).

## Zooming: no blur, no seams (2026-09-29)

Measured with `frontend/scripts/zoomcheck.mjs`, `seamcheck.mjs` and `modecheck.mjs`
(headless Chrome against the running app):

- **Blur past the data**: the camera could zoom to 1 m, where each 1 cm source
  pixel covers ~4.5 screen pixels and the photo turns soft. The zoom now stops
  at 2× magnification of the finest layer on screen (`SurveyImageryLayer.tsx`,
  from each pyramid's `source_gsd_m`): 6.9 m above the ground for the 1 cm
  orthophoto in a 1600 px window, where leaves are still sharp.
- **Dark seam lines**: looking straight down, ~1 cm gaps between the global
  terrain tiles (Esri World Elevation) showed as dark lines across the photo
  (row 28–37 grey levels darker than its neighbours; 2.7 with terrain off). The
  Field Map — a top-down 2D map — now uses a flat globe (`CesiumViewer.tsx`);
  3D Twin and Photorealistic keep the terrain (their tilted views don't show it).
  After the fix: 3.4 grey levels, i.e. noise.
- **Tinted zones hiding the photo**: the Needs Attention fill washed the whole
  close-up view red/orange. Fills now fade out between 60 m and 15 m above the
  ground; the coloured outlines stay (`DetectionLayer.tsx`).

## Photorealistic (Gaussian splats) (2026-09-29)

- **Retrained** with the fixed 2026-09-14 recipe (1200 px, ground band, 4 cm
  split, needle pruning), capped at 1.5 M splats for the 6 GB RTX 3050: 30k
  steps in 82 min on the GPU, check render L1 0.047. Splat shape vs the old
  Sept 12 model: median length 126 cm → 6.3 cm, needles (>10× elongated)
  49 % → 8.7 %.
- **Colour bug in `tile_splats_spz.py`**: PLY `f_rest` is channel-major but
  SPZ wants coefficient-major; the tiler copied it through, so every splat's
  view-dependent colour was scrambled (pink/purple speckle in Cesium).
  Confirmed on the data (R–G correlation 0.92 channel-major vs 0.01), fixed,
  and covered by `backend/tests/test_tile_splats_spz.py`.
- **Zoom limit**: a splat model only holds the detail of its training images
  (3.9 cm per pixel here, now recorded as `train_gsd_m` in `placement.json`);
  closer than that its splats read as streaks, so Photorealistic mode stops
  zooming there (~54 m in a 1600 px window). Shared with the photo limit via
  `frontend/lib/zoomFloor.ts`.
- Zone fills draw at 35 % over the reconstruction so it stays visible.
- Build-environment fixes found on the way: `run_gpu.ps1` now picks the
  installed CUDA / MSVC versions and sets `/Zc:preprocessor` (CUDA 13.2
  requires it); `gsplat_train.py` drops GCC's `-Wno-attributes` flag that
  gsplat 1.5.3 hands to MSVC, and caps PyTorch's CPU thread pool (it was
  spinning 8 cores at 100 % while the GPU did the work).

Remaining limit: this flight is nadir-only (7 % oblique), so the model looks
right from above and degrades at grazing angles. Add oblique passes to the
next flight for a model that holds up from any angle.


## Status update (2026-10-10): alignment measured, band orthophotos on the ODM cameras

**What was measured** (read-only checks against the ODM orthophoto, with ODM's
own 1 cm run as a control that reads 0.00 m):

- The quick RGB mosaic and the quick NDVI/NDRE/GNDVI maps sit **3.7 m**
  (median) from the ODM orthophoto in every window; neighbouring windows
  disagree by 2.6 m median, up to 8.6 m. At the four GCP targets the quick
  mosaic is 2.0–3.9 m off, and it shows the North target **twice** (two sharp
  copies ~2 m apart) — the original double-target problem, now without the
  see-through ghost.
- Cause: not the positions (photo GPS, the DJI `.MRK` exposure log and ODM's
  solved camera centres agree within 2 cm). ODM's bundle adjustment finds every
  RGB photo looking **~7° off vertical**, always to the same side of the image
  (the straight-down ray lands ~412 px left / ~200 px down of the principal
  point), while the gimbal reports −89.9°. 7° at 29 m is 3.8 m; on the 180°-roll
  return legs it flips direction. The ground is also ~1.3 m above the take-off
  point (29.3 m above the crop vs RelativeAltitude 30.6 m).
- Band-to-band alignment inside a capture was fine (CalibratedHMatrix: 1.5–5.6 cm).
- The ODM run was RGB-only, so every vegetation index and the health zones came
  from the misplaced, overlap-averaged quick maps. Row/weed analysis and the
  detector plug-in already ran on the ODM orthophoto.
- Handheld GPS readings of the targets (Garmin GPS 73, SatViewer, 16 Sep 2026;
  `cordinate/`, transcribed in `cordinate/gcp_readings.csv`) lie 0.4–2.1 m from
  the targets in the ODM orthophoto — consistent with those devices' accuracy,
  3.5 m median from the quick-map copies. Phone "dropped pins" were up to 14 m
  off. Handheld fixes are not survey control; RTK/PPK rover coordinates would be.

**What was built** (all heavy steps on the GPU):

- `backend/app/services/band_ortho_service.py` + `scripts/build_band_orthos.py`:
  the band frames are placed with ODM's bundle-adjusted cameras and its DSM.
  The four band cameras' fixed rotations relative to the RGB camera are
  measured from the data (Green 0.43°, Red 0.50°, Red Edge 0.17°, NIR 0.60°;
  24/24 sample captures agree within ~0.04°); each capture is then fitted
  against the photo; every 1.5 cm pixel takes all four bands from the single
  most vertical exposure (no averaging); captures under passing cloud are
  balanced (overlap disagreement 5.5–6.2 % → 2.5–2.9 %). Products: band
  orthophotos (Green/Red/Red Edge/NIR), NDVI/NDRE/GNDVI, false colour
  (NIR·R·G) and an alignment check (NIR band over the photo), with
  `band_ortho_qa.json`. Measured: bands vs Green 0.2–0.35 cm median, Green band
  vs photo 1.45 cm median (3 cm p90), GCP targets in the band maps 0–1.4 cm
  from the photo. ~3 min on the RTX 3050.
- Radiometry: DJI's M3M workflow as ODM implements it — black level before the
  vignetting correction, and the per-band SensorGainAdjustment (0.51 Green …
  0.91 NIR) that was missing, which had biased NDVI.
- `backend/app/services/gcp_service.py`: the checkerboard targets are found
  automatically in the photogrammetric orthophoto by a dense GPU scan for the
  pattern (flat, near-white, colourless squares) and stored: **five** targets,
  GCP N/E/S/W and GCP SW by the gravel road (scores 0.89–0.96, no false hits;
  SW was spotted on 2026-10-11 in a user screenshot — it lies on bright cleared
  soil and was missed by the first, blob-seeded version; it is not in the
  handheld GPS readings). The field boundary is now the camera hull widened to
  take them in with a 2 m margin (1.092 → 1.28 ha; North, South and SW were
  outside before). In the band maps the targets sit 0–1.5 cm from the photo,
  GCP SW ~5 cm (it is at the edge of the band coverage, seen only obliquely).
- Small markers (2026-10-11, from a user screenshot of two unnamed ones): the
  field also has **66** ~17 cm checkerboards, most in a cluster in the middle
  of the field, a few near GCP W. At the 2.5 cm GCP scan they are ~7 px wide,
  so `gcp_service` scans for them separately, tile by tile at the
  orthophoto's own 0.8 cm (`MARKER`), names them M1, M2, … north to south and
  stores each target's `size_m`. Straw crossings are their look-alikes at that
  size; the markers' white plastic reads 227+ grey, straw 197–210, so the
  white level (≥ 220) and flatness tell them apart: all 66 found and checked
  by eye, no straw. The viewer draws markers as smaller points, labelled only
  within 40 m of the camera. Saved to the DB the same day (71 targets; the 5
  GCPs within 1 cm of their earlier positions). M1 lies 1.6 m outside the
  five-GCP outline, so the boundary grew 1.28 → 1.30 ha; the analysis was
  re-run on it. In the band maps the markers sit 0.4 cm (median) from the
  photo, at most 2.7 cm. The band check first reported 13–28 cm in Green for
  12 markers: at 1.5 cm/px a marker is ~11 px wide and straw 20–30 cm away
  out-scored it inside the ±25 cm search; it now searches ±8 cm for markers.
- Viewer: band, false-colour, alignment-check and GCP layers; the analysis,
  tiles and viewer share one source ranking (`asset_sources.py`), so the NDVI
  the zones are measured on is the one displayed.
- Launchers pick the Python with CUDA torch; on 2026-10-10 the app had been
  running on a CPU-only venv.

**Effect on the health analysis** (same 5 m-cell method, same boundary):

| NDVI the cells are measured on | healthy | attention | problem | median veg. cover |
|---|---|---|---|---|
| quick map (misplaced, averaged, old calibration) | 21.0 % | 27.4 % | 51.6 % | 29 % |
| band orthophotos, old calibration | 26.6 % | 36.7 % | 36.7 % | 31 % |
| band orthophotos, corrected calibration | 49.9 % | 44.4 % | 5.6 % | 72 % |
| … with the five-GCP boundary (1.28 ha) | 49.4 % | 44.3 % | 6.3 % | |
| … with the boundary taking in the small markers too (1.30 ha, current) | 49.0 % | 43.9 % | 7.1 % | |

The corrected NDVI's vegetation cover (72 %) agrees with the independent RGB
measurement on the ODM photo (Excess Green, 64 %); the old calibration's 31 %
did not. Zones: 17 → 18, now drawn where the photo shows them.

**Band coverage edge.** The band cameras see a narrower strip than the RGB
camera (61° × 48° vs 71° × 56°: 34.7 × 26 m vs 41.6 × 31.1 m at 29 m), so along
the outer flight lines the photo map reaches 1.2 m (median, up to 4.2 m)
further than the band maps; that strip ends in a staircase of single-capture
footprints. It lies ~19 m outside the field boundary — inside it the bands
cover 100 %. Fly one extra line beyond the field edge to cover it next time.

## Status update (2026-10-11): band layers no longer move when switching

Reported: switching between the photo and the band layers made the picture
shift. Two causes, both fixed:

- **Viewer zoom limit.** The closest zoom follows the layer's resolution
  (photo 0.8 cm → ~4.2 m above ground, bands 1.5 cm → ~7.8 m in a 1200 px
  window). Switching from the photo to a band while closer than 7.8 m made
  Cesium push the camera up to the new limit on the next frame: the view zoomed
  out by a third and everything away from the centre jumped.
  `frontend/lib/zoomFloor.ts` now never moves the camera; the limit is held at
  the current height and catches up as you zoom out.
- **Residual band-to-photo offsets.** The bands sat 1.5 cm (median) off the
  photo, 3–6 cm within 8 m of the band coverage's edge (seen only by the outer
  flight line's steep image corners), and Red had smooth 1–3 cm patches of its
  own against Green over a quarter of the field. `band_ortho_service` now ends
  with a co-registration: local offsets in 1.9 m windows every ~1 m (gradient
  phase correlation, outliers dropped, gaps filled, smoothed) — Green against
  the photo, every other band against Green — and each band is resampled once
  through its own field.

| | before | after |
|---|---|---|
| Red vs Green (median / p90, 3.8 m windows) | 0.34 / 1.6 cm | 0.10 / 0.19 cm |
| Red Edge vs Green | 0.21 / 0.41 cm | 0.09 / 0.14 cm |
| NIR vs Green | 0.19 / 0.71 cm | 0.08 / 0.14 cm |
| Green vs photo | 1.45 / 3 cm | 0.11 / 0.36 cm |
| Green vs photo, 0–3 m from the band edge (1.9 m windows) | 3.5 / 6.4 cm | 0.15 / 1.9 cm |
| GCP targets in the band maps vs the photo | 0–5 cm | 0–1.4 cm |
| small markers (66) in the band maps vs the photo | — | 0.4 cm median, ≤ 2.7 cm |

Checked in the viewer (headless Chrome on the NVIDIA GPU), 5 m above GCP SW
and GCP N: photo → Green → Red → Red Edge → NIR → false colour → photo keeps
the camera at 5.00 m, and the whole view moves 0.0–0.1 cm between bands (Red
vs Green was 2.0 cm at SW). The build takes ~3 min for the products, ~9.5 min
with tiles, GCPs and the analysis (48.8 % healthy / 44.1 % attention / 7.1 %
problem, 19 zones).
