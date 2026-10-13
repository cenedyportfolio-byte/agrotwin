"use client";

import { X } from "lucide-react";
import type { DetectionZone, FieldSummary } from "@/lib/types";
import { detectionTypeLabel } from "@/lib/detectionTypes";
import { describeZone, formatAcres } from "@/lib/farm";
import { useMe } from "@/lib/useMe";

const DOT = { problem: "bg-problem", attention: "bg-attention", weeds: "bg-violet-500" };
const SEVERITY_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

/** A tapped zone: what it is, how big, where, and what to look for on foot. */
export function DetectionPanel({
  zone,
  field,
  onClose,
}: {
  zone: DetectionZone;
  field: FieldSummary | null;
  onClose: () => void;
}) {
  const { isStaff } = useMe();
  const spot = field ? describeZone(zone, field) : null;
  const kind = spot?.kind ?? (zone.severity === "low" ? "attention" : "problem");

  return (
    <div className="pointer-events-auto w-full rounded-xl border border-border bg-surface/95 shadow-lg backdrop-blur sm:w-72">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <span className={`h-2.5 w-2.5 rounded-full ${DOT[kind]}`} />
          {spot?.title ?? "Needs attention"}
        </h3>
        <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X size={15} />
        </button>
      </div>
      <div className="space-y-2 px-4 py-3 text-sm">
        <Row label="What" value={detectionTypeLabel(zone.type)} />
        {spot && <Row label="Size" value={formatAcres(spot.acres)} />}
        {spot?.where && <Row label="Where" value={`${spot.where} of the field`} />}
        <div>
          <div className="mb-1 text-xs text-muted-foreground">What to check</div>
          <div className="text-sm">{zone.recommended_action}</div>
        </div>
        {isStaff && (
          <div className="text-[11px] text-muted-foreground">
            Severity {SEVERITY_LABEL[zone.severity] ?? zone.severity} · confidence {Math.round(zone.confidence * 100)}%
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="font-medium text-right">{value.charAt(0).toUpperCase() + value.slice(1)}</span>
    </div>
  );
}
