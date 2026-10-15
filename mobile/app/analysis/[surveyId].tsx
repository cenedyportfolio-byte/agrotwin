import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { layout } from "@/constants/theme";
import { useRefresh } from "@/hooks/useRefresh";
import { useField } from "@/features/fields/hooks";
import { useSurvey } from "@/features/surveys/hooks";
import { useAnalysis } from "@/features/analysis/hooks";
import { enrichZones, mainSpots } from "@/features/analysis/zones";
import { useProcessingJob, useRecomputeAnalysis } from "@/features/processing/hooks";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";
import { useAuth } from "@/providers/AuthProvider";
import { parseGeometry } from "@/utils/geo";
import { formatDate } from "@/utils/format";
import { Blueprint, Button, EmptyState, ErrorState, LoadingState, Screen, ScreenHeader, SectionHeader, AppText } from "@/components/ui";
import { HealthSummary } from "@/components/analysis/HealthSummary";
import { DetectionZoneCard } from "@/components/analysis/DetectionZoneCard";
import { ProcessingProgress } from "@/components/processing/ProcessingProgress";
import { AskAiFab } from "@/components/ai/AskAiFab";

export default function AnalysisScreen() {
  const { surveyId } = useLocalSearchParams<{ surveyId: string }>();
  const router = useRouter();
  const advanced = useSettingsStore((s) => s.advancedMode);
  const setActiveSurvey = useUiStore((s) => s.setActiveSurvey);
  // re-checking crop health is a staff tool (the server refuses it for farmers)
  const { isStaff } = useAuth();
  const [showAll, setShowAll] = useState(false);

  const survey = useSurvey(surveyId);
  const field = useField(survey.data?.field_id);
  const analysis = useAnalysis(surveyId);
  const { job, active: processing } = useProcessingJob(surveyId);
  const recompute = useRecomputeAnalysis(surveyId ?? "");
  const { refreshing, onRefresh } = useRefresh(analysis.refetch, survey.refetch);

  useEffect(() => {
    if (surveyId) setActiveSurvey(surveyId);
  }, [surveyId, setActiveSurvey]);

  const zones = useMemo(() => {
    if (!analysis.data) return [];
    const f = field.data;
    return enrichZones(analysis.data.detections, {
      center: f?.center_lat != null && f.center_lon != null ? { latitude: f.center_lat, longitude: f.center_lon } : null,
      boundary: parseGeometry(f?.boundary_geojson),
    });
  }, [analysis.data, field.data]);
  // ranked: the worst and biggest first; the specks behind "show more"
  const main = useMemo(() => mainSpots(zones), [zones]);
  const shown = showAll ? zones : main;
  const hidden = zones.length - main.length;

  const subtitle = [field.data?.name, survey.data ? formatDate(survey.data.survey_date ?? survey.data.created_at) : null].filter(Boolean).join(" · ");
  const toMap = (zoneId?: string) => surveyId && router.push({ pathname: "/map/[surveyId]", params: zoneId ? { surveyId, zone: zoneId } : { surveyId } });
  const toTwin = (zoneId?: string) => surveyId && router.push({ pathname: "/twin/[surveyId]", params: zoneId ? { surveyId, zone: zoneId } : { surveyId } });

  let body: React.ReactNode;
  if (analysis.isPending || survey.isPending) body = <LoadingState skeleton />;
  else if (analysis.isError) body = <ErrorState error={analysis.error} onRetry={() => analysis.refetch()} />;
  else if (!analysis.data)
    body =
      processing && job ? (
        <ProcessingProgress job={job} surveyName={survey.data?.name} imageCount={survey.data?.image_count} />
      ) : (
        <EmptyState
          title="No results yet"
          message={
            survey.data && survey.data.image_count > 0
              ? isStaff
                ? "This flight has photos but crop health has not been checked."
                : "This flight has photos but no crop-health results yet. Open the flight to make the map."
              : "Upload the drone photos of this flight first."
          }
          actionLabel={isStaff && survey.data && survey.data.image_count > 0 ? "Check crop health" : undefined}
          onAction={isStaff && survey.data && survey.data.image_count > 0 ? () => recompute.mutate() : undefined}
          secondaryLabel="Open the flight"
          onSecondary={() => surveyId && router.push({ pathname: "/survey/[id]", params: { id: surveyId } })}
        />
      );
  else {
    const a = analysis.data;
    body = (
      <>
        <View style={{ marginBottom: 20 }}>
          <HealthSummary analysis={a} areaHectares={field.data?.area_hectares ?? null} advanced={advanced} />
        </View>
        {processing && job ? (
          <View style={{ marginBottom: 20 }}>
            <ProcessingProgress job={job} compact />
          </View>
        ) : null}
        <SectionHeader title="Spots to check" meta={`${main.length} found`} />
        {a.detections.length === 0 ? (
          <Blueprint>
            <AppText variant="bodySm">The crop looked even across the field — no spots were flagged.</AppText>
          </Blueprint>
        ) : (
          <View style={{ gap: 12 }}>
            {shown.length === 0 ? (
              <Blueprint>
                <AppText variant="bodySm">Only very small spots this time.</AppText>
              </Blueprint>
            ) : null}
            {shown.map((v) => (
              <DetectionZoneCard
                key={v.zone.id}
                zone={v.zone}
                areaM2={v.areaM2}
                locationLabel={v.locationLabel}
                method={a.method}
                advanced={advanced}
                onViewOnMap={() => toMap(v.zone.id)}
                onOpenTwin={() => toTwin(v.zone.id)}
              />
            ))}
            {hidden > 0 ? (
              <Button label={showAll ? "Show fewer" : `Show ${hidden} more (smaller spots)`} variant="ghost" size="md" onPress={() => setShowAll((v) => !v)} fullWidth />
            ) : null}
          </View>
        )}
      </>
    );
  }

  return (
    <Screen safeTop padded={false} refreshing={refreshing} onRefresh={onRefresh} bottomInset={layout.bottomClearance}>
      <ScreenHeader title="Crop health" subtitle={subtitle} />
      <View style={styles.body}>{body}</View>
      <AskAiFab surveyId={surveyId} />
    </Screen>
  );
}

const styles = StyleSheet.create({ body: { paddingHorizontal: layout.pagePadding } });
