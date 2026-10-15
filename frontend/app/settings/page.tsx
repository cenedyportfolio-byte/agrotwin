"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, LogOut, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BASEMAPS, activeBasemapId } from "@/lib/basemap";
import { ROLE_LABEL, useMe } from "@/lib/useMe";
import { serverDay } from "@/lib/serverTime";

const TERRAIN = process.env.NEXT_PUBLIC_TERRAIN === "ellipsoid" ? "ellipsoid" : "esri";

export default function SettingsPage() {
  const basemap = BASEMAPS[activeBasemapId()];
  const { me, isStaff } = useMe();
  const { data: agreement } = useQuery({ queryKey: ["agreement"], queryFn: api.getAgreement });
  const { data: detectors } = useQuery({ queryKey: ["detectors"], queryFn: api.getDetectors, enabled: isStaff });
  const { data: knowledge } = useQuery({
    queryKey: ["knowledge-topics"],
    queryFn: api.getKnowledgeTopics,
    enabled: isStaff,
  });

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6 sm:py-8 space-y-6">
        <h1 className="text-xl sm:text-2xl font-semibold">Settings</h1>

        <section className="rounded-xl border border-border bg-surface p-5 text-sm space-y-4">
          <h2 className="font-semibold text-sm">Your account</h2>
          {me && (
            <div className="space-y-1">
              <Row label="Name" value={me.name ?? "—"} />
              <Row label="Email" value={me.email} />
              <Row label="Role" value={ROLE_LABEL[me.role]} />
              {agreement && (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground shrink-0">Data agreement</span>
                  <span className="min-w-0 text-right">
                    {agreement.accepted && agreement.accepted_at
                      ? `Agreed ${serverDay(agreement.accepted_at)} · `
                      : ""}
                    <Link href="/agreement?next=/settings" className="text-brand hover:underline">
                      Read it
                    </Link>
                  </span>
                </div>
              )}
            </div>
          )}
          <PasswordForm />
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={async () => {
              await api.logout().catch(() => undefined);
              // a full load on purpose: on a shared phone the next person must not
              // see this farmer's cached fields
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.assign("/login");
            }}
          >
            <LogOut />
            Sign out
          </Button>
        </section>

        <DeleteAccount />

        {isStaff && (
          <>
            <section className="rounded-xl border border-border bg-surface p-5 text-sm space-y-2">
              <h2 className="font-semibold text-sm">This installation</h2>
              <Row label="API URL" value={process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"} mono />
              <Row label="Storage" value="Local filesystem" />
              <Row label="Database" value="SQLite (local)" />
              <Row label="Authentication" value="Sign-in required (admin · operator · farmer)" />
            </section>

            <section className="rounded-xl border border-border bg-surface p-5 text-sm space-y-3">
              <h2 className="font-semibold text-sm">Map sources</h2>
              <div className="space-y-1">
                <Row label="Basemap" value={basemap.name} />
                <Row label="Licence" value={basemap.license} />
                <Row label="Coverage" value={basemap.coverage} />
                <Row label="Fallback" value={`${BASEMAPS.eox.name} — ${BASEMAPS.eox.license}`} />
                <Row
                  label="3D terrain"
                  value={
                    TERRAIN === "esri"
                      ? "Esri World Elevation 3D (proprietary; needs an ArcGIS licence for commercial use)"
                      : "None (ellipsoid) — the survey's own reconstructed terrain is still shown"
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Choose with <code className="font-mono">NEXT_PUBLIC_BASEMAP</code> (usgs · eox · esri) and{" "}
                <code className="font-mono">NEXT_PUBLIC_TERRAIN</code> (esri · ellipsoid) in <code className="font-mono">frontend/.env.local</code>, then restart the web app. Your own
                survey products (orthomosaic, indices, 3D) are always served locally and are unaffected.
              </p>
            </section>

            <section className="rounded-xl border border-border bg-surface p-5 text-sm space-y-3">
              <h2 className="font-semibold text-sm">AI models</h2>
              {detectors && (
                <>
                  {detectors.installed.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{detectors.note}</p>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {detectors.installed.map((d) => (
                        <li key={d.name}>
                          <span className="font-medium">{d.name}</span> — {d.task} ({d.framework}){" "}
                          {d.ready ? <span className="text-healthy">ready</span> : <span className="text-attention">{d.problem}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    To add one, place a folder with <code className="font-mono">manifest.json</code> and the weights under{" "}
                    <code className="font-mono break-all">{detectors.models_dir}</code>. It then runs on the orthomosaic during analysis and its detections are labelled with the model name.
                  </p>
            </>
          )}
          <Row label="Assistant" value="Local Ollama model when running, otherwise the template responder; both cite the local knowledge base" />
          {knowledge && (
            <p className="text-xs text-muted-foreground">
              Knowledge base topics: {knowledge.topics.map((t) => t.title).join(" · ")} (backend/app/knowledge/*.md — plain Markdown, edit or add files).
            </p>
          )}
        </section>
          </>
        )}
      </div>
    </AppShell>
  );
}

/** Deletes the account and all its data, after the password and DELETE typed. */
function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const remove = useMutation({
    mutationFn: () => api.deleteAccount(password, confirm),
    // a full load: nothing of the deleted account stays cached
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    onSuccess: () => window.location.assign("/"),
  });
  const ready = !!password && confirm.trim().toUpperCase() === "DELETE";

  return (
    <section className="rounded-xl border border-problem/30 bg-surface p-5 text-sm space-y-3">
      <h2 className="font-semibold text-sm">Delete my account</h2>
      <p className="text-muted-foreground">
        Deletes your account and everything AgroTwin keeps for it: your fields and their outlines, and every
        flight&apos;s uploaded photos, maps, 3D views and crop-health results. This cannot be undone. Photos still on
        your drone&apos;s memory card or your computer are not touched.
      </p>
      {!open ? (
        <Button variant="outline" className="text-problem hover:text-problem" onClick={() => setOpen(true)}>
          <Trash2 /> Delete my account…
        </Button>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) remove.mutate();
          }}
        >
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10 text-base"
          />
          <Input
            placeholder="Type DELETE to confirm"
            autoCapitalize="characters"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="h-10 text-base"
          />
          {remove.error && <p className="text-xs text-problem">{(remove.error as Error).message}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!ready || remove.isPending} className="bg-problem text-white hover:bg-problem/90">
              {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete my account and data
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
                setPassword("");
                setConfirm("");
                remove.reset();
              }}
            >
              Keep my account
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: boolean }>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ busy: true });
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setState({ done: true });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">Change password</div>
      <Input
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        required
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        className="h-10 text-base"
      />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder="New password (at least 8 characters)"
        required
        minLength={8}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className="h-10 text-base"
      />
      {state.error && <p className="text-xs text-problem">{state.error}</p>}
      {state.done && <p className="text-xs text-healthy">Password changed. Your other devices were signed out.</p>}
      <Button type="submit" variant="secondary" disabled={state.busy}>
        {state.busy && <Loader2 className="animate-spin" />}
        Change password
      </Button>
    </form>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`min-w-0 text-right break-words ${mono ? "font-mono text-xs break-all" : ""}`}>{value}</span>
    </div>
  );
}
