/**
 * TypeScript mirrors of the FastAPI response contracts in
 * backend/app/schemas.py. Field names are identical to the backend — the
 * mobile app consumes the exact same JSON the Next.js web app does.
 *
 * The web app keeps an equivalent copy in frontend/lib/types.ts; when the
 * backend schema changes, update both.
 */
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

/** GET /api/fields and GET /api/fields/{id} — a field plus its latest analysed numbers. */
/** A login (backend/app/schemas.py UserOut). farmer: their own fields; operator, admin: every farm. */
export interface User {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "operator" | "farmer";
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
  latest_survey_id: string | null;
  latest_survey_status: string | null;
  healthy_area_percent: number | null;
  attention_area_percent: number | null;
  problem_area_percent: number | null;
  analysis_method: AnalysisMethod | null;
  analysis_is_mock: boolean | null;
  /** "Putnam County, TN" (US only; from the county boundaries kept on the server). */
  county?: string | null;
}

/** A field outline set from (or taken back from) a flight-plan file (POST/DELETE /api/fields/{id}/boundary-file). */
export interface BoundaryFileResult {
  field: FieldSummary;
  kind: string | null;
  notes: string[];
  /** Flights whose crop health is being checked again on the new outline. */
  rechecking: number;
}

export type SurveyStatus =
  | "PENDING"
  | "UPLOADING"
  | "QUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | (string & {});

export interface Survey {
  id: string;
  field_id: string;
  name: string;
  survey_date: string | null;
  drone_model: string | null;
  image_count: number;
  /** Shutter releases — a multispectral frame is several band files. */
  frame_count: number;
  status: SurveyStatus;
  created_at: string;
}

export type Band = "RGB" | "GREEN" | "RED" | "RED_EDGE" | "NIR" | "THERMAL" | (string & {});

export interface SurveyImage {
  id: string;
  survey_id: string;
  filename: string;
  band: Band;
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

export type AssetType =
  | "orthomosaic"
  | "ndvi"
  | "ndre"
  | "gndvi"
  | "thermal"
  | "dsm"
  | "model3d"
  | "tileset"
  | "pointcloud"
  | "pointcloud_laz"
  | "geojson"
  | "boundary"
  | (string & {});

export interface SurveyAsset {
  id: string;
  survey_id: string;
  asset_type: AssetType;
  /** tif | xyz (tile pyramid) | 3dtiles | geojson | las | laz | … */
  format: string | null;
  bounds_geojson: string | null;
  /** direct_georeferencing | photogrammetry_odm | manual_import */
  source: string;
  /**
   * Where a browser loads this asset from. Paths under /tiles, /models,
   * /splats are static files served by the Next.js web app; /api/... paths
   * are served by FastAPI. null when only the backend reads the file.
   */
  public_url: string | null;
  created_at: string;
}

/** GET /api/surveys/{id}/availability */
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

export type DetectionSeverity = "low" | "medium" | "high" | (string & {});

export interface DetectionZone {
  id: string;
  /** bare_soil | low_crop_density | patchy_vegetation (see analysis_service) */
  type: string;
  severity: DetectionSeverity;
  confidence: number;
  geometry: Geometry;
  recommended_action: string;
}

/** GET /api/analysis/{surveyId} */
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
}

export interface ProcessingStep {
  key: string;
  label: string;
  status: "pending" | "complete" | "failed";
  /** Progress inside a long step ("matching the photos, stage 4 of 13"). */
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
  | "FAILED"
  | (string & {});

/** GET /api/surveys/{id}/job */
export interface ProcessingJob {
  id: string;
  survey_id: string;
  status: JobStatus;
  current_step: string | null;
  steps: ProcessingStep[];
  error_message: string | null;
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

/** One line of the flight check: what was measured from the photos and, when it should change, what to do next time. */
export interface FlightCheckItem {
  key: "height" | "detail" | "angle" | "front_overlap" | "side_overlap" | "coverage" | "sun" | "weather" | "gps" | "bands" | "days";
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
  /** The flight's weather is being looked up: ask again shortly. */
  pending?: boolean;
}

/** One forecast hour for spraying (GET /api/fields/{id}/spray-weather). */
export interface SprayHour {
  /** Local time at the field, "2026-10-15T07:00". */
  time: string;
  status: "good" | "marginal" | "bad" | "night";
  reason: string;
  wind_mph: number | null;
  gust_mph: number | null;
  temp_f: number | null;
  rain_in: number | null;
  rain_chance: number | null;
}

export interface SprayWindow {
  start: string;
  end: string;
  hours: number;
}

/** The next two days for spraying: a weather guide, the label decides. */
export interface SprayWeather {
  available: boolean;
  reason?: string;
  source?: string;
  timezone?: string | null;
  hours?: SprayHour[];
  windows?: SprayWindow[];
  next_window?: SprayWindow | null;
  limits?: { wind_min_mph: number; wind_max_mph: number; gust_max_mph: number; max_temp_f: number; rain_free_hours: number };
}

/** A soil map unit inside the field (USDA soil survey). */
export interface SoilUnit {
  mukey: string;
  symbol: string | null;
  name: string;
  acres: number;
  share: number;
  drainage: string | null;
  hydrologic_group: string | null;
  slope_pct: number | null;
  flooding: string | null;
  water_table_cm: number | null;
  soil: string | null;
  texture: string | null;
  organic_matter_pct: number | null;
  ph: number | null;
  sand_pct: number | null;
  silt_pct: number | null;
  clay_pct: number | null;
}

/** A spot of the latest flight and the soil it mostly lies on. */
export interface SoilSpot {
  zone_id: string;
  type: string;
  severity: string;
  acres: number;
  mukey: string;
  symbol: string | null;
  soil: string | null;
  drainage: string | null;
  share: number;
}

/** GET /api/fields/{id}/soil. */
export interface FieldSoil {
  status: "ok" | "none" | "fetching" | "unavailable" | "no_outline" | "off";
  source?: string;
  units?: SoilUnit[];
  geojson?: { type: "FeatureCollection"; features: { type: "Feature"; geometry: Geometry; properties: { mukey: string; symbol: string | null; drainage: string | null } }[] };
  /** The largest spots of the latest flight, with their soil. */
  spots?: SoilSpot[];
  /** Every spot of the latest flight, counted per soil (mukey). */
  spots_by_soil?: Record<string, { count: number; acres: number }>;
}

/** GET /api/fields/{id}/satellite: the field's average NDVI on each clear Sentinel-2 pass. */
export interface SatelliteTimeline {
  status: "ok" | "fetching" | "unavailable" | "no_outline" | "too_small" | "off";
  season: { start: string; end: string };
  points: { date: string; ndvi: number; p10: number | null; p90: number | null; clear: number | null }[];
  passes: number;
  cloudy: number;
  flights: { survey_id: string; name: string; date: string }[];
  progress: { done: number; todo: number } | null;
  checked_at: string | null;
  source: string;
}

/** What was read from a ground control points file (backend gcp_file_service). */
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

export type GcpReportStatus = "none" | "waiting" | "no_match" | "check_only" | "applied" | "aligned" | "rejected";

/** GET /api/surveys/{id}/gcp-check — how the detailed map compares with the surveyed points. */
export interface GcpCheck {
  file: GcpFileInfo | null;
  report: {
    rtk: boolean;
    status: GcpReportStatus;
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

/** GET /api/surveys/{id}/field-boundary */
export interface FieldBoundaryResponse {
  field_id: string;
  boundary: Geometry | null;
  center_lat: number | null;
  center_lon: number | null;
  area_hectares: number | null;
}

/** A knowledge-base passage the assistant drew on (backend rag_service). */
export interface KnowledgeSource {
  title: string;
  section: string;
  snippet: string;
  score: number;
}

/** POST /api/analysis/{surveyId}/ask */
export interface AskResponse {
  question: string;
  answer: string;
  /** "template" or "ollama:<model>" — which responder actually produced the answer. */
  responder: string;
  /** Knowledge-base passages that matched the question, shown as citations. */
  sources?: KnowledgeSource[];
  context_used: Record<string, unknown>;
}

export interface FieldCreate {
  name: string;
  crop_type: string;
  farm_id?: string;
}

export interface SurveyCreate {
  field_id: string;
  name: string;
  drone_model?: string;
}

/** GET /api/health */
export interface HealthResponse {
  status: string;
  service: string;
}
