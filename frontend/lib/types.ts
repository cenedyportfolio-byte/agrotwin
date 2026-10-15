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
  /** Where the outline comes from: null, estimated around the photos; "flight_plan", the area drawn for the flight. */
  boundary_source: "flight_plan" | null;
  /** The flight-plan file's name. */
  boundary_file: string | null;
  created_at: string;
}

/** What was read from a flight-plan file (POST /api/fields/boundary-file/check). */
export interface BoundaryFileInfo {
  filename: string | null;
  kind: string;
  area_hectares: number;
  notes: string[];
}

/** A field outline set from (or taken back from) a flight-plan file. */
export interface BoundaryFileResult {
  field: FieldSummary;
  kind: string | null;
  notes: string[];
  /** Flights whose crop health is being checked again on the new outline. */
  rechecking: number;
}

export type UserRole = "admin" | "operator" | "farmer";

/** A login. admin: everything incl. accounts; operator: every farm; farmer: their own fields. */
export interface User {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  /** The data agreement accepted (a hash of its text) and when. */
  consent_version?: string | null;
  consent_at?: string | null;
  /** A farmer who must accept the current data agreement before anything else. */
  consent_required?: boolean;
}

/** The data agreement in force (GET /api/auth/agreement; null when there is none). */
export interface Agreement {
  version: string;
  title: string;
  text: string;
  /** By the signed-in user, this version. */
  accepted: boolean;
  accepted_at: string | null;
}

/** What deleting an account removed. */
export interface AccountDeleted {
  deleted: boolean;
  fields: number;
  flights: number;
}

export interface FieldSummary extends FieldOut {
  /** The farmer whose field this is (null: not given to anyone yet — staff only). */
  owner_id: string | null;
  owner_name: string | null;
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

/** A ground control target (black/white checkerboard) found in the survey's photogrammetric
 * orthophoto: a GCP (40–60 cm, "GCP N") or a small marker (~17 cm, "M1", "M2", …). */
export interface GroundControlPoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Surface height at the target, in the photogrammetry's own vertical datum. */
  height_m: number | null;
  source: string;
  score: number | null;
  /** Side length of the checkerboard, in metres (null on rows detected before sizes were stored). */
  size_m: number | null;
  /** source "surveyed" (the farmer's GCP file): measured with RTK — such points move the detailed map. */
  rtk?: boolean | null;
}

/** What was read from a GCP file (POST /api/surveys/{id}/gcp-file). */
export interface GcpFileInfo {
  format: "csv-latlon" | "csv-projected" | "odm";
  crs: string;
  rtk: boolean;
  notes: string[];
  odm_observations: number;
  queued?: boolean;
  filename?: string;
  points: { name: string; lat: number; lon: number; elevation_m: number | null }[];
}

/** One line of the flight check: what was measured from the photos and, when it should change, what to do next time. */
export interface FlightCheckItem {
  key: "height" | "detail" | "angle" | "front_overlap" | "side_overlap" | "coverage" | "sun" | "gps" | "bands" | "days";
  label: string;
  status: "ok" | "warn" | "info";
  value: string;
  target: string | null;
  message: string | null;
}

/** How the flight was flown, from its photos' own data (GET /api/surveys/{id}/flight-check). Advice only. */
export interface FlightCheck {
  status: "good" | "check" | "unknown";
  summary: string;
  frames: number;
  items: FlightCheckItem[];
}

/** How the detailed map compares with the surveyed points (gcp_correction_service). */
export interface GcpCheck {
  file: GcpFileInfo | null;
  report: {
    rtk: boolean;
    status: "none" | "waiting" | "no_match" | "check_only" | "applied" | "aligned" | "rejected";
    message: string;
    model: { shift_m: number; rotation_deg: number; scale: number; rms_m: number; points_used: number } | null;
    points: {
      name: string;
      lat: number;
      lon: number;
      used: boolean;
      matched: string | null;
      before_m: number | null;
      after_m: number | null;
    }[];
  } | null;
}

/** The ~17 cm markers (M1, M2, …), as opposed to the 40–60 cm GCPs. */
export function isMarker(g: GroundControlPoint): boolean {
  return g.size_m != null && g.size_m < 0.3;
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
  /** Progress within a long step ("matching the photos (stage 4 of 13)"). */
  note?: string;
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
  /** The technical reason (staff only). */
  error_detail?: string | null;
  created_at: string | null;
  updated_at: string | null;
  queued_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  /** Where it is in line, while it waits (GET /api/surveys/{id}/job only). */
  queue?: JobQueuePlace | null;
}

/** Where a waiting job is in line (backend queue_service.position). */
export interface JobQueuePlace {
  /** Jobs running or waiting before it. */
  ahead: number;
  /** Estimated from recent jobs; null without history. */
  wait_minutes: number | null;
  /** "8 pm–6 am": the hours detailed maps start in. */
  hours: string | null;
  /** "8 pm": waiting for those hours. */
  starts_at: string | null;
}

/** A job in the staff queue view (GET /api/queue). */
export interface QueueJob {
  id: string;
  survey_id: string;
  survey_name: string | null;
  field_id: string | null;
  field_name: string | null;
  owner: string | null;
  queue: "quick" | "detailed";
  kind: string;
  status: JobStatus | string;
  step: string | null;
  note: string | null;
  photos: number;
  /** 1 = next to start on its queue. */
  place: number | null;
  wait_minutes: number | null;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

export interface QueueOverview {
  /** Running, then waiting in the order they will run. */
  jobs: QueueJob[];
  /** Finished in the last few days, newest first. */
  recent: QueueJob[];
  settings: {
    detailed_enabled: boolean;
    detailed_workers: number;
    detailed_hours: string | null;
    detailed_hours_setting: string | null;
    detailed_open_now: boolean;
  };
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
