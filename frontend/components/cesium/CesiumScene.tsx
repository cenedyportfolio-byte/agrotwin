"use client";

import type * as GeoJSON from "geojson";
import { useEffect } from "react";
import type { SurveyImage } from "@/lib/types";
import type { ViewMode } from "@/lib/digitalTwinStore";
import { healthColor } from "@/lib/colors";

export interface CesiumSceneProps {
  viewer: any;
  Cesium: any;
  ready: boolean;
  /** The viewer exists. The camera flies to the field from this moment, with a
   * provisional altitude until the ground height is known (`ready`), so a slow
   * terrain service never leaves the user looking at the whole globe. */
  cameraReady?: boolean;
  boundary: GeoJSON.Geometry | null;
  centerLat: number | null;
  centerLon: number | null;
  images: SurveyImage[];
  showFieldBoundary: boolean;
  showRgbPoints: boolean;
  showCropDensity: boolean;
  mode: ViewMode;
  /** Deep-linked camera (?cam=lon,lat,height,heading,pitch) — overrides the mode's default view. */
  initialCamera?: { lon: number; lat: number; height: number; heading: number; pitch: number } | null;
  /** Terrain height of the field's ground plane; camera heights are above this. */
  groundHeight?: number;
}

/** Owns the "base" scene content shared by every view mode: field boundary,
 * survey image capture points, and mode-driven camera placement. Detection
 * zones and raster overlays are separate layers (DetectionLayer,
 * SurveyImageryLayer) so each concern can evolve independently. */
const PROVISIONAL_GROUND_M = 600;

export function CesiumScene({
  viewer,
  Cesium,
  ready,
  cameraReady = ready,
  boundary,
  centerLat,
  centerLon,
  images,
  showFieldBoundary,
  showRgbPoints,
  showCropDensity,
  mode,
  initialCamera = null,
  groundHeight = 0,
}: CesiumSceneProps) {
  // Until the terrain under the field has been sampled, fly as if the ground
  // could be up to PROVISIONAL_GROUND_M high: the camera lands above the field
  // for nearly all farmland, then the mode effect below re-flies to the exact
  // height (it depends on groundHeight) a moment later.
  const base = ready ? groundHeight : PROVISIONAL_GROUND_M;
  useEffect(() => {
    if (!viewer || !Cesium || !ready || viewer.isDestroyed()) return;

    viewer.entities.removeById("field-boundary");
    viewer.entities.removeById("field-boundary-line");
    if (boundary && showFieldBoundary && boundary.type === "Polygon") {
      const coords = (boundary as GeoJSON.Polygon).coordinates[0];
      const positions = coords.flatMap(([lon, lat]) => [lon, lat]);
      const green = Cesium.Color.fromCssColorString("#22c55e");
      const drape = mode !== "photorealistic"; // splats are not classifiable
      viewer.entities.add({
        id: "field-boundary",
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
          material: green.withAlpha(0.12),
          ...(drape ? { classificationType: Cesium.ClassificationType.BOTH } : { height: groundHeight }),
        },
      });
      // undraped (splat) mode: the line sits just above the splat's ground plane
      const lifted = coords.flatMap(([lon, lat]) => [lon, lat, groundHeight + 1.5]);
      viewer.entities.add({
        id: "field-boundary-line",
        polyline: {
          positions: drape ? Cesium.Cartesian3.fromDegreesArray(positions) : Cesium.Cartesian3.fromDegreesArrayHeights(lifted),
          width: 3,
          material: green,
          clampToGround: drape,
          ...(drape ? { classificationType: Cesium.ClassificationType.BOTH } : {}),
        },
      });
    }
  }, [viewer, Cesium, ready, boundary, showFieldBoundary, mode, groundHeight]);

  useEffect(() => {
    if (!viewer || !Cesium || !cameraReady || viewer.isDestroyed() || centerLat == null || centerLon == null) return;

    if (initialCamera) {
      // a shared exact view needs the exact ground height
      if (!ready) return;
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(initialCamera.lon, initialCamera.lat, groundHeight + initialCamera.height),
        orientation: {
          heading: Cesium.Math.toRadians(initialCamera.heading),
          pitch: Cesium.Math.toRadians(initialCamera.pitch),
          roll: 0,
        },
      });
      return;
    }
    if (mode === "3d-twin") {
      // ~300 m south of the centre at 350 m, looking down 50°: the whole
      // field fills the view with some perspective on the terrain mesh
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat - 0.0027, base + 350),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
        duration: 1.2,
      });
    } else if (mode === "photorealistic") {
      // steep view from the south edge: nadir-only captures reconstruct the
      // ground well but look "needly" at grazing angles
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat - 0.0009, base + 330),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
        duration: 1.2,
      });
    } else if (mode === "field-map") {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, base + 350),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        duration: 1.2,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, Cesium, mode, cameraReady, ready, centerLat, centerLon, initialCamera, groundHeight]);

  useEffect(() => {
    if (!viewer || !Cesium || !ready || viewer.isDestroyed()) return;

    const showPoints = showRgbPoints || showCropDensity;
    for (const img of images) {
      if (img.lat == null || img.lon == null) continue;
      const id = `img-${img.id}`;
      viewer.entities.removeById(id);
      if (!showPoints) continue;

      // Crop Density colors each point by its real measured vegetation
      // fraction (Excess Green Index — see backend vision_service.py);
      // plain coverage mode just marks where a photo was taken.
      let color = Cesium.Color.WHITE.withAlpha(0.85);
      let pixelSize = 5;
      if (showCropDensity && img.vegetation_fraction != null) {
        const [r, g, b] = healthColor(img.vegetation_fraction);
        color = Cesium.Color.fromBytes(r, g, b, 220);
        pixelSize = 8;
      }

      // Placed at the field's sampled ground height rather than clamped to
      // the terrain: CLAMP_TO_GROUND re-picks every point's height against
      // each terrain tile that loads during the camera's descent, which for a
      // 1,378-frame survey froze the page for over a minute (profiled
      // 2026-09-24). A field is flat at this scale, and the globe's depth
      // test is off, so the points still sit on the surface.
      viewer.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(img.lon, img.lat, groundHeight + 1),
        point: {
          pixelSize,
          color,
          outlineColor: Cesium.Color.fromCssColorString("#16a34a"),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }, [viewer, Cesium, ready, images, showRgbPoints, showCropDensity, groundHeight]);

  return null;
}
