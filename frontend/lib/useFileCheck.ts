"use client";

import { useEffect, useState } from "react";

/** Reads a chosen file on the server whenever it (or `extra`, e.g. a typed
 * EPSG code) changes, after a short pause. Each answer is kept with the file
 * it was for, so a stale one never shows and "checking" simply means "no
 * answer yet for this file". */
export function useFileCheck<T>(
  file: File | null,
  extra: string,
  read: (file: File) => Promise<T>
): { info: T | null; error: string | null; checking: boolean } {
  const key = file ? `${file.name}|${file.size}|${file.lastModified}|${extra}` : null;
  const [answer, setAnswer] = useState<{ key: string; info: T | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!file || !key) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      read(file)
        .then((info) => alive && setAnswer({ key, info, error: null }))
        .catch((err) => alive && setAnswer({ key, info: null, error: (err as Error).message }));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // `read` is recreated by callers each render; the file and `extra` decide
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return { info: null, error: null, checking: false };
  const current = answer?.key === key ? answer : null;
  return { info: current?.info ?? null, error: current?.error ?? null, checking: current === null };
}
