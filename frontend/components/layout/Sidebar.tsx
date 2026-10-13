"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings, Leaf } from "lucide-react";
import clsx from "clsx";
import { NAV_ITEMS } from "@/lib/navItems";
import { useMe } from "@/lib/useMe";

export function Sidebar() {
  const pathname = usePathname();
  const { isAdmin } = useMe();

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center gap-2 px-5 h-16 border-b border-border">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-white">
          <Leaf size={18} />
        </div>
        <div>
          <div className="font-semibold leading-tight">AgroTwin</div>
          <div className="text-[10px] text-muted-foreground leading-tight">Digital Twin Platform</div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.filter((item) => isAdmin || !item.adminOnly).map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-brand/10 text-brand font-medium"
                  : "text-muted-foreground hover:bg-surface-2 hover:text-foreground"
              )}
            >
              <Icon size={17} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 py-4 border-t border-border">
        <Link
          href="/settings"
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-surface-2 hover:text-foreground"
        >
          <Settings size={17} />
          Settings
        </Link>
      </div>
    </aside>
  );
}
