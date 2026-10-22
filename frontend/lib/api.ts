import type {
  AccountDeleted,
  Agreement,
  AnalysisResult,
  AskResponse,
  BoundaryFileInfo,
  BoundaryFileResult,
  DetectorStatus,
  FieldBoundaryResponse,
  FieldOut,
  FieldSoil,
  FieldSummary,
  FlightCheck,
  GcpCheck,
  GcpFileInfo,
  GroundControlPoint,
  ProcessingJob,
  QueueOverview,
  SatelliteTimeline,
  SprayWeather,
  Survey,
  SurveyAsset,
  SurveyAvailability,
  SurveyImage,
  User,
  UserRole,
} from "@/lib/types";

// a wrong password at sign-in is a 401 too, but means "try again", not "signed out"
const NO_SIGN_IN_REDIRECT = ["/api/auth/login"];

/** Signed out (or the session ran out): back to the sign-in page, then here. */
function toSignIn(path: string) {
  if (typeof window === "undefined" || NO_SIGN_IN_REDIRECT.includes(path)) return;
  if (window.location.pathname === "/login") return;
  const next = window.location.pathname + window.location.search;
  // a full load on purpose: nothing cached for the old session survives
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

/** The backend's answer to a farmer who has not accepted the data agreement (auth.CONSENT_REQUIRED). */
const CONSENT_REQUIRED = "Accept the data agreement";

/** The data agreement changed (or was never accepted): read and accept it, then back here. */
function toAgreement() {
  if (typeof window === "undefined" || window.location.pathname === "/agreement") return;
  const next = window.location.pathname + window.location.search;
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/agreement?next=${encodeURIComponent(next)}`);
}

/** An error answer from the backend, with its HTTP status (a network failure is a plain Error). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// next.config.ts rewrites /api/* to the FastAPI backend, so plain relative
// paths work from both the browser and (during SSR) the Next.js server.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (res.status === 401) toSignIn(path);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      // response body wasn't JSON
    }
    if (res.status === 403 && detail.startsWith(CONSENT_REQUIRED)) toAgreement();
    throw new ApiError(detail || `Request failed (${res.status})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Files per request when uploading a flight: keeps each request well under
 * proxy/body limits and lets progress advance batch by batch. */
export const UPLOAD_BATCH_SIZE = 20;

/** A job is still being worked on by the backend (poll it). */
export function isJobActive(job: ProcessingJob | null | undefined): boolean {
  return !!job && !["COMPLETED", "FAILED", "PENDING", "UPLOADING"].includes(job.status);
}

export const api = {
  // --- sign-in and accounts ---
  /** `remember` false: the session cookie ends when the browser closes (a shared computer). */
  login: (email: string, password: string, remember = true) =>
    postJson<{ user: User; token: string }>("/api/auth/login", { email, password, remember }),
  logout: () => postJson<{ signed_out: boolean }>("/api/auth/logout", {}),
  me: () => request<User>("/api/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    postJson<{ changed: boolean }>("/api/auth/password", {
      current_password: currentPassword,
      new_password: newPassword,
    }),
  /** The data agreement in force and whether this user accepted it; null when there is none. */
  getAgreement: () => request<Agreement | null>("/api/auth/agreement"),
  acceptAgreement: (version: string) => postJson<User>("/api/auth/agreement", { version }),
  /** Deletes the signed-in user's account with all their fields, flights and maps. */
  deleteAccount: (password: string, confirm: string) => postJson<AccountDeleted>("/api/auth/delete-account", { password, confirm }),
  /** Admin: deletes an account with all its data; `confirm` is the account's email, typed. */
  deleteUser: (userId: string, confirm: string) => postJson<AccountDeleted>(`/api/users/${userId}/delete`, { confirm }),
  listUsers: () => request<User[]>("/api/users"),
  listFarmers: () => request<User[]>("/api/users/farmers"),
  createUser: (user: { email: string; name?: string; role: UserRole; password: string }) =>
    postJson<User>("/api/users", user),
  updateUser: (userId: string, patch: { name?: string; role?: UserRole; is_active?: boolean; password?: string }) =>
    request<User>(`/api/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),

  listFields: () => request<FieldSummary[]>("/api/fields"),
  getField: (fieldId: string) => request<FieldSummary>(`/api/fields/${fieldId}`),
  createField: (name: string, cropType: string, ownerId?: string) =>
    postJson<FieldOut>("/api/fields", { name, crop_type: cropType, owner_id: ownerId }),
  deleteField: (fieldId: string) => request<{ deleted: string }>(`/api/fields/${fieldId}`, { method: "DELETE" }),
  updateField: (fieldId: string, patch: { name?: string; crop_type?: string; owner_id?: string }) =>
    request<FieldSummary>(`/api/fields/${fieldId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  listFieldSurveys: (fieldId: string) => request<Survey[]>(`/api/fields/${fieldId}/surveys`),
  /** Reads a flight-plan file (KMZ/KML) without attaching it; `fieldId` compares it with that field. */
  checkBoundaryFile: (file: File, fieldId?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (fieldId) form.append("field_id", fieldId);
    return request<BoundaryFileInfo>("/api/fields/boundary-file/check", { method: "POST", body: form });
  },
  /** The field's outline from the flight plan; the field's finished flights are checked again on it. */
  attachBoundaryFile: (fieldId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<BoundaryFileResult>(`/api/fields/${fieldId}/boundary-file`, { method: "POST", body: form });
  },
  /** Back to the outline estimated around the photos. */
  /** The next two days for spraying at the field (a weather guide; the label decides). */
  getSprayWeather: (fieldId: string) => request<SprayWeather>(`/api/fields/${fieldId}/spray-weather`),
  /** The soil under the field (USDA soil survey), and the soil under each spot. */
  getSoil: (fieldId: string) => request<FieldSoil>(`/api/fields/${fieldId}/soil`),
  /** The field's crop greenness on each clear Sentinel-2 pass of the season. */
  getSatellite: (fieldId: string) => request<SatelliteTimeline>(`/api/fields/${fieldId}/satellite`),
  removeBoundaryFile: (fieldId: string) =>
    request<BoundaryFileResult>(`/api/fields/${fieldId}/boundary-file`, { method: "DELETE" }),

  listSurveys: () => request<Survey[]>("/api/surveys"),
  getSurvey: (surveyId: string) => request<Survey>(`/api/surveys/${surveyId}`),
  createSurvey: (fieldId: string, name: string, droneModel?: string) =>
    postJson<Survey>("/api/surveys", { field_id: fieldId, name, drone_model: droneModel }),
  deleteSurvey: (surveyId: string) => request<{ deleted: string }>(`/api/surveys/${surveyId}`, { method: "DELETE" }),

  uploadSurveyImages: (surveyId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("files", file);
    return request<SurveyImage[]>(`/api/surveys/${surveyId}/images`, { method: "POST", body: form });
  },
  listSurveyImages: (surveyId: string) => request<SurveyImage[]>(`/api/surveys/${surveyId}/images`),

  uploadSurveyAsset: (surveyId: string, assetType: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const query = new URLSearchParams({ asset_type: assetType });
    return request<SurveyAsset>(`/api/surveys/${surveyId}/assets?${query}`, { method: "POST", body: form });
  },
  listSurveyAssets: (surveyId: string) => request<SurveyAsset[]>(`/api/surveys/${surveyId}/assets`),
  deleteSurveyAsset: (surveyId: string, assetId: string) =>
    request<{ deleted: string }>(`/api/surveys/${surveyId}/assets/${assetId}`, { method: "DELETE" }),

  // These queue background jobs (HTTP 202) — poll getJob for progress.
  triggerProcessing: (surveyId: string) => postJson<ProcessingJob>(`/api/surveys/${surveyId}/process`, undefined),
  rebuildMosaic: (surveyId: string) => postJson<ProcessingJob>(`/api/surveys/${surveyId}/mosaic`, undefined),
  makeDetailedMap: (surveyId: string) => postJson<ProcessingJob>(`/api/surveys/${surveyId}/detailed`, undefined),
  /** Reads (dryRun) or attaches a GCP file: CSV or OpenDroneMap gcp_list.txt. */
  uploadGcpFile: (surveyId: string, file: File, opts: { rtk: boolean; epsg?: string; dryRun?: boolean }) => {
    const form = new FormData();
    form.append("file", file);
    form.append("rtk", String(opts.rtk));
    if (opts.epsg?.trim()) form.append("epsg", opts.epsg.trim());
    form.append("dry_run", String(!!opts.dryRun));
    return request<GcpFileInfo>(`/api/surveys/${surveyId}/gcp-file`, { method: "POST", body: form });
  },
  checkGcpFile: (file: File, opts: { epsg?: string; fieldId?: string }) => {
    const form = new FormData();
    form.append("file", file);
    if (opts.epsg?.trim()) form.append("epsg", opts.epsg.trim());
    if (opts.fieldId) form.append("field_id", opts.fieldId);
    return request<GcpFileInfo>("/api/surveys/gcp-file/check", { method: "POST", body: form });
  },
  deleteGcpFile: (surveyId: string) =>
    request<{ deleted: boolean; queued: boolean }>(`/api/surveys/${surveyId}/gcp-file`, { method: "DELETE" }),
  getGcpCheck: (surveyId: string) => request<GcpCheck>(`/api/surveys/${surveyId}/gcp-check`),
  getFlightCheck: (surveyId: string) => request<FlightCheck>(`/api/surveys/${surveyId}/flight-check`),

  /** Staff: every processing job running or waiting, recent ones, the queue settings. */
  getQueue: () => request<QueueOverview>("/api/queue"),
  /** Staff: take a job out of the queue before it starts. */
  cancelQueuedJob: (jobId: string) => request<ProcessingJob>(`/api/queue/${jobId}/cancel`, { method: "POST" }),
  recomputeAnalysis: (surveyId: string) => postJson<ProcessingJob>(`/api/analysis/${surveyId}/recompute`, undefined),
  getJob: (surveyId: string) => request<ProcessingJob | null>(`/api/surveys/${surveyId}/job`),

  getSurveyAvailability: (surveyId: string) =>
    request<SurveyAvailability>(`/api/surveys/${surveyId}/availability`),
  getFieldBoundary: (surveyId: string) =>
    request<FieldBoundaryResponse>(`/api/surveys/${surveyId}/field-boundary`),
  listGcps: (surveyId: string) => request<GroundControlPoint[]>(`/api/surveys/${surveyId}/gcps`),

  getAnalysis: (surveyId: string) => request<AnalysisResult>(`/api/analysis/${surveyId}`),
  askAssistant: (surveyId: string, question: string) =>
    postJson<AskResponse>(`/api/analysis/${surveyId}/ask`, { question }),
  getDetectors: () => request<DetectorStatus>("/api/analysis/detectors"),
  getKnowledgeTopics: () => request<{ topics: { title: string; sections: string[] }[] }>("/api/analysis/knowledge"),

  imageThumbnailUrl: (surveyId: string, imageId: string) =>
    `/api/surveys/${surveyId}/images/${imageId}/thumbnail`,
  imageFileUrl: (surveyId: string, imageId: string) => `/api/surveys/${surveyId}/images/${imageId}/file`,
  imageDisplayUrl: (surveyId: string, imageId: string) =>
    `/api/surveys/${surveyId}/images/${imageId}/display`,
  frameIndexUrl: (surveyId: string, frameKey: string, index: string) =>
    `/api/surveys/${surveyId}/frames/${encodeURIComponent(frameKey)}/index/${index}`,
  assetPreviewUrl: (surveyId: string, assetId: string) => `/api/surveys/${surveyId}/assets/${assetId}/preview`,
};
