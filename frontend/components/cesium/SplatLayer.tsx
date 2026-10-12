"use client";

import { useEffect } from "react";
import type { ViewMode } from "@/lib/digitalTwinStore";
import { liftTileset } from "@/lib/cesiumPlacement";
import { setZoomFloor } from "@/lib/zoomFloor";

// A splat model only holds the detail of the images it was trained on; drawn
// finer than one training pixel per screen pixel its splats read as streaks.
const SPLAT_MAX_MAGNIFICATION = 1;

export type SplatStatus = "idle" | "loading" | "loaded" | "missing" | "error";

export interface SplatLayerProps {
  viewer: any;
  Cesium: any;
  ready: boolean;
  mode: ViewMode;
  surveyId: string | null;
  groundHeight?: number;
  onStatus?: (status: SplatStatus, detail?: string) => void;
}

/** Photorealistic mode: loads the survey's Gaussian-splat 3D Tileset
 * (frontend/public/splats/<survey_id>/tileset.json, produced by
 * backend/scripts/build_splats.py from the survey's own frames — SfM →
 * 3DGS → 3D Tiles, geo-aligned to the RTK camera positions). Local files,
 * no Cesium Ion. Removed again when the mode changes. */
export function SplatLayer({ viewer, Cesium, ready, mode, surveyId, groundHeight = 0, onStatus }: SplatLayerProps) {
  useEffect(() => {
    if (!viewer || !Cesium || !ready || viewer.isDestroyed() || mode !== "photorealistic" || !surveyId) {
      return undefined;
    }

    let cancelled = false;
    let tileset: any = null;
    const url = `/splats/${surveyId}/tileset.json`;
    const floorKey = Symbol("splats");

    (async () => {
      onStatus?.("loading");
      try {
        const head = await fetch(url, { method: "HEAD" });
        if (!head.ok) {
          if (!cancelled) onStatus?.("missing");
          return;
        }
        tileset = await Cesium.Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: 8 });
        await liftTileset(Cesium, tileset, url, groundHeight);
        if (cancelled || viewer.isDestroyed()) {
          tileset.destroy?.();
          return;
        }
        viewer.scene.morphTo3D(0);
        viewer.scene.primitives.add(tileset);
        if (!cancelled) onStatus?.("loaded");
        const placement = await fetch(`/splats/${surveyId}/placement.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!cancelled && !viewer.isDestroyed() && typeof placement?.train_gsd_m === "number") {
          setZoomFloor(viewer, floorKey, { group: "splats", gsdM: placement.train_gsd_m, maxMagnification: SPLAT_MAX_MAGNIFICATION });
        }
      } catch (e: any) {
        console.error(e);
        if (!cancelled) onStatus?.("error", e?.message ?? String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (!viewer.isDestroyed()) setZoomFloor(viewer, floorKey, null);
      if (tileset && !viewer.isDestroyed()) {
        try {
          viewer.scene.primitives.remove(tileset);
        } catch {
          /* already gone */
        }
      }
      onStatus?.("idle");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, Cesium, ready, mode, surveyId, groundHeight]);

  return null;
}
