"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Camera, MapPin, Plane, Search, Sprout, UploadCloud } from "lucide-react";
import { api } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { FieldCard } from "@/components/dashboard/FieldCard";
import { SpotList } from "@/components/dashboard/SpotList";
import { useFieldAnalyses } from "@/lib/hooks/useFieldAnalyses";
import { acres, describeZone, flightStatusLabel, formatAcres, mainSpots, sortSpots } from "@/lib/farm";
import { useMe } from "@/lib/useMe";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function DashboardPage() {
  const { me } = useMe();
  const { data: fields, isLoading, isError } = useQuery({ queryKey: ["fields"], queryFn: api.listFields });
  const { data: surveys } = useQuery({ queryKey: ["surveys"], queryFn: api.listSurveys });
  const { data: analyses } = useFieldAnalyses(fields);

  const totalAcres = (fields ?? []).reduce((sum, f) => sum + (f.area_hectares != null ? acres(f.area_hectares) : 0), 0);
  const recentSurveys = [...(surveys ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 4);
  const fieldName = useMemo(() => new Map((fields ?? []).map((f) => [f.id, f.name])), [fields]);
  const spots = useMemo(
    () =>
      sortSpots(
        (analyses ?? []).flatMap(({ field, analysis }) =>
          (analysis?.detections ?? []).map((d) => describeZone(d, field, analysis?.survey_id))
        )
      ),
    [analyses]
  );
  const firstName = me?.name?.split(" ")[0];

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8 space-y-6 sm:space-y-8">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">
            {greeting()}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">Here&apos;s how your fields are doing.</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <SummaryCard icon={Sprout} label="Fields" value={fields ? String(fields.length) : "—"} />
          <SummaryCard icon={MapPin} label="Total area" value={fields ? formatAcres(totalAcres) : "—"} />
          <SummaryCard
            icon={Camera}
            label="Latest flight"
            value={recentSurveys[0] ? flightStatusLabel(recentSurveys[0].status) : "None yet"}
          />
          <SummaryCard icon={Search} label="Spots to check" value={analyses ? String(mainSpots(spots).length) : "—"} />
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Your fields</h2>
            <Link href="/fields" className="text-sm text-brand hover:underline">
              View all
            </Link>
          </div>

          {isLoading && <div className="text-sm text-muted-foreground">Loading your fields…</div>}
          {isError && (
            <div className="text-sm text-problem">Could not load your fields. Check your internet connection and try again.</div>
          )}
          {fields && fields.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground space-y-3">
              <p>No fields yet. Fly your field with the drone, then upload the photos here.</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Link
                  href="/upload"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white"
                >
                  <UploadCloud size={15} /> Upload a flight
                </Link>
                <Link
                  href="/flight-guide"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium"
                >
                  <Plane size={15} /> How to fly
                </Link>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {fields?.map((field) => (
              <FieldCard key={field.id} field={field} />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Spots to check</h2>
              <Link href="/analysis" className="text-sm text-brand hover:underline">
                View all
              </Link>
            </div>
            <SpotList
              spots={spots}
              limit={5}
              showField
              empty="Nothing that stands out in your latest flights."
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Recent flights</h2>
              <Link href="/surveys" className="text-sm text-brand hover:underline">
                View all
              </Link>
            </div>
            <div className="space-y-2">
              {recentSurveys.map((survey) => (
                <Link
                  key={survey.id}
                  href={`/surveys/${survey.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 hover:border-brand/50"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 text-brand shrink-0">
                      <Camera size={15} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{survey.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {fieldName.get(survey.field_id) ?? ""}
                        {survey.survey_date ? ` · ${new Date(survey.survey_date).toLocaleDateString()}` : ""} ·{" "}
                        {survey.frame_count} photos
                      </div>
                    </div>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-muted-foreground">
                    {flightStatusLabel(survey.status)}
                  </span>
                </Link>
              ))}
              {recentSurveys.length === 0 && <div className="text-sm text-muted-foreground">No flights yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3 sm:p-4 flex items-center gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-base sm:text-lg font-semibold leading-tight">{value}</div>
      </div>
    </div>
  );
}
