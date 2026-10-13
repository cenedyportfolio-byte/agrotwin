"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Sprout, UploadCloud, BarChart3, Bot } from "lucide-react";
import clsx from "clsx";

// a farmer's phone: their fields, uploading a flight, the health of the crop;
// Flights, How to fly and Settings are in the menu
const BOTTOM_NAV_ITEMS = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/fields", label: "Fields", icon: Sprout },
  { href: "/upload", label: "Upload", icon: UploadCloud },
  { href: "/analysis", label: "Health", icon: BarChart3 },
  { href: "/ask-ai", label: "Ask AI", icon: Bot },
];

export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Mobile navigation"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-surface/95 backdrop-blur-md border-t border-border safe-area-pb"
    >
      <div className="grid grid-cols-5 h-14 items-center px-1">
        {BOTTOM_NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex flex-col items-center justify-center gap-1 py-1 px-1 text-center transition-colors rounded-lg",
                active
                  ? "text-brand font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <div className={clsx("relative flex items-center justify-center", active && "scale-110 transition-transform")}>
                <Icon size={19} strokeWidth={active ? 2.3 : 1.8} />
                {active && (
                  <span className="absolute -bottom-1 w-1 h-1 rounded-full bg-brand" />
                )}
              </div>
              <span className="text-[10px] leading-none tracking-tight truncate max-w-[56px]">
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
