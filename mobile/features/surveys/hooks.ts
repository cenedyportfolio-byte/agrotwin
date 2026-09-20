import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { assetsService } from "@/services/assets";
import { surveysService } from "@/services/surveys";
import type { SurveyAsset, SurveyCreate } from "@/types";
import { queryKeys } from "../queryKeys";

export function useSurveys() {
  return useQuery({
    queryKey: queryKeys.surveys,
    queryFn: surveysService.list,
    select: (surveys) =>
      [...surveys].sort((a, b) => (b.survey_date ?? b.created_at).localeCompare(a.survey_date ?? a.created_at)),
  });
}

export function useSurvey(surveyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.survey(surveyId ?? ""),
    queryFn: () => surveysService.get(surveyId as string),
    enabled: !!surveyId,
  });
}

/**
 * Every registered frame of the survey. One request, cached for the session;
 * the gallery and map page through it client-side and only ever fetch the
 * thumbnails that are on screen.
 */
export function useSurveyImages(surveyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.surveyImages(surveyId ?? ""),
    queryFn: () => surveysService.listImages(surveyId as string),
    enabled: !!surveyId,
    staleTime: 5 * 60_000,
  });
}

export function useSurveyAssets(surveyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.surveyAssets(surveyId ?? ""),
    queryFn: () => assetsService.list(surveyId as string),
    enabled: !!surveyId,
  });
}

export function useSurveyAvailability(surveyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.surveyAvailability(surveyId ?? ""),
    queryFn: () => surveysService.availability(surveyId as string),
    enabled: !!surveyId,
  });
}

export function useFieldBoundary(surveyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.surveyBoundary(surveyId ?? ""),
    queryFn: () => surveysService.fieldBoundary(surveyId as string),
    enabled: !!surveyId,
  });
}


export function useCreateSurvey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SurveyCreate) => surveysService.create(payload),
    onSuccess: (survey) => {
      qc.invalidateQueries({ queryKey: queryKeys.surveys });
      qc.invalidateQueries({ queryKey: queryKeys.fieldSurveys(survey.field_id) });
      qc.invalidateQueries({ queryKey: queryKeys.fields });
    },
  });
}

export function useDeleteSurvey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (surveyId: string) => surveysService.remove(surveyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.surveys });
      qc.invalidateQueries({ queryKey: queryKeys.fields });
    },
  });
}
