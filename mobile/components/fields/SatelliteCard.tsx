import { StyleSheet, View } from "react-native";
import Svg, { Circle, Line, Path, Polygon, Polyline, Text as SvgText } from "react-native-svg";
import { Satellite } from "lucide-react-native";
import { alpha, iconStroke, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useSatellite } from "@/features/fields/hooks";
import type { FieldSummary } from "@/types";
import { AppText, Blueprint, LoadingState } from "@/components/ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const W = 320;
const H = 160;
const PAD = { left: 24, right: 6, top: 10, bottom: 16 };

function day(d: string): number {
  const [y = 1970, m = 1, dd = 1] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, dd) / 86_400_000;
}

function dateText(d: string): string {
  const [, m = 1, dd = 1] = d.split("-").map(Number);
  return `${MONTHS[m - 1]} ${dd}`;
}

/** What an NDVI means for a crop field, in plain words (as on the website). */
export function greenness(ndvi: number): string {
  if (ndvi < 0.2) return "bare soil or residue";
  if (ndvi < 0.4) return "low: a young or thin crop, or one drying down";
  if (ndvi < 0.6) return "medium: a canopy filling in or thinning";
  if (ndvi < 0.8) return "high: a dense canopy";
  return "very high: a full canopy";
}

/** The field's crop greenness (average NDVI) on every clear Sentinel-2 pass of
 * the season, with the drone flights marked. Same as the website's SatelliteCard. */
export function SatelliteCard({ field }: { field: FieldSummary }) {
  const { colors } = useTheme();
  const { data } = useSatellite(field);
  if (!data || data.status === "no_outline" || data.status === "off") return null;

  const points = data.points;
  const x0 = day(data.season.start);
  const x1 = Math.max(day(data.season.end), x0 + 1);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (d: string) => PAD.left + ((day(d) - x0) / (x1 - x0)) * plotW;
  const y = (v: number) => PAD.top + (1 - Math.max(0, Math.min(1, v))) * plotH;
  const months: { at: number; label: string }[] = [];
  const [sy = 1970, sm = 1] = data.season.start.split("-").map(Number);
  for (let m = sm - 1; m < sm + 11; m++) {
    const d = `${sy + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-01`;
    if (day(d) > x1) break;
    if (day(d) >= x0) months.push({ at: x(d), label: MONTHS[m % 12] ?? "" });
  }
  const band = points.filter((p) => p.p10 != null && p.p90 != null);
  const last = points[points.length - 1];
  const font = { fontFamily: typography.small.fontFamily, fontSize: 8 };

  return (
    <Blueprint style={{ gap: 10 }}>
      <View style={styles.head}>
        <Satellite size={18} color={colors.accent} strokeWidth={iconStroke} />
        <AppText variant="heading" style={{ flex: 1 }}>
          Crop greenness from satellite
        </AppText>
      </View>
      {data.status === "too_small" ? (
        <AppText variant="bodySm" tone="muted">
          This field is too small for the satellite&apos;s 10 m pixels.
        </AppText>
      ) : points.length === 0 ? (
        data.status === "fetching" ? (
          <LoadingState message={`Reading this season's satellite passes${data.progress ? ` (${data.progress.done} of ${data.progress.todo})` : ""}… The first time takes a few minutes.`} />
        ) : (
          <AppText variant="bodySm" tone="muted">
            {data.status === "unavailable" ? "The satellite catalogue could not be reached; AgroTwin tries again later." : "No clear satellite pass over this field yet this season."}
          </AppText>
        )
      ) : (
        <>
          {last ? (
            <AppText variant="bodySm">
              Last clear pass, {dateText(last.date)}: <AppText variant="bodySmStrong">{last.ndvi.toFixed(2)}</AppText> — {greenness(last.ndvi)}.
            </AppText>
          ) : null}
          <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} accessibilityLabel="Crop greenness over the season">
            {[0.2, 0.4, 0.6, 0.8].map((v) => (
              <Line key={`g${v}`} x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={colors.hairline} strokeWidth={0.6} />
            ))}
            {[0.2, 0.4, 0.6, 0.8].map((v) => (
              <SvgText key={`l${v}`} x={PAD.left - 4} y={y(v) + 3} textAnchor="end" fill={colors.muted} {...font}>
                {v.toFixed(1)}
              </SvgText>
            ))}
            {months.map((m) => (
              <SvgText key={m.label + m.at} x={m.at} y={H - 4} textAnchor="middle" fill={colors.muted} {...font}>
                {m.label}
              </SvgText>
            ))}
            {band.length > 1 ? (
              <Polygon
                points={[...band.map((p) => `${x(p.date)},${y(p.p90 as number)}`), ...[...band].reverse().map((p) => `${x(p.date)},${y(p.p10 as number)}`)].join(" ")}
                fill={alpha(colors.healthy, 0.15)}
              />
            ) : null}
            {data.flights.map((f) => (
              <Line key={`f${f.survey_id}`} x1={x(f.date)} x2={x(f.date)} y1={PAD.top} y2={H - PAD.bottom} stroke={colors.accent} strokeWidth={1} strokeDasharray="3 2" />
            ))}
            {data.flights.map((f) => (
              <Path key={`t${f.survey_id}`} d={`M${x(f.date) - 4} ${PAD.top - 2}L${x(f.date) + 4} ${PAD.top - 2}L${x(f.date)} ${PAD.top + 4}Z`} fill={colors.accent} />
            ))}
            <Polyline points={points.map((p) => `${x(p.date)},${y(p.ndvi)}`).join(" ")} fill="none" stroke={colors.healthy} strokeWidth={1.6} />
            {points.map((p) => (
              <Circle key={p.date} cx={x(p.date)} cy={y(p.ndvi)} r={2.4} fill={colors.healthy} />
            ))}
          </Svg>
          <View style={styles.legend}>
            <View style={styles.legendItem}>
              <View style={{ width: 14, height: 2, backgroundColor: colors.healthy }} />
              <AppText variant="small" tone="muted">
                Field average (NDVI)
              </AppText>
            </View>
            <View style={styles.legendItem}>
              <View style={{ width: 14, height: 10, backgroundColor: alpha(colors.healthy, 0.15) }} />
              <AppText variant="small" tone="muted">
                Middle 80% of the field
              </AppText>
            </View>
            <View style={styles.legendItem}>
              <View style={{ width: 0, height: 12, borderLeftWidth: 1, borderStyle: "dashed", borderColor: colors.accent }} />
              <AppText variant="small" tone="muted">
                Drone flight
              </AppText>
            </View>
          </View>
        </>
      )}
      <AppText variant="small" tone="muted">
        {data.passes > 0 ? `${points.length} clear passes of ${data.passes} this season (${data.cloudy} too cloudy). ` : ""}
        The Sentinel-2 satellites pass every few days; their 10 m pixels show the whole crop&apos;s trend between flights, not weeds or single plants. Contains modified Copernicus
        Sentinel data.
      </AppText>
    </Blueprint>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
});
