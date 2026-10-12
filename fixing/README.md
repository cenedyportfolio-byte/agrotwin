# AgroTwin Fixing & Photogrammetry Directory

This directory contains the technical documentation, bug investigations, and engineering action plans for resolving identified issues in **AgroTwin v2**—focusing on **Solution B (WebODM / OpenDroneMap)** as the definitive solution for ghosting, blur, and 3D digital twins.

---

### Documents in this Directory:

1. **[`FIXES_NEEDED.md`](./FIXES_NEEDED.md)**:
   - Comprehensive technical breakdown of why the quick mosaic suffered from **ghosting** (gimbal-roll heading bug plus weighted-average blending; both fixed 2026-09-28, flat-ground limits remain) and **zoom-in blur** (half-resolution decode and a 2 cm grid; now full resolution on a 1 cm-floored grid).
   - In-depth architectural blueprint for **Solution B (WebODM / OpenDroneMap)** as the primary photogrammetry pipeline.
   - Analysis of Gimbal Roll 180° flips, exFAT filesystem guards, and multi-battery flight merging.

2. **[`WEBODM_SETUP_AND_WORKFLOW.md`](./WEBODM_SETUP_AND_WORKFLOW.md)**:
   - Step-by-step practical guide for processing the Ditty Road Soybean dataset (Missions `012` and `013`, 230 captures).
   - Recommended WebODM command flags (`--dsm`, `--orthophoto-resolution 0.8`, `--feature-quality high`, `--mesh-size 800000`).
   - Instructions for importing the resulting survey-grade orthophoto and 3D textured mesh into AgroTwin using `backend/scripts/import_odm.py`.
