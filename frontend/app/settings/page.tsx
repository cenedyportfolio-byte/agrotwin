"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { BASEMAPS, activeBasemapId } from "@/lib/basemap";

const TERRAIN = process.env.NEXT_PUBLIC_TERRAIN === "ellipsoid" ? "ellipsoid" : "esri";

export default function SettingsPage() {
  const basemap = BASEMAPS[activeBasemapId()];
  const { data: detectors } = useQuery({ queryKey: ["detectors"], queryFn: api.getDetectors });
  const { data: knowledge } = useQuery({ queryKey: ["knowledge-topics"], queryFn: api.getKnowledgeTopics });

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6 sm:py-8 space-y-6">
        <h1 className="text-xl sm:text-2xl font-semibold">Settings</h1>

        <section className="rounded-xl border border-border bg-surface p-5 text-sm space-y-2">
          <h2 className="font-semibold text-sm">This installation</h2>
          <Row label="API URL" value={process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"} mono />
          <Row label="Storage" value="Local filesystem" />
          <Row label="Database" value="SQLite (local)" />
          <Row label="Authentication" value="Disabled (local MVP)" />
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
                <code className="font-mono">{detectors.models_dir}</code>. It then runs on the orthomosaic during analysis and its detections are labelled with the model name.
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
      </div>
    </AppShell>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={`text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}
