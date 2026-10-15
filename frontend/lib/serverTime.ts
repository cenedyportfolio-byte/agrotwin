/** A time from the backend. It sends UTC without a zone ("2026-10-15T14:00:00"),
 * which a browser would read as local time. */
export function serverTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  return new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

/** "10/15/2026" in the reader's own format, or "" without a time. */
export function serverDay(s: string | null | undefined): string {
  return serverTime(s)?.toLocaleDateString() ?? "";
}
