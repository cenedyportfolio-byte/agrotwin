import type {
  AnalysisResult,
  AskResponse,
  DetectorStatus,
  FieldBoundaryResponse,
  FieldOut,
  FieldSummary,
  ProcessingJob,
  Survey,
  SurveyAsset,
  SurveyAvailability,
  SurveyImage,
} from "@/lib/types";

// next.config.ts rewrites /api/* to the FastAPI backend, so plain relative
// paths work from both the browser and (during SSR) the Next.js server.
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      // response body wasn't JSON
    }
    throw new Error(detail || `Request failed (${res.status})`);
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
  listFields: () => request<FieldSummary[]>("/api/fields"),
  getField: (fieldId: string) => request<FieldSummary>(`/api/fields/${fieldId}`),
  createField: (name: string, cropType: string) =>
    postJson<FieldOut>("/api/fields", { name, crop_type: cropType }),
  deleteField: (fieldId: string) => request<{ deleted: string }>(`/api/fields/${fieldId}`, { method: "DELETE" }),
  updateField: (fieldId: string, patch: { name?: string; crop_type?: string }) =>
    request<FieldSummary>(`/api/fields/${fieldId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  listFieldSurveys: (fieldId: string) => request<Survey[]>(`/api/fields/${fieldId}/surveys`),

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
  recomputeAnalysis: (surveyId: string) => postJson<ProcessingJob>(`/api/analysis/${surveyId}/recompute`, undefined),
  getJob: (surveyId: string) => request<ProcessingJob | null>(`/api/surveys/${surveyId}/job`),

  getSurveyAvailability: (surveyId: string) =>
    request<SurveyAvailability>(`/api/surveys/${surveyId}/availability`),
  getFieldBoundary: (surveyId: string) =>
    request<FieldBoundaryResponse>(`/api/surveys/${surveyId}/field-boundary`),

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
