"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, LogOut } from "lucide-react";
import { api } from "@/lib/api";
import { serverDay } from "@/lib/serverTime";
import { Button } from "@/components/ui/button";
import { AgreementText } from "./AgreementText";

function nextPage(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/agreement") ? next : "/dashboard";
}

/** The data agreement: read, tick, agree — then on to where the farmer was going.
 * Staff and farmers who already agreed can read it here too. */
export function AgreementView() {
  const qc = useQueryClient();
  const { data: agreement, isPending, error } = useQuery({ queryKey: ["agreement"], queryFn: api.getAgreement });
  const [ticked, setTicked] = useState(false);
  const accept = useMutation({
    mutationFn: (version: string) => api.acceptAgreement(version),
    onSuccess: (me) => {
      qc.setQueryData(["me"], me);
      window.location.assign(nextPage());
    },
    onError: () => qc.invalidateQueries({ queryKey: ["agreement"] }), // it changed meanwhile: show the new text
  });

  return (
    <div className="min-h-dvh bg-background px-4 py-6 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:py-10">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-center gap-2 text-brand">
          <FileText size={20} />
          <span className="text-sm font-semibold">AgroTwin</span>
        </div>
        {isPending ? (
          <p className="text-sm text-muted-foreground">
            <Loader2 className="inline animate-spin" size={14} /> Loading…
          </p>
        ) : error ? (
          <p className="text-sm text-problem">{(error as Error).message}</p>
        ) : !agreement ? (
          <section className="rounded-xl border border-border bg-surface p-5 text-sm space-y-3">
            <h1 className="text-lg font-semibold">No agreement to accept</h1>
            <p className="text-muted-foreground">There is no data agreement on this AgroTwin server.</p>
            <Button onClick={() => window.location.assign(nextPage())}>Continue</Button>
          </section>
        ) : (
          <section className="rounded-xl border border-border bg-surface p-5 sm:p-6 space-y-4">
            <div>
              <h1 className="text-xl font-semibold">{agreement.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {agreement.accepted
                  ? `You agreed to this on ${serverDay(agreement.accepted_at)}.`
                  : "Before you use AgroTwin, read how your fields' photos and maps are used and kept. If it changes, you are asked again."}
              </p>
            </div>
            <div className="max-h-[55dvh] overflow-y-auto rounded-lg border border-border bg-background p-4">
              <AgreementText text={agreement.text} />
            </div>
            {agreement.accepted ? (
              <Button onClick={() => window.location.assign(nextPage())}>Continue</Button>
            ) : (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
                  I have read the agreement and I agree to it.
                </label>
                {accept.error && <p className="text-sm text-problem">{(accept.error as Error).message}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => accept.mutate(agreement.version)} disabled={!ticked || accept.isPending} className="bg-brand text-white hover:bg-brand/90">
                    {accept.isPending && <Loader2 className="animate-spin" />} Agree and continue
                  </Button>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      await api.logout().catch(() => undefined);
                      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                      window.location.assign("/login");
                    }}
                  >
                    <LogOut /> Sign out
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Questions about the agreement or your data? Ask your AgroTwin contact. You can delete your account and
                  all its data at any time under Settings.
                </p>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
