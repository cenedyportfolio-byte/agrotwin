"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, Info, Plane } from "lucide-react";
import { api } from "@/lib/api";
import type { FlightCheckItem } from "@/lib/types";

const ICON = {
  ok: <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-healthy" />,
  warn: <AlertTriangle size={15} className="mt-0.5 shrink-0 text-attention" />,
  info: <Info size={15} className="mt-0.5 shrink-0 text-muted-foreground" />,
};

/** How the flight was flown — height, detail, overlap, camera angle, sun, GPS,
 * bands — measured from the photos, with what to change for the next flight.
 * Advice only: processing goes ahead whatever it says. */
export function FlightCheckCard({ surveyId, photos }: { surveyId: string; photos: number }) {
  const { data } = useQuery({
    // the photo count is in the key: a check made while photos were still arriving is redone
    queryKey: ["flight-check", surveyId, photos],
    queryFn: () => api.getFlightCheck(surveyId),
    enabled: photos > 0,
    // the flight's weather is being looked up: ask again until it is in
    refetchInterval: (q) => (q.state.data?.pending ? 4000 : false),
  });
  const [open, setOpen] = useState<boolean | null>(null);
  if (!data || data.status === "unknown") return null;
  const expanded = open ?? data.status === "check";
  const good = data.status === "good";

  return (
    <div className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-3">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-semibold text-sm">
            <Plane size={16} className="text-brand" /> Flight check
          </h2>
          <p className={`mt-1 flex items-center gap-1.5 text-sm ${good ? "text-healthy" : "text-attention"}`}>
            {good ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />} {data.summary}
          </p>
        </div>
        <ChevronDown size={18} className={`mt-0.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <>
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {data.items.map((item) => (
              <Row key={item.key} item={item} />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Measured from the photos&apos; own flight data. Advice for the next flight — this map is made either way.{" "}
            <Link href="/flight-guide" className="text-brand hover:underline">
              How to fly for a good map
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

function Row({ item }: { item: FlightCheckItem }) {
  return (
    <li className="flex gap-2 px-3 py-2">
      {ICON[item.status]}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-muted-foreground">{item.label}</span>
          <span className="font-medium">{item.value}</span>
        </div>
        {item.status === "warn" && item.target && <div className="text-xs text-muted-foreground">Aim for: {item.target}</div>}
        {item.message && (
          <p className={`mt-0.5 text-xs ${item.status === "warn" ? "text-attention" : "text-muted-foreground"}`}>{item.message}</p>
        )}
      </div>
    </li>
  );
}
