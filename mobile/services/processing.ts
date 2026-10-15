import type { ProcessingJob } from "@/types";
import { getJson, postJson } from "./apiClient";

const base = (surveyId: string) => `/api/surveys/${encodeURIComponent(surveyId)}`;

/** A job the backend worker is still working on (poll it). Mirrors frontend/lib/api.ts. */
export function isJobActive(job: ProcessingJob | null | undefined): boolean {
  return !!job && !["COMPLETED", "FAILED", "PENDING", "UPLOADING"].includes(job.status);
}

/** Processing jobs run on the backend's in-process worker; these calls only enqueue and poll. */
export const processingService = {
  latestJob: (surveyId: string) => getJson<ProcessingJob | null>(`${base(surveyId)}/job`),

  /** Full pipeline: field boundary, quick mosaic + tiles, analysis. 202 + job. */
  triggerProcessing: (surveyId: string) => postJson<ProcessingJob>(`${base(surveyId)}/process`),

  /** The detailed map (OpenDroneMap, hours) — again after a failure. It also starts by itself after the quick map. */
  makeDetailedMap: (surveyId: string) => postJson<ProcessingJob>(`${base(surveyId)}/detailed`),

  /** Staff only: rebuild the direct-georeferencing mosaics and re-analyse. */
  rebuildMosaic: (surveyId: string) => postJson<ProcessingJob>(`${base(surveyId)}/mosaic`),

  /** Staff only: fresh vegetation analysis from the survey's own imagery. */
  recomputeAnalysis: (surveyId: string) => postJson<ProcessingJob>(`/api/analysis/${encodeURIComponent(surveyId)}/recompute`),
};

export type JobKind = "full" | "detailed" | "gcp" | "mosaic" | "analysis";

/** Which kind of job this is, from its steps (backend processing_service *_STEPS). */
export function jobKind(job: ProcessingJob): JobKind {
  const first = job.steps[0]?.key;
  if (first === "odm_prepare") return "detailed";
  if (first === "gcp_align") return "gcp";
  if (job.steps.length > 2) return "full";
  return job.steps.length === 2 ? "mosaic" : "analysis";
}
