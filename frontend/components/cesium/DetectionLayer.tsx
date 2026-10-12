"use client";

import type * as GeoJSON from "geojson";
import { useEffect } from "react";
import type { DetectionZone } from "@/lib/types";
import { isWeedZone } from "@/lib/types";

const SEVERITY_COLOR: Record<string, [number, number, number, number]> = {
  low: [234, 179, 8, 90],
  medium: [249, 115, 22, 110],
  high: [239, 68, 68, 130],
};
// weed candidates / model detections are a different kind of finding from
// the cover tiers, so they get their own colour whatever their severity
const WEED_COLOR: [number, number, number, number] = [168, 85, 247, 120];
// Close up, a tinted fill hides the very photo it annotates: fade it out
// between these heights above the ground; the outline stays.
const FILL_FULL_ABOVE_M = 60;
const FILL_GONE_BELOW_M = 15;
// over the Photorealistic reconstruction the fill is only a hint, so it stays visible
const RECONSTRUCTION_FILL_FACTOR = 0.35;

export interface DetectionLayerProps {
  viewer: any;
  Cesium: any;
  ready: boolean;
  detections: DetectionZone[];
  /** Cover-tier zones (bare soil / low density / patchy). */
  showProblemZones: boolean;
  /** Weed candidates and trained-detector zones. */
  showWeedAreas?: boolean;
  /** Drape onto terrain / 3D Tiles (reality mesh) instead of floating at a
   * fixed height. Off in Photorealistic mode: splats are not classifiable. */
  drape?: boolean;
  /** Terrain height of the field's ground plane (for the non-draped placement). */
  groundHeight?: number;
}

/** Renders AI/CV detection zones as clickable polygons (each entity carries its
 * detectionId; the click handler is CesiumViewer's, shared with the GCPs). */
export function DetectionLayer({
  viewer,
  Cesium,
  ready,
  detections,
  showProblemZones,
  showWeedAreas = true,
  drape = true,
  groundHeight = 0,
}: DetectionLayerProps) {
  useEffect(() => {
    if (!viewer || !Cesium || !ready || viewer.isDestroyed()) return;

    for (const d of detections) {
      viewer.entities.removeById(`zone-${d.id}`);
      viewer.entities.removeById(`zone-outline-${d.id}`);
    }

    const fade = { value: 1 };
    const updateFade = () => {
      const cam = viewer.camera.positionCartographic;
      const above = cam.height - (viewer.scene.globe.getHeight(cam) ?? groundHeight);
      fade.value = Math.min(Math.max((above - FILL_GONE_BELOW_M) / (FILL_FULL_ABOVE_M - FILL_GONE_BELOW_M), 0), 1);
    };
    updateFade();
    const removeFadeListener = viewer.scene.preRender.addEventListener(updateFade);

    for (const d of detections) {
      const weed = isWeedZone(d.type);
      if (weed ? !showWeedAreas : !showProblemZones) continue;
      if (d.geometry.type !== "Polygon") continue;
      const coords = (d.geometry as GeoJSON.Polygon).coordinates[0];
      const positions = coords.flatMap(([lon, lat]) => [lon, lat]);
      const [r, g, b, a] = weed ? WEED_COLOR : (SEVERITY_COLOR[d.severity] ?? SEVERITY_COLOR.medium);
      const base = Cesium.Color.fromBytes(r, g, b, a);
      const fill = new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty((_time: unknown, result: unknown) => {
          const c = Cesium.Color.clone(base, result);
          c.alpha = base.alpha * fade.value * (drape ? 1 : RECONSTRUCTION_FILL_FACTOR);
          return c;
        }, false),
      );
      const line = Cesium.Color.fromBytes(r, g, b, 255);
      if (drape) {
        // ground polygons cannot carry an outline, so it is a clamped polyline
        viewer.entities.add({
          id: `zone-${d.id}`,
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
            material: fill,
            classificationType: Cesium.ClassificationType.BOTH,
          },
          properties: { detectionId: d.id },
        });
        viewer.entities.add({
          id: `zone-outline-${d.id}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(positions),
            width: 2,
            material: line,
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
          properties: { detectionId: d.id },
        });
      } else {
        viewer.entities.add({
          id: `zone-${d.id}`,
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
            material: fill,
            outline: true,
            outlineColor: line,
            height: groundHeight + 1.5,
          },
          properties: { detectionId: d.id },
        });
      }
    }
    return () => removeFadeListener();
  }, [viewer, Cesium, ready, detections, showProblemZones, showWeedAreas, drape, groundHeight]);

  return null;
}
