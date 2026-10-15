"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, Loader2, Server, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { formatWait } from "@/lib/queue";
import { serverTime } from "@/lib/serverTime";
import { useMe } from "@/lib/useMe";
import type { QueueJob } from "@/lib/types";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";

function minutesSince(s: string | null): number | null {
  const t = serverTime(s);
  return t ? Math.max(0, (Date.now() - t.getTime()) / 60_000) : null;
}

function ago(s: string | null): string {
  const m = minutesSince(s);
  if (m == null) return "";
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

function duration(from: string | null, to: string | null): string | null {
  const a = serverTime(from);
  const b = serverTime(to);
  if (!a || !b) return null;
  const m = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Staff: every processing job running or waiting, in the order they will run,
 * and the ones that just finished. A waiting job can be taken out of the line. */
export default function QueuePage() {
  const { isStaff, isPending } = useMe();
  const { data, isLoading, error } = useQuery({ queryKey: ["queue"], queryFn: api.getQueue, enabled: isStaff, refetchInterval: 10_000 });
  const running = data?.jobs.filter((j) => j.status !== "QUEUED") ?? [];
  const waiting = data?.jobs.filter((j) => j.status === "QUEUED") ?? [];
  const s = data?.settings;

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6 sm:py-8 space-y-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">Processing queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Maps being made and waiting, for every farm. Quick maps and crop-health checks take minutes, one at a time;
            detailed maps take hours and have their own line, so they never hold up a quick map.
          </p>
        </div>

        {!isPending && !isStaff ? (
          <p className="text-sm text-muted-foreground">Only AgroTwin staff can see the queue.</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">
            <Loader2 className="inline animate-spin" size={14} /> Loading…
          </p>
        ) : error ? (
          <p className="text-sm text-problem">{(error as Error).message}</p>
        ) : (
          <>
            {s && (
              <section className="rounded-xl border border-border bg-surface p-4 sm:p-5 text-sm space-y-1">
                <h2 className="flex items-center gap-2 font-semibold">
                  <Server size={16} className="text-brand" /> Detailed maps on this server
                </h2>
                {s.detailed_enabled ? (
                  <p>
                    {s.detailed_workers === 1 ? "One at a time" : `${s.detailed_workers} at a time`} ·{" "}
                    {s.detailed_hours ? (
                      <>
                        started only {s.detailed_hours}{" "}
                        <span className={s.detailed_open_now ? "text-healthy" : "text-muted-foreground"}>
                          ({s.detailed_open_now ? "open now" : "closed now"})
                        </span>
                      </>
                    ) : (
                      "started at any time"
                    )}
                  </p>
                ) : (
                  <p>Switched off — only quick maps are made.</p>
                )}
                {s.detailed_hours_setting && !s.detailed_hours && (
                  <p className="text-attention">
                    AGROTWIN_ODM_HOURS is set to &ldquo;{s.detailed_hours_setting}&rdquo;, which is not like 20-6, so it is ignored.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Set on the server: AGROTWIN_ODM_ENABLED, AGROTWIN_ODM_WORKERS (how many at once) and AGROTWIN_ODM_HOURS
                  (e.g. 20-6 for 8 pm–6 am), then restart the API.
                </p>
              </section>
            )}

            <Section title="Running" empty="Nothing is being made right now." jobs={running} />
            <Section title="Waiting" empty="No one is waiting." jobs={waiting} />
            <Section title="Finished in the last 3 days" empty="Nothing finished recently." jobs={data?.recent ?? []} />
          </>
        )}
      </div>
    </AppShell>
  );
}

function Section({ title, empty, jobs }: { title: string; empty: string; jobs: QueueJob[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">
        {title} {jobs.length > 0 && <span className="font-normal text-muted-foreground">({jobs.length})</span>}
      </h2>
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </section>
  );
}

function JobRow({ job }: { job: QueueJob }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelQueuedJob(job.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
  });
  const waiting = job.status === "QUEUED";
  const finished = job.status === "COMPLETED" || job.status === "FAILED";
  const icon = waiting ? (
    <Clock size={16} className="text-muted-foreground" />
  ) : job.status === "COMPLETED" ? (
    <CheckCircle2 size={16} className="text-healthy" />
  ) : job.status === "FAILED" ? (
    <XCircle size={16} className="text-problem" />
  ) : (
    <Loader2 size={16} className="animate-spin text-attention" />
  );

  return (
    <li className="flex gap-3 p-3 sm:p-4 text-sm">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{job.kind}</span>
          <Link href={`/surveys/${job.survey_id}`} className="min-w-0 truncate text-brand hover:underline">
            {[job.field_name, job.survey_name].filter(Boolean).join(" · ") || "Flight"}
          </Link>
        </div>
        <div className="text-xs text-muted-foreground">
          {[job.owner, `${job.photos} photos`].filter(Boolean).join(" · ")}
        </div>
        {waiting && (
          <div className="text-xs">
            {job.place === 1 ? "Next" : `#${job.place}`} on the {job.queue} line
            {job.wait_minutes != null && job.place !== 1 ? ` · starts in ${formatWait(job.wait_minutes)}` : ""} · queued{" "}
            {ago(job.queued_at)}
          </div>
        )}
        {!waiting && !finished && (
          <div className="text-xs">
            {job.step ?? "Working"}
            {job.note ? ` — ${job.note}` : ""} · started {ago(job.started_at)}
          </div>
        )}
        {finished && (
          <div className="text-xs text-muted-foreground">
            {job.status === "COMPLETED" ? "Done" : "Failed"} {ago(job.finished_at)}
            {duration(job.started_at, job.finished_at) ? ` · took ${duration(job.started_at, job.finished_at)}` : ""}
          </div>
        )}
        {job.status === "FAILED" && job.error_message && <div className="text-xs text-problem break-words">{job.error_message}</div>}
        {cancel.error && <div className="text-xs text-problem">{(cancel.error as Error).message}</div>}
      </div>
      {waiting && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 self-start text-muted-foreground hover:text-problem"
          disabled={cancel.isPending}
          onClick={() =>
            window.confirm(`Take this ${job.kind.toLowerCase()} out of the line? The farmer sees it stopped and can start it again.`) &&
            cancel.mutate()
          }
        >
          {cancel.isPending ? <Loader2 className="animate-spin" /> : null} Cancel
        </Button>
      )}
    </li>
  );
}
