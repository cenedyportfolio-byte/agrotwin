"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp, Loader2, Map as MapIcon, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { formatArea } from "@/lib/farm";
import type { BoundaryFileResult, FieldSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";

/** Where the field's outline comes from — the flight plan (the exact field) or
 * the photo positions (an estimate) — and adding, replacing or removing the
 * flight plan. Every acre figure and health share of the field uses it. */
export function OutlineCard({ field }: { field: FieldSummary }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const updated = (res: BoundaryFileResult, what: string) => {
    qc.setQueryData(["field", field.id], res.field);
    qc.invalidateQueries({ queryKey: ["fields"] });
    const area = formatArea(res.field.area_hectares);
    const recheck = res.rechecking
      ? ` Crop health is being checked again on the new outline (${res.rechecking} ${res.rechecking === 1 ? "flight" : "flights"}); the numbers update in a few minutes.`
      : "";
    setMessage(`${what}${area ? ` · ${area}` : ""}.${recheck}${res.notes.length ? ` ${res.notes.join(" ")}` : ""}`);
  };
  const attach = useMutation({
    mutationFn: (file: File) => api.attachBoundaryFile(field.id, file),
    onMutate: () => setMessage(null),
    onSuccess: (res) => updated(res, `Outline set from the flight plan${res.kind ? ` (${res.kind})` : ""}`),
  });
  const remove = useMutation({
    mutationFn: () => api.removeBoundaryFile(field.id),
    onMutate: () => setMessage(null),
    onSuccess: (res) => updated(res, "Back to the outline estimated from the photos"),
  });

  const fromPlan = field.boundary_source === "flight_plan";
  const area = formatArea(field.area_hectares);
  const busy = attach.isPending || remove.isPending;
  const error = (attach.error ?? remove.error) as Error | null;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <MapIcon size={16} className="text-brand" /> Field outline
          </h2>
          <p className="mt-1 text-sm">
            {fromPlan ? "From the flight plan" : field.boundary_geojson ? "Estimated from where the photos were taken" : "Not known yet"}
            {fromPlan && field.boundary_file && <span className="break-all text-muted-foreground"> · {field.boundary_file}</span>}
            {area && <span className="text-muted-foreground"> · {area}</span>}
          </p>
          {!fromPlan && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Add the flight plan — the area drawn for the mapping mission, as KMZ or KML — for the exact field. Every acre
              figure and health share uses this outline.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => input.current?.click()} disabled={busy}>
            {attach.isPending ? <Loader2 className="animate-spin" /> : <FileUp />}
            {fromPlan ? "Replace" : "Add flight plan (KMZ)"}
          </Button>
          {fromPlan && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                window.confirm("Use the outline estimated from the photos again? The acres and crop health are worked out again on it.") &&
                remove.mutate()
              }
            >
              {remove.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />} Use the photo outline
            </Button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept=".kmz,.kml,application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // the same file can be chosen again after a fix
          if (file) attach.mutate(file);
        }}
      />
      {message && <p className="text-sm text-healthy">{message}</p>}
      {error && <p className="text-sm text-problem">{error.message}</p>}
    </div>
  );
}
