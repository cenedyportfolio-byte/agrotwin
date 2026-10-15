import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeError } from "@/services/errors";
import { gcpService } from "@/services/gcp";
import type { LocalFile } from "@/services/surveys";
import type { GcpFileInfo } from "@/types";
import { queryKeys } from "../queryKeys";

/** The flight's GCP file and how the map compares with it. */
export function useGcpCheck(surveyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.gcpCheck(surveyId ?? ""),
    queryFn: () => gcpService.check(surveyId as string),
    enabled: !!surveyId,
  });
}

/**
 * Reads the chosen file whenever it or the EPSG code changes (after a pause in
 * typing). Each answer is kept with the file and code it was for, so a stale
 * one never shows and "checking" simply means "no answer yet for these".
 * Same as the website's useGcpFileCheck.
 */
export function useGcpFileCheck(
  file: LocalFile | null,
  epsg: string,
  read: (file: LocalFile, epsg: string) => Promise<GcpFileInfo>
): { info: GcpFileInfo | null; error: string | null; checking: boolean } {
  const key = file ? `${file.uri}|${file.name}|${epsg.trim()}` : null;
  const [answer, setAnswer] = useState<{ key: string; info: GcpFileInfo | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!file || !key) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      read(file, epsg)
        .then((info) => alive && setAnswer({ key, info, error: null }))
        .catch((err) => alive && setAnswer({ key, info: null, error: describeError(err).message }));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // `read` is recreated by callers each render; the file and the code decide
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return { info: null, error: null, checking: false };
  const current = answer?.key === key ? answer : null;
  return { info: current?.info ?? null, error: current?.error ?? null, checking: current === null };
}

function useRefreshGcp(surveyId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.gcpCheck(surveyId) });
    qc.invalidateQueries({ queryKey: queryKeys.job(surveyId) });
  };
}

export function useAttachGcpFile(surveyId: string) {
  const refresh = useRefreshGcp(surveyId);
  return useMutation({
    mutationFn: (v: { file: LocalFile; rtk: boolean; epsg: string }) => gcpService.uploadFile(surveyId, v.file, { rtk: v.rtk, epsg: v.epsg }),
    onSuccess: refresh,
  });
}

export function useDeleteGcpFile(surveyId: string) {
  const refresh = useRefreshGcp(surveyId);
  return useMutation({ mutationFn: () => gcpService.deleteFile(surveyId), onSuccess: refresh });
}
