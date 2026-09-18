import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { secureStorage } from "./secureStorage";

export type MapBaseLayer = "satellite" | "hybrid" | "standard";

/**
 * Which component draws the Field Map: the native SDK (Google Maps on Android,
 * Apple Maps on iOS) or the website's Cesium Field Map in a WebView, which
 * needs no Google Maps key or Play services. The screen switches to "web" by
 * itself when the native map fails to draw; the Layers sheet lets you switch back.
 */
export type MapEngine = "native" | "web";

/** Simple layers are on by default; advanced ones are opt-in, like the web viewer's Advanced View. */
export type MapLayerKey = "field" | "zones" | "orthomosaic" | "imagePoints" | "ndvi" | "ndre" | "gndvi" | "dsm";

interface MapLayerState {
  baseLayer: MapBaseLayer;
  layers: Record<MapLayerKey, boolean>;
  showAdvanced: boolean;
  mapEngine: MapEngine;
  setMapEngine: (engine: MapEngine) => void;
  setBaseLayer: (base: MapBaseLayer) => void;
  toggleLayer: (key: MapLayerKey) => void;
  setLayer: (key: MapLayerKey, on: boolean) => void;
  setShowAdvanced: (on: boolean) => void;
}

const defaultLayers: Record<MapLayerKey, boolean> = {
  field: true,
  zones: true,
  orthomosaic: true,
  imagePoints: false,
  ndvi: false,
  ndre: false,
  gndvi: false,
  dsm: false,
};

export const useMapLayerStore = create<MapLayerState>()(
  persist(
    (set) => ({
      baseLayer: "hybrid",
      layers: defaultLayers,
      showAdvanced: false,
      mapEngine: "native",
      setMapEngine: (mapEngine) => set({ mapEngine }),
      setBaseLayer: (baseLayer) => set({ baseLayer }),
      toggleLayer: (key) => set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),
      setLayer: (key, on) => set((s) => ({ layers: { ...s.layers, [key]: on } })),
      setShowAdvanced: (showAdvanced) => set({ showAdvanced }),
    }),
    {
      name: "agrotwin.map",
      storage: createJSONStorage(() => secureStorage),
      partialize: (s) => ({ baseLayer: s.baseLayer, layers: s.layers, showAdvanced: s.showAdvanced, mapEngine: s.mapEngine }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<MapLayerState>;
        return { ...current, ...p, layers: { ...defaultLayers, ...(p.layers ?? {}) } };
      },
    }
  )
);
