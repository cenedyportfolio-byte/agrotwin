import type { FieldBoundaryResponse, FlightCheck, Survey, SurveyAvailability, SurveyCreate, SurveyImage } from "@/types";
import { apiUrl, del, getJson, postJson, uploadMultipart, type UploadOptions } from "./apiClient";

const base = (surveyId: string) => `/api/surveys/${encodeURIComponent(surveyId)}`;

export interface LocalFile {
  uri: string;
  name: string;
  /** MIME type; defaults to image/jpeg for images. */
  type?: string;
}

/** /api/surveys — see backend/app/routers/surveys.py. */
export const surveysService = {
  list: () => getJson<Survey[]>("/api/surveys"),
  get: (surveyId: string) => getJson<Survey>(base(surveyId)),
  create: (payload: SurveyCreate) => postJson<Survey>("/api/surveys", payload),
  remove: (surveyId: string) => del<{ deleted: string }>(base(surveyId)),

  /** All registered frames of the survey (the backend has no server-side paging yet; the gallery pages client-side). */
  listImages: (surveyId: string) => getJson<SurveyImage[]>(`${base(surveyId)}/images`),
  availability: (surveyId: string) => getJson<SurveyAvailability>(`${base(surveyId)}/availability`),
  fieldBoundary: (surveyId: string) => getJson<FieldBoundaryResponse>(`${base(surveyId)}/field-boundary`),
  /** How the flight was flown (height, overlap, sun, …) — advice for the next flight. */
  flightCheck: (surveyId: string) => getJson<FlightCheck>(`${base(surveyId)}/flight-check`),

  /** Cached JPEG thumbnail rendered by the backend. */
  thumbnailUrl: (surveyId: string, imageId: string) => apiUrl(`${base(surveyId)}/images/${encodeURIComponent(imageId)}/thumbnail`),
  /** Browser-viewable rendition (JPG passthrough; 16-bit TIFs stretched to PNG). */
  displayUrl: (surveyId: string, imageId: string) => apiUrl(`${base(surveyId)}/images/${encodeURIComponent(imageId)}/display`),
  /** Original bytes (download). */
  fileUrl: (surveyId: string, imageId: string) => apiUrl(`${base(surveyId)}/images/${encodeURIComponent(imageId)}/file`),
  /** Colourised NDVI/NDRE/GNDVI preview for a multispectral frame (404 when the bands are missing). */
  frameIndexUrl: (surveyId: string, frameKey: string, index: "ndvi" | "ndre" | "gndvi") =>
    apiUrl(`${base(surveyId)}/frames/${encodeURIComponent(frameKey)}/index/${index}`),

  /**
   * Uploads a batch of drone images. Already-registered files (same name and
   * size) are skipped server-side, so an interrupted upload can be retried.
   */
  uploadImages: (surveyId: string, files: LocalFile[], options?: UploadOptions) => {
    const form = new FormData();
    for (const f of files) {
      // React Native's FormData accepts {uri, name, type} objects as file parts.
      form.append("files", { uri: f.uri, name: f.name, type: f.type ?? "image/jpeg" } as unknown as Blob);
    }
    return uploadMultipart<SurveyImage[]>(`${base(surveyId)}/images`, form, options);
  },
};
