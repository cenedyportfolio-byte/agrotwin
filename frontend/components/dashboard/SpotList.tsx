"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatAcres, MIN_SPOT_ACRES, type Spot } from "@/lib/farm";

const DOT = { problem: "bg-problem", attention: "bg-attention", weeds: "bg-violet-500" };

/** Places to walk to: what, how big, where in the field; tap opens the map there.
 * `spots` come ranked (sortSpots); the first `limit` sizeable ones show, the
 * rest (and the specks) behind "show more". */
export function SpotList({
  spots,
  showField = false,
  limit = 6,
  empty,
}: {
  spots: Spot[];
  showField?: boolean;
  limit?: number;
  empty?: string;
}) {
  const [all, setAll] = useState(false);
  const main = spots.filter((s) => s.acres >= MIN_SPOT_ACRES).slice(0, limit);
  const shown = all ? spots : main;
  const hidden = spots.length - main.length;

  if (spots.length === 0) {
    return <div className="text-sm text-muted-foreground">{empty ?? "Nothing flagged."}</div>;
  }
  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-surface">
      {shown.length === 0 && <div className="px-4 py-3 text-sm text-muted-foreground">Only very small spots this time.</div>}
      {shown.map((spot) => (
        <Link key={spot.zone.id} href={spot.href} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[spot.kind]}`} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {spot.title} <span className="font-normal text-muted-foreground">· {spot.what}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {showField && `${spot.fieldName} · `}
              {formatAcres(spot.acres)}
              {spot.where && ` · ${spot.where}`}
            </div>
          </div>
          <span className="flex shrink-0 items-center text-xs font-medium text-brand">
            Map <ChevronRight size={14} />
          </span>
        </Link>
      ))}
      {hidden > 0 && (
        <button
          onClick={() => setAll((v) => !v)}
          className="flex w-full items-center justify-center gap-1 px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronDown size={14} className={all ? "rotate-180" : ""} />
          {all ? "Show fewer" : `Show ${hidden} more (smaller spots)`}
        </button>
      )}
    </div>
  );
}
