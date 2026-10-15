"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FolderOpen, Loader2, Map as MapIcon, Plane, UploadCloud } from "lucide-react";
import { api, ApiError, UPLOAD_BATCH_SIZE } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CROP_TYPES, formatArea } from "@/lib/farm";
import { useFileCheck } from "@/lib/useFileCheck";
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

const PHOTO_RE = /\.(jpe?g|tiff?)$/i;
const DJI_DAY_RE = /^DJI_(\d{4})(\d{2})(\d{2})\d{6}_/i;

/** One folder of a chosen directory and the flight photos in it. */
interface FolderGroup {
  key: string;
  label: string;
  /** The day most of its photos were taken (DJI file names), "2026-06-03". */
  day: string | null;
  files: File[];
}

/** The photos in a chosen folder and its subfolders, grouped by the folder they
 * are in: DJI starts a new folder with every battery, and a memory card often
 * holds flights from several days. Everything else (logs, timestamps) is skipped. */
function groupFolder(list: File[]): { groups: FolderGroup[]; skipped: number } {
  const byFolder = new Map<string, File[]>();
  let skipped = 0;
  for (const f of list) {
    if (!PHOTO_RE.test(f.name)) {
      skipped += 1;
      continue;
    }
    const path = f.webkitRelativePath || f.name;
    const key = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const group = byFolder.get(key);
    if (group) group.push(f);
    else byFolder.set(key, [f]);
  }
  const groups = [...byFolder.entries()].map(([key, files]) => {
    const count = new Map<string, number>();
    for (const f of files) {
      const m = DJI_DAY_RE.exec(f.name);
      if (m) count.set(`${m[1]}-${m[2]}-${m[3]}`, (count.get(`${m[1]}-${m[2]}-${m[3]}`) ?? 0) + 1);
    }
    const day = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { key, label: key.split("/").pop() || "the chosen folder", day, files };
  });
  groups.sort((a, b) => (a.day ?? "").localeCompare(b.day ?? "") || a.key.localeCompare(b.key));
  return { groups, skipped };
}

const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

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
  // or a whole folder (the memory card's DCIM), with its subfolders to tick
  const [folder, setFolder] = useState<{ groups: FolderGroup[]; skipped: number } | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // optional: the flight plan — the area drawn for the mission, the exact field outline
  const [showPlan, setShowPlan] = useState(false);
  const [planFile, setPlanFile] = useState<File | null>(null);
  // optional: the surveyed positions of the targets laid out for this flight
  const [showGcp, setShowGcp] = useState(false);
  const [gcpFile, setGcpFile] = useState<File | null>(null);
  const [gcpRtk, setGcpRtk] = useState(false);
  const [gcpEpsg, setGcpEpsg] = useState("");

  // the farmer's (only) field is the usual choice; a new field only when there is none
  const fieldId = fieldChoice ?? (fields && fields.length > 0 ? fields[0].id : "__new__");
  const busy = phase.kind === "uploading" || phase.kind === "starting";
  const photos = folder ? folder.groups.filter((g) => ticked.has(g.key)).flatMap((g) => g.files) : files;
  const totalBytes = photos.reduce((n, f) => n + f.size, 0);
  const folderDays = folder ? [...new Set(folder.groups.map((g) => g.day).filter((d): d is string => !!d))] : [];

  const pickFolder = (list: FileList | null) => {
    const result = groupFolder(Array.from(list ?? []));
    const days = [...new Set(result.groups.map((g) => g.day).filter(Boolean))].sort();
    // photos from several days: most likely several flights — the newest is ticked
    const newest = days.at(-1);
    setTicked(new Set(result.groups.filter((g) => days.length <= 1 || g.day === newest).map((g) => g.key)));
    setFolder(result);
    setFiles([]);
  };

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
  const plan = useFileCheck(planFile, fieldId, (file) => api.checkBoundaryFile(file, fieldId !== "__new__" ? fieldId : undefined));

  const start = async () => {
    if (!photos.length) return setPhase({ kind: "error", message: "Choose the photos of the flight first." });
    if (gcpFile && (gcp.error || gcp.checking))
      return setPhase({ kind: "error", message: "Fix or remove the ground control points file first." });
    if (planFile && (plan.error || plan.checking))
      return setPhase({ kind: "error", message: "Fix or remove the flight plan first." });
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
      for (let i = 0; i < photos.length; i += UPLOAD_BATCH_SIZE) {
        const batch = photos.slice(i, i + UPLOAD_BATCH_SIZE);
        const done = i;
        received.push(...(await sendBatch(survey.id, batch, (n) => setPhase({ kind: "uploading", done, retry: n }))));
        setPhase({ kind: "uploading", done: Math.min(photos.length, i + batch.length) });
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
      // the outline first: processing then measures the field inside it (and
      // leaves it as it is); if it cannot be used, the flight page says why
      let outlineProblem = "";
      if (planFile) {
        await api
          .attachBoundaryFile(targetFieldId, planFile)
          .catch((err) => (outlineProblem = (err as Error).message));
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
      const problems = new URLSearchParams();
      if (gcpProblem) problems.set("gcp_error", gcpProblem);
      if (outlineProblem) problems.set("outline_error", outlineProblem);
      router.push(`/surveys/${survey.id}${problems.size ? `?${problems}` : ""}`);
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  };

  const pct = photos.length && phase.kind === "uploading" ? Math.round((100 * phase.done) / photos.length) : 0;

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
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
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
              {photos.length ? (
                <span className="font-medium text-foreground">
                  {photos.length} photos · {formatSize(totalBytes)}
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
                onChange={(e) => {
                  setFolder(null);
                  setFiles(Array.from(e.target.files ?? []));
                }}
              />
            </label>
            <label
              className={`mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-brand ${busy ? "opacity-50" : "cursor-pointer hover:underline"}`}
            >
              <FolderOpen size={15} /> Or choose the whole folder from the memory card
              <input
                type="file"
                multiple
                disabled={busy}
                className="hidden"
                // a folder picker: React has no prop for it, so it is set on the element
                ref={(el) => el?.setAttribute("webkitdirectory", "")}
                onChange={(e) => pickFolder(e.target.files)}
              />
            </label>
            {folder && (
              <div className="mt-2 space-y-2 rounded-lg border border-border bg-surface-2 p-3 text-sm">
                <div className="text-xs text-muted-foreground">
                  {folder.groups.reduce((n, g) => n + g.files.length, 0)} photos in{" "}
                  {folder.groups.length === 1 ? "the folder" : `${folder.groups.length} folders`}
                  {folder.skipped > 0 && ` · ${folder.skipped} other files skipped (not photos)`}
                </div>
                {folder.groups.length === 0 && <div className="text-problem">No drone photos (JPG or TIF) in this folder.</div>}
                {folder.groups.length > 1 && (
                  <>
                    <div className="text-xs">
                      {folderDays.length > 1
                        ? "These photos are from more than one day — probably more than one flight. Only the newest day is ticked; tick the folders of this flight."
                        : "DJI starts a new folder with each battery. All folders of this flight are ticked."}
                    </div>
                    {folder.groups.map((g) => (
                      <label key={g.key} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={ticked.has(g.key)}
                          disabled={busy}
                          onChange={(e) =>
                            setTicked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(g.key);
                              else next.delete(g.key);
                              return next;
                            })
                          }
                          className="h-4 w-4 accent-brand"
                        />
                        <span className="min-w-0 truncate">
                          {g.label}
                          <span className="text-muted-foreground">
                            {g.day ? ` · ${dayLabel(g.day)}` : ""} · {g.files.length} photos
                          </span>
                        </span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            )}
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

          <div>
            {showPlan || planFile ? (
              <>
                <label className="text-sm font-medium">
                  Flight plan <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                  The area drawn for the mapping mission: the KMZ from DJI Pilot 2, or a KML/KMZ outline of the field. It
                  becomes the exact field outline; without it the outline is estimated from where the photos were taken.
                </p>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border bg-surface-2 px-3 py-3 text-sm text-muted-foreground hover:border-brand/50">
                  <MapIcon size={18} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {planFile ? <span className="font-medium text-foreground">{planFile.name}</span> : "Choose the flight plan (KMZ or KML)"}
                  </span>
                  {planFile && !busy && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        setPlanFile(null);
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Remove
                    </button>
                  )}
                  <input
                    type="file"
                    accept=".kmz,.kml,application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml"
                    disabled={busy}
                    className="hidden"
                    onChange={(e) => setPlanFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                {plan.checking && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 size={13} className="animate-spin" /> Reading the flight plan…
                  </div>
                )}
                {plan.error && <div className="mt-2 text-sm text-problem">{plan.error}</div>}
                {plan.info && !plan.error && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    <span className="font-medium text-healthy">Outline read</span> ({plan.info.kind}):{" "}
                    {formatArea(plan.info.area_hectares)}
                    {plan.info.notes.length > 0 && ` · ${plan.info.notes.join(" ")}`}
                  </div>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => setShowPlan(true)}
                disabled={busy}
                className="text-sm font-medium text-brand hover:underline"
              >
                + Add the flight plan (KMZ, optional)
              </button>
            )}
          </div>

          <Button size="lg" className="h-11 w-full text-base" onClick={start} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />}
            {phase.kind === "uploading"
              ? phase.retry
                ? `Connection lost — trying again (${phase.retry})…`
                : `Uploading ${phase.done} of ${photos.length} (${pct}%)…`
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
