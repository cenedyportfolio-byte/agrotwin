"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useState, useEffect } from "react";
import { useDigitalTwinStore } from "@/lib/digitalTwinStore";
import type { MeshKind } from "@/lib/surveyAssets";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";

function LayerToggle({
  checked,
  onChange,
  label,
  disabled,
  hint,
  badge,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
  hint?: string;
  /** Small text at the right instead of "n/a" (e.g. why a layer is unavailable). */
  badge?: string;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-3 py-1.5 text-xs ${
        disabled ? "text-muted-foreground/50 cursor-not-allowed" : "cursor-pointer"
      }`}
      title={hint}
    >
      <span className="flex items-center gap-2">
        <Checkbox checked={checked && !disabled} disabled={disabled} onCheckedChange={() => onChange()} />
        {label}
      </span>
      {disabled && <span className="text-[10px] text-muted-foreground/60">{badge ?? "n/a"}</span>}
    </label>
  );
}

export interface LayerControlsProps {
  hasOrthomosaic?: boolean;
  hasNdvi?: boolean;
  hasNdre?: boolean;
  hasGndvi?: boolean;
  hasDsm?: boolean;
  hasMesh?: boolean;
  /** "reality": true-3D photogrammetry mesh (OpenDroneMap); "imported": manually imported 3D Tiles; "terrain": 2.5D heightfield fallback */
  meshKind?: MeshKind;
  hasPointCloud?: boolean;
  hasVectorOverlays?: boolean;
  hasVegetationMask?: boolean;
  /** Weed candidates / model detections exist for this survey. */
  hasWeedAreas?: boolean;
  /** Why weed candidates are absent (backend row-analysis status), shown as the toggle's hint. */
  weedHint?: string;
}

export function LayerControls({
  hasOrthomosaic,
  hasNdvi,
  hasNdre,
  hasGndvi,
  hasDsm,
  hasMesh,
  meshKind = "terrain",
  hasPointCloud,
  hasVectorOverlays,
  hasVegetationMask,
  hasWeedAreas,
  weedHint,
}: LayerControlsProps) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (window.innerWidth < 768) {
      setOpen(false);
    }
  }, []);

  const {
    advanced,
    toggleAdvanced,
    showRgbPoints,
    showFieldBoundary,
    showProblemZones,
    showWeedAreas,
    showOrthomosaic,
    showNdvi,
    showNdre,
    showGndvi,
    showCropDensity,
    showDsm,
    showMesh,
    showPointCloud,
    showVectorOverlays,
    showVegetationMask,
    mode,
    toggleLayer,
  } = useDigitalTwinStore();

  return (
    <div className="pointer-events-auto w-48 sm:w-56 rounded-xl border border-border bg-surface/90 shadow-lg backdrop-blur">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold hover:bg-surface-2/60 transition-colors rounded-t-xl"
      >
        <span>Layers</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <div className="border-t border-border px-3 py-2 max-h-[50vh] sm:max-h-[65vh] overflow-y-auto">
          <LayerToggle checked={showFieldBoundary} onChange={() => toggleLayer("fieldBoundary")} label="Field Boundary" />
          {mode === "3d-twin" && (
            <LayerToggle
              checked={showMesh}
              onChange={() => toggleLayer("mesh")}
              label={
                meshKind === "reality"
                  ? advanced ? "Reality Mesh (true 3D, photogrammetry)" : "3D Reality Mesh"
                  : meshKind === "imported"
                    ? advanced ? "3D Model (imported 3D Tiles)" : "3D Model"
                    : advanced ? "3D Model (textured terrain)" : "3D Terrain"
              }
              disabled={!hasMesh}
              hint={
                meshKind === "reality"
                  ? "Full 3D textured mesh from multi-view stereo on the survey's frames (OpenDroneMap): rounded tree crowns, real vertical faces"
                  : meshKind === "imported"
                    ? "3D Tiles model imported from DJI Terra / Metashape / ODM, placed by its own georeference"
                    : "Bare-earth terrain mesh reconstructed from the survey's frames, textured with the field photo map"
              }
            />
          )}
          <LayerToggle
            checked={showOrthomosaic}
            onChange={() => toggleLayer("orthomosaic")}
            label={advanced ? "Orthomosaic (quick mosaic)" : "Field Photo Map"}
            disabled={!hasOrthomosaic}
            hint="Georeferenced RGB mosaic built from the survey's RTK-tagged frames"
          />
          <LayerToggle
            checked={showNdvi}
            onChange={() => toggleLayer("ndvi")}
            label={advanced ? "NDVI map" : "Crop Health Map"}
            disabled={!hasNdvi}
            hint="Georeferenced NDVI computed from the multispectral bands (red = low, green = high)"
          />
          <LayerToggle
            checked={showProblemZones}
            onChange={() => toggleLayer("problemZones")}
            label={advanced ? "Detection Zones" : "Needs Attention"}
          />
          <LayerToggle
            checked={showWeedAreas}
            onChange={() => toggleLayer("weedAreas")}
            label={advanced ? "Weed candidates (inter-row)" : "Weed Areas"}
            disabled={!hasWeedAreas}
            badge={hasWeedAreas ? undefined : "none"}
            hint={
              weedHint ??
              "Vegetation growing between the crop rows, flagged for scouting while the canopy is still open; species are not identified"
            }
          />
          {hasVectorOverlays && (
            <LayerToggle
              checked={showVectorOverlays}
              onChange={() => toggleLayer("vectorOverlays")}
              label={advanced ? "Imported GeoJSON" : "Imported Boundaries"}
              hint="Boundaries / zones imported as GeoJSON, drawn at their real position"
            />
          )}
          <LayerToggle
            checked={showRgbPoints}
            onChange={() => toggleLayer("rgbPoints")}
            label={advanced ? "Image Capture Points" : "Survey Coverage"}
          />
          <LayerToggle
            checked={showCropDensity}
            onChange={() => toggleLayer("cropDensity")}
            label={advanced ? "Crop Density (per frame)" : "Crop Density"}
            hint="Measured per-frame vegetation coverage (NDVI when multispectral bands exist, RGB index otherwise) — red/amber/green"
          />

          {advanced && (
            <>
              <div className="my-2 border-t border-border" />
              <LayerToggle
                checked={showVegetationMask}
                onChange={() => toggleLayer("vegetationMask")}
                label="Vegetation mask"
                disabled={!hasVegetationMask}
                hint="Exactly the pixels the analysis counted as vegetation (Excess Green above threshold), at 5 cm"
              />
              <LayerToggle
                checked={showNdre}
                onChange={() => toggleLayer("ndre")}
                label="NDRE map"
                disabled={!hasNdre}
                hint="Georeferenced NDRE (NIR / Red Edge) — canopy chlorophyll sensitivity"
              />
              <LayerToggle
                checked={showGndvi}
                onChange={() => toggleLayer("gndvi")}
                label="GNDVI map"
                disabled={!hasGndvi}
                hint="Georeferenced GNDVI (NIR / Green)"
              />
              <LayerToggle
                checked={showDsm}
                onChange={() => toggleLayer("dsm")}
                label="Elevation (DSM)"
                disabled={!hasDsm}
                hint="Digital surface model from the 3D reconstruction — relative relief, low (blue) to high (red)"
              />
              <LayerToggle
                checked={showPointCloud}
                onChange={() => toggleLayer("pointCloud")}
                label="Point Cloud"
                disabled={!hasPointCloud}
                hint="Coloured surface points — from the 3D reconstruction or an imported LAS/LAZ cloud"
              />
              <LayerToggle checked={false} onChange={() => {}} label="Thermal" disabled hint="No thermal sensor data in this dataset" />
            </>
          )}

          <div className="my-2 border-t border-border" />
          <Button variant="link" size="xs" onClick={toggleAdvanced} className="px-0 text-[11px]">
            {advanced ? "Simple View" : "Advanced View"}
          </Button>
        </div>
      )}
    </div>
  );
}
