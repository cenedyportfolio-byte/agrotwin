"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { HealthBar } from "@/components/dashboard/HealthBar";
import { SpotList } from "@/components/dashboard/SpotList";
import { MethodBadge, MockDataBadge } from "@/components/dashboard/StatusPill";
import { useFieldAnalyses } from "@/lib/hooks/useFieldAnalyses";
import { describeZone, sortSpots } from "@/lib/farm";
import { useMe } from "@/lib/useMe";
import type { RowMetrics } from "@/lib/types";

const ROW_STATUS_LABEL: Record<string, string> = {
  measured: "Weed candidates measured",
  canopy_closed: "Canopy closed — weed candidates not measurable",
  rows_not_locked: "Rows not separable — weed candidates not measurable",
  rows_not_found: "No row pattern found",
  no_rgb_orthomosaic: "No RGB orthomosaic",
  error: "Row analysis failed",
};

function RowMetricsCard({ rows }: { rows: RowMetrics }) {
  return (
    <div className="mt-4 rounded-lg border border-border bg-surface-2/50 p-4 text-xs space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">Crop rows &amp; canopy</span>
        <span className="text-muted-foreground">measured on the orthomosaic · {rows.method}</span>
      </div>
      <div className="grid grid-cols-2 @xl:grid-cols-4 gap-3">
        <Metric label="Row spacing" value={rows.row_spacing_m != null ? `${rows.row_spacing_m} m` : "—"} />
        <Metric label="Row bearing" value={rows.row_orientation_deg != null ? `${rows.row_orientation_deg}°` : "—"} />
        <Metric label="Vegetation cover" value={rows.vegetation_cover_percent != null ? `${rows.vegetation_cover_percent}%` : "—"} />
        <Metric
          label="Canopy closure"
          value={rows.canopy_closure_percent != null ? `${rows.canopy_closure_percent}%` : "—"}
          hint="Share of the ground between rows covered by leaves, where rows could be followed"
        />
      </div>
      <div className={rows.status === "measured" ? "text-healthy" : "text-muted-foreground"}>
        <span className="font-medium">{ROW_STATUS_LABEL[rows.status] ?? rows.status}.</span> {rows.reason}
        {rows.status === "measured" && ` ${rows.candidate_count} candidate patches, ${rows.candidate_area_m2} m² in total.`}
      </div>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

export default function AnalysisPage() {
  const { isStaff } = useMe();
  const { data: fields } = useQuery({ queryKey: ["fields"], queryFn: api.listFields });
  const analyses = useFieldAnalyses(fields);
  const { data: detectors } = useQuery({ queryKey: ["detectors"], queryFn: api.getDetectors, enabled: isStaff });

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-8 space-y-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">Crop health</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">
            How evenly your crop is growing in the latest flight of each field, and the spots worth walking to. The
            drone measures how much green, growing crop there is — it cannot tell why a spot is thin, which weed it
            is, or whether there is disease. Go and look before you act.
          </p>
        </div>

        {isStaff && detectors && detectors.installed.length === 0 && (
          <div className="rounded-xl border border-border bg-surface px-5 py-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Trained detectors: none installed.</span> {detectors.note}{" "}
            <Link href="/settings" className="text-brand hover:underline">
              How to add one
            </Link>
            .
          </div>
        )}

        <div className="space-y-4">
          {analyses.data?.map(({ field, analysis }) => (
            <div key={field.id} className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/fields/${field.id}`} className="font-semibold hover:underline">
                  {field.name}
                </Link>
                <div className="flex items-center gap-2">
                  {analysis && <MethodBadge method={analysis.method} />}
                  {analysis?.is_mock && <MockDataBadge />}
                </div>
              </div>

              {!analysis && <div className="text-sm text-muted-foreground">No flight measured yet.</div>}

              {analysis && (
                <>
                  <HealthBar
                    healthy={analysis.analysis_summary.healthy_area_percent}
                    attention={analysis.analysis_summary.attention_area_percent}
                    problem={analysis.analysis_summary.problem_area_percent}
                    explain
                  />
                  <SpotList
                    spots={sortSpots(analysis.detections.map((d) => describeZone(d, field, analysis.survey_id)))}
                    empty="No spots stand out in this flight."
                  />
                  {isStaff && analysis.metrics?.rows && <RowMetricsCard rows={analysis.metrics.rows} />}
                </>
              )}
            </div>
          ))}

          {fields && fields.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No fields yet.
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
