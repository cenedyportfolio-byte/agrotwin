import type { Geometry, Position } from "geojson";
import type { DetectionZone, FieldSummary } from "@/lib/types";
import { detectionTypeLabel } from "@/lib/detectionTypes";
import { isWeedZone } from "@/lib/types";

/** Farmer-facing wording and units (US): acres, plain words, where a spot is
 * in the field and how big. The backend keeps hectares and m². */

export const CROP_TYPES = ["soybean", "corn", "wheat", "cotton", "rice", "sorghum", "canola", "sunflower", "potato", "other"];

const ACRES_PER_HECTARE = 2.47105;
const M2_PER_ACRE = 4046.86;
const EARTH_M_PER_DEG = 111_320;

export function acres(hectares: number): number {
  return hectares * ACRES_PER_HECTARE;
}

/** "3.2 acres", "14 acres", "0.05 acres". */
export function formatAcres(value: number): string {
  const digits = value >= 10 ? 0 : value >= 1 ? 1 : 2;
  return `${value.toFixed(digits)} ${value === 1 ? "acre" : "acres"}`;
}

export function formatArea(hectares: number | null | undefined): string | null {
  return hectares == null ? null : formatAcres(acres(hectares));
}

/** Whole percent: the decimals only suggest a precision the measurement does not have. */
export function pct(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

/** The health shares are relative to the field itself, which nobody guesses. */
export const HEALTH_EXPLAINER =
  "Compared with the best-growing parts of this same field: “needs attention” grows noticeably less, “problem” less than half as much.";

/** One word for a whole field, from the share of problem area. Most fields
 * have some "needs attention" area (it is relative), so that alone is not a warning. */
export function fieldStatus(field: Pick<FieldSummary, "healthy_area_percent" | "problem_area_percent">) {
  if (field.healthy_area_percent == null) return { kind: "none" as const, label: "Not measured yet" };
  const problem = field.problem_area_percent ?? 0;
  if (problem >= 15) return { kind: "problem" as const, label: "Problem areas" };
  if (problem >= 3) return { kind: "attention" as const, label: "A few spots to check" };
  return { kind: "healthy" as const, label: "Looks even" };
}

function rings(geometry: Geometry): Position[][] {
  if (geometry.type === "Polygon") return [geometry.coordinates[0]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((p) => p[0]);
  return [];
}

/** Area of a lon/lat polygon in m² (flat at field scale). */
export function areaM2(geometry: Geometry): number {
  let total = 0;
  for (const ring of rings(geometry)) {
    if (ring.length < 3) continue;
    const kx = EARTH_M_PER_DEG * Math.cos((ring[0][1] * Math.PI) / 180);
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      s += x1 * kx * y2 * EARTH_M_PER_DEG - x2 * kx * y1 * EARTH_M_PER_DEG;
    }
    total += Math.abs(s) / 2;
  }
  return total;
}

export function centroid(geometry: Geometry): { lat: number; lon: number } | null {
  const pts = rings(geometry).flat();
  if (pts.length === 0) return null;
  return {
    lon: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    lat: pts.reduce((s, p) => s + p[1], 0) / pts.length,
  };
}

const DIRECTIONS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** "north-east part", or "middle" for a spot near the field's centre. */
export function partOfField(point: { lat: number; lon: number }, center: { lat: number; lon: number }): string {
  const dn = (point.lat - center.lat) * EARTH_M_PER_DEG;
  const de = (point.lon - center.lon) * EARTH_M_PER_DEG * Math.cos((center.lat * Math.PI) / 180);
  if (Math.hypot(dn, de) < 20) return "middle";
  const bearing = (Math.atan2(de, dn) * 180) / Math.PI;
  return `${DIRECTIONS[Math.round(((bearing + 360) % 360) / 45) % 8]} part`;
}

export interface Spot {
  zone: DetectionZone;
  fieldId: string;
  fieldName: string;
  title: string;
  kind: "problem" | "attention" | "weeds";
  what: string;
  acres: number;
  where: string | null;
  /** Opens the field map on this spot. */
  href: string;
}

/** A detection zone as a farmer reads it: what, how big, where, and a map link. */
export function describeZone(zone: DetectionZone, field: FieldSummary, surveyId?: string | null): Spot {
  const c = centroid(zone.geometry);
  const kind = isWeedZone(zone.type) ? "weeds" : zone.severity === "low" ? "attention" : "problem";
  const title = kind === "weeds" ? "Possible weeds" : kind === "attention" ? "Needs attention" : "Problem area";
  const params = new URLSearchParams();
  if (surveyId) params.set("survey", surveyId);
  params.set("zone", zone.id);
  if (c) params.set("cam", `${c.lon.toFixed(7)},${c.lat.toFixed(7)},120,0,-90`);
  return {
    zone,
    fieldId: field.id,
    fieldName: field.name,
    title,
    kind,
    what: detectionTypeLabel(zone.type),
    acres: areaM2(zone.geometry) / M2_PER_ACRE,
    where: c && field.center_lat != null && field.center_lon != null
      ? partOfField(c, { lat: field.center_lat, lon: field.center_lon })
      : null,
    href: `/fields/${field.id}/digital-twin?${params.toString()}`,
  };
}

const KIND_WEIGHT = { problem: 3, weeds: 2, attention: 1 };

/** Smaller than this (about 30 x 30 ft) a spot is mostly a few odd squares of
 * the 16 ft grid: still listed, but behind "show more" and not counted. */
export const MIN_SPOT_ACRES = 0.02;

/** The spots that matter most first: how bad, times how big. A 2-acre thin
 * area outranks a problem speck of a few square yards. */
export function sortSpots(spots: Spot[]): Spot[] {
  return [...spots].sort((a, b) => KIND_WEIGHT[b.kind] * b.acres - KIND_WEIGHT[a.kind] * a.acres);
}

export function mainSpots(spots: Spot[]): Spot[] {
  return spots.filter((s) => s.acres >= MIN_SPOT_ACRES);
}

/** A flight's processing state in plain words. */
export function flightStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "COMPLETED":
      return "Ready";
    case "FAILED":
      return "Failed — open the flight";
    case "PENDING":
    case "UPLOADING":
      return "Waiting for photos";
    case "QUEUED":
      return "Waiting in line";
    case null:
    case undefined:
      return "—";
    default:
      return "Processing…";
  }
}

/** A distance for a US farmer: inches below a foot, feet above. */
export function formatDistance(m: number | null | undefined): string {
  if (m == null) return "—";
  const ft = m * 3.28084;
  return ft < 1 ? `${(ft * 12).toFixed(1)} in` : `${ft.toFixed(1)} ft`;
}

/** A checkerboard target's size from its side length: "60 × 60 cm · 0.36 m²"
 * (small markers in cm²: "17 × 17 cm · 289 cm²"). */
export function formatTargetSize(sideM: number): string {
  const side = Math.round(sideM * 100);
  const area = sideM * sideM;
  return `${side} × ${side} cm · ${area < 0.1 ? `${Math.round(area * 10_000)} cm²` : `${area.toFixed(2)} m²`}`;
}
