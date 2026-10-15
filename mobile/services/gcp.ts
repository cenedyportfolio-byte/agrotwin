import type { GcpCheck, GcpFileInfo } from "@/types";
import { del, getJson, uploadMultipart } from "./apiClient";
import type { LocalFile } from "./surveys";

const base = (surveyId: string) => `/api/surveys/${encodeURIComponent(surveyId)}`;

function fileForm(file: LocalFile, epsg?: string): FormData {
  const form = new FormData();
  // React Native's FormData accepts {uri, name, type} objects as file parts.
  form.append("file", { uri: file.uri, name: file.name, type: file.type ?? "text/plain" } as unknown as Blob);
  if (epsg?.trim()) form.append("epsg", epsg.trim());
  return form;
}

/** A flight's ground control points file (CSV or OpenDroneMap gcp_list.txt) —
 * see backend gcp_file_service. Mirrors frontend/lib/api.ts. Sent with
 * XMLHttpRequest like the photos: React Native's fetch fails on Android with
 * "Network request failed" for a multipart body holding a picked file. */
export const gcpService = {
  /** Reads a file before the flight exists (the upload screen); `fieldId` compares it with that field. */
  checkFile: (file: LocalFile, opts: { epsg?: string; fieldId?: string | null }) => {
    const form = fileForm(file, opts.epsg);
    if (opts.fieldId) form.append("field_id", opts.fieldId);
    return uploadMultipart<GcpFileInfo>("/api/surveys/gcp-file/check", form, { timeoutMs: 30_000 });
  },

  /** Reads (`dryRun`) or attaches the file. RTK points line the detailed map up; handheld ones are compared. */
  uploadFile: (surveyId: string, file: LocalFile, opts: { rtk: boolean; epsg?: string; dryRun?: boolean }) => {
    const form = fileForm(file, opts.epsg);
    form.append("rtk", String(opts.rtk));
    form.append("dry_run", String(!!opts.dryRun));
    return uploadMultipart<GcpFileInfo>(`${base(surveyId)}/gcp-file`, form, { timeoutMs: 60_000 });
  },

  /** Forgets the points; a map lined up with them goes back to how it was made. */
  deleteFile: (surveyId: string) => del<{ deleted: boolean; queued: boolean }>(`${base(surveyId)}/gcp-file`),

  check: (surveyId: string) => getJson<GcpCheck>(`${base(surveyId)}/gcp-check`),
};
