/** How close the camera may zoom. Past a few screen pixels per source pixel
 * (photo) or per training pixel (splat model) the view only gets softer or
 * streakier, never more detailed, so the zoom stops there. Every layer that
 * knows its resolution registers it under a group: within a group the finest
 * layer sets the limit (an NDVI overlay must not stop you zooming into the
 * photo under it), across groups the strictest does.
 *
 * The limit never moves the camera. Switching from the photo (limit ~4 m) to
 * a band layer (~8 m) while zoomed in closer than that used to make Cesium
 * push the camera up to the new limit on the next frame — the picture
 * suddenly zoomed out and everything away from the centre jumped, which looked
 * as if the bands were misplaced. Now the limit is held at the current height
 * (you just cannot zoom in further) and catches up as you zoom out. */

interface ViewerLike {
  isDestroyed?: () => boolean;
  scene: {
    canvas: HTMLCanvasElement;
    screenSpaceCameraController: { minimumZoomDistance: number };
    globe?: { getHeight: (position: unknown) => number | undefined };
  };
  camera: {
    frustum: { fov?: number };
    positionCartographic: { height: number };
    moveEnd?: { addEventListener: (listener: () => void) => () => void };
  };
}

interface Floor {
  group: "imagery" | "splats";
  gsdM: number; // ground metres per source pixel
  maxMagnification: number; // screen pixels allowed per source pixel
}

const CESIUM_DEFAULT_MIN_ZOOM_M = 1.0;
const floors = new WeakMap<object, Map<symbol, Floor>>();
const listeners = new WeakMap<object, () => void>(); // removes the resize + camera listeners

function heightAboveGround(viewer: ViewerLike): number {
  const position = viewer.camera.positionCartographic;
  return position.height - (viewer.scene.globe?.getHeight(position) ?? 0);
}

function apply(viewer: ViewerLike) {
  if (viewer.isDestroyed?.()) return;
  const canvas = viewer.scene.canvas;
  const px = Math.max(canvas.clientWidth, canvas.clientHeight) || 1600;
  const fov = viewer.camera.frustum.fov ?? Math.PI / 3; // spans the larger canvas side
  const byGroup = new Map<string, number>();
  for (const f of floors.get(viewer)?.values() ?? []) {
    const metres = ((f.gsdM / f.maxMagnification) * px) / (2 * Math.tan(fov / 2));
    byGroup.set(f.group, Math.min(byGroup.get(f.group) ?? Infinity, metres));
  }
  const wanted = Math.max(CESIUM_DEFAULT_MIN_ZOOM_M, ...byGroup.values());
  const height = heightAboveGround(viewer);
  viewer.scene.screenSpaceCameraController.minimumZoomDistance =
    Number.isFinite(height) && height < wanted ? Math.max(CESIUM_DEFAULT_MIN_ZOOM_M, height - 0.01) : wanted;
}

/** Registers (or, with null, removes) one layer's resolution limit. */
export function setZoomFloor(viewer: ViewerLike, key: symbol, floor: Floor | null) {
  if (!floors.has(viewer)) floors.set(viewer, new Map());
  const entries = floors.get(viewer)!;
  if (floor) entries.set(key, floor);
  else entries.delete(key);

  if (entries.size && !listeners.has(viewer)) {
    const update = () => apply(viewer);
    window.addEventListener("resize", update);
    const removeCamera = viewer.camera.moveEnd?.addEventListener(update);
    listeners.set(viewer, () => {
      window.removeEventListener("resize", update);
      removeCamera?.();
    });
  } else if (!entries.size && listeners.has(viewer)) {
    listeners.get(viewer)!();
    listeners.delete(viewer);
  }
  apply(viewer);
}
