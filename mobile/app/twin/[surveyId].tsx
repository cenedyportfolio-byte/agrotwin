import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, Crosshair, Info, Layers, Map as MapIcon } from "lucide-react-native";
import { iconStroke, immersive, layout } from "@/constants/theme";
import { useSurvey, useSurveyAvailability } from "@/features/surveys/hooks";
import { useAnalysis } from "@/features/analysis/hooks";
import { useProcessingJob } from "@/features/processing/hooks";
import { useSplatAvailability } from "@/features/digitalTwin/hooks";
import { useUiStore } from "@/stores/uiStore";
import { detectionTypeLabel, priorityLabel } from "@/constants/labels";
import { Button, ErrorState, IconButton, LoadingState, Screen, AppText } from "@/components/ui";
import { DigitalTwinWebView, type DigitalTwinHandle } from "@/components/digitalTwin/DigitalTwinWebView";
import { TwinModeCard } from "@/components/digitalTwin/TwinStatusCard";
import type { SplatStatus, TwinMode } from "@/components/digitalTwin/digitalTwinBridge";

const NEXT_MODE: Record<TwinMode, TwinMode> = { "field-map": "3d-twin", "3d-twin": "photorealistic", photorealistic: "field-map" };

export default function DigitalTwinScreen() {
  const { surveyId, mode: modeParam, zone: zoneParam } = useLocalSearchParams<{ surveyId: string; mode?: string; zone?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const setActiveSurvey = useUiStore((s) => s.setActiveSurvey);
  const twinRef = useRef<DigitalTwinHandle>(null);

  const initialMode: TwinMode = modeParam === "3d-twin" || modeParam === "photorealistic" ? modeParam : "field-map";
  const [mode, setMode] = useState<TwinMode>(initialMode);
  const [ready, setReady] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(zoneParam ?? null);
  const [splat, setSplat] = useState<{ status: SplatStatus; detail?: string } | null>(null);
  const [layerError, setLayerError] = useState<string | null>(null);

  const survey = useSurvey(surveyId);
  const analysis = useAnalysis(surveyId);
  const availability = useSurveyAvailability(surveyId);
  const splatAvail = useSplatAvailability(surveyId);
  const { active: processing } = useProcessingJob(surveyId);

  useEffect(() => {
    if (surveyId) setActiveSurvey(surveyId);
  }, [surveyId, setActiveSurvey]);

  const changeMode = useCallback((next: TwinMode) => {
    setMode(next);
    setLayerError(null);
    twinRef.current?.send({ type: "SET_MODE", mode: next });
  }, []);

  if (survey.isPending) {
    return (
      <Screen scroll={false} safeTop>
        <LoadingState message="Opening digital twin…" />
      </Screen>
    );
  }
  if (survey.isError || !survey.data) {
    return (
      <Screen scroll={false} safeTop>
        <ErrorState error={survey.error} title="Digital twin unavailable" onRetry={() => survey.refetch()} />
      </Screen>
    );
  }

  const selectedZone = analysis.data?.detections.find((d) => d.id === selectedZoneId) ?? null;
  const hasMesh = !!availability.data?.model_3d || !!availability.data?.dsm || !!availability.data?.pointcloud;
  const tools: Array<{ label: string; icon: typeof Layers; onPress: () => void; selected?: boolean }> = [
    { label: "Layers", icon: Layers, onPress: () => surveyId && router.push({ pathname: "/map/[surveyId]", params: { surveyId } }) },
    { label: `Switch to ${NEXT_MODE[mode] === "field-map" ? "field map" : NEXT_MODE[mode] === "3d-twin" ? "3D twin" : "photorealistic"}`, icon: MapIcon, onPress: () => changeMode(NEXT_MODE[mode]) },
    { label: "Focus field", icon: Crosshair, onPress: () => twinRef.current?.reload() },
    { label: advanced ? "Hide technical layers" : "Show technical layers", icon: Info, onPress: () => setAdvanced((v) => !v), selected: advanced },
  ];

  return (
    <View style={styles.root}>
      <DigitalTwinWebView
        ref={twinRef}
        fieldId={survey.data.field_id}
        surveyId={survey.data.id}
        mode={initialMode}
        focusZoneId={zoneParam ?? null}
        onReady={() => setReady(true)}
        onZoneSelected={setSelectedZoneId}
        onModeChanged={setMode}
        onSplatStatus={(status, detail) => setSplat({ status, detail })}
        onLayerError={setLayerError}
      />

      <View style={[styles.topBar, { top: insets.top + 10 }]} pointerEvents="box-none">
        <IconButton tone="dark" size={46} icon={<ArrowLeft size={20} color={immersive.text} strokeWidth={1.6} />} accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))} />
        {/* Sized to its own text and non-interactive, so it never blankets and blocks
            taps meant for the embedded site underneath — see map/[surveyId].tsx. */}
        <View style={styles.titlePill} pointerEvents="none">
          <AppText variant="heading" tone="inverse" style={{ fontSize: 18, lineHeight: 20 }} numberOfLines={1}>
            {survey.data.name}
          </AppText>
          <AppText variant="label" tone="inverseMuted" numberOfLines={1}>
            Digital twin · {ready ? "ready" : "loading"}
          </AppText>
        </View>
      </View>

      <View style={[styles.tools, { top: insets.top + 76 }]} pointerEvents="box-none">
        {tools.map((t) => (
          <IconButton
            key={t.label}
            tone="dark"
            size={layout.toolSm}
            selected={t.selected}
            icon={<t.icon size={20} color={immersive.text} strokeWidth={iconStroke} />}
            accessibilityLabel={t.label}
            onPress={() => {
              if (t.label.startsWith("Show") || t.label.startsWith("Hide")) twinRef.current?.send({ type: "SET_ADVANCED", advanced: !advanced });
              t.onPress();
            }}
            disabled={!ready && t.label !== "Layers"}
          />
        ))}
      </View>

      <View style={[styles.bottom, { bottom: insets.bottom + 22 }]} pointerEvents="box-none">
        {selectedZone ? (
          <View style={styles.zoneCard}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="bodyStrong" tone="inverse">
                {detectionTypeLabel(selectedZone.type)}
              </AppText>
              <AppText variant="small" tone="inverseMuted" numberOfLines={2}>
                {priorityLabel(selectedZone.severity)} · {selectedZone.recommended_action}
              </AppText>
            </View>
            <Button label="Details" variant="secondary" minHeight={40} onPress={() => surveyId && router.push({ pathname: "/analysis/[surveyId]", params: { surveyId } })} style={{ borderColor: immersive.border }} />
          </View>
        ) : null}
        <TwinModeCard
          mode={mode}
          ready={ready}
          splat={splat}
          splatAvailable={splatAvail.data === "available"}
          hasMesh={hasMesh}
          processing={processing}
          layerError={layerError}
          onOpenPhotorealistic={() => changeMode("photorealistic")}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: immersive.bg },
  topBar: { position: "absolute", left: 14, right: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  titlePill: { alignSelf: "flex-start", maxWidth: "70%", minWidth: 0, backgroundColor: immersive.panel, borderWidth: 1, borderColor: immersive.border, paddingHorizontal: 12, paddingVertical: 8 },
  tools: { position: "absolute", right: 14, gap: 10 },
  bottom: { position: "absolute", left: 14, right: 14, gap: 10 },
  zoneCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: immersive.panelStrong, borderWidth: 1, borderColor: immersive.border, padding: 12 },
});
