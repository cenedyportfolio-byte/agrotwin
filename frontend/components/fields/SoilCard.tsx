"use client";

import { useQuery } from "@tanstack/react-query";
import type { Geometry } from "geojson";
import { Layers, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { formatAcres } from "@/lib/farm";
import { boundsOf, fit } from "@/lib/geoSvg";
import type { DetectionZone, FieldSummary, SoilUnit } from "@/lib/types";

/** One colour per soil, in the order of their share of the field. */
export const SOIL_COLORS = ["#a07850", "#7c9a5c", "#c8a45a", "#6f8fae", "#b8735c", "#8d7aa8", "#5f9488", "#c4927a", "#8a8a5c", "#a4a4a4"];

function details(u: SoilUnit): string {
  return [
    u.drainage,
    u.texture,
    u.organic_matter_pct != null ? `organic matter ${u.organic_matter_pct}%` : null,
    u.ph != null ? `pH ${u.ph}` : null,
    u.slope_pct != null ? `${u.slope_pct}% slope` : null,
    u.flooding && u.flooding !== "None" ? `${u.flooding.toLowerCase()} flooding` : null,
    u.water_table_cm != null ? `water table from ${Math.round(u.water_table_cm / 2.54)} in` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The soil under the field (USDA soil survey): a map of its soils with the
 * latest flight's spots on top, each soil's share and surface layer, and how
 * many spots lie on each — where they lie, never why. */
export function SoilCard({ field, detections }: { field: FieldSummary; detections?: DetectionZone[] }) {
  const { data } = useQuery({
    queryKey: ["soil", field.id, field.boundary_geojson],
    queryFn: () => api.getSoil(field.id),
    refetchInterval: (q) => (q.state.data?.status === "fetching" ? 4000 : false),
    enabled: !!field.boundary_geojson,
  });
  if (!data || data.status === "no_outline" || data.status === "off") return null;

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Layers size={16} className="text-brand" /> Soil
      </h2>
      <span className="text-xs text-muted-foreground">USDA soil survey</span>
    </div>
  );
  if (data.status !== "ok" || !data.units?.length) {
    const text = {
      fetching: "Looking up the soil survey for this field…",
      none: "No soil survey covers this field (the USDA survey is for US fields).",
      unavailable: "The USDA soil service could not be reached; AgroTwin tries again later.",
    }[data.status as "fetching" | "none" | "unavailable"];
    return (
      <section className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-2 text-sm">
        {header}
        <p className="text-muted-foreground">
          {data.status === "fetching" && <Loader2 size={14} className="mr-1 inline animate-spin" />}
          {text}
        </p>
      </section>
    );
  }

  const units = data.units;
  const color = Object.fromEntries(units.map((u, i) => [u.mukey, SOIL_COLORS[i % SOIL_COLORS.length]]));
  const outline: Geometry | null = field.boundary_geojson ? JSON.parse(field.boundary_geojson) : null;
  const shapes = data.geojson?.features ?? [];
  const bounds = boundsOf([...(outline ? [outline] : []), ...shapes.map((f) => f.geometry)]);
  const map = bounds ? fit(bounds, 360) : null;
  const onSoil = new Map(Object.entries(data.spots_by_soil ?? {}));

  return (
    <section className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-3">
      {header}
      <div className="grid gap-4 @xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        {map && (
          <svg viewBox={`0 0 360 ${map.height}`} className="w-full max-h-72 rounded-lg bg-background" role="img" aria-label="Soil map of the field">
            {shapes.map((f) => (
              <path key={f.properties.mukey} d={map.path(f.geometry)} fill={color[f.properties.mukey]} fillOpacity={0.75} stroke="white" strokeWidth={0.6} />
            ))}
            {detections?.map((d) => (
              <path key={d.id} d={map.path(d.geometry)} fill="none" className="stroke-foreground" strokeWidth={1.2} />
            ))}
            {outline && <path d={map.path(outline)} fill="none" className="stroke-foreground" strokeWidth={1.6} strokeDasharray="4 3" />}
          </svg>
        )}
        <ul className="space-y-2.5 text-sm">
          {units.map((u) => {
            const spots = onSoil.get(u.mukey);
            return (
              <li key={u.mukey} className="flex gap-2">
                <span className="mt-1 h-3 w-3 shrink-0 rounded-sm" style={{ background: color[u.mukey] }} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="font-medium">
                      {u.symbol ? `${u.symbol} · ` : ""}
                      {u.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {Math.round(u.share)}% · {formatAcres(u.acres)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">{details(u)}</div>
                  {spots && (
                    <div className="text-xs">
                      {spots.count} {spots.count === 1 ? "spot" : "spots"} of the latest flight on this soil ({formatAcres(spots.acres)})
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        {detections?.length ? "Outlined: the latest flight's spots. " : ""}The soil survey maps soils to about an acre: it shows where
        a spot lies, not why. Talk it over with your agronomist before acting on it.
      </p>
    </section>
  );
}
