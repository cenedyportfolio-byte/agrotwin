"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CloudSun } from "lucide-react";
import { api } from "@/lib/api";
import type { SprayHour, SprayWindow } from "@/lib/types";

const CELL: Record<SprayHour["status"], string> = {
  good: "bg-healthy",
  marginal: "bg-attention",
  bad: "bg-problem/80",
  night: "bg-muted-foreground/25",
};
const LEGEND: [SprayHour["status"], string][] = [
  ["good", "Good"],
  ["marginal", "Check the label"],
  ["bad", "Not now"],
  ["night", "Night"],
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-10-15T07:00" at the field → its weekday and hour, as written (no time-zone conversion). */
function parts(time: string) {
  const [d, t] = time.split("T");
  const [y, m, day] = d.split("-").map(Number);
  return { day: d, weekday: DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()], hour: Number(t.slice(0, 2)) };
}

export function hourText(h: number): string {
  return h === 0 ? "midnight" : h === 12 ? "noon" : `${h % 12} ${h < 12 ? "am" : "pm"}`;
}

function windowText(w: SprayWindow): string {
  const a = parts(w.start);
  const b = parts(w.end);
  const end = b.hour === 0 ? "midnight" : hourText(b.hour);
  return `${a.weekday} ${hourText(a.hour)} – ${a.day === b.day || b.hour === 0 ? "" : `${b.weekday} `}${end} (${w.hours} h)`;
}

/** The next two days for spraying at the field, hour by hour — a weather guide;
 * the product label decides. Tap an hour for its wind, temperature and rain. */
export function SprayWeatherCard({ fieldId }: { fieldId: string }) {
  const { data } = useQuery({
    queryKey: ["spray-weather", fieldId],
    queryFn: () => api.getSprayWeather(fieldId),
    staleTime: 15 * 60_000,
    refetchInterval: 30 * 60_000,
  });
  const [picked, setPicked] = useState<SprayHour | null>(null);
  if (!data) return null;
  if (!data.available || !data.hours?.length) {
    return data.reason?.includes("no position") ? null : (
      <section className="rounded-xl border border-border bg-surface p-4 sm:p-5 text-sm">
        <h2 className="flex items-center gap-2 font-semibold">
          <CloudSun size={16} className="text-brand" /> Spray weather
        </h2>
        <p className="mt-1 text-muted-foreground">{data.reason}</p>
      </section>
    );
  }

  const days: { day: string; weekday: string; slots: (SprayHour | null)[] }[] = [];
  for (const h of data.hours) {
    const p = parts(h.time);
    let row = days.find((d) => d.day === p.day);
    if (!row) {
      row = { day: p.day, weekday: p.weekday, slots: Array(24).fill(null) };
      days.push(row);
    }
    row.slots[p.hour] = h;
  }
  const limits = data.limits;
  const shown = picked ?? data.hours.find((h) => h.status !== "night") ?? data.hours[0];

  return (
    <section className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <CloudSun size={16} className="text-brand" /> Spray weather — next 2 days
        </h2>
        <span className="text-xs text-muted-foreground">Open-Meteo forecast</span>
      </div>
      <p className={`text-sm font-medium ${data.next_window ? "text-healthy" : "text-attention"}`}>
        {data.next_window ? `Next good window: ${windowText(data.next_window)}` : "No good spraying window in the next 2 days."}
      </p>

      <div className="space-y-1.5">
        {days.map((d) => (
          <div key={d.day} className="flex items-center gap-2">
            <span className="w-9 shrink-0 text-xs text-muted-foreground">{d.weekday}</span>
            <div className="grid flex-1 grid-cols-24 gap-px">
              {d.slots.map((h, i) =>
                h ? (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setPicked(h)}
                    title={`${d.weekday} ${hourText(i)} · ${h.reason}`}
                    aria-label={`${d.weekday} ${hourText(i)}: ${h.reason}`}
                    className={`h-6 rounded-[3px] ${CELL[h.status]} ${shown === h ? "ring-2 ring-foreground ring-offset-1 ring-offset-surface" : ""}`}
                  />
                ) : (
                  <span key={i} className="h-6" />
                )
              )}
            </div>
          </div>
        ))}
        <div className="relative ml-11 h-3 text-[10px] text-muted-foreground">
          {(
            [
              [0, "midnight"],
              [6, "6 am"],
              [12, "noon"],
              [18, "6 pm"],
            ] as const
          ).map(([h, label]) => (
            <span key={h} className={`absolute ${h ? "-translate-x-1/2" : ""}`} style={{ left: `${(h / 24) * 100}%` }}>
              {label}
            </span>
          ))}
        </div>
      </div>

      {shown && (
        <div className="rounded-lg bg-background px-3 py-2 text-xs">
          <span className="font-medium">
            {parts(shown.time).weekday} {hourText(parts(shown.time).hour)}: {shown.reason}
          </span>
          <span className="text-muted-foreground">
            {" "}
            · wind {shown.wind_mph != null ? `${Math.round(shown.wind_mph)} mph` : "—"}
            {shown.gust_mph != null ? `, gusts ${Math.round(shown.gust_mph)}` : ""} · {shown.temp_f != null ? `${Math.round(shown.temp_f)}°F` : "—"}
            {shown.rain_chance != null ? ` · ${shown.rain_chance}% chance of rain` : ""}
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {LEGEND.map(([status, label]) => (
          <span key={status} className="inline-flex items-center gap-1">
            <span className={`h-2.5 w-2.5 rounded-[2px] ${CELL[status]}`} /> {label}
          </span>
        ))}
      </div>
      {limits && (
        <p className="text-xs text-muted-foreground">
          Good: wind {limits.wind_min_mph}–{limits.wind_max_mph} mph, gusts under {limits.gust_max_mph} mph, no rain for{" "}
          {limits.rain_free_hours} hours, under {limits.max_temp_f}°F, in daylight. A weather guide only — always follow the
          product label, including any dicamba rules.
        </p>
      )}
    </section>
  );
}
