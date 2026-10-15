"use client";

import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import s from "./landing.module.css";

/* Pieces the landing (/ and /welcome) and sign-in (/login) pages share. */

export type ThemeMode = "light" | "dark" | "system";

/** Shared with the rest of the site (app/layout.tsx, ThemeToggle). */
const THEME_KEY = "agrotwin-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Runs while the page is parsed, before it is painted: puts the saved theme
 * on the page root so a light-mode visitor never sees a dark flash. */
const THEME_SCRIPT = `(function(){try{var r=document.currentScript.parentElement,t=localStorage.getItem('${THEME_KEY}');if(t==='system')t=matchMedia('${DARK_QUERY}').matches?'dark':'light';if(t==='light'||t==='dark')r.setAttribute('data-theme',t)}catch(e){}})()`;

/** First child of the page root (which needs suppressHydrationWarning). */
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}

const themeListeners = new Set<() => void>();
function readSavedTheme(): ThemeMode | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" || t === "system" ? t : null;
  } catch {
    return null;
  }
}
function subscribeSavedTheme(onChange: () => void) {
  themeListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    themeListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}
function subscribeSystemTheme(onChange: () => void) {
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** The visitor's theme: their saved choice (light when none), "system" resolved. */
export function useSiteTheme() {
  const saved = useSyncExternalStore(subscribeSavedTheme, readSavedTheme, () => null);
  const systemDark = useSyncExternalStore(subscribeSystemTheme, () => window.matchMedia(DARK_QUERY).matches, () => false);
  const mode: ThemeMode = saved ?? "light";
  const theme: "light" | "dark" = mode === "system" ? (systemDark ? "dark" : "light") : mode;
  return { mode, theme };
}

function pickTheme(k: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, k);
  } catch {
    // private browsing: the choice lasts for this visit only
  }
  // the rest of the site follows the same choice
  const resolved = k === "system" ? (window.matchMedia(DARK_QUERY).matches ? "dark" : "light") : k;
  document.documentElement.setAttribute("data-theme", resolved);
  themeListeners.forEach((l) => l());
}

const THEMES: { k: ThemeMode; label: string; icon: string }[] = [
  { k: "light", label: "Light mode", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" },
  { k: "dark", label: "Dark mode", icon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" },
  { k: "system", label: "Match system", icon: "M4 4h16v11H4zM8 20h8M12 15v5" },
];

/** Light / dark / match-system switch. */
export function ThemeSwitch({ mode, className = "" }: { mode: ThemeMode; className?: string }) {
  return (
    <div role="group" aria-label="Color theme" className={`${s.themeGroup} ${className}`}>
      {THEMES.map((t) => (
        <button
          key={t.k}
          type="button"
          className={s.themeBtn}
          onClick={() => pickTheme(t.k)}
          aria-pressed={mode === t.k}
          aria-label={t.label}
          title={t.label}
        >
          <Icon d={t.icon} />
        </button>
      ))}
    </div>
  );
}

export const IC = {
  ok: "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3",
  warn: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01",
  bad: "M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2zM15 9l-6 6M9 9l6 6",
};
const LEAF = ["M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z", "M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"];
export const CHECK = "M20 6 9 17l-5-5";

/** Lucide-style line icon at the design's 1.5 stroke. */
export function Icon({
  d,
  size = 16,
  strokeWidth = 1.5,
  stroke = "currentColor",
  style,
  children,
}: {
  d?: string | readonly string[];
  size?: number;
  strokeWidth?: number;
  stroke?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const paths = d === undefined ? [] : typeof d === "string" ? [d] : d;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths.map((p) => (
        <path key={p} d={p} />
      ))}
      {children}
    </svg>
  );
}

/** The four "+" registration marks of a blueprint frame. */
export function Corners() {
  return (
    <>
      <i className={`${s.corner} ${s.tl}`} />
      <i className={`${s.corner} ${s.tr}`} />
      <i className={`${s.corner} ${s.bl}`} />
      <i className={`${s.corner} ${s.br}`} />
    </>
  );
}

/** The leaf in its blueprint frame, and the wordmark. */
export function Brand({ href, className = "" }: { href: string; className?: string }) {
  return (
    <a href={href} className={`${s.brand} ${className}`}>
      <span className={`${s.blueprint} ${s.logo}`}>
        <Corners />
        <Icon d={LEAF} size={20} />
      </span>
      <span className={s.wordmark}>AgroTwin</span>
    </a>
  );
}
