"use client";

import type * as GeoJSON from "geojson";
import { useEffect, useRef, useState } from "react";
import type { SurveyImage } from "@/lib/types";
import { useDigitalTwinStore, type ViewMode } from "@/lib/digitalTwinStore";
import { healthColor } from "@/lib/colors";

export interface CesiumSceneProps {
  viewer: any;
  Cesium: any;
  ready: boolean;
  /** The viewer exists. The opening globe spin starts from this moment, and the
   * camera then flies down to the field with a provisional altitude if the
   * ground height is still unknown (`ready`), so a slow terrain service never
   * leaves the user looking at the whole globe. */
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

/** Opening: the whole Earth, turning eastward like the planet itself and
 * easing to a stop with the field in the centre, then a flight down to the
 * field. The spin waits for the globe's imagery (an untextured ball is not
 * worth watching), up to GLOBE_WAIT_MS. Skipped for a deep-linked view and
 * for reduced motion; a click or scroll during the spin goes straight down.
 * Mode switches later fly directly. */
const GLOBE_HEIGHT_M = 20_000_000;
const GLOBE_SPIN_DEG = 40; // the field starts this far west of the view's centre
const GLOBE_WAIT_MS = 4000;
const GLOBE_SPIN_MS = 2500;
const DESCENT_S = 4;
const MODE_SWITCH_S = 1.2;

type Intro = "globe" | "descent" | "done";

/** Cesium moves the height linearly in (eased) flight time, so a descent from
 * orbit spends most of its time high up and ends in a plunge. This easing
 * changes the height by the same factor every moment — a steady zoom — and
 * eases in and out. For flights between very different heights only. */
function steadyZoom(startHeight: number, endHeight: number) {
  const r = Math.max(endHeight, 1) / Math.max(startHeight, 1);
  return (t: number) => (1 - Math.pow(r, t * t * (3 - 2 * t))) / (1 - r);
}

/** Where each mode looks at the field from: lon/lat offset, height above the ground, pitch. */
function homeView(mode: ViewMode, lon: number, lat: number, ground: number) {
  if (mode === "3d-twin") {
    // ~300 m south of the centre at 350 m, looking down 50°: the whole
    // field fills the view with some perspective on the terrain mesh
    return { lon, lat: lat - 0.0027, height: ground + 350, pitch: -50 };
  }
  if (mode === "photorealistic") {
    // steep view from the south edge: nadir-only captures reconstruct the
    // ground well but look "needly" at grazing angles
    return { lon, lat: lat - 0.0009, height: ground + 330, pitch: -70 };
  }
  return { lon, lat, height: ground + 350, pitch: -90 };
}

/** Height above the ground when looking down at one point (a photo's position). */
const POINT_VIEW_M = 120;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

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
  const [intro, setIntro] = useState<Intro>(() => (initialCamera || prefersReducedMotion() ? "done" : "globe"));
  const flight = useRef(0); // only the latest flight's end counts

  useEffect(() => {
    if (intro !== "globe" || !viewer || !Cesium || !cameraReady || viewer.isDestroyed()) return;
    if (centerLat == null || centerLon == null) return;
    const place = (k: number) =>
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(centerLon + GLOBE_SPIN_DEG * (1 - k), centerLat, GLOBE_HEIGHT_M),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    place(0);
    // imagery loaded = the tile queue has filled and emptied again
    let queued = false;
    let loaded = false;
    const removeProgress = viewer.scene.globe.tileLoadProgressEvent.addEventListener((n: number) => {
      if (n > 0) queued = true;
      else if (queued) loaded = true;
    });
    const opened = performance.now();
    let start: number | null = null;
    let frame = 0;
    const spin = () => {
      const now = performance.now();
      if (start === null && (loaded || now - opened > GLOBE_WAIT_MS)) start = now;
      const t = start === null ? 0 : Math.min(1, (now - start) / GLOBE_SPIN_MS);
      place(1 - (1 - t) ** 3); // eases out to a stop over the field
      if (t < 1) frame = requestAnimationFrame(spin);
      else setIntro("descent");
    };
    frame = requestAnimationFrame(spin);
    const skip = () => {
      cancelAnimationFrame(frame);
      place(1);
      setIntro("done");
    };
    const canvas = viewer.scene.canvas as HTMLCanvasElement;
    canvas.addEventListener("pointerdown", skip);
    canvas.addEventListener("wheel", skip, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      removeProgress();
      canvas.removeEventListener("pointerdown", skip);
      canvas.removeEventListener("wheel", skip);
    };
  }, [intro, viewer, Cesium, cameraReady, centerLat, centerLon]);

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
    if (intro === "globe") return;

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
    // the descent from the globe; afterwards (and once the exact ground height
    // replaces the provisional one) a short flight
    const id = ++flight.current;
    const ended = () => {
      if (id === flight.current && intro === "descent") setIntro("done");
    };
    const fly = (lon: number, lat: number, height: number, pitchDeg: number) => {
      const from = viewer.camera.positionCartographic.height;
      const steep = Math.max(from, height) > 10 * Math.max(Math.min(from, height), 1);
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
        duration: intro === "descent" ? DESCENT_S : MODE_SWITCH_S,
        ...(steep ? { easingFunction: steadyZoom(from, height) } : {}),
        complete: ended,
        cancel: ended,
      });
    };
    const home = homeView(mode, centerLon, centerLat, base);
    fly(home.lon, home.lat, home.height, home.pitch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, Cesium, mode, cameraReady, ready, centerLat, centerLon, initialCamera, groundHeight, intro]);

  // One-off moves asked for by the mobile app: back to this mode's view of the
  // field ("Centre"), or straight down at a point (where a photo was taken).
  // Held until the opening flight has landed on the exact ground height, so
  // that flight does not undo it.
  const cameraRequest = useDigitalTwinStore((s) => s.cameraRequest);
  const handledRequest = useRef(0);
  useEffect(() => {
    if (!cameraRequest || cameraRequest.seq === handledRequest.current) return;
    if (!viewer || !Cesium || viewer.isDestroyed() || !ready || intro !== "done" || centerLat == null || centerLon == null) return;
    handledRequest.current = cameraRequest.seq;
    const to =
      cameraRequest.kind === "point"
        ? { lon: cameraRequest.lon, lat: cameraRequest.lat, height: groundHeight + POINT_VIEW_M, pitch: -90 }
        : homeView(mode, centerLon, centerLat, groundHeight);
    flight.current++;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(to.lon, to.lat, to.height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(to.pitch), roll: 0 },
      duration: MODE_SWITCH_S,
    });
  }, [viewer, Cesium, cameraRequest, ready, intro, mode, centerLat, centerLon, groundHeight]);

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
