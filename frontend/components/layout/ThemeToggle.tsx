"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

function applyTheme(theme: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("agrotwin-theme", theme);
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("agrotwin-theme");
    // "system" (chosen on the landing page) shows as whatever the page resolved it to
    setTheme(stored === "light" || stored === "dark" ? stored : ((document.documentElement.getAttribute("data-theme") as "light" | "dark") ?? "light"));
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }

  if (!theme) return <div className="h-9 w-9" />; // avoid layout shift before hydration reads localStorage

  return (
    <button
      onClick={toggle}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-2 text-muted-foreground hover:text-foreground"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
