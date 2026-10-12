"use client";

import { useEffect } from "react";
import { setZoomFloor } from "@/lib/zoomFloor";

export interface RasterAsset {
  previewUrl: string;
  bounds: [west: number, south: number, east: number, north: number];
  /** Base of an XYZ pyramid (…/tilemeta.json, {z}/{x}/{y}.<ext>) built by build_tiles.py. */
  tilesUrl?: string | null;
}

interface TileMeta {
  minzoom: number;
  maxzoom: number;
  format: string;
  bounds: [number, number, number, number];
  source_gsd_m?: number;
}

// a photo stays sharp up to ~2 screen pixels per source pixel
const MAX_MAGNIFICATION = 2;

function metresPerDegreeLon(lat: number) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

export interface SurveyImageryLayerProps {
  viewer: any;
  Cesium: any;
  ready: boolean;
  /** When set, layers drape onto this 3D Tileset (reality mesh) instead of the globe. */
  tileset?: any;
  orthomosaic: RasterAsset | null;
  ndvi: RasterAsset | null;
  ndre: RasterAsset | null;
  gndvi: RasterAsset | null;
  dsm: RasterAsset | null;
  vegetationMask?: RasterAsset | null;
  /** Band orthophotos and their composites (see backend band_ortho_service). */
  bandGreen?: RasterAsset | null;
  bandRed?: RasterAsset | null;
  bandRedEdge?: RasterAsset | null;
  bandNir?: RasterAsset | null;
  falseColor?: RasterAsset | null;
  alignmentCheck?: RasterAsset | null;
  showOrthomosaic: boolean;
  showNdvi: boolean;
  showNdre: boolean;
  showGndvi: boolean;
  showDsm: boolean;
  showVegetationMask?: boolean;
  showBandGreen?: boolean;
  showBandRed?: boolean;
  showBandRedEdge?: boolean;
  showBandNir?: boolean;
  showFalseColor?: boolean;
  showAlignmentCheck?: boolean;
}

/** The Cesium provider for a raster and its ground resolution (m per source pixel). */
async function providerFor(Cesium: any, asset: RasterAsset): Promise<{ provider: unknown; gsd: number | null }> {
  const [west, south, east, north] = asset.bounds;
  if (asset.tilesUrl) {
    const res = await fetch(`${asset.tilesUrl}/tilemeta.json`);
    if (res.ok) {
      const meta: TileMeta = await res.json();
      // Google-Maps-style pyramid: only the 256px tiles the view needs, native
      // resolution at the deepest level, so zooming into a crop row stays sharp.
      const provider = new Cesium.UrlTemplateImageryProvider({
        url: `${asset.tilesUrl}/{z}/{x}/{y}.${meta.format}`,
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        rectangle: Cesium.Rectangle.fromDegrees(...meta.bounds),
        minimumLevel: meta.minzoom,
        maximumLevel: meta.maxzoom,
        hasAlphaChannel: true,
        tileWidth: 256,
        tileHeight: 256,
      });
      return { provider, gsd: meta.source_gsd_m ?? null };
    }
  }
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = asset.previewUrl;
  });
  const provider = new Cesium.SingleTileImageryProvider({
    url: asset.previewUrl,
    tileWidth: img.naturalWidth,
    tileHeight: img.naturalHeight,
    rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
  });
  const gsd = ((east - west) * metresPerDegreeLon((south + north) / 2)) / img.naturalWidth;
  return { provider, gsd };
}

/** One raster overlay as a Cesium ImageryLayer, placed by the asset's real
 * geographic bounds. Added to the globe, or draped onto a 3D Tileset
 * (Cesium ≥ 1.126 imagery draping) when one is passed. */
function useRasterLayer(viewer: any, Cesium: any, ready: boolean, tileset: any, asset: RasterAsset | null, show: boolean) {
  useEffect(() => {
    if (!viewer || !Cesium || !ready || !asset || !show) return undefined;
    if (tileset && tileset.isDestroyed?.()) return undefined;

    let layer: any = null;
    let cancelled = false;
    const collection = tileset ? tileset.imageryLayers : viewer.imageryLayers;
    const key = Symbol("raster");

    providerFor(Cesium, asset)
      .then(({ provider, gsd }) => {
        if (cancelled || viewer.isDestroyed?.() || (tileset && tileset.isDestroyed?.())) return;
        layer = new Cesium.ImageryLayer(provider);
        collection.add(layer);
        if (gsd) setZoomFloor(viewer, key, { group: "imagery", gsdM: gsd, maxMagnification: MAX_MAGNIFICATION });
      })
      .catch((e) => console.error("raster layer", e));

    return () => {
      cancelled = true;
      if (!viewer.isDestroyed?.()) setZoomFloor(viewer, key, null);
      if (layer) {
        try {
          if (!viewer.isDestroyed?.() && !(tileset && tileset.isDestroyed?.())) collection.remove(layer, true);
        } catch {
          /* viewer may already be destroyed */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, Cesium, ready, tileset, asset?.previewUrl, asset?.tilesUrl, show]);
}

export function SurveyImageryLayer({
  viewer,
  Cesium,
  ready,
  tileset = null,
  orthomosaic,
  ndvi,
  ndre,
  gndvi,
  dsm,
  vegetationMask = null,
  bandGreen = null,
  bandRed = null,
  bandRedEdge = null,
  bandNir = null,
  falseColor = null,
  alignmentCheck = null,
  showOrthomosaic,
  showNdvi,
  showNdre,
  showGndvi,
  showDsm,
  showVegetationMask = false,
  showBandGreen = false,
  showBandRed = false,
  showBandRedEdge = false,
  showBandNir = false,
  showFalseColor = false,
  showAlignmentCheck = false,
}: SurveyImageryLayerProps) {
  useRasterLayer(viewer, Cesium, ready, tileset, orthomosaic, showOrthomosaic);
  useRasterLayer(viewer, Cesium, ready, tileset, ndvi, showNdvi);
  useRasterLayer(viewer, Cesium, ready, tileset, ndre, showNdre);
  useRasterLayer(viewer, Cesium, ready, tileset, gndvi, showGndvi);
  useRasterLayer(viewer, Cesium, ready, tileset, dsm, showDsm);
  useRasterLayer(viewer, Cesium, ready, tileset, vegetationMask, showVegetationMask);
  useRasterLayer(viewer, Cesium, ready, tileset, bandGreen, showBandGreen);
  useRasterLayer(viewer, Cesium, ready, tileset, bandRed, showBandRed);
  useRasterLayer(viewer, Cesium, ready, tileset, bandRedEdge, showBandRedEdge);
  useRasterLayer(viewer, Cesium, ready, tileset, bandNir, showBandNir);
  useRasterLayer(viewer, Cesium, ready, tileset, falseColor, showFalseColor);
  useRasterLayer(viewer, Cesium, ready, tileset, alignmentCheck, showAlignmentCheck);
  return null;
}
