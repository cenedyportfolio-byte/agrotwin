import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, X } from "lucide-react-native";
import { useTheme } from "@/hooks/useTheme";
import { useField } from "@/features/fields/hooks";
import { useFieldBoundary, useSurvey, useSurveyAssets, useSurveyImages } from "@/features/surveys/hooks";
import { useAnalysis } from "@/features/analysis/hooks";
import { enrichZones } from "@/features/analysis/zones";
import { useMapLayerStore, type MapLayerKey } from "@/stores/mapLayerStore";
import { useUiStore } from "@/stores/uiStore";
import type { DetectionZone } from "@/types";
import { ErrorState, IconButton, LoadingState, Screen, Swatch, AppText } from "@/components/ui";
import { LayerSheet, MapControls, MapViewer, ZoneMarkers, ZoneSheet, selectRasterSources, type MapViewerHandle } from "@/components/map";
import { DigitalTwinWebView, type DigitalTwinHandle } from "@/components/digitalTwin/DigitalTwinWebView";
import type { TwinLayer } from "@/components/digitalTwin/digitalTwinBridge";

const LEGEND = [
  { tier: "healthy", label: "Healthy" },
  { tier: "attention", label: "Needs attention" },
  { tier: "problem", label: "Problem" },
] as const;

/** Native layer toggles → the web viewer's layer keys, so the Layers sheet drives both engines. */
const WEB_LAYER: Record<MapLayerKey, TwinLayer> = {
  field: "fieldBoundary",
  zones: "problemZones",
  orthomosaic: "orthomosaic",
  imagePoints: "rgbPoints",
  ndvi: "ndvi",
  ndre: "ndre",
  gndvi: "gndvi",
  dsm: "dsm",
};

export default function FieldMapScreen() {
  const { surveyId, zone: zoneParam, image: imageParam } = useLocalSearchParams<{ surveyId: string; zone?: string; image?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const setActiveSurvey = useUiStore((s) => s.setActiveSurvey);
  const layers = useMapLayerStore((s) => s.layers);
  const mapEngine = useMapLayerStore((s) => s.mapEngine);
  const setMapEngine = useMapLayerStore((s) => s.setMapEngine);
  // "web": the website's Cesium Field Map in a WebView — no Google Maps key or Play services needed.
  const webMap = mapEngine === "web";

  const mapRef = useRef<MapViewerHandle>(null);
  const webRef = useRef<DigitalTwinHandle>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(zoneParam ?? null);
  const [mapReady, setMapReady] = useState(false);
  const [webReady, setWebReady] = useState(false);
  // True after Google Maps drew nothing and the screen switched itself to the web map.
  const [autoSwitched, setAutoSwitched] = useState(false);

  const survey = useSurvey(surveyId);
  const field = useField(survey.data?.field_id);
  const boundary = useFieldBoundary(surveyId);
  const analysis = useAnalysis(surveyId);
  const images = useSurveyImages(surveyId);
  const assets = useSurveyAssets(surveyId);

  useEffect(() => {
    if (surveyId) setActiveSurvey(surveyId);
  }, [surveyId, setActiveSurvey]);

  // Each engine starts from scratch when the user (or the stall detector) switches.
  useEffect(() => {
    setMapReady(false);
    setWebReady(false);
  }, [webMap]);

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

  useEffect(() => {
    if (!webMap && mapReady && selected?.bbox) mapRef.current?.focusOn(selected.bbox);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webMap, mapReady, selectedId]);

  useEffect(() => {
    if (webMap || !mapReady || !imageParam) return;
    const img = images.data?.find((i) => i.id === imageParam);
    if (img?.lat != null && img.lon != null) mapRef.current?.focusOn({ latitude: img.lat, longitude: img.lon });
  }, [webMap, mapReady, imageParam, images.data]);

  // Web map: mirror the Layers sheet into the embedded viewer.
  useEffect(() => {
    if (!webMap || !webReady) return;
    for (const key of Object.keys(WEB_LAYER) as MapLayerKey[]) {
      webRef.current?.send({ type: "SET_LAYER", layer: WEB_LAYER[key], visible: layers[key] });
    }
  }, [webMap, webReady, layers]);

  const onSelectZone = useCallback((z: DetectionZone | null) => setSelectedId(z?.id ?? null), []);

  // Android Google Maps drew no tiles (build without a Maps key, or no Play services):
  // switch to the website's map, which needs neither, and say so. Persisted, so the
  // next visit does not wait on a blank canvas again; the Layers sheet can switch back.
  const onBaseMapStalled = useCallback(() => {
    setMapEngine("web");
    setAutoSwitched(true);
  }, [setMapEngine]);

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
  if (fatal) {
    return (
      <Screen scroll={false} safeTop>
        <ErrorState error={fatal} title="Unable to load map" onRetry={() => (survey.isError ? survey.refetch() : boundary.refetch())} />
      </Screen>
    );
  }

  const hasBoundary = !!boundary.data?.boundary;
  const imageList = images.data ?? [];
  const noGeometry = !hasBoundary && zones.length === 0 && imageList.every((i) => i.lat == null) && !(assets.data ?? []).some((a) => a.bounds_geojson);
  const fieldId = survey.data?.field_id ?? null;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      {webMap && fieldId ? (
        <DigitalTwinWebView
          ref={webRef}
          fieldId={fieldId}
          surveyId={surveyId}
          mode="field-map"
          focusZoneId={zoneParam ?? null}
          onReady={() => setWebReady(true)}
          onZoneSelected={setSelectedId}
          frameColor={colors.bg}
        />
      ) : noGeometry ? (
        <Screen scroll={false} safeTop>
          <ErrorState
            error={new Error("no geometry")}
            title="Nothing to show on the map yet"
            onRetry={() => {
              boundary.refetch();
              images.refetch();
            }}
          />
          <AppText variant="body" tone="muted" style={{ textAlign: "center", paddingHorizontal: 24 }}>
            This survey has no field boundary, GPS photo positions or stitched map yet. Run processing from the survey page.
          </AppText>
        </Screen>
      ) : (
        <MapViewer
          ref={mapRef}
          boundary={boundary.data?.boundary}
          zones={zones}
          images={imageList}
          assets={assets.data}
          selectedZoneId={selectedId}
          onSelectZone={onSelectZone}
          highlightImageId={imageParam ?? null}
          onMapReady={() => setMapReady(true)}
          onBaseMapStalled={onBaseMapStalled}
          edgePadding={{ top: insets.top + 90, right: 80, bottom: bottomEdge + 120, left: 30 }}
        >
          <ZoneMarkers zones={zoneViews} visible={layers.zones} onPress={(v) => setSelectedId(v.zone.id)} />
        </MapViewer>
      )}

      {/* top bar */}
      <View style={[styles.topBar, { top: insets.top + 10 }]} pointerEvents="box-none">
        <IconButton tone="raised" size={46} icon={<ArrowLeft size={20} color={colors.text} strokeWidth={1.6} />} accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))} />
        {/*
          Sized to its own text (not flex:1) and non-interactive: in web-map mode this
          chip floats over the embedded website, and a full-width opaque pill here — even
          the blank stretch past the text — used to sit on top of and swallow every tap
          meant for the site's own Layers panel underneath. Shrinking it and letting taps
          fall through keeps the label readable while leaving that panel reachable.
        */}
        <View style={[styles.titlePill, { backgroundColor: colors.bg, borderColor: colors.divider }, colors.shadowMd]} pointerEvents="none">
          <AppText variant="heading" style={{ fontSize: 18, lineHeight: 20 }} numberOfLines={1}>
            {field.data?.name ?? survey.data?.name ?? "Field map"}
          </AppText>
          <AppText variant="label" tone="muted" numberOfLines={1}>
            {webMap ? `Web map · ${onCount} layers on` : `${onCount} layers on · tap a marker for details`}
          </AppText>
        </View>
      </View>

      {autoSwitched ? (
        <View style={[styles.notice, { top: insets.top + 74, backgroundColor: colors.bg, borderColor: colors.attention }, colors.shadowMd]} accessibilityRole="alert" pointerEvents="box-none">
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="captionStrong">Showing the web map</AppText>
            <AppText variant="small" tone="muted">
              Google Maps could not draw on this phone (a build without a Maps key, or no Google Play services), so the map from the website is shown instead. Change this under
              Layers → Map engine.
            </AppText>
          </View>
          <IconButton size={36} icon={<X size={16} color={colors.text} strokeWidth={1.6} />} accessibilityLabel="Dismiss" onPress={() => setAutoSwitched(false)} />
        </View>
      ) : null}

      <MapControls
        bottom={bottomEdge}
        layersOpen={layersOpen}
        onLayers={() => setLayersOpen(true)}
        onCentre={() => (webMap ? webRef.current?.reload() : mapRef.current?.fitToField())}
        onTwin={() => surveyId && router.push({ pathname: "/twin/[surveyId]", params: selectedId ? { surveyId, zone: selectedId } : { surveyId } })}
        onAi={() => router.push(surveyId ? { pathname: "/ai/chat", params: { surveyId } } : "/ai/chat")}
      />

      {/* legend */}
      <View style={[styles.legend, { bottom: bottomEdge, backgroundColor: colors.bg, borderColor: colors.divider }, colors.shadowMd]} accessibilityLabel="Legend">
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

      <LayerSheet visible={layersOpen} onClose={() => setLayersOpen(false)} rasters={rasters} hasZones={zones.length > 0} hasImages={imageList.some((i) => i.lat != null)} hasBoundary={hasBoundary} />
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
  // Capped well short of the row's full width: the embedded website still draws its own
  // (soon-to-be-removed once redeployed) mode switcher at the right edge of this same row,
  // and this chip must not be the thing sitting in front of it.
  titlePill: { alignSelf: "flex-start", maxWidth: "50%", minWidth: 0, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  notice: { position: "absolute", left: 14, right: 14, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  legend: { position: "absolute", left: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, maxWidth: 200 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 3 },
});
