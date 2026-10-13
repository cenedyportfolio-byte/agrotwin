import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Image } from "expo-image";
import { Bot, Camera, Cuboid } from "lucide-react-native";
import { iconStroke, layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useRefresh } from "@/hooks/useRefresh";
import { useField, useFieldSurveys } from "@/features/fields/hooks";
import { useSurveyAssets } from "@/features/surveys/hooks";
import { useAnalysis } from "@/features/analysis/hooks";
import { useProcessingJob } from "@/features/processing/hooks";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";
import { assetsService } from "@/services/assets";
import { cropLabel, formatDate, formatHectares, formatNumber, relativeDay } from "@/utils/format";
import { sharesFromPercents } from "@/utils/health";
import { Blueprint, Button, ErrorState, KeyValueRow, ListGroup, ListRow, LoadingState, Screen, ScreenHeader, SectionHeader, AppText } from "@/components/ui";
import { FieldHealthSummary } from "@/components/fields/FieldHealthSummary";
import { ProcessingProgress } from "@/components/processing/ProcessingProgress";
import { AskAiFab } from "@/components/ai/AskAiFab";
import { authHeaders } from "@/services/apiClient";

export default function FieldDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const advanced = useSettingsStore((s) => s.advancedMode);
  const setActiveSurvey = useUiStore((s) => s.setActiveSurvey);
  const setActiveField = useUiStore((s) => s.setActiveField);

  const field = useField(id);
  const surveys = useFieldSurveys(id);
  const latest = surveys.data?.[0] ?? null;
  const analysis = useAnalysis(latest?.id);
  const assets = useSurveyAssets(latest?.id);
  const { job, active: processing } = useProcessingJob(latest?.id);
  const { refreshing, onRefresh } = useRefresh(field.refetch, surveys.refetch, analysis.refetch);

  useEffect(() => {
    setActiveField(id ?? null);
    if (latest) setActiveSurvey(latest.id);
  }, [id, latest, setActiveField, setActiveSurvey]);

  // The stitched field map preview (a backend-rendered PNG) when one exists.
  const previewUrl = useMemo(() => {
    const tif = (assets.data ?? []).find((a) => a.asset_type === "orthomosaic" && !!a.format && /tiff?$/i.test(a.format));
    return tif ? assetsService.previewUrl(tif.survey_id, tif.id) : null;
  }, [assets.data]);

  if (field.isPending) {
    return (
      <Screen safeTop>
        <LoadingState skeleton />
      </Screen>
    );
  }
  if (field.isError || !field.data) {
    return (
      <Screen safeTop refreshing={refreshing} onRefresh={onRefresh}>
        <ErrorState error={field.error} title="Unable to load field" onRetry={() => field.refetch()} />
      </Screen>
    );
  }

  const f = field.data;
  const shares = sharesFromPercents(f.healthy_area_percent, f.attention_area_percent, f.problem_area_percent);
  const meta = `${cropLabel(f.crop_type)} · ${f.area_hectares != null ? formatHectares(f.area_hectares) : "size not measured"}`;
  const go = (pathname: "/map/[surveyId]" | "/analysis/[surveyId]" | "/twin/[surveyId]" | "/gallery/[surveyId]") => latest && router.push({ pathname, params: { surveyId: latest.id } });
  const procLabel = latest ? (analysis.data ? "Analysis complete" : processing ? "Processing" : latest.status === "FAILED" ? "Failed" : "Not analysed") : "—";
  const procColor = analysis.data ? colors.healthy : processing ? colors.accent : latest?.status === "FAILED" ? colors.problem : colors.muted;

  return (
    <Screen safeTop padded={false} refreshing={refreshing} onRefresh={onRefresh} bottomInset={layout.bottomClearance}>
      <ScreenHeader title={f.name} subtitle={meta} />
      <View style={styles.body}>
        <View style={[styles.imagery, { borderColor: colors.divider }]}>
          {previewUrl ? (
            <Image source={{ uri: previewUrl, headers: authHeaders() }} style={styles.fill} contentFit="cover" cachePolicy="memory-disk" accessibilityLabel="Stitched field map" />
          ) : (
            <View style={[styles.fill, styles.center]}>
              <AppText variant="tagUpper" tone="faint" style={{ letterSpacing: 1.5 }}>
                {latest ? (processing ? "Field map is being built" : "No field map yet") : "No survey yet"}
              </AppText>
            </View>
          )}
          <Button label="Open map" variant="secondary" minHeight={40} onPress={() => go("/map/[surveyId]")} disabled={!latest} style={[styles.openMap, { backgroundColor: colors.bg }]} />
        </View>

        <View style={{ marginBottom: 18 }}>
          <FieldHealthSummary shares={shares} method={f.analysis_method} isMock={f.analysis_is_mock} advanced={advanced} processing={processing} />
        </View>

        {processing && job && latest ? (
          <View style={{ marginBottom: 18 }}>
            <ProcessingProgress job={job} compact surveyName={latest.name} imageCount={latest.image_count} />
          </View>
        ) : null}

        <SectionHeader title="Latest survey" />
        <Blueprint style={{ marginBottom: 18 }}>
          {surveys.isPending ? (
            <LoadingState message="Loading surveys…" />
          ) : latest ? (
            <>
              <KeyValueRow label="Date" value={formatDate(latest.survey_date ?? latest.created_at)} />
              <KeyValueRow label="Drone images" value={formatNumber(latest.frame_count || latest.image_count)} />
              <KeyValueRow label="Status" value={procLabel} valueColor={procColor} last />
            </>
          ) : (
            <AppText variant="bodySm" tone="muted">
              No surveys of this field yet.
            </AppText>
          )}
        </Blueprint>

        <View style={styles.actions}>
          <Button label="View field map" size="lg" onPress={() => go("/map/[surveyId]")} disabled={!latest} fullWidth />
          <Button label="View analysis" variant="secondary" size="lg" onPress={() => go("/analysis/[surveyId]")} disabled={!latest || !analysis.data} fullWidth />
        </View>

        <SectionHeader title="More for this field" />
        <ListGroup>
          <ListRow icon={<Cuboid size={20} color={colors.accent} strokeWidth={iconStroke} />} label="Digital twin" note="3D model of this field" onPress={latest ? () => go("/twin/[surveyId]") : undefined} disabled={!latest} />
          <ListRow icon={<Bot size={20} color={colors.accent} strokeWidth={iconStroke} />} label="Ask AgroTwin AI" note="Questions about this field" onPress={() => router.push(latest ? { pathname: "/ai/chat", params: { surveyId: latest.id } } : "/ai/chat")} />
          <ListRow
            icon={<Camera size={20} color={colors.accent} strokeWidth={iconStroke} />}
            label="Survey images"
            note={latest ? `${formatNumber(latest.frame_count || latest.image_count)} drone photos` : "No survey yet"}
            onPress={latest ? () => go("/gallery/[surveyId]") : undefined}
            disabled={!latest}
            last={(surveys.data?.length ?? 0) <= 1}
          />
          {(surveys.data?.length ?? 0) > 1 ? (
            <ListRow
              icon={<Camera size={20} color={colors.accent} strokeWidth={iconStroke} />}
              label="Survey history"
              note={`${surveys.data?.length} surveys · latest ${relativeDay(latest?.survey_date ?? latest?.created_at)}`}
              onPress={() => router.push("/(tabs)/surveys")}
              last
            />
          ) : null}
        </ListGroup>
      </View>
      <AskAiFab surveyId={latest?.id} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.pagePadding },
  imagery: { height: 132, borderWidth: 1, marginBottom: 18, overflow: "hidden" },
  fill: { width: "100%", height: "100%" },
  center: { alignItems: "center", justifyContent: "center" },
  openMap: { position: "absolute", right: 10, bottom: 10 },
  actions: { gap: 10, marginBottom: 18 },
});
