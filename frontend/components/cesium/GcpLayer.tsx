"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- Cesium is loaded at runtime (lib/loadCesium.ts), as in the other layers */

import { useEffect } from "react";
import { isMarker, type GroundControlPoint } from "@/lib/types";

/** Marker labels show only with the camera this close: the markers stand
 * about a metre apart, and dozens of labels over the field view would hide
 * the field. */
const MARKER_LABEL_MAX_M = 40;
/** Further out the GCP labels pile up into one block over the field, and on
 * the opening globe the points do too (the capture points mark the field there). */
const GCP_LABEL_MAX_M = 1000;
const POINT_MAX_M = 5000;
/** A tap this close to a target's point selects it: a fingertip cannot land on a 6 px dot. */
const TAP_SLOP_PX = 22;
const SELECTED = "#facc15";

export interface GcpLayerProps {
  viewer: any;
  Cesium: any;
  ready: boolean;
  gcps: GroundControlPoint[];
  show: boolean;
  /** Terrain height of the field's ground plane (0 on the flat Field Map globe). */
  groundHeight?: number;
  /** Highlighted, and labelled at any distance the point shows. */
  selectedId?: string | null;
}

const entityId = (g: GroundControlPoint) => `gcp-${g.id}`;
const position = (Cesium: any, g: GroundControlPoint, groundHeight: number) =>
  Cesium.Cartesian3.fromDegrees(g.lon, g.lat, groundHeight);

/** The survey's ground control targets as labelled markers. Clamped to the
 * ground plane / terrain so the marker stays dead-center on the physical target
 * from all viewing angles (no perspective parallax), and drawn over everything
 * with depth test disabled so a target is never hidden by a drape or mesh —
 * they are the reference points for checking that the layers line up. */
export function GcpLayer({ viewer, Cesium, ready, gcps, show, groundHeight = 0, selectedId = null }: GcpLayerProps) {
  useEffect(() => {
    if (!viewer || !Cesium || !ready || viewer.isDestroyed() || !show) return undefined;
    const ids: string[] = [];
    for (const g of gcps) {
      const id = entityId(g);
      const marker = isMarker(g);
      const selected = g.id === selectedId;
      viewer.entities.removeById(id);
      viewer.entities.add({
        id,
        position: position(Cesium, g, groundHeight),
        point: {
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          pixelSize: (marker ? 6 : 9) + (selected ? 4 : 0),
          color: selected ? Cesium.Color.fromCssColorString(SELECTED) : Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: marker ? 2 : 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, POINT_MAX_M),
        },
        label: {
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          text: g.name,
          font: marker ? "600 11px sans-serif" : "600 12px sans-serif",
          fillColor: selected ? Cesium.Color.BLACK : Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: selected ? Cesium.Color.fromCssColorString(SELECTED) : Cesium.Color.BLACK.withAlpha(0.65),
          backgroundPadding: new Cesium.Cartesian2(marker ? 4 : 6, marker ? 2 : 3),
          pixelOffset: new Cesium.Cartesian2(0, marker ? -13 : -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            selected ? POINT_MAX_M : marker ? MARKER_LABEL_MAX_M : GCP_LABEL_MAX_M
          ),
        },
        description:
          `${g.name}${g.size_m != null ? ` — ${Math.round(g.size_m * 100)} cm target` : ""}` +
          ` — ${g.lat.toFixed(7)}, ${g.lon.toFixed(7)}`,
      });
      ids.push(id);
    }
    return () => {
      if (viewer.isDestroyed()) return;
      for (const id of ids) viewer.entities.removeById(id);
    };
  }, [viewer, Cesium, ready, gcps, show, groundHeight, selectedId]);

  return null;
}

/** The target a click or tap at `click` (canvas pixels) meant: the one whose
 * point or label is under it, else the nearest drawn point within TAP_SLOP_PX. */
export function gcpAt(
  viewer: any,
  Cesium: any,
  gcps: GroundControlPoint[],
  groundHeight: number,
  click: { x: number; y: number }
): string | null {
  const picked = viewer.scene.pick(click)?.id?.id;
  const hit = typeof picked === "string" ? gcps.find((g) => entityId(g) === picked) : undefined;
  if (hit) return hit.id;
  let best: string | null = null;
  let bestPx = TAP_SLOP_PX;
  for (const g of gcps) {
    const p = position(Cesium, g, groundHeight);
    if (Cesium.Cartesian3.distance(viewer.camera.positionWC, p) > POINT_MAX_M) continue; // not drawn
    const w = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, p);
    if (!w) continue;
    const d = Math.hypot(w.x - click.x, w.y - click.y);
    if (d < bestPx) {
      bestPx = d;
      best = g.id;
    }
  }
  return best;
}
