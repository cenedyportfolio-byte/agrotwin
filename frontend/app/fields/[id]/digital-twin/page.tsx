"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useDigitalTwinStore } from "@/lib/digitalTwinStore";
import { CesiumToolbar } from "@/components/cesium/CesiumToolbar";
import { LayerControls } from "@/components/cesium/LayerControls";
import { DetectionPanel } from "@/components/cesium/DetectionPanel";
import { MethodBadge, MockDataBadge } from "@/components/dashboard/StatusPill";
import { groupFrames } from "@/lib/frames";
import { selectViewerAssets } from "@/lib/surveyAssets";
import { isWeedZone } from "@/lib/types";
import type { CursorPosition } from "@/components/cesium/CesiumViewer";
import type { SplatStatus } from "@/components/cesium/SplatLayer";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useProcessingJob } from "@/lib/hooks/useProcessingJob";
import { notifyHost, useHostBridge, useIsEmbedded } from "@/lib/hostBridge";
import type { LayerKey } from "@/lib/digitalTwinStore";

const CesiumViewer = dynamic(() => import("@/components/cesium/CesiumViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-surface text-sm text-muted-foreground">
      Loading Digital Twin viewer…
    </div>
  ),
});

export default function DigitalTwinPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  const { data: field } = useQuery({ queryKey: ["field", id], queryFn: () => api.getField(id) });
  const { data: surveys } = useQuery({
    queryKey: ["field-surveys", id],
    queryFn: () => api.listFieldSurveys(id),
  });
  const requestedSurvey = searchParams.get("survey");
  const surveyId =
    (requestedSurvey && surveys?.some((s) => s.id === requestedSurvey) ? requestedSurvey : null) ??
    field?.latest_survey_id ??
    null;

  const { data: images } = useQuery({
    queryKey: ["survey-images", surveyId],
    queryFn: () => api.listSurveyImages(surveyId as string),
    enabled: !!surveyId,
  });
  const { data: analysis } = useQuery({
    queryKey: ["analysis", surveyId],
    queryFn: () => api.getAnalysis(surveyId as string),
    enabled: !!surveyId,
    retry: false,
  });
  const { data: assets } = useQuery({
    queryKey: ["survey-assets", surveyId],
    queryFn: () => api.listSurveyAssets(surveyId as string),
    enabled: !!surveyId,
  });
  // keeps the viewer current while the backend is still building this survey's products
  const { job, active: processing } = useProcessingJob(surveyId);

  const [splat, setSplat] = useState<{ status: SplatStatus; detail?: string }>({ status: "idle" });
  const onSplatStatus = useCallback((status: SplatStatus, detail?: string) => {
    setSplat({ status, detail });
    notifyHost({ type: "SPLAT_STATUS", status, detail });
  }, []);
  const [cursor, setCursor] = useState<CursorPosition | null>(null);
  const [layerError, setLayerError] = useState<string | null>(null);

  // Deep link: ?mode=field-map|3d-twin|photorealistic
  const setMode = useDigitalTwinStore((s) => s.setMode);
  const requestedMode = searchParams.get("mode");
  useEffect(() => {
    if (requestedMode === "field-map" || requestedMode === "3d-twin" || requestedMode === "photorealistic") {
      setMode(requestedMode);
    }
  }, [requestedMode, setMode]);

  // Deep link: ?cam=lon,lat,height,heading,pitch (share an exact view)
  const initialCamera = useMemo(() => {
    const v = searchParams.get("cam")?.split(",").map(Number);
    if (!v || v.length !== 5 || v.some((n) => !Number.isFinite(n))) return null;
    const [lon, lat, height, heading, pitch] = v;
    return { lon, lat, height, heading, pitch };
  }, [searchParams]);

  const selectedDetectionId = useDigitalTwinStore((s) => s.selectedDetectionId);
  const setSelectedDetectionId = useDigitalTwinStore((s) => s.setSelectedDetectionId);
  const mode = useDigitalTwinStore((s) => s.mode);
  const advanced = useDigitalTwinStore((s) => s.advanced);

  // Native host (the AgroTwin mobile app's WebView). No-ops in a plain browser tab.
  const embedded = useIsEmbedded();
  const hostHandlers = useMemo(
    () => ({
      onSetMode: (m: "field-map" | "3d-twin" | "photorealistic") => setMode(m),
      onFocusZone: (zoneId: string) => setSelectedDetectionId(zoneId),
      onSetLayer: (layer: LayerKey, visible: boolean) => {
        const state = useDigitalTwinStore.getState();
        const stateKey = `show${layer.charAt(0).toUpperCase()}${layer.slice(1)}` as keyof typeof state;
        if (state[stateKey] !== visible) state.toggleLayer(layer);
      },
      onSetAdvanced: (on: boolean) => {
        const state = useDigitalTwinStore.getState();
        if (state.advanced !== on) state.toggleAdvanced();
      },
    }),
    [setMode, setSelectedDetectionId]
  );
  useHostBridge(hostHandlers);

  // Deep link: ?zone=<detection id> opens that zone's panel (used by the mobile app).
  const requestedZone = searchParams.get("zone");
  const detectionCount = analysis?.detections.length ?? 0;
  useEffect(() => {
    if (requestedZone && detectionCount > 0 && analysis?.detections.some((d) => d.id === requestedZone)) {
      setSelectedDetectionId(requestedZone);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedZone, detectionCount]);

  const viewerDataReady = !!surveyId && images !== undefined && assets !== undefined;
  useEffect(() => {
    if (viewerDataReady) notifyHost({ type: "VIEWER_READY", surveyId });
  }, [viewerDataReady, surveyId]);
  useEffect(() => {
    notifyHost({ type: "ZONE_SELECTED", zoneId: selectedDetectionId });
  }, [selectedDetectionId]);
  useEffect(() => {
    notifyHost({ type: "MODE_CHANGED", mode });
  }, [mode]);
  useEffect(() => {
    if (layerError) notifyHost({ type: "LAYER_ERROR", message: layerError });
  }, [layerError]);

  const boundary = field?.boundary_geojson ? JSON.parse(field.boundary_geojson) : null;
  // One map point per shutter release — a multispectral frame is 5 files at the same spot.
  const frameAnchors = useMemo(() => groupFrames(images ?? []).map((f) => f.anchor), [images]);
  const detections = analysis?.detections ?? [];
  const selectedZone = detections.find((d) => d.id === selectedDetectionId) ?? null;

  // Capture geometry from the frames' own gimbal pitch: a nadir-only flight
  // (all ≈ −90°) leaves depth poorly constrained along the viewing rays, so
  // a splat reconstruction looks needly from low angles; oblique passes
  // (35–45° tilt) are what make it hold up from any direction.
  const capture = useMemo(() => {
    const pitches = frameAnchors.map((f) => f.gimbal_pitch_deg).filter((p): p is number => p != null);
    if (pitches.length === 0) return null;
    const oblique = pitches.filter((p) => p > -80).length;
    return { total: pitches.length, oblique, pct: Math.round((100 * oblique) / pitches.length) };
  }, [frameAnchors]);

  const viewerAssets = useMemo(
    () => selectViewerAssets(assets, (assetId) => api.assetPreviewUrl(surveyId as string, assetId)),
    [assets, surveyId]
  );

  return (
    <div className="relative h-screen w-full">
      <CesiumViewer
        boundary={boundary}
        centerLat={field?.center_lat ?? null}
        centerLon={field?.center_lon ?? null}
        images={frameAnchors}
        detections={detections}
        orthomosaic={viewerAssets.orthomosaic}
        ndvi={viewerAssets.ndvi}
        ndre={viewerAssets.ndre}
        gndvi={viewerAssets.gndvi}
        dsm={viewerAssets.dsm}
        vegetationMask={viewerAssets.vegetationMask}
        meshUrl={viewerAssets.meshUrl}
        meshKind={viewerAssets.meshKind}
        pointCloudUrl={viewerAssets.pointCloudUrl}
        vectorOverlays={viewerAssets.vectorOverlays}
        surveyId={surveyId}
        initialCamera={initialCamera}
        onSelectDetection={setSelectedDetectionId}
        onSplatStatus={onSplatStatus}
        onCursor={advanced ? setCursor : undefined}
        onLayerError={setLayerError}
      />

      {/* top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center justify-between gap-2 p-2 sm:p-4 z-30">
        <div className="pointer-events-auto flex items-center gap-2">
          {!embedded && (
            <Link
              href={`/fields/${id}`}
              className="flex items-center gap-1.5 sm:gap-2 rounded-lg border border-border bg-surface/90 px-2.5 py-1.5 sm:px-3 sm:py-2 text-xs sm:text-sm font-medium shadow-lg backdrop-blur hover:bg-surface-2"
            >
              <ArrowLeft size={15} />
              <span className="max-w-[100px] sm:max-w-none truncate">{field?.name ?? "Field"}</span>
            </Link>
          )}
          {!embedded && surveys && surveys.length > 1 && surveyId && (
            <select
              value={surveyId}
              onChange={(e) => router.replace(`/fields/${id}/digital-twin?survey=${e.target.value}`)}
              className="max-w-[130px] sm:max-w-[240px] rounded-lg border border-border bg-surface/90 px-2 sm:px-3 py-1.5 sm:py-2 text-xs font-medium shadow-lg backdrop-blur outline-none focus:border-brand truncate"
              title="Choose which survey of this field to view"
            >
              {surveys.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {/* Both host screens (the app's Digital Twin screen and its Field Map fallback)
            already drive mode switching from their own native controls over the
            SET_MODE/MODE_CHANGED bridge messages — this on-page switcher is only
            for the standalone browser. Keeping it while embedded doubled the mode
            control and, being the same width-stretching row, sat directly under
            the host's title chip where it could not be reached. */}
        {!embedded && <CesiumToolbar />}
      </div>

      {/* layer controls */}
      <div className="pointer-events-none absolute right-2 sm:right-4 top-14 sm:top-20 z-20">
        <LayerControls
          hasOrthomosaic={!!viewerAssets.orthomosaic}
          hasNdvi={!!viewerAssets.ndvi}
          hasNdre={!!viewerAssets.ndre}
          hasGndvi={!!viewerAssets.gndvi}
          hasDsm={!!viewerAssets.dsm}
          hasMesh={!!viewerAssets.meshUrl}
          meshKind={viewerAssets.meshKind}
          hasPointCloud={!!viewerAssets.pointCloudUrl}
          hasVectorOverlays={viewerAssets.vectorOverlays.length > 0}
          hasVegetationMask={!!viewerAssets.vegetationMask}
          hasWeedAreas={detections.some((d) => isWeedZone(d.type))}
          weedHint={analysis?.metrics?.rows?.reason}
        />
      </div>

      {/* detection detail panel */}
      {selectedZone && (
        <div className="pointer-events-none absolute right-2 sm:right-4 top-[18rem] sm:top-[21rem] z-20">
          <DetectionPanel zone={selectedZone} onClose={() => setSelectedDetectionId(null)} />
        </div>
      )}

      {/* transient notices */}
      <div className="pointer-events-none absolute inset-x-0 bottom-20 sm:bottom-24 flex flex-col items-center gap-2 px-4">
        {processing && job && (
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-surface/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
            <Loader2 size={13} className="animate-spin text-attention" />
            {job.steps.find((s) => s.key === job.current_step)?.label ?? "Processing"}… layers update automatically when it finishes
          </div>
        )}
        {layerError && (
          <div className="pointer-events-auto rounded-lg border border-problem/40 bg-surface/95 px-3 py-2 text-xs text-problem shadow-lg backdrop-blur">
            {layerError}
          </div>
        )}
        {surveyId && !processing && !viewerAssets.orthomosaic && frameAnchors.length > 0 && mode === "field-map" && (
          <div className="pointer-events-auto rounded-lg border border-border bg-surface/95 px-3 py-2 text-xs text-muted-foreground shadow-lg backdrop-blur text-center">
            No continuous field map yet — showing the survey&apos;s photo positions. Run processing or import an
            orthomosaic from the{" "}
            <Link href={`/surveys/${surveyId}`} className="text-brand hover:underline">
              survey page
            </Link>
            .
          </div>
        )}
        {mode === "photorealistic" && splat.status !== "loaded" && (
          <div className="pointer-events-auto rounded-lg border border-attention/40 bg-surface/95 px-3 sm:px-4 py-2 text-xs text-attention shadow-lg backdrop-blur text-center">
            {splat.status === "loading" && "Loading Gaussian-splat reconstruction…"}
            {splat.status === "missing" &&
              "No photorealistic reconstruction exists for this survey yet — run backend/scripts/build_splats.py (GPU, hours) to build one from its frames."}
            {splat.status === "error" && `Could not load the reconstruction: ${splat.detail}`}
            {splat.status === "idle" && "Preparing…"}
          </div>
        )}
        {mode === "photorealistic" && splat.status === "loaded" && (
          <div className="rounded-lg border border-border bg-surface/90 px-3 py-1.5 text-[11px] text-muted-foreground shadow backdrop-blur text-center">
            Gaussian splats reconstructed from this survey&apos;s frames (SfM + 3DGS), geo-aligned to the RTK camera positions
            {capture && capture.oblique === 0 && (
              <span className="block text-attention">
                Nadir-only capture ({capture.total} frames at −90°): looks best from above. Add oblique passes (gimbal 35–45°,
                cross-hatch or orbit) to the next flight for a view that holds up from any angle.
              </span>
            )}
            {capture && capture.oblique > 0 && (
              <span className="block">
                {capture.oblique} of {capture.total} frames oblique ({capture.pct}%)
              </span>
            )}
          </div>
        )}
      </div>

      {/* bottom status bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface/90 px-3 py-2 sm:px-6 sm:py-3 backdrop-blur z-30">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-[11px] sm:text-xs">
          {analysis && (
            <>
              <span>🟢 {analysis.analysis_summary.healthy_area_percent}% <span className="hidden xs:inline">Healthy</span></span>
              <span>🟡 {analysis.analysis_summary.attention_area_percent}% <span className="hidden xs:inline">Attention</span></span>
              <span>🔴 {analysis.analysis_summary.problem_area_percent}% <span className="hidden xs:inline">Problem</span></span>
              <MethodBadge method={analysis.method} />
              {analysis.is_mock && <MockDataBadge />}
            </>
          )}
          {!analysis && surveyId && !processing && (
            <span className="text-muted-foreground">No analysis for this survey yet</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] sm:text-xs text-muted-foreground">
          {advanced && cursor && (
            <span className="font-mono tabular-nums hidden sm:inline" title="Cursor position (WGS84) and terrain height">
              {cursor.lat.toFixed(6)}, {cursor.lon.toFixed(6)}
              {cursor.height != null && ` · ${cursor.height.toFixed(1)} m`}
            </span>
          )}
          <span className="hidden sm:inline">
            {images ? `${frameAnchors.length} frames` : ""} {field?.area_hectares != null && `· ${field.area_hectares} ha`}
          </span>
        </div>
      </div>
    </div>
  );
}
