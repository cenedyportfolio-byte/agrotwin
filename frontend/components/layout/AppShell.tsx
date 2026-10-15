"use client";

import { useEffect, useState } from "react";
import { useMe } from "@/lib/useMe";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNavDrawer } from "./MobileNavDrawer";
import { MobileBottomNav } from "./MobileBottomNav";

/** The page frame. `h-dvh`: the height actually visible, so Safari's toolbars
 * never hide the bottom of a page (100vh is taller than the screen there).
 * The safe-area padding keeps the frame clear of an iPhone's notch and home bar
 * (the page opts into the full screen with viewport-fit=cover, app/layout.tsx).
 * <main> is a size container: pages lay out their columns by the room they
 * have, not by the screen — on a tablet the sidebar takes part of the screen. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // a farmer who has not accepted the data agreement (or its new version) reads it first
  const mustAgree = !!useMe().me?.consent_required;
  useEffect(() => {
    if (!mustAgree) return;
    const next = window.location.pathname + window.location.search;
    window.location.replace(`/agreement?next=${encodeURIComponent(next)}`);
  }, [mustAgree]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <Sidebar />
      <MobileNavDrawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar onMenuClick={() => setMobileNavOpen(true)} />
        <main className="@container flex-1 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-[env(safe-area-inset-bottom)]">
          {mustAgree ? null : children}
        </main>
        <MobileBottomNav />
      </div>
    </div>
  );
}
