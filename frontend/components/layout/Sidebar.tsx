"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings, Leaf } from "lucide-react";
import clsx from "clsx";
import { navItemsFor } from "@/lib/navItems";
import { useMe } from "@/lib/useMe";

/** On tablets and small laptops (768–1279 px) a narrow rail — icon with a small
 * label — so the page keeps most of the screen (the full 240 px sidebar left an
 * iPad in portrait about 530 px). From 1280 px the full sidebar. Below 768 px
 * the top bar and bottom tabs take over. */
export function Sidebar() {
  const pathname = usePathname();
  const { isStaff, isAdmin } = useMe();
  const item = (active: boolean) =>
    clsx(
      "flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-center text-[11px] leading-tight transition-colors xl:flex-row xl:gap-3 xl:px-3 xl:text-left xl:text-sm",
      active ? "bg-brand/10 text-brand font-medium" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground"
    );

  return (
    <aside className="hidden md:flex w-[5.25rem] xl:w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-center gap-2 h-16 border-b border-border xl:justify-start xl:px-5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white" title="AgroTwin">
          <Leaf size={18} />
        </div>
        <div className="hidden xl:block">
          <div className="font-semibold leading-tight">AgroTwin</div>
          <div className="text-[10px] text-muted-foreground leading-tight">Digital Twin Platform</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-1 xl:px-3">
        {navItemsFor({ isStaff, isAdmin }).map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link key={href} href={href} title={label} className={item(active)}>
              <Icon size={18} className="shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="px-2 py-4 border-t border-border xl:px-3">
        <Link href="/settings" title="Settings" className={item(pathname.startsWith("/settings"))}>
          <Settings size={18} className="shrink-0" />
          Settings
        </Link>
      </div>
    </aside>
  );
}
