"use client";

import Link from "next/link";
import { User, Menu, Leaf } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { ROLE_LABEL, useMe } from "@/lib/useMe";

export function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { me } = useMe();
  return (
    <header className="flex h-16 items-center justify-between gap-3 border-b border-border bg-surface px-3 sm:px-6">
      <div className="flex items-center gap-2.5 shrink-0">
        <button
          onClick={onMenuClick}
          aria-label="Open menu"
          className="md:hidden p-1.5 -ml-1 text-muted-foreground hover:text-foreground rounded-lg hover:bg-surface-2 transition-colors shrink-0"
        >
          <Menu size={22} />
        </button>
        <div className="flex items-center gap-2 md:hidden">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-white shadow-sm">
            <Leaf size={15} />
          </div>
          <span className="font-semibold text-sm tracking-tight">AgroTwin</span>
        </div>
      </div>


      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <ThemeToggle />
        <Link href="/settings" className="flex items-center gap-2 sm:gap-3" aria-label="Your account">
          {me && (
            <div className="text-right hidden sm:block">
              <div className="text-sm font-medium leading-tight">{me.name ?? me.email}</div>
              <div className="text-xs text-muted-foreground leading-tight">{ROLE_LABEL[me.role]}</div>
            </div>
          )}
          <div className="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-full bg-surface-2 border border-border">
            <User size={15} className="text-muted-foreground" />
          </div>
        </Link>
      </div>
    </header>
  );
}
