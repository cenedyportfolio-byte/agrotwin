import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { CloudSun } from "lucide-react-native";
import { alpha, iconStroke } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useSprayWeather } from "@/features/fields/hooks";
import type { FieldSummary, SprayHour, SprayWindow } from "@/types";
import { AppText, Blueprint } from "@/components/ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LEGEND: [SprayHour["status"], string][] = [
  ["good", "Good"],
  ["marginal", "Check the label"],
  ["bad", "Not now"],
  ["night", "Night"],
];

/** "2026-10-15T07:00" at the field → its weekday and hour, as written. */
function parts(time: string) {
  const [d = "", t = "00"] = time.split("T");
  const [y = 1970, m = 1, day = 1] = d.split("-").map(Number);
  return { day: d, weekday: DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()] ?? "", hour: Number(t.slice(0, 2)) };
}

export function hourText(h: number): string {
  return h === 0 ? "midnight" : h === 12 ? "noon" : `${h % 12} ${h < 12 ? "am" : "pm"}`;
}

function windowText(w: SprayWindow): string {
  const a = parts(w.start);
  const b = parts(w.end);
  return `${a.weekday} ${hourText(a.hour)} – ${a.day === b.day || b.hour === 0 ? "" : `${b.weekday} `}${hourText(b.hour)} (${w.hours} h)`;
}

/** The next two days for spraying at the field, hour by hour — a weather
 * guide; the product label decides. Tap an hour for its wind, temperature and
 * rain. Same as the website's SprayWeatherCard. */
export function SprayWeatherCard({ field }: { field: FieldSummary }) {
  const { colors } = useTheme();
  const { data } = useSprayWeather(field);
  const [picked, setPicked] = useState<SprayHour | null>(null);
  if (!data || field.center_lat == null) return null;
  const cell: Record<SprayHour["status"], string> = {
    good: colors.healthy,
    marginal: colors.attention,
    bad: alpha(colors.problem, 0.8),
    night: colors.track,
  };

  const head = (
    <View style={styles.head}>
      <CloudSun size={18} color={colors.accent} strokeWidth={iconStroke} />
      <AppText variant="heading" style={{ flex: 1 }}>
        Spray weather
      </AppText>
      <AppText variant="caption" tone="muted">
        Next 2 days
      </AppText>
    </View>
  );
  if (!data.available || !data.hours?.length) {
    return (
      <Blueprint style={{ gap: 8 }}>
        {head}
        <AppText variant="bodySm" tone="muted">
          {data.reason ?? "No forecast right now."}
        </AppText>
      </Blueprint>
    );
  }

  const days: { day: string; weekday: string; slots: (SprayHour | null)[] }[] = [];
  for (const h of data.hours) {
    const p = parts(h.time);
    let row = days.find((d) => d.day === p.day);
    if (!row) {
      row = { day: p.day, weekday: p.weekday, slots: Array<SprayHour | null>(24).fill(null) };
      days.push(row);
    }
    row.slots[p.hour] = h;
  }
  const shown = picked ?? data.hours.find((h) => h.status !== "night") ?? data.hours[0];
  const limits = data.limits;

  return (
    <Blueprint style={{ gap: 12 }}>
      {head}
      <AppText variant="bodyStrong" tone={data.next_window ? "healthy" : "attention"}>
        {data.next_window ? `Next good window: ${windowText(data.next_window)}` : "No good spraying window in the next 2 days."}
      </AppText>
      <View style={{ gap: 4 }}>
        {days.map((d) => (
          <View key={d.day} style={styles.dayRow}>
            <AppText variant="small" tone="muted" style={{ width: 32 }}>
              {d.weekday}
            </AppText>
            <View style={styles.cells}>
              {d.slots.map((h, i) =>
                h ? (
                  <Pressable
                    key={i}
                    onPress={() => setPicked(h)}
                    accessibilityRole="button"
                    accessibilityLabel={`${d.weekday} ${hourText(i)}: ${h.reason}`}
                    style={[styles.cell, { backgroundColor: cell[h.status] }, shown === h && { borderWidth: 2, borderColor: colors.text }]}
                  />
                ) : (
                  <View key={i} style={styles.cell} />
                )
              )}
            </View>
          </View>
        ))}
        <View style={[styles.dayRow, { marginTop: 2 }]}>
          <View style={{ width: 32 }} />
          <View style={[styles.cells, { justifyContent: "space-between" }]}>
            {["12 am", "6 am", "noon", "6 pm", ""].map((t) => (
              <AppText key={t} variant="label" tone="faint">
                {t}
              </AppText>
            ))}
          </View>
        </View>
      </View>
      {shown ? (
        <AppText variant="caption">
          {parts(shown.time).weekday} {hourText(parts(shown.time).hour)}: {shown.reason}
          <AppText variant="caption" tone="muted">
            {` · wind ${shown.wind_mph != null ? Math.round(shown.wind_mph) : "—"} mph${shown.gust_mph != null ? `, gusts ${Math.round(shown.gust_mph)}` : ""} · ${
              shown.temp_f != null ? `${Math.round(shown.temp_f)}°F` : "—"
            }${shown.rain_chance != null ? ` · ${shown.rain_chance}% chance of rain` : ""}`}
          </AppText>
        </AppText>
      ) : null}
      <View style={styles.legend}>
        {LEGEND.map(([status, label]) => (
          <View key={status} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: cell[status] }]} />
            <AppText variant="small" tone="muted">
              {label}
            </AppText>
          </View>
        ))}
      </View>
      {limits ? (
        <AppText variant="small" tone="muted">
          Good: wind {limits.wind_min_mph}–{limits.wind_max_mph} mph, gusts under {limits.gust_max_mph} mph, no rain for {limits.rain_free_hours} hours, under{" "}
          {limits.max_temp_f}°F, in daylight. A weather guide only (Open-Meteo forecast) — always follow the product label, including any dicamba rules.
        </AppText>
      ) : null}
    </Blueprint>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  dayRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  cells: { flex: 1, flexDirection: "row", gap: 1 },
  cell: { flex: 1, height: 22, borderRadius: 2 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
});
