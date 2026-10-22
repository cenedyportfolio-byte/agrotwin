"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Satellite } from "lucide-react";
import { api } from "@/lib/api";
import type { FieldSummary } from "@/lib/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const W = 360;
const H = 170;
const PAD = { left: 26, right: 8, top: 10, bottom: 18 };

/** "2026-06-03" as a day number (no time zone involved). */
function day(d: string): number {
  const [y, m, dd] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, dd) / 86_400_000;
}

function dateText(d: string): string {
  const [, m, dd] = d.split("-").map(Number);
  return `${MONTHS[m - 1]} ${dd}`;
}

/** What an NDVI means for a crop field, in plain words. */
export function greenness(ndvi: number): string {
  if (ndvi < 0.2) return "bare soil or residue";
  if (ndvi < 0.4) return "low: a young or thin crop, or one drying down";
  if (ndvi < 0.6) return "medium: a canopy filling in or thinning";
  if (ndvi < 0.8) return "high: a dense canopy";
  return "very high: a full canopy";
}

/** The field's crop greenness (average NDVI) on every clear Sentinel-2 pass of
 * the season, with the drone flights marked: the trend between the flights. */
export function SatelliteCard({ field }: { field: FieldSummary }) {
  const { data } = useQuery({
    queryKey: ["satellite", field.id, field.boundary_geojson],
    queryFn: () => api.getSatellite(field.id),
    refetchInterval: (q) => (q.state.data?.status === "fetching" ? 10_000 : false),
    enabled: !!field.boundary_geojson,
  });
  if (!data || data.status === "no_outline" || data.status === "off") return null;

  const points = data.points;
  const x0 = day(data.season.start);
  const x1 = Math.max(day(data.season.end), x0 + 1);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (d: string) => PAD.left + ((day(d) - x0) / (x1 - x0)) * plotW;
  const y = (v: number) => PAD.top + (1 - Math.max(0, Math.min(1, v))) * plotH;
  const months: { at: number; label: string }[] = [];
  const [sy, sm] = data.season.start.split("-").map(Number);
  for (let m = sm - 1; ; m++) {
    const d = `${sy + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-01`;
    if (day(d) > x1) break;
    if (day(d) >= x0) months.push({ at: x(d), label: MONTHS[m % 12] });
  }
  const band = points.filter((p) => p.p10 != null && p.p90 != null);
  const last = points[points.length - 1];

  return (
    <section className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Satellite size={16} className="text-brand" /> Crop greenness from satellite
        </h2>
        <span className="text-xs text-muted-foreground">Sentinel-2 · {data.season.start.slice(0, 4)} season</span>
      </div>

      {data.status === "too_small" ? (
        <p className="text-sm text-muted-foreground">This field is too small for the satellite&apos;s 10 m pixels.</p>
      ) : points.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {data.status === "fetching" ? (
            <>
              <Loader2 size={14} className="mr-1 inline animate-spin" />
              Reading this season&apos;s satellite passes
              {data.progress ? ` (${data.progress.done} of ${data.progress.todo})` : ""}… The first time takes a few minutes.
            </>
          ) : data.status === "unavailable" ? (
            "The satellite catalogue could not be reached; AgroTwin tries again later."
          ) : (
            "No clear satellite pass over this field yet this season."
          )}
        </p>
      ) : (
        <>
          {last && (
            <p className="text-sm">
              Last clear pass, {dateText(last.date)}: <span className="font-medium">{last.ndvi.toFixed(2)}</span> —{" "}
              {greenness(last.ndvi)}.
            </p>
          )}
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl" role="img" aria-label="Crop greenness over the season">
            {[0.2, 0.4, 0.6, 0.8].map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={0.6} />
                <text x={PAD.left - 4} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground" fontSize={8}>
                  {v.toFixed(1)}
                </text>
              </g>
            ))}
            {months.map((m) => (
              <text key={m.label + m.at} x={m.at} y={H - 5} textAnchor="middle" className="fill-muted-foreground" fontSize={8}>
                {m.label}
              </text>
            ))}
            {band.length > 1 && (
              <polygon
                points={[...band.map((p) => `${x(p.date)},${y(p.p90 as number)}`), ...[...band].reverse().map((p) => `${x(p.date)},${y(p.p10 as number)}`)].join(" ")}
                className="fill-healthy/15"
              />
            )}
            {data.flights.map((f) => (
              <g key={f.survey_id}>
                <title>{`Drone flight ${dateText(f.date)}: ${f.name}`}</title>
                <line x1={x(f.date)} x2={x(f.date)} y1={PAD.top} y2={H - PAD.bottom} className="stroke-brand" strokeWidth={1} strokeDasharray="3 2" />
                <path d={`M${x(f.date) - 4} ${PAD.top - 2}L${x(f.date) + 4} ${PAD.top - 2}L${x(f.date)} ${PAD.top + 4}Z`} className="fill-brand" />
              </g>
            ))}
            <polyline points={points.map((p) => `${x(p.date)},${y(p.ndvi)}`).join(" ")} fill="none" className="stroke-healthy" strokeWidth={1.6} />
            {points.map((p) => (
              <circle key={p.date} cx={x(p.date)} cy={y(p.ndvi)} r={2.4} className="fill-healthy">
                <title>{`${dateText(p.date)}: ${p.ndvi.toFixed(2)} (${greenness(p.ndvi)})`}</title>
              </circle>
            ))}
          </svg>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="h-0.5 w-4 bg-healthy" /> Field average (NDVI)
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2.5 w-4 bg-healthy/15" /> Middle 80% of the field
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-3 w-0 border-l border-dashed border-brand" /> Drone flight
            </span>
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        {data.passes > 0 && `${points.length} clear passes of ${data.passes} this season (${data.cloudy} too cloudy). `}
        {data.status === "fetching" && points.length > 0 && "Reading the newest passes… "}
        The satellites pass every few days; their 10 m pixels show the whole crop&apos;s trend between flights, not weeds or
        single plants. Contains modified Copernicus Sentinel data.
      </p>
    </section>
  );
}
