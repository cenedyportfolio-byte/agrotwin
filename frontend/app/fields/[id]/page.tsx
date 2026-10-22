"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { MethodBadge, MockDataBadge } from "@/components/dashboard/StatusPill";
import { Globe2, ArrowRight, Trash2, Loader2, UploadCloud, Pencil, Check, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMe } from "@/lib/useMe";
import { NotAvailable } from "@/components/layout/NotAvailable";
import { CROP_TYPES, describeZone, flightStatusLabel, formatArea, sortSpots } from "@/lib/farm";
import { HealthBar } from "@/components/dashboard/HealthBar";
import { OutlineCard } from "@/components/fields/OutlineCard";
import { SatelliteCard } from "@/components/fields/SatelliteCard";
import { SoilCard } from "@/components/fields/SoilCard";
import { SprayWeatherCard } from "@/components/fields/SprayWeatherCard";
import { SpotList } from "@/components/dashboard/SpotList";
import type { FieldSummary } from "@/lib/types";


export default function FieldDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();

  const { data: field, isError: fieldMissing } = useQuery({ queryKey: ["field", id], queryFn: () => api.getField(id) });
  const { data: surveys } = useQuery({
    queryKey: ["field-surveys", id],
    queryFn: () => api.listFieldSurveys(id),
  });
  const { data: analysis } = useQuery({
    queryKey: ["analysis", field?.latest_survey_id],
    queryFn: () => api.getAnalysis(field?.latest_survey_id as string),
    enabled: !!field?.latest_survey_id,
    retry: false,
  });
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftCrop, setDraftCrop] = useState("soybean");
  const startEditing = () => {
    setDraftName(field?.name ?? "");
    setDraftCrop(field?.crop_type ?? "soybean");
    setEditing(true);
  };
  const save = useMutation({
    mutationFn: () => api.updateField(id, { name: draftName, crop_type: draftCrop }),
    onSuccess: (updated) => {
      qc.setQueryData(["field", id], updated);
      qc.invalidateQueries({ queryKey: ["fields"] });
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteField(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fields"] });
      qc.invalidateQueries({ queryKey: ["surveys"] });
      router.push("/fields");
    },
  });

  if (fieldMissing) {
    return (
      <AppShell>
        <NotAvailable what="field" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-8 space-y-6">
        <div className="flex flex-col @2xl:flex-row @2xl:items-start justify-between gap-4">
          {editing ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <div>
                <label className="text-xs font-medium text-muted-foreground">Field name</label>
                <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} className="mt-1 w-64" autoFocus />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Crop</label>
                <select
                  value={CROP_TYPES.includes(draftCrop) ? draftCrop : "other"}
                  onChange={(e) => setDraftCrop(e.target.value)}
                  className="mt-1 block h-9 rounded-lg border border-border bg-surface-2 px-3 text-sm outline-none focus:border-brand"
                >
                  {CROP_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" size="sm" disabled={save.isPending || !draftName.trim()}>
                {save.isPending ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />} Save
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
                <X size={14} /> Cancel
              </Button>
            </form>
          ) : (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{field?.crop_type}</div>
              <h1 className="flex items-center gap-2 text-xl sm:text-2xl font-semibold">
                {field?.name ?? "Loading…"}
                {field && (
                  <button onClick={startEditing} className="text-muted-foreground hover:text-foreground" title="Rename field / set crop type">
                    <Pencil size={15} />
                  </button>
                )}
              </h1>
              {(field?.area_hectares != null || field?.county) && (
                <p className="text-muted-foreground mt-1 text-xs sm:text-sm">
                  {[formatArea(field.area_hectares), field.county].filter(Boolean).join(" · ")}
                </p>
              )}
              {field && <OwnerPicker field={field} />}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/fields/${id}/digital-twin`}
              className={buttonVariants({ size: "sm", className: "sm:h-10 sm:px-4 sm:py-2 text-xs sm:text-sm bg-brand hover:bg-brand/90 text-white" })}
            >
              <Globe2 size={16} /> Open field map
            </Link>
            <Button
              variant="outline"
              size="sm"
              className="sm:h-10 sm:px-3 sm:py-2 text-xs sm:text-sm text-muted-foreground hover:text-problem"
              onClick={() => {
                if (window.confirm(`Delete "${field?.name}" and all of its flights? This cannot be undone.`))
                  remove.mutate();
              }}
              disabled={remove.isPending}
              title="Delete this field"
            >
              {remove.isPending ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />}
            </Button>
          </div>
        </div>
        {remove.isError && <div className="text-sm text-problem">{(remove.error as Error).message}</div>}
        {save.isError && <div className="text-sm text-problem">{(save.error as Error).message}</div>}

        {field && <OutlineCard field={field} />}

        {field?.center_lat != null && <SprayWeatherCard fieldId={id} />}

        {field?.healthy_area_percent != null && (
          <div className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-sm">Crop health — latest flight</h2>
              <div className="flex items-center gap-2">
                <MethodBadge method={field.analysis_method} />
                {field.analysis_is_mock && <MockDataBadge />}
              </div>
            </div>
            <HealthBar
              healthy={field.healthy_area_percent}
              attention={field.attention_area_percent}
              problem={field.problem_area_percent}
              explain
            />
            {analysis && (
              <div>
                <h3 className="mb-2 text-sm font-medium">Spots to check</h3>
                <SpotList
                  spots={sortSpots(analysis.detections.map((d) => describeZone(d, field, analysis.survey_id)))}
                  empty="No spots stand out in this flight."
                />
              </div>
            )}
          </div>
        )}

        {field && <SoilCard field={field} detections={analysis?.detections} />}
        {field && <SatelliteCard field={field} />}

        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-sm">Flights</h2>
            <Link href="/upload" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
              <UploadCloud size={13} /> Upload a flight
            </Link>
          </div>
          <div className="space-y-2">
            {surveys?.map((survey) => (
              <Link
                key={survey.id}
                href={`/surveys/${survey.id}`}
                className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 hover:border-brand/50 transition-colors"
              >
                <div>
                  <div className="font-medium text-sm">{survey.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {survey.survey_date ? `${new Date(survey.survey_date).toLocaleDateString()} · ` : ""}
                    {survey.frame_count} photos · {flightStatusLabel(survey.status)}
                  </div>
                </div>
                <ArrowRight size={16} className="text-muted-foreground" />
              </Link>
            ))}
            {surveys && surveys.length === 0 && (
              <div className="text-sm text-muted-foreground">No flights uploaded for this field yet.</div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** Staff only: which farmer this field belongs to (they see it, nobody else does). */
function OwnerPicker({ field }: { field: FieldSummary }) {
  const qc = useQueryClient();
  const { isStaff } = useMe();
  const { data: farmers } = useQuery({ queryKey: ["farmers"], queryFn: api.listFarmers, enabled: isStaff });
  const move = useMutation({
    mutationFn: (ownerId: string) => api.updateField(field.id, { owner_id: ownerId }),
    onSuccess: (updated) => {
      qc.setQueryData(["field", field.id], updated);
      qc.invalidateQueries({ queryKey: ["fields"] });
    },
  });
  if (!isStaff) return null;
  return (
    <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      Farmer
      <select
        value={field.owner_id ?? ""}
        disabled={move.isPending || !farmers}
        onChange={(e) => e.target.value && move.mutate(e.target.value)}
        className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground"
      >
        {!field.owner_id && <option value="">Nobody yet (only staff see it)</option>}
        {farmers?.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name ?? f.email}
          </option>
        ))}
      </select>
      {move.isPending && <Loader2 className="animate-spin" size={13} />}
      {move.isError && <span className="text-problem">{(move.error as Error).message}</span>}
    </label>
  );
}
