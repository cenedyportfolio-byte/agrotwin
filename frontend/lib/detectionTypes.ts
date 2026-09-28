// Mirrors _classify_zone_type / SAFE_ACTIONS in backend/app/services/analysis_service.py.
// Zones from trained detectors are typed "<model name>:<label>" and fall through to the raw label.
export const DETECTION_TYPE_LABEL: Record<string, string> = {
  bare_soil: "Bare Soil",
  low_crop_density: "Low Crop Density",
  patchy_vegetation: "Patchy Vegetation",
  weed_candidate: "Weed Candidate (between rows)",
};

export function detectionTypeLabel(type: string): string {
  if (DETECTION_TYPE_LABEL[type]) return DETECTION_TYPE_LABEL[type];
  const i = type.indexOf(":");
  if (i > 0) return `${type.slice(i + 1).replace(/_/g, " ")} (model: ${type.slice(0, i)})`;
  return type;
}
