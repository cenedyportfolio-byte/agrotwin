"use client";

import { useEffect } from "react";

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
  showOrthomosaic: boolean;
  showNdvi: boolean;
  showNdre: boolean;
  showGndvi: boolean;
  showDsm: boolean;
  showVegetationMask?: boolean;
}

async function providerFor(Cesium: any, asset: RasterAsset): Promise<any> {
  const [west, south, east, north] = asset.bounds;
  if (asset.tilesUrl) {
    const res = await fetch(`${asset.tilesUrl}/tilemeta.json`);
    if (res.ok) {
      const meta: TileMeta = await res.json();
      // Google-Maps-style pyramid: only the 256px tiles the view needs, native
      // resolution at the deepest level, so zooming into a crop row stays sharp.
      return new Cesium.UrlTemplateImageryProvider({
        url: `${asset.tilesUrl}/{z}/{x}/{y}.${meta.format}`,
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        rectangle: Cesium.Rectangle.fromDegrees(...meta.bounds),
        minimumLevel: meta.minzoom,
        maximumLevel: meta.maxzoom,
        hasAlphaChannel: true,
        tileWidth: 256,
        tileHeight: 256,
      });
    }
  }
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = asset.previewUrl;
  });
  return new Cesium.SingleTileImageryProvider({
    url: asset.previewUrl,
    tileWidth: img.naturalWidth,
    tileHeight: img.naturalHeight,
    rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
  });
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

    providerFor(Cesium, asset)
      .then((provider) => {
        if (cancelled || viewer.isDestroyed?.() || (tileset && tileset.isDestroyed?.())) return;
        layer = new Cesium.ImageryLayer(provider);
        collection.add(layer);
      })
      .catch((e) => console.error("raster layer", e));

    return () => {
      cancelled = true;
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
  showOrthomosaic,
  showNdvi,
  showNdre,
  showGndvi,
  showDsm,
  showVegetationMask = false,
}: SurveyImageryLayerProps) {
  useRasterLayer(viewer, Cesium, ready, tileset, orthomosaic, showOrthomosaic);
  useRasterLayer(viewer, Cesium, ready, tileset, ndvi, showNdvi);
  useRasterLayer(viewer, Cesium, ready, tileset, ndre, showNdre);
  useRasterLayer(viewer, Cesium, ready, tileset, gndvi, showGndvi);
  useRasterLayer(viewer, Cesium, ready, tileset, dsm, showDsm);
  useRasterLayer(viewer, Cesium, ready, tileset, vegetationMask, showVegetationMask);
  return null;
}
