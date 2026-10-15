"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { FieldCard } from "@/components/dashboard/FieldCard";

export default function FieldsPage() {
  const { data: fields, isLoading } = useQuery({ queryKey: ["fields"], queryFn: api.listFields });

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8 space-y-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">My Fields</h1>
          <p className="text-muted-foreground mt-1 text-xs sm:text-sm">Your fields and how the crop is doing in each.</p>
        </div>

        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

        <div className="grid grid-cols-1 @2xl:grid-cols-2 @6xl:grid-cols-3 gap-4">
          {fields?.map((field) => (
            <FieldCard key={field.id} field={field} />
          ))}
        </div>
      </div>
    </AppShell>
  );
}
