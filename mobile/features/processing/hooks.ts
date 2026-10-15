import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jobPollIntervalMs } from "@/constants/config";
import { isJobActive, jobKind, processingService } from "@/services/processing";
import type { ProcessingJob } from "@/types";
import { queryKeys } from "../queryKeys";

/**
 * The survey's latest processing job, polled while the backend works on it.
 * When a job finishes, everything derived from the survey is refetched once —
 * the same behaviour as the web app's useProcessingJob.
 */
export function useProcessingJob(surveyId: string | null | undefined) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.job(surveyId ?? ""),
    queryFn: () => processingService.latestJob(surveyId as string),
    enabled: !!surveyId,
    refetchInterval: (q) => (isJobActive(q.state.data) ? jobPollIntervalMs : false),
  });

  const active = isJobActive(query.data);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active && surveyId) {
      for (const key of [
        queryKeys.survey(surveyId),
        queryKeys.surveyImages(surveyId),
        queryKeys.surveyAssets(surveyId),
        queryKeys.surveyAvailability(surveyId),
        queryKeys.surveyBoundary(surveyId),
        queryKeys.analysis(surveyId),
        queryKeys.gcpCheck(surveyId),
        queryKeys.fields,
        queryKeys.surveys,
      ]) {
        qc.invalidateQueries({ queryKey: key });
      }
      qc.invalidateQueries({ queryKey: ["field"] });
      qc.invalidateQueries({ queryKey: ["field-surveys"] });
    }
    wasActive.current = active;
  }, [active, surveyId, qc]);

  return { ...query, job: query.data ?? null, active };
}

function useJobMutation(surveyId: string, fn: (id: string) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fn(surveyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.job(surveyId) });
      qc.invalidateQueries({ queryKey: queryKeys.survey(surveyId) });
      qc.invalidateQueries({ queryKey: queryKeys.surveys });
    },
  });
}

export function useTriggerProcessing(surveyId: string) {
  return useJobMutation(surveyId, processingService.triggerProcessing);
}

export function useRebuildMosaic(surveyId: string) {
  return useJobMutation(surveyId, processingService.rebuildMosaic);
}

export function useRecomputeAnalysis(surveyId: string) {
  return useJobMutation(surveyId, processingService.recomputeAnalysis);
}

export function useMakeDetailedMap(surveyId: string) {
  return useJobMutation(surveyId, processingService.makeDetailedMap);
}

/** "Try again" for a failed job: the whole map, or the detailed map. A lining-up
 * job is redone by adding the points again; rebuilds are staff tools. */
export function useRetryJob(surveyId: string, job: ProcessingJob | null) {
  const process = useTriggerProcessing(surveyId);
  const detailed = useMakeDetailedMap(surveyId);
  const kind = job ? jobKind(job) : null;
  return kind === "full" ? process : kind === "detailed" ? detailed : null;
}
