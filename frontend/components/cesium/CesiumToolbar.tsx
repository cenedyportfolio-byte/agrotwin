"use client";

import { Map, Globe2, Sparkles } from "lucide-react";
import clsx from "clsx";
import { useDigitalTwinStore, type ViewMode } from "@/lib/digitalTwinStore";

const MODES: { key: ViewMode; label: string; shortLabel: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: "field-map", label: "Field Map", shortLabel: "Map", icon: Map },
  { key: "3d-twin", label: "3D Twin", shortLabel: "3D", icon: Globe2 },
  { key: "photorealistic", label: "Photorealistic", shortLabel: "Realistic", icon: Sparkles },
];

export function CesiumToolbar() {
  const mode = useDigitalTwinStore((s) => s.mode);
  const setMode = useDigitalTwinStore((s) => s.setMode);

  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border bg-surface/90 p-1 shadow-lg backdrop-blur">
      {MODES.map(({ key, label, shortLabel, icon: Icon }) => (
        <button
          key={key}
          onClick={() => setMode(key)}
          className={clsx(
            "flex items-center gap-1 sm:gap-1.5 rounded-lg px-2 sm:px-3 py-1 sm:py-1.5 text-xs font-medium transition-colors",
            mode === key ? "bg-brand text-white" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground"
          )}
        >
          <Icon size={14} />
          <span className="hidden xs:inline sm:inline">{label}</span>
          <span className="xs:hidden sm:hidden">{shortLabel}</span>
        </button>
      ))}
    </div>
  );
}
