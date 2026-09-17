import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, X } from "lucide-react-native";
import { layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useField } from "@/features/fields/hooks";
import { useFieldBoundary, useSurvey, useSurveyAssets, useSurveyImages } from "@/features/surveys/hooks";
import { useAnalysis } from "@/features/analysis/hooks";
import { enrichZones } from "@/features/analysis/zones";
import { useMapLayerStore } from "@/stores/mapLayerStore";
import { useUiStore } from "@/stores/uiStore";
import type { DetectionZone } from "@/types";
import { ErrorState, IconButton, LoadingState, Screen, Swatch, AppText } from "@/components/ui";
import { LayerSheet, MapControls, MapViewer, ZoneMarkers, ZoneSheet, selectRasterSources, type MapViewerHandle } from "@/components/map";

const LEGEND = [
  { tier: "healthy", label: "Healthy" },
  { tier: "attention", label: "Needs attention" },
  { tier: "problem", label: "Problem" },
] as const;

export default function FieldMapScreen() {
  const { surveyId, zone: zoneParam, image: imageParam } = useLocalSearchParams<{ surveyId: string; zone?: string; image?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const setActiveSurvey = useUiStore((s) => s.setActiveSurvey);
  const layers = useMapLayerStore((s) => s.layers);

  const mapRef = useRef<MapViewerHandle>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(zoneParam ?? null);
  const [mapReady, setMapReady] = useState(false);
  // Android: the Google Maps SDK drew nothing (no key in this build, or no Play services on the device).
  const [imageryStalled, setImageryStalled] = useState(false);
  const [stallDismissed, setStallDismissed] = useState(false);

  const survey = useSurvey(surveyId);
  const field = useField(survey.data?.field_id);
  const boundary = useFieldBoundary(surveyId);
  const analysis = useAnalysis(surveyId);
  const images = useSurveyImages(surveyId);
  const assets = useSurveyAssets(surveyId);

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

  useEffect(() => {
    if (mapReady && selected?.bbox) mapRef.current?.focusOn(selected.bbox);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, selectedId]);

  useEffect(() => {
    if (!mapReady || !imageParam) return;
    const img = images.data?.find((i) => i.id === imageParam);
    if (img?.lat != null && img.lon != null) mapRef.current?.focusOn({ latitude: img.lat, longitude: img.lon });
  }, [mapReady, imageParam, images.data]);

  const onSelectZone = useCallback((z: DetectionZone | null) => setSelectedId(z?.id ?? null), []);

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

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      {noGeometry ? (
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
          onBaseMapStalled={() => setImageryStalled(true)}
          onBaseMapLoaded={() => setImageryStalled(false)}
          edgePadding={{ top: insets.top + 90, right: 80, bottom: bottomEdge + 120, left: 30 }}
        >
          <ZoneMarkers zones={zoneViews} visible={layers.zones} onPress={(v) => setSelectedId(v.zone.id)} />
        </MapViewer>
      )}

      {/* top bar */}
      <View style={[styles.topBar, { top: insets.top + 10 }]} pointerEvents="box-none">
        <IconButton tone="raised" size={46} icon={<ArrowLeft size={20} color={colors.text} strokeWidth={1.6} />} accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)"))} />
        <View style={[styles.titlePill, { backgroundColor: colors.bg, borderColor: colors.divider }, colors.shadowMd]}>
          <AppText variant="heading" style={{ fontSize: 18, lineHeight: 20 }} numberOfLines={1}>
            {field.data?.name ?? survey.data?.name ?? "Field map"}
          </AppText>
          <AppText variant="label" tone="muted" numberOfLines={1}>
            {onCount} layers on · tap a marker for details
          </AppText>
        </View>
      </View>

      {imageryStalled && !stallDismissed ? (
        <View style={[styles.notice, { top: insets.top + 74, backgroundColor: colors.bg, borderColor: colors.attention }, colors.shadowMd]} accessibilityRole="alert">
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="captionStrong">Map imagery is not loading</AppText>
            <AppText variant="small" tone="muted">
              Your field data loaded, but Google Maps on this phone is not drawing. A custom build needs a Google Maps key (see mobile/.env.example); an emulator needs a Google
              Play image.
            </AppText>
          </View>
          <IconButton size={36} icon={<X size={16} color={colors.text} strokeWidth={1.6} />} accessibilityLabel="Dismiss" onPress={() => setStallDismissed(true)} />
        </View>
      ) : null}

      <MapControls
        bottom={bottomEdge}
        layersOpen={layersOpen}
        onLayers={() => setLayersOpen(true)}
        onCentre={() => mapRef.current?.fitToField()}
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
  titlePill: { flex: 1, minWidth: 0, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  notice: { position: "absolute", left: 14, right: 14, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  legend: { position: "absolute", left: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, maxWidth: 200 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 3 },
});

void layout;
