import type { BoundaryFileResult, FieldCreate, FieldOut, FieldSoil, FieldSummary, SatelliteTimeline, SprayWeather, Survey } from "@/types";
import { del, getJson, postJson, uploadMultipart } from "./apiClient";
import type { LocalFile } from "./surveys";

/** GET/POST /api/fields — the same endpoints the web app uses (backend/app/routers/fields.py). */
export const fieldsService = {
  list: () => getJson<FieldSummary[]>("/api/fields"),
  get: (fieldId: string) => getJson<FieldSummary>(`/api/fields/${encodeURIComponent(fieldId)}`),
  listSurveys: (fieldId: string) => getJson<Survey[]>(`/api/fields/${encodeURIComponent(fieldId)}/surveys`),
  create: (payload: FieldCreate) => postJson<FieldOut>("/api/fields", payload),
  remove: (fieldId: string) => del<{ deleted: string }>(`/api/fields/${encodeURIComponent(fieldId)}`),

  /** The flight plan's drawn area (DJI Pilot 2 mission KMZ, or a KML/KMZ outline) becomes the field outline.
   * Sent with XMLHttpRequest: React Native's fetch fails on Android for a multipart body holding a picked file. */
  attachFlightPlan: (fieldId: string, file: LocalFile) => {
    const form = new FormData();
    form.append("file", { uri: file.uri, name: file.name, type: file.type ?? "application/octet-stream" } as unknown as Blob);
    return uploadMultipart<BoundaryFileResult>(`/api/fields/${encodeURIComponent(fieldId)}/boundary-file`, form, { timeoutMs: 60_000 });
  },
  /** The next two days for spraying at the field (a weather guide; the label decides). */
  sprayWeather: (fieldId: string) => getJson<SprayWeather>(`/api/fields/${encodeURIComponent(fieldId)}/spray-weather`),
  /** The soil under the field (USDA soil survey), and the soil under each spot. */
  soil: (fieldId: string) => getJson<FieldSoil>(`/api/fields/${encodeURIComponent(fieldId)}/soil`),
  /** The field's crop greenness on each clear Sentinel-2 pass of the season. */
  satellite: (fieldId: string) => getJson<SatelliteTimeline>(`/api/fields/${encodeURIComponent(fieldId)}/satellite`),
  /** Back to the outline estimated around the photo positions. */
  removeFlightPlan: (fieldId: string) => del<BoundaryFileResult>(`/api/fields/${encodeURIComponent(fieldId)}/boundary-file`),
};
