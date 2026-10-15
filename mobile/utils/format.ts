const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  // The backend emits naive ISO timestamps (no zone). Treat them as local time.
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "September 14, 2026" */
export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "Unknown date";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "Sep 14" */
export function formatShortDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "—";
  return `${(MONTHS[d.getMonth()] ?? "").slice(0, 3)} ${d.getDate()}`;
}

/** "September 2026" */
export function formatMonthYear(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "Unknown";
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Sep 14, 2026, 15:03" */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "Unknown";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${(MONTHS[d.getMonth()] ?? "").slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}, ${hh}:${mm}`;
}

/** "Today", "Yesterday", or "Sep 6" for older dates (canvas: "Last survey · Today"). */
export function relativeDay(iso: string | null | undefined, now = new Date()): string {
  const d = parse(iso);
  if (!d) return "—";
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return formatShortDate(iso);
}

/** Season (crop year) a survey belongs to — the calendar year of its date. */
export function seasonOf(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? `${d.getFullYear()} Season` : "Undated";
}

/** "1,378" */
export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "66%" / "1.7%" — one decimal when it matters, none when it's a whole number. */
export function formatPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

const ACRES_PER_HECTARE = 2.47105;
const M2_PER_ACRE = 4046.86;
const FEET_PER_METER = 3.28084;

/** "3.2 acres", "14 acres", "0.05 acres" — US farmers think in acres; the backend keeps m² and hectares. */
export function formatAcres(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.005) return "under 0.01 acres";
  const digits = value >= 10 ? 0 : value >= 1 ? 1 : 2;
  return `${value.toFixed(digits)} ${value === 1 ? "acre" : "acres"}`;
}

export function acresFromM2(m2: number): number {
  return m2 / M2_PER_ACRE;
}

export function acresFromHectares(ha: number): number {
  return ha * ACRES_PER_HECTARE;
}

/** An area measured in m² (a spot in the field), in acres. */
export function formatArea(m2: number | null | undefined): string {
  if (m2 == null || !Number.isFinite(m2)) return "—";
  return formatAcres(acresFromM2(m2));
}

/** A field size stored in hectares, in acres. */
export function formatFieldArea(ha: number | null | undefined): string {
  if (ha == null || !Number.isFinite(ha)) return "—";
  return formatAcres(acresFromHectares(ha));
}

export function formatCoordinate(lat: number | null | undefined, lon: number | null | undefined): string {
  if (lat == null || lon == null) return "No GPS";
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/** A height in feet ("400 ft"), from metres. */
export function formatFeet(m: number | null | undefined, digits = 0): string {
  if (m == null || !Number.isFinite(m)) return "—";
  return `${(m * FEET_PER_METER).toFixed(digits)} ft`;
}

/** A short distance for a US farmer: inches below a foot, feet above. */
export function formatDistance(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return "—";
  const ft = m * FEET_PER_METER;
  return ft < 1 ? `${(ft * 12).toFixed(1)} in` : `${ft.toFixed(1)} ft`;
}

export function formatConfidence(c: number | null | undefined): string {
  if (c == null) return "—";
  return `${Math.round(c * 100)}%`;
}

/** Sentence-cases a snake_case crop type: "soybean" → "Soybean". */
export function cropLabel(crop: string | null | undefined): string {
  if (!crop) return "Unknown crop";
  return crop.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/** "2 files", "1 file" */
export function plural(n: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${formatNumber(n)} ${n === 1 ? noun : pluralNoun}`;
}

/** A checkerboard target's size from its side length: "60 × 60 cm · 0.36 m²"
 * (small markers in cm²: "17 × 17 cm · 289 cm²"). Same as the website. */
export function formatTargetSize(sideM: number): string {
  const side = Math.round(sideM * 100);
  const area = sideM * sideM;
  return `${side} × ${side} cm · ${area < 0.1 ? `${Math.round(area * 10_000)} cm²` : `${area.toFixed(2)} m²`}`;
}
