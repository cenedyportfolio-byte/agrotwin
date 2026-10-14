"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Crosshair, Loader2, Trash2, UploadCloud } from "lucide-react";
import { api } from "@/lib/api";
import { formatDistance } from "@/lib/farm";
import type { GcpCheck } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { GcpFileFields, useGcpFileCheck } from "./GcpFileFields";

const STATUS_TONE: Record<NonNullable<GcpCheck["report"]>["status"], string> = {
  none: "text-muted-foreground",
  waiting: "text-muted-foreground",
  no_match: "text-problem",
  check_only: "text-muted-foreground",
  applied: "text-healthy",
  aligned: "text-healthy",
  rejected: "text-problem",
};

/** A flight's ground control points: add, replace or remove the file, and how
 * the detailed map compares with each surveyed point (before / after lining up). */
export function GcpCard({ surveyId, busy, initialError }: { surveyId: string; busy: boolean; initialError?: string | null }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["gcp-check", surveyId], queryFn: () => api.getGcpCheck(surveyId) });
  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [rtk, setRtk] = useState(false);
  const [epsg, setEpsg] = useState("");
  const check = useGcpFileCheck(file, epsg, (f, code) => api.uploadGcpFile(surveyId, f, { rtk: false, epsg: code, dryRun: true }));

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["gcp-check", surveyId] });
    qc.invalidateQueries({ queryKey: ["job", surveyId] });
    qc.invalidateQueries({ queryKey: ["survey-gcps", surveyId] });
  };
  const attach = useMutation({
    mutationFn: () => api.uploadGcpFile(surveyId, file as File, { rtk, epsg }),
    onSuccess: () => {
      setEditing(false);
      setFile(null);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => api.deleteGcpFile(surveyId), onSuccess: refresh });
  // a lining-up job just finished: show its outcome
  useEffect(() => {
    if (!busy) qc.invalidateQueries({ queryKey: ["gcp-check", surveyId] });
  }, [busy, qc, surveyId]);

  const report = data?.report ?? null;
  const fileInfo = data?.file ?? null;
  const showForm = editing || !fileInfo;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-sm">
          <Crosshair size={16} className="text-brand" /> Ground control points
          {!fileInfo && <span className="font-normal text-muted-foreground">(optional)</span>}
        </h2>
        {fileInfo && !editing && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
              <UploadCloud /> Replace
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-muted-foreground hover:text-problem"
              disabled={busy || remove.isPending}
              onClick={() => window.confirm("Remove the surveyed points? A map lined up with them goes back to how it was made.") && remove.mutate()}
            >
              {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            </Button>
          </div>
        )}
      </div>

      {initialError && !fileInfo && (
        <div className="text-sm text-problem">The ground control points file could not be used: {initialError}</div>
      )}

      {fileInfo && !editing && (
        <>
          <div className="text-xs text-muted-foreground">
            {fileInfo.points.length} {fileInfo.points.length === 1 ? "point" : "points"} from {fileInfo.filename ?? "the file"} ·{" "}
            {fileInfo.rtk ? "measured with RTK" : "handheld GPS (compared only)"}
          </div>
          {report?.message && <div className={`text-sm ${STATUS_TONE[report.status]}`}>{report.message}</div>}
          {report && report.points.length > 0 && report.status !== "waiting" && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-3 font-normal">Point</th>
                    <th className="py-1 pr-3 font-normal">Target in the map</th>
                    <th className="py-1 pr-3 text-right font-normal">Distance</th>
                    {report.status === "applied" && <th className="py-1 text-right font-normal">After lining up</th>}
                  </tr>
                </thead>
                <tbody>
                  {report.points.map((p) => (
                    <tr key={p.name} className="border-t border-border">
                      <td className="py-1.5 pr-3 font-medium">{p.name}</td>
                      <td className="py-1.5 pr-3 text-muted-foreground">
                        {p.matched ?? "none nearby"}
                        {report.status === "applied" && !p.used && p.matched && (
                          <span className="ml-1 text-xs text-attention">(not used — check this point)</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{formatDistance(p.before_m)}</td>
                      {report.status === "applied" && (
                        <td className="py-1.5 text-right tabular-nums">{formatDistance(p.after_m)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {showForm && (
        <>
          {!fileInfo && (
            <p className="text-xs text-muted-foreground">
              If you surveyed the checkerboard targets of this flight, add their positions (CSV from your GPS, or
              OpenDroneMap&apos;s gcp_list.txt). RTK points line the detailed map up with them; handheld points are compared.
            </p>
          )}
          <GcpFileFields
            file={file}
            onFile={setFile}
            rtk={rtk}
            onRtk={setRtk}
            epsg={epsg}
            onEpsg={setEpsg}
            info={check.info}
            error={check.error}
            checking={check.checking}
            disabled={busy || attach.isPending}
          />
          {attach.isError && <div className="text-sm text-problem">{(attach.error as Error).message}</div>}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => attach.mutate()}
              disabled={!file || !check.info || !!check.error || check.checking || busy || attach.isPending}
            >
              {attach.isPending ? <Loader2 className="animate-spin" /> : <UploadCloud />}
              {fileInfo ? "Use this file" : "Add points"}
            </Button>
            {editing && (
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
