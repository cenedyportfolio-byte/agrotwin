import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { useTheme } from "@/hooks/useTheme";
import { useField } from "@/features/fields/hooks";
import { useFieldBoundary, useSurvey, useSurveyAssets, useSurveyAvailability, useSurveyImages } from "@/features/surveys/hooks";
import { useAnalysis } from "@/features/analysis/hooks";
import { enrichZones } from "@/features/analysis/zones";
import { useMapLayerStore, type MapLayerKey } from "@/stores/mapLayerStore";
import { useUiStore } from "@/stores/uiStore";
import { ErrorState, IconButton, LoadingState, Screen, Swatch, AppText } from "@/components/ui";
import { LayerSheet, MapControls, ZoneSheet, selectRasterSources } from "@/components/map";
import { DigitalTwinWebView, type DigitalTwinHandle } from "@/components/digitalTwin/DigitalTwinWebView";
import { TwinModeSelector } from "@/components/digitalTwin/TwinModeSelector";
import type { TwinLayer, TwinMode } from "@/components/digitalTwin/digitalTwinBridge";

const LEGEND = [
  { tier: "healthy", label: "Healthy" },
  { tier: "attention", label: "Needs attention" },
  { tier: "problem", label: "Problem" },
] as const;

/** The Layers sheet's keys → the web viewer's layer keys (SET_LAYER). */
const WEB_LAYER: Record<MapLayerKey, TwinLayer> = {
  field: "fieldBoundary",
  zones: "problemZones",
  orthomosaic: "orthomosaic",
  imagePoints: "rgbPoints",
  cropDensity: "cropDensity",
  vectorOverlays: "vectorOverlays",
  ndvi: "ndvi",
  ndre: "ndre",
  gndvi: "gndvi",
  dsm: "dsm",
};

/**
 * Field Map. The map is the website's Cesium Field Map (satellite imagery,
 * boundary, photo map tiles, zones) shown in a WebView in embedded mode, which
 * hides the site's own chrome; this screen draws the phone chrome — back, title,
 * tool stack, legend, Layers sheet, zone sheet — over it and talks to the page
 * through the bridge. No native map SDK and no map API key are involved.
 */
export default function FieldMapScreen() {
  const { surveyId, zone: zoneParam, image: imageParam } = useLocalSearchParams<{ surveyId: string; zone?: string; image?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const setActiveSurvey = useUiStore((s) => s.setActiveSurvey);
  const layers = useMapLayerStore((s) => s.layers);
  const setLayer = useMapLayerStore((s) => s.setLayer);

  const webRef = useRef<DigitalTwinHandle>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(zoneParam ?? null);
  const [webReady, setWebReady] = useState(false);
  const [mode, setMode] = useState<TwinMode>("field-map");
  const [splatStatus, setSplatStatus] = useState<string | null>(null);

  const changeMode = useCallback((nextMode: TwinMode) => {
    setMode(nextMode);
    webRef.current?.send({ type: "SET_MODE", mode: nextMode });
  }, []);

  const survey = useSurvey(surveyId);
  const field = useField(survey.data?.field_id);
  const boundary = useFieldBoundary(surveyId);
  const analysis = useAnalysis(surveyId);
  const images = useSurveyImages(surveyId);
  const assets = useSurveyAssets(surveyId);
  const availability = useSurveyAvailability(surveyId);

  useEffect(() => {
    if (surveyId) setActiveSurvey(surveyId);
  }, [surveyId, setActiveSurvey]);

  const zones = useMemo(() => analysis.data?.detections ?? [], [analysis.data]);
  const zoneViews = useMemo(
    () =>
      enrichZones(zones, {
        center: boundary.data?.center_lat != null && boundary.data.center_lon != null ? { latitude: boundary.data.center_lat, longitude: boundary.data.center_lon } : null,
        boundary: boundary.data?.boundary ?? null,
      }),
    [zones, boundary.data]
  );
  const selected = zoneViews.find((v) => v.zone.id === selectedId) ?? null;
  const rasters = useMemo(() => selectRasterSources(assets.data), [assets.data]);

  // Mirror the Layers sheet into the page whenever it is ready or a toggle changes.
  useEffect(() => {
    if (!webReady) return;
    for (const key of Object.keys(WEB_LAYER) as MapLayerKey[]) {
      webRef.current?.send({ type: "SET_LAYER", layer: WEB_LAYER[key], visible: layers[key] });
    }
  }, [webReady, layers]);

  // "View on map" from the gallery: show the photo locations and look down at that photo.
  useEffect(() => {
    if (!webReady || !imageParam) return;
    const img = images.data?.find((i) => i.id === imageParam);
    if (img?.lat == null || img.lon == null) return;
    setLayer("imagePoints", true);
    webRef.current?.send({ type: "FOCUS_POINT", lat: img.lat, lon: img.lon });
  }, [webReady, imageParam, images.data, setLayer]);

  const loading = survey.isPending || boundary.isPending || analysis.isPending || assets.isPending;
  const fatal = survey.isError ? survey.error : boundary.isError ? boundary.error : null;
  const onCount = Object.values(layers).filter(Boolean).length;
  const bottomEdge = insets.bottom + 26;

  if (loading) {
    return (
      <Screen scroll={false} safeTop>
        <LoadingState message="Loading field map…" />
      </Screen>
    );
  }
  if (fatal || !survey.data) {
    return (
      <Screen scroll={false} safeTop>
        <ErrorState error={fatal ?? new Error("Survey not found")} title="Unable to load map" onRetry={() => (survey.isError ? survey.refetch() : boundary.refetch())} />
      </Screen>
    );
  }

  const imageList = images.data ?? [];
  const hasBoundary = !!boundary.data?.boundary;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <DigitalTwinWebView
        ref={webRef}
        fieldId={survey.data.field_id}
        surveyId={survey.data.id}
        mode={mode}
        focusZoneId={zoneParam ?? null}
        onReady={() => setWebReady(true)}
        onZoneSelected={setSelectedId}
        onModeChanged={setMode}
        onSplatStatus={(status) => setSplatStatus(status)}
        frameColor={colors.bg}
      />

      {/* top bar */}
      <View style={[styles.topBar, { top: insets.top + 10 }]} pointerEvents="box-none">
        <IconButton tone="raised" size={46} icon={<ArrowLeft size={20} color={colors.text} strokeWidth={1.6} />} accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))} />
        {/* Sized to its text and non-interactive, so it never sits on top of (and swallows taps for) the page beneath. */}
        <View style={[styles.titlePill, { backgroundColor: colors.bg, borderColor: colors.divider }, colors.shadowMd]} pointerEvents="none">
          <AppText variant="heading" style={{ fontSize: 18, lineHeight: 20 }} numberOfLines={1}>
            {field.data?.name ?? survey.data.name}
          </AppText>
          <AppText variant="label" tone="muted" numberOfLines={1}>
            {webReady ? `${onCount} layers on · tap a zone for details` : "Loading map…"}
          </AppText>
        </View>
      </View>

      {/* 3-mode selector: Map | 3D | Realistic */}
      <View style={[styles.modeBar, { top: insets.top + 70 }]} pointerEvents="box-none">
        <TwinModeSelector mode={mode} onSelectMode={changeMode} />
      </View>

      {mode === "photorealistic" && splatStatus === "missing" ? (
        <View style={[styles.noticePill, { top: insets.top + 114, backgroundColor: colors.bg, borderColor: colors.attention }, colors.shadowMd]} pointerEvents="none">
          <AppText variant="small" tone="attention">
            No 3D Gaussian splat built yet for this survey
          </AppText>
        </View>
      ) : null}

      <MapControls
        bottom={bottomEdge}
        layersOpen={layersOpen}
        onLayers={() => setLayersOpen(true)}
        onCentre={() => webRef.current?.send({ type: "RESET_VIEW" })}
        onTwin={() => surveyId && router.push({ pathname: "/twin/[surveyId]", params: selectedId ? { surveyId, zone: selectedId } : { surveyId } })}
        onAi={() => router.push(surveyId ? { pathname: "/ai/chat", params: { surveyId } } : "/ai/chat")}
      />

      {/* legend */}
      <View style={[styles.legend, { bottom: bottomEdge, backgroundColor: colors.bg, borderColor: colors.divider }, colors.shadowMd]} accessibilityLabel="Legend" pointerEvents="none">
        <AppText variant="kickerSm" tone="muted" style={{ marginBottom: 6 }}>
          Legend
        </AppText>
        {LEGEND.map((l) => (
          <View key={l.tier} style={styles.legendRow}>
            <Swatch color={colors[l.tier]} size={10} />
            <AppText variant="small">{l.label}</AppText>
          </View>
        ))}
        {analysis.isError ? (
          <AppText variant="small" tone="problem" style={{ marginTop: 4 }}>
            Zones unavailable
          </AppText>
        ) : null}
      </View>

      <LayerSheet
        visible={layersOpen}
        onClose={() => setLayersOpen(false)}
        rasters={rasters}
        hasZones={zones.length > 0}
        hasImages={imageList.some((i) => i.lat != null)}
        hasBoundary={hasBoundary}
        hasVectorOverlays={!!availability.data?.vector_overlays}
      />
      <ZoneSheet
        zone={selected?.zone ?? null}
        areaM2={selected?.areaM2 ?? null}
        fieldHectares={boundary.data?.area_hectares ?? field.data?.area_hectares ?? null}
        locationLabel={selected?.locationLabel ?? null}
        onClose={() => setSelectedId(null)}
        onViewDetails={() => surveyId && router.push({ pathname: "/analysis/[surveyId]", params: { surveyId } })}
        onOpenTwin={() => surveyId && selected && router.push({ pathname: "/twin/[surveyId]", params: { surveyId, zone: selected.zone.id } })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { position: "absolute", left: 14, right: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  titlePill: { alignSelf: "flex-start", maxWidth: "70%", minWidth: 0, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  modeBar: { position: "absolute", left: 14, zIndex: 10 },
  noticePill: { position: "absolute", left: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 300, zIndex: 10 },
  legend: { position: "absolute", left: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, maxWidth: 200 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 3 },
});
