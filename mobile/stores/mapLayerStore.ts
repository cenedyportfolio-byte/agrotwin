import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "./secureStorage";

/**
 * Layers of the Field Map. The map itself is the website's Cesium Field Map
 * shown in a WebView; these toggles are pushed to it over the bridge
 * (SET_LAYER), so the keys mirror the web viewer's digitalTwinStore.
 * Simple layers are on by default; advanced ones are opt-in.
 */
export type MapLayerKey = "field" | "zones" | "orthomosaic" | "imagePoints" | "cropDensity" | "vectorOverlays" | "ndvi" | "ndre" | "gndvi" | "dsm";

interface MapLayerState {
  layers: Record<MapLayerKey, boolean>;
  toggleLayer: (key: MapLayerKey) => void;
  setLayer: (key: MapLayerKey, on: boolean) => void;
}

const defaultLayers: Record<MapLayerKey, boolean> = {
  field: true,
  zones: true,
  orthomosaic: true,
  imagePoints: false,
  cropDensity: false,
  vectorOverlays: true,
  ndvi: false,
  ndre: false,
  gndvi: false,
  dsm: false,
};

export const useMapLayerStore = create<MapLayerState>()(
  persist(
    (set) => ({
      layers: defaultLayers,
      toggleLayer: (key) => set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),
      setLayer: (key, on) => set((s) => ({ layers: { ...s.layers, [key]: on } })),
    }),
    {
      name: "agrotwin.map",
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({ layers: s.layers }),
      // Older persisted state may carry keys from the removed native map (baseLayer,
      // mapEngine); only the layer toggles are kept, and new keys get their defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { layers?: Partial<Record<MapLayerKey, boolean>> };
        return { ...current, layers: { ...defaultLayers, ...(p.layers ?? {}) } };
      },
    }
  )
);
