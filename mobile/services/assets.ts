import type { SurveyAsset } from "@/types";
import { apiUrl, del, getJson, publicAssetUrl, uploadMultipart, type UploadOptions } from "./apiClient";
import type { LocalFile } from "./surveys";

const base = (surveyId: string) => `/api/surveys/${encodeURIComponent(surveyId)}`;

/** Asset types the backend's import_service accepts for manual import. */
export const IMPORTABLE_ASSET_TYPES = [
  { value: "orthomosaic", label: "Orthomosaic (GeoTIFF)", hint: "Georeferenced RGB mosaic" },
  { value: "ndvi", label: "NDVI map (GeoTIFF)", hint: "Georeferenced vegetation index raster" },
  { value: "ndre", label: "NDRE map (GeoTIFF)", hint: "Georeferenced vegetation index raster" },
  { value: "gndvi", label: "GNDVI map (GeoTIFF)", hint: "Georeferenced vegetation index raster" },
  { value: "dsm", label: "Elevation / DSM (GeoTIFF)", hint: "Digital surface model" },
  { value: "geojson", label: "Boundaries or zones (GeoJSON)", hint: "Field boundary or zone polygons" },
  { value: "tileset", label: "3D model (Cesium 3D Tiles .zip)", hint: "Zipped tileset.json + tiles" },
  { value: "pointcloud", label: "Point cloud (LAS/LAZ)", hint: "Georeferenced point cloud" },
] as const;

export type ImportableAssetType = (typeof IMPORTABLE_ASSET_TYPES)[number]["value"];


/** Survey assets — rasters, tile pyramids, 3D products (backend/app/routers/surveys.py). */
export const assetsService = {
  list: (surveyId: string) => getJson<SurveyAsset[]>(`${base(surveyId)}/assets`),
  remove: (surveyId: string, assetId: string) => del<{ deleted: string }>(`${base(surveyId)}/assets/${encodeURIComponent(assetId)}`),

  /** PNG rendition of a GeoTIFF asset over its exact bounds (large — a few MB). */
  previewUrl: (surveyId: string, assetId: string) => apiUrl(`${base(surveyId)}/assets/${encodeURIComponent(assetId)}/preview`),

  /** Absolute URL of an asset's public_url (tile pyramid root, 3D Tiles tileset, GeoJSON…). */
  publicUrl: (asset: SurveyAsset) => (asset.public_url ? publicAssetUrl(asset.public_url) : null),

  /** `{z}/{x}/{y}.<ext>` template for an XYZ tile-pyramid asset built by build_tiles.py. */
  tileTemplate: (asset: SurveyAsset, format = "webp") =>
    asset.public_url ? `${publicAssetUrl(asset.public_url)}/{z}/{x}/{y}.${format}` : null,

  /** Manual import of a processed file; the backend validates georeferencing and rejects with a helpful 422 otherwise. */
  upload: (surveyId: string, assetType: ImportableAssetType, file: LocalFile, options?: UploadOptions) => {
    const form = new FormData();
    form.append("file", { uri: file.uri, name: file.name, type: file.type ?? "application/octet-stream" } as unknown as Blob);
    return uploadMultipart<SurveyAsset>(`${base(surveyId)}/assets`, form, { ...options, query: { asset_type: assetType } });
  },
};
