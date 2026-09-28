"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { Markdown } from "@/lib/markdown";
import { Bot, Send, Loader2, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { KnowledgeSource } from "@/lib/types";

const SUGGESTIONS = [
  "How is my field doing?",
  "Show problem areas",
  "Where are the weeds?",
  "What should I check when scouting a thin area?",
  "What changed since the last survey?",
];

function responderLabel(responder: string) {
  return responder.startsWith("ollama:")
    ? `answered by the local model (${responder.slice("ollama:".length)})`
    : "answered from the measured numbers (no language model running)";
}

export default function AskAiPage() {
  const { data: fields } = useQuery({ queryKey: ["fields"], queryFn: api.listFields });
  const withSurvey = fields?.filter((f) => f.latest_survey_id) ?? [];
  const [fieldId, setFieldId] = useState<string | null>(null);
  const field = withSurvey.find((f) => f.id === fieldId) ?? withSurvey[0];
  const surveyId = field?.latest_survey_id ?? null;

  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<{ q: string; a: string; responder: string; sources: KnowledgeSource[] }[]>([]);

  const ask = useMutation({
    mutationFn: (q: string) => api.askAssistant(surveyId as string, q),
    onSuccess: (res) =>
      setHistory((h) => [...h, { q: res.question, a: res.answer, responder: res.responder, sources: res.sources ?? [] }]),
  });

  function send(q: string) {
    if (!q.trim() || !surveyId) return;
    ask.mutate(q.trim());
    setQuestion("");
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6 sm:py-8 space-y-6">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Bot size={18} />
            </div>
            <h1 className="text-xl sm:text-2xl font-semibold">Ask AI</h1>
          </div>
          <p className="text-muted-foreground mt-2 text-xs sm:text-sm">
            Answers are grounded in the field&apos;s measured analysis plus a local agronomy knowledge base (growth
            stages, indices, scouting, weeds, survey practice) — the assistant explains the numbers and cites its sources,
            it never invents findings. A local Ollama model is used for the wording when one is running; otherwise the
            answer is built directly from the measurements and says so.
          </p>
        </div>

        {withSurvey.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No field with a survey yet — create one from Upload first.
          </div>
        )}

        {field && surveyId && (
          <>
            {withSurvey.length > 1 && (
              <select
                value={field.id}
                onChange={(e) => {
                  setFieldId(e.target.value);
                  setHistory([]);
                }}
                className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
              >
                {withSurvey.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
            {withSurvey.length === 1 && <div className="text-xs text-muted-foreground">Field: {field.name} (latest survey)</div>}

            <div className="space-y-3">
              {history.map((h, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="ml-auto max-w-[85%] w-fit rounded-lg rounded-br-sm bg-brand px-3 py-2 text-sm text-white">
                    {h.q}
                  </div>
                  <div className="mr-auto max-w-[85%] w-fit rounded-lg rounded-bl-sm border border-border bg-surface px-3 py-2 text-sm">
                    <Markdown text={h.a} />
                    {h.sources.length > 0 && (
                      <div className="mt-2 border-t border-border pt-1.5 text-[11px] text-muted-foreground space-y-0.5">
                        <div className="flex items-center gap-1 font-medium">
                          <BookOpen size={11} /> Sources (local knowledge base)
                        </div>
                        {h.sources.map((s, j) => (
                          <div key={j} title={s.snippet}>
                            {s.title} — {s.section}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-1.5 text-[10px] text-muted-foreground">{responderLabel(h.responder)}</div>
                  </div>
                </div>
              ))}
              {ask.isPending && (
                <div className="mr-auto flex w-fit items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> Thinking…
                </div>
              )}
              {ask.isError && <div className="text-sm text-problem">{(ask.error as Error).message}</div>}
            </div>

            {history.length === 0 && (
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <Button key={s} variant="outline" size="sm" className="rounded-full" onClick={() => send(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(question);
              }}
              className="flex items-center gap-2"
            >
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask about this field…"
                className="flex-1"
              />
              <Button type="submit" size="icon-lg" disabled={ask.isPending || !question.trim()}>
                <Send />
              </Button>
            </form>
          </>
        )}
      </div>
    </AppShell>
  );
}
