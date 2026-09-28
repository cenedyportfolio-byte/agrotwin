import type { SurveyAsset } from "@/lib/types";
import { wsenFromPolygon } from "@/lib/geo";
import type { RasterAsset } from "@/components/cesium/SurveyImageryLayer";
import type { VectorOverlay } from "@/components/cesium/VectorLayer";

export type MeshKind = "reality" | "imported" | "terrain";

export interface ViewerAssets {
  orthomosaic: RasterAsset | null;
  ndvi: RasterAsset | null;
  ndre: RasterAsset | null;
  gndvi: RasterAsset | null;
  dsm: RasterAsset | null;
  vegetationMask: RasterAsset | null;
  meshUrl: string | null;
  meshKind: MeshKind;
  pointCloudUrl: string | null;
  vectorOverlays: VectorOverlay[];
}

// True photogrammetry (OpenDroneMap) beats the quick direct-georeferenced
// products, which beat the splat-derived ones, when a survey has several.
// Manual imports rank with photogrammetry: the user chose to bring them in.
const SOURCE_RANK: Record<string, number> = { photogrammetry_odm: 0, manual_import: 0, direct_georeferencing: 1 };
const rank = (a: SurveyAsset) => SOURCE_RANK[a.source] ?? 2;

/** Picks, per layer, which of a survey's assets the viewer should load and
 * turns them into the URL/bounds shape the Cesium layers take. */
export function selectViewerAssets(assets: SurveyAsset[] | undefined, previewUrl: (assetId: string) => string): ViewerAssets {
  const list = assets ?? [];
  const best = (pred: (a: SurveyAsset) => boolean) => list.filter(pred).sort((a, b) => rank(a) - rank(b))[0];
  const raster = (type: string) => best((a) => a.asset_type === type && !!a.format?.match(/tiff?$/));
  // A tile pyramid (build_tiles.py) keeps zooming sharp; the flat preview is the fallback.
  const tilesFor = (type: string) => best((a) => a.asset_type === type && a.format === "xyz")?.public_url ?? null;
  const toRaster = (asset: SurveyAsset | undefined): RasterAsset | null => {
    if (!asset?.bounds_geojson) return null;
    const bounds = wsenFromPolygon(JSON.parse(asset.bounds_geojson));
    if (!bounds) return null;
    return { previewUrl: previewUrl(asset.id), bounds, tilesUrl: tilesFor(asset.asset_type) };
  };

  // 3D Tilesets: generated under frontend/public/models/<survey>/ (import_odm.py,
  // build_dense.py) or served from a manual import folder by the API.
  const mesh = best((a) => (a.asset_type === "model3d" || a.asset_type === "tileset") && !!a.public_url);
  const meshKind: MeshKind =
    mesh?.source === "photogrammetry_odm" ? "reality" : mesh?.source === "manual_import" ? "imported" : "terrain";
  const pointCloud = best((a) => (a.asset_type === "pointcloud" || a.asset_type === "pointcloud_laz") && !!a.public_url);

  return {
    orthomosaic: toRaster(raster("orthomosaic")),
    ndvi: toRaster(raster("ndvi")),
    ndre: toRaster(raster("ndre")),
    gndvi: toRaster(raster("gndvi")),
    dsm: toRaster(raster("dsm")),
    vegetationMask: toRaster(raster("vegetation_mask")),
    meshUrl: mesh?.public_url ?? null,
    meshKind,
    pointCloudUrl: pointCloud?.public_url ?? null,
    vectorOverlays: list
      .filter((a) => a.asset_type === "geojson" && !!a.public_url)
      .map((a) => ({ id: a.id, url: a.public_url as string })),
  };
}
