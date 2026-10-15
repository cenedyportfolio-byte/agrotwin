"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, KeyRound, Loader2, Trash2, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ROLE_LABEL, useMe } from "@/lib/useMe";
import { serverDay } from "@/lib/serverTime";
import type { Agreement, User, UserRole } from "@/lib/types";

const ROLES: UserRole[] = ["farmer", "operator", "admin"];
const ROLE_HINT: Record<UserRole, string> = {
  farmer: "sees only their own fields",
  operator: "sees every farm, cannot manage accounts",
  admin: "everything, including accounts",
};

/** Easy to read out or type on a phone: no 0/O or 1/l/I. */
function temporaryPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const s = Array.from(bytes, (b) => chars[b % chars.length]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export default function UsersPage() {
  const { isAdmin, isPending } = useMe();
  const { data: users, isLoading } = useQuery({ queryKey: ["users"], queryFn: api.listUsers, enabled: isAdmin });
  const { data: agreement } = useQuery({ queryKey: ["agreement"], queryFn: api.getAgreement, enabled: isAdmin });
  const farmers = users?.filter((u) => u.role === "farmer" && u.is_active) ?? [];
  const agreed = agreement ? farmers.filter((u) => u.consent_version === agreement.version).length : 0;

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6 sm:py-8 space-y-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold">Users</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create an account for each farmer and give them their email and temporary password. They can change it under
            Settings. To give a farmer an existing field, open the field and choose them as its owner.
          </p>
        </div>
        {!isPending && !isAdmin ? (
          <p className="text-sm text-muted-foreground">Only an admin can manage accounts.</p>
        ) : (
          <>
            <NewUser />
            <section className="flex items-start gap-2 rounded-xl border border-border bg-surface p-4 text-sm">
              <FileText size={16} className="mt-0.5 shrink-0 text-brand" />
              {agreement ? (
                <p>
                  Data agreement: <span className="font-medium">{agreement.title}</span> — {agreed} of {farmers.length}{" "}
                  {farmers.length === 1 ? "farmer has" : "farmers have"} agreed to this version.{" "}
                  <Link href="/agreement?next=/users" className="text-brand hover:underline">
                    Read it
                  </Link>
                </p>
              ) : (
                <p className="text-muted-foreground">
                  No data agreement is set, so farmers are not asked to accept one. To ask them, put its text in a file on the
                  server and set AGROTWIN_AGREEMENT_FILE to it.
                </p>
              )}
            </section>
            <section className="rounded-xl border border-border bg-surface">
              {isLoading && (
                <div className="p-5 text-sm text-muted-foreground">
                  <Loader2 className="inline animate-spin" size={14} /> Loading…
                </div>
              )}
              {users?.map((u) => <UserRow key={u.id} user={u} agreement={agreement ?? null} />)}
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}

function NewUser() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("farmer");
  const [password, setPassword] = useState(temporaryPassword);
  const create = useMutation({
    mutationFn: () => api.createUser({ email, name: name || undefined, role, password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  const reset = () => {
    setName("");
    setEmail("");
    setRole("farmer");
    setPassword(temporaryPassword());
    create.reset();
  };

  if (create.isSuccess) {
    return (
      <section className="rounded-xl border border-healthy/40 bg-surface p-5 text-sm space-y-3">
        <h2 className="font-semibold">Account created</h2>
        <p className="text-muted-foreground">Give these sign-in details to {create.data.name ?? create.data.email}:</p>
        <div className="rounded-lg bg-surface-2 p-3 font-mono text-sm select-all">
          {create.data.email}
          <br />
          {password}
        </div>
        <Button variant="secondary" onClick={reset}>
          <UserPlus />
          Add another
        </Button>
      </section>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
      className="rounded-xl border border-border bg-surface p-5 text-sm space-y-3"
    >
      <h2 className="font-semibold">New account</h2>
      {/* grid-cols-1 (minmax(0, 1fr)): the role list's long option texts no longer widen the form past a phone's screen */}
      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="h-10 text-base" />
        <Input
          type="email"
          placeholder="Email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-10 text-base"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          className="h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base sm:text-sm"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]} — {ROLE_HINT[r]}
            </option>
          ))}
        </select>
        <Input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Temporary password"
          minLength={8}
          required
          className="h-10 font-mono text-base"
        />
      </div>
      {create.isError && <p className="text-xs text-problem">{(create.error as Error).message}</p>}
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? <Loader2 className="animate-spin" /> : <UserPlus />}
        Create account
      </Button>
    </form>
  );
}

function consentText(user: User, agreement: Agreement | null): string | null {
  if (!agreement || user.role !== "farmer") return null;
  if (user.consent_version === agreement.version && user.consent_at) {
    return `Agreed to the data agreement ${serverDay(user.consent_at)}`;
  }
  return user.consent_version ? "Agreed to an earlier version — asked again at sign-in" : "Not agreed yet — asked at sign-in";
}

function UserRow({ user, agreement }: { user: User; agreement: Agreement | null }) {
  const qc = useQueryClient();
  const { me } = useMe();
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateUser>[1]) => api.updateUser(user.id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const remove = useMutation({
    mutationFn: (confirm: string) => api.deleteUser(user.id, confirm),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const self = me?.id === user.id;
  const consent = consentText(user, agreement);

  return (
    <div className="flex flex-col gap-2 border-b border-border p-4 last:border-b-0 @2xl:flex-row @2xl:items-center">
      <div className="min-w-0 flex-1">
        <div className={`font-medium ${user.is_active ? "" : "text-muted-foreground line-through"}`}>
          {user.name ?? user.email} {self && <span className="text-xs text-muted-foreground">(you)</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        {consent && (
          <div className={`text-xs ${user.consent_version === agreement?.version ? "text-healthy" : "text-attention"}`}>{consent}</div>
        )}
        {newPassword && (
          <div className="mt-1 text-xs">
            New password: <span className="select-all font-mono">{newPassword}</span>
          </div>
        )}
        {update.isError && <div className="mt-1 text-xs text-problem">{(update.error as Error).message}</div>}
        {remove.isError && <div className="mt-1 text-xs text-problem">{(remove.error as Error).message}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={user.role}
          disabled={self || update.isPending}
          onChange={(e) => update.mutate({ role: e.target.value as UserRole })}
          className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
          aria-label="Role"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() => {
            const pw = temporaryPassword();
            update.mutate({ password: pw }, { onSuccess: () => setNewPassword(pw) });
          }}
        >
          <KeyRound />
          New password
        </Button>
        {!self && (
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate({ is_active: !user.is_active })}
          >
            {user.is_active ? "Switch off" : "Switch on"}
          </Button>
        )}
        {!self && (
          <Button
            size="sm"
            variant="outline"
            className="text-muted-foreground hover:text-problem"
            disabled={remove.isPending}
            title="Delete the account and all its fields, flights and maps"
            onClick={() => {
              const typed = window.prompt(
                `Delete ${user.email} with all their fields, flights, maps and results? This cannot be undone.\n\nType their email to confirm:`
              );
              if (typed) remove.mutate(typed);
            }}
          >
            {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
          </Button>
        )}
      </div>
    </div>
  );
}
