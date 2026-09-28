"use client";

import { X } from "lucide-react";
import type { DetectionZone } from "@/lib/types";
import { isWeedZone } from "@/lib/types";
import { detectionTypeLabel } from "@/lib/detectionTypes";

const SEVERITY_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

function title(zone: DetectionZone): string {
  if (zone.type === "weed_candidate") return "🟣 Possible Weeds";
  if (isWeedZone(zone.type)) return "🟣 Model Detection";
  return zone.severity === "low" ? "🟡 Needs Attention" : "🔴 Problem Area";
}

export function DetectionPanel({ zone, onClose }: { zone: DetectionZone; onClose: () => void }) {
  return (
    <div className="pointer-events-auto w-64 rounded-xl border border-border bg-surface/95 shadow-lg backdrop-blur">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h3 className="text-sm font-semibold">{title(zone)}</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X size={15} />
        </button>
      </div>
      <div className="space-y-2.5 px-4 py-3 text-sm">
        <Row label="Type" value={detectionTypeLabel(zone.type)} />
        <Row label="Severity" value={SEVERITY_LABEL[zone.severity] ?? zone.severity} />
        <Row label="Confidence" value={`${Math.round(zone.confidence * 100)}%`} />
        <div>
          <div className="text-xs text-muted-foreground mb-1">Recommended Action</div>
          <div className="text-sm">{zone.recommended_action}</div>
        </div>
        {zone.type === "weed_candidate" && (
          <div className="text-[11px] text-muted-foreground">
            Vegetation growing between the crop rows. The species is not identified from the image.
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
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}
