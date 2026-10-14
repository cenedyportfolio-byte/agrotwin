"use client";

import { useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { GcpFileInfo } from "@/lib/types";

/** Reads the chosen file whenever it or the EPSG code changes (after a pause in
 * typing). Each answer is kept with the file and code it was for, so a stale one
 * never shows and "checking" simply means "no answer yet for these". */
export function useGcpFileCheck(
  file: File | null,
  epsg: string,
  read: (file: File, epsg: string) => Promise<GcpFileInfo>
): { info: GcpFileInfo | null; error: string | null; checking: boolean } {
  const key = file ? `${file.name}|${file.size}|${file.lastModified}|${epsg.trim()}` : null;
  const [answer, setAnswer] = useState<{ key: string; info: GcpFileInfo | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!file || !key) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      read(file, epsg)
        .then((info) => alive && setAnswer({ key, info, error: null }))
        .catch((err) => alive && setAnswer({ key, info: null, error: (err as Error).message }));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // `read` is recreated by callers each render; the file and the code decide
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return { info: null, error: null, checking: false };
  const current = answer?.key === key ? answer : null;
  return { info: current?.info ?? null, error: current?.error ?? null, checking: current === null };
}

const FORMAT_LABEL: Record<GcpFileInfo["format"], string> = {
  "csv-latlon": "latitude / longitude",
  "csv-projected": "easting / northing",
  odm: "OpenDroneMap gcp_list.txt",
};

/** The optional GCP file: the file, whether it was measured with RTK, the
 * coordinate system when it uses UTM / State Plane, and what was read from it. */
export function GcpFileFields({
  file,
  onFile,
  rtk,
  onRtk,
  epsg,
  onEpsg,
  info,
  error,
  checking,
  disabled,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  rtk: boolean;
  onRtk: (rtk: boolean) => void;
  epsg: string;
  onEpsg: (epsg: string) => void;
  info: GcpFileInfo | null;
  error: string | null;
  checking: boolean;
  disabled?: boolean;
}) {
  const askEpsg = !!epsg || info?.format === "csv-projected" || (error?.includes("EPSG") ?? false);
  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border bg-surface-2 px-3 py-3 text-sm text-muted-foreground hover:border-brand/50">
        <FileText size={18} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {file ? <span className="font-medium text-foreground">{file.name}</span> : "Choose the file (CSV or gcp_list.txt)"}
        </span>
        {file && !disabled && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onFile(null);
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Remove
          </button>
        )}
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          disabled={disabled}
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </label>

      {file && (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={rtk}
              disabled={disabled}
              onChange={(e) => onRtk(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-brand"
            />
            <span>
              Measured with an <strong>RTK GPS</strong> (accurate to about an inch)
              <span className="block text-xs text-muted-foreground">
                Then the detailed map is lined up with these points. Leave it unticked for a handheld GPS or phone — the
                points are then only compared, because they are less accurate than the map.
              </span>
            </span>
          </label>

          {askEpsg && (
            <div>
              <label className="text-sm font-medium">
                Coordinate system <span className="font-normal text-muted-foreground">(EPSG code, for UTM or State Plane)</span>
              </label>
              <Input
                value={epsg}
                disabled={disabled}
                onChange={(e) => onEpsg(e.target.value)}
                placeholder="e.g. 6576 — Tennessee State Plane, US feet"
                inputMode="numeric"
                className="mt-1 h-10 text-base"
              />
            </div>
          )}

          {checking && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={13} className="animate-spin" /> Reading the file…
            </div>
          )}
          {error && <div className="text-sm text-problem">{error}</div>}
          {info && !error && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-healthy">
                {info.points.length} {info.points.length === 1 ? "point" : "points"} read
              </span>{" "}
              ({FORMAT_LABEL[info.format]}): {info.points.slice(0, 6).map((p) => p.name).join(", ")}
              {info.points.length > 6 ? ", …" : ""}
              {info.notes.length > 0 && ` · ${info.notes.join(" ")}`}
            </div>
          )}
        </>
      )}
    </div>
  );
}
