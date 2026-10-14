"use client";

import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { isMarker, type GroundControlPoint } from "@/lib/types";

/** 36.0969 → 36°05'48.84"N — what a handheld GPS shows by default. */
function dms(value: number, positive: string, negative: string): string {
  const a = Math.abs(value);
  const d = Math.floor(a);
  const mFull = (a - d) * 60;
  const m = Math.floor(mFull);
  const s = (mFull - m) * 60;
  return `${d}°${String(m).padStart(2, "0")}'${s.toFixed(2).padStart(5, "0")}"${value >= 0 ? positive : negative}`;
}

/** The Clipboard API exists only on https / localhost; the app is also opened
 * over plain http on the LAN (phones, the mobile app's WebView). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** A ground control target's position, shown on click or tap — the only way to
 * read it on a phone, where there is no cursor readout. */
export function GcpPanel({ gcp, onClose }: { gcp: GroundControlPoint; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const latLon = `${gcp.lat.toFixed(7)}, ${gcp.lon.toFixed(7)}`;
  const size = gcp.size_m != null ? ` · ${Math.round(gcp.size_m * 100)} cm` : "";

  const copy = async () => {
    if (await copyText(latLon)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="pointer-events-auto w-full rounded-xl border border-border bg-surface/95 shadow-lg backdrop-blur sm:w-64">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 sm:py-2.5">
        <div>
          <h3 className="text-sm font-semibold">{gcp.name}</h3>
          <div className="text-[11px] text-muted-foreground">
            {gcp.source === "surveyed"
              ? `Surveyed point · ${gcp.rtk ? "RTK" : "handheld GPS"}`
              : isMarker(gcp)
                ? "Small marker"
                : "Ground control target"}
            {gcp.source === "surveyed" ? "" : size}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X size={15} />
        </button>
      </div>
      <div className="space-y-2 px-4 py-2.5 text-sm sm:space-y-2.5 sm:py-3">
        <Row label="Latitude" value={gcp.lat.toFixed(7)} />
        <Row label="Longitude" value={gcp.lon.toFixed(7)} />
        <div className="select-all text-right text-xs text-muted-foreground tabular-nums">
          {dms(gcp.lat, "N", "S")} {dms(gcp.lon, "E", "W")}
        </div>
        {gcp.height_m != null && (
          <Row
            label="Elevation"
            value={`${gcp.height_m.toFixed(2)} m`}
            hint={gcp.source === "surveyed" ? "From your GCP file" : "Surface height from the photogrammetry (its own vertical datum)"}
          />
        )}
        <button
          onClick={copy}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
        >
          {copied ? <Check size={13} className="text-brand" /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy coordinates"}
        </button>
        <div className="hidden text-[11px] text-muted-foreground sm:block">
          {gcp.source === "surveyed"
            ? "WGS84, as in your ground control points file."
            : "WGS84, centre of the target as found in the photogrammetric orthophoto."}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-2" title={hint}>
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="select-all font-medium text-right tabular-nums">{value}</span>
    </div>
  );
}
