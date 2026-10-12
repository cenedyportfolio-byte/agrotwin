# WebODM Photogrammetry Pipeline (Solution B)
## Step-by-Step Execution Guide for AgroTwin v2

This workflow produces a **zero-ghosting, crystal-clear 2D orthophoto** ($\le 0.8\text{ cm/pixel}$) and a **true 3D Digital Twin** for the **Ditty Road Soybean field** by processing drone missions `012` and `013` through **WebODM (OpenDroneMap)**.

---

## 1. Input Datasets

Combine the images from both battery passes into a single WebODM task:

| Flight Pass | Directory | Contents |
| :--- | :--- | :--- |
| **Pass 1** | `Data/DJI_202606031411_012_DittyRoadSoybeanfield` | 38 RGB JPGs (`_D.JPG`) + MS bands |
| **Pass 2 & 3** | `Data/DJI_202606031442_013_DittyRoadSoybeanfield` | 192 RGB JPGs (`_D.JPG`) + MS bands |
| **Total Combined** | **230 Captures** | Complete field coverage with overlapping tie-points |

---

## 2. Recommended WebODM Settings

In the WebODM project configuration, apply these parameters for optimal agricultural detail and 3D mesh quality:

```text
--dsm
--orthophoto-resolution 0.8
--feature-quality high
--mesh-size 800000
--radiometric-calibration camera
--crop 0
```

### Parameter Rationale:
* **`--orthophoto-resolution 0.8`**: Forces the output raster to match the DJI Mavic 3M's native camera resolution (0.8 cm per pixel). **Eliminates zoom-in blur completely**.
* **`--dsm`**: Generates the true surface elevation model, orthorectifying every pixel against the actual terrain slope.
* **`--feature-quality high`**: Guarantees maximum tie-points between Pass 1 (012) and Pass 2 (013), eliminating flight-line boundary drift.
* **`--mesh-size 800000`**: Builds a dense 3D polygon reality mesh for Cesium's 3D Digital Twin view.
* **Graph-Cut Seamlines (Default in ODM)**: Selects 100% of the pixels in each cell from the sharpest single photo, **eliminating ghosting and duplicate targets**.

---

## 3. Importing Outputs into AgroTwin

Once WebODM completes the run, it generates the standard photogrammetry package:
- `odm_orthophoto.tif` (Georeferenced 2D Orthomosaic)
- `dsm.tif` (Digital Surface Model)
- `odm_texturing/` (3D Reality Mesh)

### Execution Command:
Run the built-in AgroTwin importer from the repo root:

```bash
cd backend && python -m scripts.import_odm --survey <survey_id> --odm-dir <path_to_webodm_output>
```

---

## 4. What Happens Automatically in AgroTwin

1. **Asset Registration**:
   `scripts/import_odm.py` registers the new files into SQLite (`data/agrotwin.db`) with `source="photogrammetry_odm"`.

2. **Tile Pyramid Priority**:
   `backend/app/services/tile_service.py` automatically detects the WebODM asset and prioritizes it over the draft quick mosaic:
   ```python
   SOURCE_RANK = {"photogrammetry_odm": 0, "direct_georeferencing": 1}
   ```

3. **Deep Zoom Pyramid**:
   AgroTwin generates Web-Mercator WebP tiles down to **zoom 24** (`MAX_ZOOM_CAP`; chosen from the raster's GSD, so a 0.8-1.0 cm orthophoto gets z24), preserving individual leaf detail for Cesium.

4. **Cesium 3D Twin**:
   The 3D textured mesh is placed in `frontend/public/models/<survey_id>/` and renders immediately when switching to **3D Twin Mode**.

---

## 5. Expected Verification Results

When viewing the survey in the AgroTwin Digital Twin viewer:
* **Ground Control Targets**: Checkerboard targets appear **exactly once** with sharp, distinct edges.
* **Zoom Clarity**: Zooming into a row displays crisp plant boundaries with **zero pixelation or draft blur**.
* **Elevation & 3D Reality**: Tilting the Cesium camera reveals real 3D field contours rather than a flat texture drape.
