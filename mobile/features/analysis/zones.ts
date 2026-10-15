import type { Geometry } from "geojson";
import type { DetectionZone } from "@/types";
import { acresFromM2 } from "@/utils/format";
import { bboxOf, centroidOf, compassLabel, polygonAreaM2, type BBox, type LatLng } from "@/utils/geo";

export interface ZoneView {
  zone: DetectionZone;
  areaM2: number | null;
  centroid: LatLng | null;
  bbox: BBox | null;
  /** "North-West area" relative to the field centre, when known. */
  locationLabel: string | null;
  /** What a farmer walks to: a problem, a thinner area, or possible weeds. */
  kind: SpotKind;
  /** Size in acres (0 when the outline could not be measured). */
  acres: number;
}

export type SpotKind = "problem" | "attention" | "weeds";

/** Smaller than this (about 30 x 30 ft) a spot is mostly a few odd squares of
 * the 16 ft grid: still listed, but behind "show more". Same as the website. */
export const MIN_SPOT_ACRES = 0.02;

const KIND_WEIGHT: Record<SpotKind, number> = { problem: 3, weeds: 2, attention: 1 };

/** Weed candidates, and zones of a trained detector ("<model>:<label>"). */
export function isWeedZone(type: string): boolean {
  return type === "weed_candidate" || type.includes(":");
}

export function spotKind(zone: DetectionZone): SpotKind {
  if (isWeedZone(zone.type)) return "weeds";
  return zone.severity === "low" ? "attention" : "problem";
}

/** The spots that matter most come first: how bad, times how big — a 2-acre
 * thin area outranks a problem speck of a few square yards (as on the website). */
export function rankZones(views: ZoneView[]): ZoneView[] {
  return [...views].sort((a, b) => KIND_WEIGHT[b.kind] * b.acres - KIND_WEIGHT[a.kind] * a.acres || b.zone.confidence - a.zone.confidence);
}

/** The ones worth walking to; the specks are listed behind "show more". */
export function mainSpots(views: ZoneView[]): ZoneView[] {
  return views.filter((v) => v.acres >= MIN_SPOT_ACRES);
}

/** Adds derived, farmer-facing facts (size, where in the field) to raw detection zones, most important first. */
export function enrichZones(
  zones: DetectionZone[],
  field: { center: LatLng | null; boundary: Geometry | null } | null
): ZoneView[] {
  const fieldBBox = field?.boundary ? bboxOf(field.boundary) : null;
  const center = field?.center ?? (fieldBBox ? { latitude: (fieldBBox.south + fieldBBox.north) / 2, longitude: (fieldBBox.west + fieldBBox.east) / 2 } : null);
  const views = zones.map<ZoneView>((zone) => {
    const centroid = centroidOf(zone.geometry);
    const areaM2 = polygonAreaM2(zone.geometry);
    return {
      zone,
      areaM2,
      centroid,
      bbox: bboxOf(zone.geometry),
      locationLabel: centroid && center ? compassLabel(centroid, center, fieldBBox) : null,
      kind: spotKind(zone),
      acres: areaM2 != null ? acresFromM2(areaM2) : 0,
    };
  });
  return rankZones(views);
}

export function countBySeverity(zones: DetectionZone[]): Record<"high" | "medium" | "low", number> {
  const out = { high: 0, medium: 0, low: 0 };
  for (const z of zones) {
    const s = z.severity as string;
    if (s === "high" || s === "medium" || s === "low") out[s] += 1;
  }
  return out;
}

export function countByType(zones: DetectionZone[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const z of zones) out[z.type] = (out[z.type] ?? 0) + 1;
  return out;
}
