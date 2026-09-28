import type { Geometry } from "geojson";

/** ndvi_map / exg_map: 5 m cells measured on a georeferenced mosaic; ndvi / exg: one sample per frame. */
export type AnalysisMethod = "ndvi_map" | "exg_map" | "ndvi" | "exg";

export interface FieldOut {
  id: string;
  farm_id: string;
  name: string;
  crop_type: string;
  boundary_geojson: string | null;
  area_hectares: number | null;
  center_lat: number | null;
  center_lon: number | null;
  created_at: string;
}

export interface FieldSummary extends FieldOut {
  latest_survey_id: string | null;
  latest_survey_status: string | null;
  healthy_area_percent: number | null;
  attention_area_percent: number | null;
  problem_area_percent: number | null;
  analysis_method: AnalysisMethod | null;
  analysis_is_mock: boolean | null;
}

export interface Survey {
  id: string;
  field_id: string;
  name: string;
  survey_date: string | null;
  drone_model: string | null;
  image_count: number;
  frame_count: number;
  status: string;
  created_at: string;
}

export interface SurveyImage {
  id: string;
  survey_id: string;
  filename: string;
  band: string;
  lat: number | null;
  lon: number | null;
  altitude_m: number | null;
  captured_at: string | null;
  width: number | null;
  height: number | null;
  frame_key: string | null;
  vegetation_fraction: number | null;
  ndvi_mean: number | null;
  ndre_mean: number | null;
  gndvi_mean: number | null;
  gimbal_yaw_deg: number | null;
  gimbal_pitch_deg: number | null;
  rel_altitude_m: number | null;
  rtk_fix: string | null;
  rtk_std_m: number | null;
}

export interface SurveyAsset {
  id: string;
  survey_id: string;
  asset_type: string;
  /** tif | xyz (tile pyramid) | 3dtiles | geojson | … */
  format: string | null;
  bounds_geojson: string | null;
  source: string;
  public_url: string | null;
  created_at: string;
}

export interface SurveyAvailability {
  rgb_images: boolean;
  gps_metadata: boolean;
  multispectral: boolean;
  nir: boolean;
  red_edge: boolean;
  thermal: boolean;
  orthomosaic: boolean;
  model_3d: boolean;
  pointcloud: boolean;
  gnss_ppk: boolean;
  dsm: boolean;
  vector_overlays: boolean;
}

export interface DetectionZone {
  id: string;
  type: string;
  severity: string;
  confidence: number;
  geometry: Geometry;
  recommended_action: string;
}

/** Crop-row geometry / canopy closure / weed-candidate status measured on the orthomosaic (backend weed_service). */
export interface RowMetrics {
  method: string;
  status: "measured" | "canopy_closed" | "rows_not_locked" | "rows_not_found" | "no_rgb_orthomosaic" | "error";
  reason: string;
  row_orientation_deg: number | null;
  row_spacing_m: number | null;
  row_signal: number | null;
  lock_fraction: number | null;
  row_cover_percent: number | null;
  midrow_cover_percent: number | null;
  canopy_closure_percent: number | null;
  vegetation_cover_percent: number | null;
  inter_row_vegetation_percent: number | null;
  candidate_count: number;
  candidate_area_m2: number;
}

export interface AnalysisMetrics {
  rows?: RowMetrics;
  detectors?: { installed: string[]; ran: Record<string, number>; note: string };
  vegetation_mask?: { status: string; reason: string };
}

export interface AnalysisResult {
  survey_id: string;
  analysis_summary: {
    healthy_area_percent: number;
    attention_area_percent: number;
    problem_area_percent: number;
  };
  method: AnalysisMethod;
  is_mock: boolean;
  detections: DetectionZone[];
  metrics: AnalysisMetrics;
}

export interface DetectorStatus {
  models_dir: string;
  installed: {
    name: string;
    task: string;
    framework: string;
    labels: string[];
    trained_on: string;
    input_gsd_m: number | null;
    ready: boolean;
    problem: string | null;
  }[];
  note: string;
}

export interface KnowledgeSource {
  title: string;
  section: string;
  snippet: string;
  score: number;
}

/** Zone types produced by trained detectors are "<model name>:<label>". */
export const WEED_CANDIDATE = "weed_candidate";
export function isWeedZone(type: string): boolean {
  return type === WEED_CANDIDATE || type.includes(":");
}

export interface ProcessingStep {
  key: string;
  label: string;
  status: "pending" | "complete" | "failed";
}

export type JobStatus =
  | "PENDING"
  | "QUEUED"
  | "UPLOADING"
  | "PROCESSING"
  | "GENERATING_ORTHOMOSAIC"
  | "GENERATING_ANALYSIS"
  | "COMPLETED"
  | "FAILED";

export interface ProcessingJob {
  id: string;
  survey_id: string;
  status: JobStatus | string;
  current_step: string | null;
  steps: ProcessingStep[];
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface FieldBoundaryResponse {
  field_id: string;
  boundary: Geometry | null;
  center_lat: number | null;
  center_lon: number | null;
  area_hectares: number | null;
}

export interface AskResponse {
  question: string;
  answer: string;
  /** "template" or "ollama:<model>" — which responder actually produced the answer. */
  responder: string;
  /** Knowledge-base passages that matched the question (shown as sources). */
  sources: KnowledgeSource[];
  context_used: Record<string, unknown>;
}
