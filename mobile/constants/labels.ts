/**
 * Farmer-friendly wording for backend enumerations. Technical names stay
 * available for the "Advanced details" sections.
 */
import type { StatusTier } from "./theme";

// Mirrors _classify_zone_type in backend/app/services/analysis_service.py.
export const DETECTION_TYPE_LABEL: Record<string, string> = {
  bare_soil: "Bare patch",
  low_crop_density: "Low crop density",
  patchy_vegetation: "Patchy vegetation",
  weed_candidate: "Possible weeds (between rows)",
};

/** Plain-language explanation shown under a zone title (design: `z.plain`). */
export const DETECTION_TYPE_DESCRIPTION: Record<string, string> = {
  bare_soil: "Almost no crop was measured here compared with the rest of the field.",
  low_crop_density: "Plants here are thinner than in the rest of the field, so the ground shows through.",
  patchy_vegetation: "The crop here is uneven — some spots are thinner than their surroundings.",
  weed_candidate: "Plants are growing between the crop rows here. Walk to it to see what they are — the species is not identified from the image.",
};

export function detectionTypeLabel(type: string): string {
  if (DETECTION_TYPE_LABEL[type]) return DETECTION_TYPE_LABEL[type];
  // Trained-detector zones are typed "<model name>:<label>" by the backend.
  const colon = type.indexOf(":");
  if (colon > 0) {
    const label = type.slice(colon + 1).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    return `${label} (model ${type.slice(0, colon)})`;
  }
  return type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const SEVERITY_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

export function priorityLabel(severity: string): string {
  return `${SEVERITY_LABEL[severity] ?? severity} priority`;
}

/**
 * Colour for a zone's priority (design: high → bad, medium → warn, low →
 * accent). Distinct from the field-health tiers.
 */
export function severityTier(severity: string): StatusTier {
  if (severity === "high") return "problem";
  if (severity === "medium") return "attention";
  return "info";
}

export const TIER_LABEL: Record<StatusTier, string> = {
  healthy: "Healthy",
  attention: "Needs attention",
  problem: "Problem",
  info: "Info",
  neutral: "Unknown",
};

// Mirrors METHOD_LABEL / METHOD_DESCRIPTION in frontend/lib/frames.ts.
export const METHOD_LABEL: Record<string, string> = {
  ndvi_map: "NDVI map (multispectral, 5 m cells)",
  exg_map: "Excess Green map (RGB, 5 m cells)",
  ndvi: "NDVI per frame (multispectral)",
  exg: "Excess Green per frame (RGB)",
};

export const METHOD_DESCRIPTION: Record<string, string> = {
  ndvi_map: "Vegetation cover measured on the georeferenced NDVI mosaic in 5 m cells — true area shares.",
  exg_map:
    "Vegetation cover measured on the georeferenced RGB photo map in 5 m cells (Excess Green Index) — true area shares.",
  ndvi: "Vegetation cover measured per photo from the NIR/Red bands; overlapping photos are not deduplicated.",
  exg: "Vegetation cover measured per photo with the RGB Excess Green Index; overlapping photos are not deduplicated.",
};

/** Plain-language version for the default (non-advanced) view. */
export const METHOD_PLAIN: Record<string, string> = {
  ndvi_map: "Measured from the multispectral crop-health map of this survey.",
  exg_map: "Measured from the colour photo map of this survey (how green each 5 m patch is).",
  ndvi: "Measured photo by photo from the multispectral bands.",
  exg: "Measured photo by photo from how green the crop looks.",
};

export const SURVEY_STATUS_LABEL: Record<string, string> = {
  PENDING: "Waiting for images",
  UPLOADING: "Uploading",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  GENERATING_ORTHOMOSAIC: "Building field map",
  GENERATING_ANALYSIS: "Analysing",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

export function surveyStatusLabel(status: string): string {
  return SURVEY_STATUS_LABEL[status] ?? status.charAt(0) + status.slice(1).toLowerCase();
}

/** Design: completed → ok, failed → bad, anything in flight → accent. */
export function surveyStatusTier(status: string): StatusTier {
  if (status === "COMPLETED") return "healthy";
  if (status === "FAILED") return "problem";
  if (status === "PENDING") return "neutral";
  return "info";
}

export const BAND_LABEL: Record<string, string> = {
  RGB: "RGB",
  GREEN: "Green",
  RED: "Red",
  RED_EDGE: "Red Edge",
  NIR: "NIR",
  THERMAL: "Thermal",
};

export const ASSET_TYPE_LABEL: Record<string, string> = {
  orthomosaic: "Stitched field map",
  ndvi: "Vegetation index (NDVI)",
  ndre: "Leaf nitrogen index (NDRE)",
  gndvi: "GNDVI map",
  thermal: "Thermal map",
  dsm: "Elevation (DSM)",
  model3d: "3D model",
  tileset: "3D tiles",
  pointcloud: "Point cloud",
  pointcloud_laz: "Point cloud (LAZ)",
  geojson: "Imported boundaries",
  boundary: "Field boundary",
};

export function assetTypeLabel(type: string): string {
  return ASSET_TYPE_LABEL[type] ?? type;
}

/** Suggested questions shown in the AI chat (design). Answered from measured data only. */
export const SUGGESTED_QUESTIONS = [
  "How is my field doing?",
  "Where should I inspect today?",
  "Show problem areas",
  "What changed since my last survey?",
] as const;

/** Human-friendly copy for the most common failure modes (design: error state). */
export const ERROR_COPY = {
  offline: {
    title: "Unable to reach AgroTwin",
    message:
      "We couldn't reach AgroTwin. Check that the server is running on your computer and that this phone is on the same Wi-Fi network — you can change the server address in Settings.",
  },
  timeout: {
    title: "AgroTwin is taking too long",
    message: "The server did not answer in time. It may be busy processing a survey — try again in a moment.",
  },
  notConfigured: {
    title: "Server address not set",
    message: "Open Settings and enter the address of your AgroTwin computer (for example http://192.168.1.50:8000).",
  },
  notFound: {
    title: "Not found",
    message: "This item no longer exists on the server. It may have been deleted from the web app.",
  },
  generic: {
    title: "Something went wrong",
    message: "AgroTwin could not complete this request. Please try again.",
  },
} as const;
