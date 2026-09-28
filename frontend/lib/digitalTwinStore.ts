import { create } from "zustand";

export type ViewMode = "field-map" | "3d-twin" | "photorealistic";

export type LayerKey =
  | "fieldBoundary"
  | "mesh"
  | "orthomosaic"
  | "ndvi"
  | "problemZones"
  | "weedAreas"
  | "rgbPoints"
  | "cropDensity"
  | "ndre"
  | "gndvi"
  | "dsm"
  | "pointCloud"
  | "vectorOverlays"
  | "vegetationMask";

type ShowKey =
  | "showFieldBoundary"
  | "showMesh"
  | "showOrthomosaic"
  | "showNdvi"
  | "showProblemZones"
  | "showWeedAreas"
  | "showRgbPoints"
  | "showCropDensity"
  | "showNdre"
  | "showGndvi"
  | "showDsm"
  | "showPointCloud"
  | "showVectorOverlays"
  | "showVegetationMask";

interface DigitalTwinState extends Record<ShowKey, boolean> {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;

  advanced: boolean;
  toggleAdvanced: () => void;

  selectedDetectionId: string | null;
  setSelectedDetectionId: (id: string | null) => void;

  toggleLayer: (key: LayerKey) => void;
}

const LAYER_STATE_KEY: Record<LayerKey, ShowKey> = {
  fieldBoundary: "showFieldBoundary",
  mesh: "showMesh",
  orthomosaic: "showOrthomosaic",
  ndvi: "showNdvi",
  problemZones: "showProblemZones",
  weedAreas: "showWeedAreas",
  rgbPoints: "showRgbPoints",
  cropDensity: "showCropDensity",
  ndre: "showNdre",
  gndvi: "showGndvi",
  dsm: "showDsm",
  pointCloud: "showPointCloud",
  vectorOverlays: "showVectorOverlays",
  vegetationMask: "showVegetationMask",
};

export const useDigitalTwinStore = create<DigitalTwinState>((set) => ({
  mode: "field-map",
  setMode: (mode) => set({ mode }),

  advanced: false,
  toggleAdvanced: () => set((s) => ({ advanced: !s.advanced })),

  selectedDetectionId: null,
  setSelectedDetectionId: (id) => set({ selectedDetectionId: id }),

  showFieldBoundary: true,
  showMesh: true,
  showOrthomosaic: true,
  showNdvi: false,
  showProblemZones: true,
  showWeedAreas: true,
  showRgbPoints: true,
  showCropDensity: false,
  showNdre: false,
  showGndvi: false,
  showDsm: false,
  showPointCloud: false,
  showVectorOverlays: true,
  showVegetationMask: false,

  toggleLayer: (key) =>
    set((s) => {
      const stateKey = LAYER_STATE_KEY[key];
      return { [stateKey]: !s[stateKey] };
    }),
}));
