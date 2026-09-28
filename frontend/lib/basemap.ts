// Token-free basemaps with a per-tile fallback.
//
// NEXT_PUBLIC_BASEMAP picks the primary source:
//   usgs  (default) USGS "Imagery Only" — USDA NAIP aerial photography over the
//         US, public domain, served by The National Map (LOD 0–16, ~2 m/px).
//         Outside the US its tiles are missing, so the fallback takes over.
//   eox   EOX Sentinel-2 cloudless (global, 10 m, CC-BY 4.0 / open data).
//   esri  Esri World Imagery (global, sub-metre). Free to access without a
//         key, but Esri's terms require an ArcGIS licence for sustained or
//         commercial use — opt in only if you hold one.
// Every failed tile (network resets, missing coverage) is fetched from EOX
// instead, so the globe never stays blank; after several consecutive
// failures the primary is skipped for a while to avoid waiting on timeouts.

export const ESRI_IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const USGS_IMAGERY_URL =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";
export const EOX_S2_URL =
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg";

export type BasemapId = "usgs" | "eox" | "esri";

export interface BasemapInfo {
  id: BasemapId;
  name: string;
  license: string;
  coverage: string;
  url: string;
  maximumLevel: number;
  credit: string;
}

export const BASEMAPS: Record<BasemapId, BasemapInfo> = {
  usgs: {
    id: "usgs",
    name: "USGS Imagery Only (USDA NAIP)",
    license: "Public domain (US government work) — free for any use, no key",
    coverage: "United States; falls back to Sentinel-2 elsewhere",
    url: USGS_IMAGERY_URL,
    maximumLevel: 16,
    credit: "USDA, USGS The National Map: Orthoimagery",
  },
  eox: {
    id: "eox",
    name: "Sentinel-2 cloudless (EOX)",
    license: "Open data — CC BY 4.0, contains modified Copernicus Sentinel data",
    coverage: "Global, ~10 m/px",
    url: EOX_S2_URL,
    maximumLevel: 18,
    credit: "Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data)",
  },
  esri: {
    id: "esri",
    name: "Esri World Imagery",
    license: "Proprietary — needs an ArcGIS licence for sustained/commercial use",
    coverage: "Global, sub-metre",
    url: ESRI_IMAGERY_URL,
    maximumLevel: 18,
    credit: "Esri, Maxar, Earthstar Geographics",
  },
};

export function activeBasemapId(): BasemapId {
  const v = process.env.NEXT_PUBLIC_BASEMAP;
  return v === "esri" || v === "eox" ? v : "usgs";
}

const SKIP_AFTER_FAILURES = 6;
const PROBE_EVERY = 25;

export function createBasemapProvider(Cesium: any, id: BasemapId = activeBasemapId()) {
  const info = BASEMAPS[id];
  const primary = new Cesium.UrlTemplateImageryProvider({
    url: info.url,
    credit: info.credit,
    maximumLevel: info.maximumLevel,
  });
  if (id === "eox") return primary;

  const fb = BASEMAPS.eox;
  const fallback = new Cesium.UrlTemplateImageryProvider({ url: fb.url, credit: fb.credit, maximumLevel: fb.maximumLevel });

  const requestPrimary = primary.requestImage.bind(primary);
  let consecutiveFailures = 0;
  let skipped = 0;

  primary.requestImage = (x: number, y: number, level: number, request?: any) => {
    if (consecutiveFailures >= SKIP_AFTER_FAILURES && ++skipped % PROBE_EVERY !== 0) {
      return fallback.requestImage(x, y, level, request);
    }
    const attempt = requestPrimary(x, y, level, request);
    if (!attempt) return attempt; // throttled by Cesium's request scheduler — it will ask again
    return attempt.then(
      (image: unknown) => {
        consecutiveFailures = 0;
        return image;
      },
      () => {
        consecutiveFailures += 1;
        return fallback.requestImage(x, y, level);
      }
    );
  };
  return primary;
}

/** Resolves to `fallback` if `promise` hasn't settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}
