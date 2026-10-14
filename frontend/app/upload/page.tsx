"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plane, UploadCloud } from "lucide-react";
import { api, ApiError, UPLOAD_BATCH_SIZE } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CROP_TYPES } from "@/lib/farm";
import { useMe } from "@/lib/useMe";
import type { SurveyImage } from "@/lib/types";
import { GcpFileFields, useGcpFileCheck } from "@/components/surveys/GcpFileFields";

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends one batch, retrying when the connection drops or the server hiccups
 * (a phone on a rural connection); a refused file (4xx) is not retried. */
async function sendBatch(surveyId: string, batch: File[], onRetry: (n: number) => void): Promise<SurveyImage[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.uploadSurveyImages(surveyId, batch);
    } catch (err) {
      const permanent = err instanceof ApiError && err.status < 500;
      if (permanent || attempt >= RETRY_DELAYS_MS.length) throw err;
      onRetry(attempt + 1);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

type Phase = { kind: "idle" } | { kind: "uploading"; done: number; retry?: number } | { kind: "starting" } | { kind: "error"; message: string };

export default function UploadPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { isStaff } = useMe();
  const { data: fields } = useQuery({ queryKey: ["fields"], queryFn: api.listFields });
  const { data: farmers } = useQuery({ queryKey: ["farmers"], queryFn: api.listFarmers, enabled: isStaff });

  const [fieldChoice, setFieldChoice] = useState<string | null>(null);
  const [newFieldName, setNewFieldName] = useState("");
  const [crop, setCrop] = useState("soybean");
  const [ownerId, setOwnerId] = useState("");
  const [flightName, setFlightName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // optional: the surveyed positions of the targets laid out for this flight
  const [showGcp, setShowGcp] = useState(false);
  const [gcpFile, setGcpFile] = useState<File | null>(null);
  const [gcpRtk, setGcpRtk] = useState(false);
  const [gcpEpsg, setGcpEpsg] = useState("");

  // the farmer's (only) field is the usual choice; a new field only when there is none
  const fieldId = fieldChoice ?? (fields && fields.length > 0 ? fields[0].id : "__new__");
  const busy = phase.kind === "uploading" || phase.kind === "starting";
  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  // leaving the page stops the upload: say so, and keep a phone's screen on meanwhile
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => undefined);
    return () => {
      window.removeEventListener("beforeunload", warn);
      lock?.release().catch(() => undefined);
    };
  }, [busy]);

  const gcp = useGcpFileCheck(gcpFile, gcpEpsg, (file, epsg) =>
    api.checkGcpFile(file, { epsg, fieldId: fieldId !== "__new__" ? fieldId : undefined })
  );

  const start = async () => {
    if (!files.length) return setPhase({ kind: "error", message: "Choose the photos of the flight first." });
    if (gcpFile && (gcp.error || gcp.checking))
      return setPhase({ kind: "error", message: "Fix or remove the ground control points file first." });
    try {
      let targetFieldId = fieldId;
      if (fieldId === "__new__") {
        if (!newFieldName.trim()) return setPhase({ kind: "error", message: "Give the new field a name." });
        const field = await api.createField(newFieldName.trim(), crop, isStaff && ownerId ? ownerId : undefined);
        targetFieldId = field.id;
        setFieldChoice(field.id);
      }
      const survey = await api.createSurvey(
        targetFieldId,
        flightName.trim() || `Flight — ${new Date().toLocaleDateString()}`
      );

      // a whole flight is hundreds of files: batches keep each request small
      // and let an interrupted upload resume (already-received files are skipped)
      setPhase({ kind: "uploading", done: 0 });
      const received: SurveyImage[] = [];
      for (let i = 0; i < files.length; i += UPLOAD_BATCH_SIZE) {
        const batch = files.slice(i, i + UPLOAD_BATCH_SIZE);
        const done = i;
        received.push(...(await sendBatch(survey.id, batch, (n) => setPhase({ kind: "uploading", done, retry: n }))));
        setPhase({ kind: "uploading", done: Math.min(files.length, i + batch.length) });
      }
      qc.invalidateQueries({ queryKey: ["fields"] });
      qc.invalidateQueries({ queryKey: ["surveys"] });

      if (received.length > 0 && received.every((img) => img.lat == null)) {
        return setPhase({
          kind: "error",
          message:
            "These photos have no GPS position, so they cannot be placed on a map. Use the original files from the drone's memory card — copies from a phone gallery or a messaging app often lose it.",
        });
      }
      // attached before processing starts, so the detailed map is lined up with it;
      // if it cannot be (e.g. points far from the photos) the flight page says why
      let gcpProblem = "";
      if (gcpFile) {
        await api
          .uploadGcpFile(survey.id, gcpFile, { rtk: gcpRtk, epsg: gcpEpsg })
          .catch((err) => (gcpProblem = (err as Error).message));
      }
      setPhase({ kind: "starting" });
      await api.triggerProcessing(survey.id);
      router.push(`/surveys/${survey.id}${gcpProblem ? `?gcp_error=${encodeURIComponent(gcpProblem)}` : ""}`);
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  };

  const pct = files.length && phase.kind === "uploading" ? Math.round((100 * phase.done) / files.length) : 0;

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6 sm:py-8 space-y-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">Upload a flight</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Choose all the photos of one flight from the drone&apos;s memory card. AgroTwin turns them into a map of
            your field and checks how evenly the crop is growing.{" "}
            <Link href="/flight-guide" className="text-brand hover:underline">
              How to fly for a good map
            </Link>
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface p-4 sm:p-5 space-y-4">
          <div>
            <label className="text-sm font-medium">Field</label>
            <select
              value={fieldId}
              disabled={busy}
              onChange={(e) => setFieldChoice(e.target.value)}
              className="mt-1 h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-base sm:text-sm outline-none focus:border-brand"
            >
              {fields?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {isStaff && f.owner_name ? ` — ${f.owner_name}` : ""}
                </option>
              ))}
              <option value="__new__">+ A new field</option>
            </select>
          </div>

          {fieldId === "__new__" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Field name</label>
                <Input
                  value={newFieldName}
                  disabled={busy}
                  onChange={(e) => setNewFieldName(e.target.value)}
                  placeholder="e.g. North 40"
                  className="mt-1 h-11 text-base"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Crop</label>
                <select
                  value={crop}
                  disabled={busy}
                  onChange={(e) => setCrop(e.target.value)}
                  className="mt-1 h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-base sm:text-sm capitalize outline-none focus:border-brand"
                >
                  {CROP_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              {isStaff && (
                <div className="sm:col-span-2">
                  <label className="text-sm font-medium">Farmer</label>
                  <select
                    value={ownerId}
                    disabled={busy}
                    onChange={(e) => setOwnerId(e.target.value)}
                    className="mt-1 h-11 w-full rounded-lg border border-border bg-surface-2 px-3 text-base sm:text-sm outline-none focus:border-brand"
                  >
                    <option value="">Nobody yet (only staff see it)</option>
                    {farmers?.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name ?? f.email}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-sm font-medium">
              Name of this flight <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Input
              value={flightName}
              disabled={busy}
              onChange={(e) => setFlightName(e.target.value)}
              placeholder={`Flight — ${new Date().toLocaleDateString()}`}
              className="mt-1 h-11 text-base"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Photos</label>
            <label className="mt-1 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-2 px-4 py-8 text-center text-sm text-muted-foreground hover:border-brand/50">
              <UploadCloud size={24} />
              {files.length ? (
                <span className="font-medium text-foreground">
                  {files.length} photos · {formatSize(totalBytes)}
                </span>
              ) : (
                "Tap to choose the flight's photos (JPG and TIF)"
              )}
              <input
                type="file"
                accept="image/jpeg,image/jpg,image/tiff,.jpg,.jpeg,.tif,.tiff"
                multiple
                disabled={busy}
                className="hidden"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            <p className="mt-1.5 text-xs text-muted-foreground">
              On a phone, choose them in the Files app from the memory card, not from the photo gallery. Use Wi-Fi for a
              big flight, and keep this page open until it says done.
            </p>
          </div>

          <div>
            {showGcp || gcpFile ? (
              <>
                <label className="text-sm font-medium">
                  Ground control points <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                  The surveyed positions of the checkerboard targets you laid out, as your GPS exports them (CSV with
                  latitude / longitude or easting / northing), or OpenDroneMap&apos;s gcp_list.txt.
                </p>
                <GcpFileFields
                  file={gcpFile}
                  onFile={setGcpFile}
                  rtk={gcpRtk}
                  onRtk={setGcpRtk}
                  epsg={gcpEpsg}
                  onEpsg={setGcpEpsg}
                  info={gcp.info}
                  error={gcp.error}
                  checking={gcp.checking}
                  disabled={busy}
                />
              </>
            ) : (
              <button
                type="button"
                onClick={() => setShowGcp(true)}
                disabled={busy}
                className="text-sm font-medium text-brand hover:underline"
              >
                + Add ground control points (optional)
              </button>
            )}
          </div>

          <Button size="lg" className="h-11 w-full text-base" onClick={start} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />}
            {phase.kind === "uploading"
              ? phase.retry
                ? `Connection lost — trying again (${phase.retry})…`
                : `Uploading ${phase.done} of ${files.length} (${pct}%)…`
              : phase.kind === "starting"
                ? "Starting the map…"
                : "Upload"}
          </Button>

          {phase.kind === "uploading" && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}

          {phase.kind === "error" && <div className="text-sm text-problem">{phase.message}</div>}
        </div>

        <Link href="/flight-guide" className="flex items-center gap-2 text-sm text-brand hover:underline">
          <Plane size={15} /> Flying for the first time? Read the short flight guide.
        </Link>
      </div>
    </AppShell>
  );
}
