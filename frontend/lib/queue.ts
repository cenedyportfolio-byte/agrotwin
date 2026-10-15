import type { JobQueuePlace } from "@/lib/types";

/** "25 min", "about 3 h", "about 2 days". */
export function formatWait(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes / 5) * 5)} min`;
  const hours = minutes / 60;
  if (hours < 36) return `about ${hours < 10 ? Math.round(hours * 2) / 2 : Math.round(hours)} h`;
  return `about ${Math.round(hours / 24)} days`;
}

/** What a farmer reads while their job waits: its place in line, the wait, the night hours. */
export function queueText(q: JobQueuePlace): string {
  const ahead = q.ahead === 1 ? "1 map is ahead of yours" : `${q.ahead} maps are ahead of yours`;
  const wait = q.wait_minutes != null && q.wait_minutes >= 1 ? formatWait(q.wait_minutes) : null;
  if (q.starts_at) {
    const when = q.ahead === 0 ? `yours starts at ${q.starts_at}` : `${ahead}${wait ? `; yours should start in ${wait}` : ""}`;
    return `Detailed maps are made ${q.hours ?? "at night"}, when the server is free: ${when}.`;
  }
  if (q.ahead === 0) return "Yours is next in line — it starts in a moment.";
  return `${ahead} in line${wait ? ` — yours should start in ${wait}` : ""}.`;
}
