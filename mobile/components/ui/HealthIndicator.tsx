import { StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { AlertTriangle, Check } from "lucide-react-native";
import { iconStroke, type StatusTier } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { formatFieldArea, formatPercent } from "@/utils/format";
import type { HealthShares } from "@/utils/health";
import { IconBox, Swatch } from "./IconBox";
import { AppText } from "./Text";

interface HealthBarProps {
  shares: HealthShares;
  /** 8 (list cards), 10 (home overview), 12 (field overview). */
  height?: number;
}

/** Stacked bar of the three measured area shares with 2 px gaps (canvas). */
export function HealthBar({ shares, height = 8 }: HealthBarProps) {
  const { colors } = useTheme();
  const total = Math.max(shares.healthy + shares.attention + shares.problem, 0.0001);
  const seg = (v: number) => ({ flex: Math.max(v / total, 0) });
  return (
    <View
      style={[styles.bar, { height }]}
      accessibilityRole="progressbar"
      accessibilityLabel={`Healthy ${formatPercent(shares.healthy)}, needs attention ${formatPercent(shares.attention)}, problem ${formatPercent(shares.problem)}`}
    >
      <View style={[seg(shares.healthy), { backgroundColor: colors.healthy }]} />
      <View style={[seg(shares.attention), { backgroundColor: colors.attention }]} />
      <View style={[seg(shares.problem), { backgroundColor: colors.problem }]} />
    </View>
  );
}

/** Glyph in a 22 px hairline box: ✓ healthy, ⚠ attention, ■ problem (canvas legend). */
export function TierGlyph({ tier, size = 22 }: { tier: StatusTier; size?: number }) {
  const { colors } = useTheme();
  const color = colors[tier];
  const inner = Math.round(size * 0.6);
  return (
    <IconBox size={size}>
      {tier === "healthy" ? (
        <Check size={inner} color={color} strokeWidth={2.2} />
      ) : tier === "attention" ? (
        <AlertTriangle size={inner} color={color} strokeWidth={1.8} />
      ) : (
        <View style={{ width: 8, height: 8, backgroundColor: color }} />
      )}
    </IconBox>
  );
}

const TIERS: Array<{ tier: StatusTier; label: string }> = [
  { tier: "healthy", label: "healthy" },
  { tier: "attention", label: "needs attention" },
  { tier: "problem", label: "problem" },
];

/** Home overview legend: glyph box · bold percentage · label, one per row. */
export function HealthLegendRows({ shares }: { shares: HealthShares }) {
  const values = [shares.healthy, shares.attention, shares.problem];
  return (
    <View style={styles.rows}>
      {TIERS.map((t, i) => (
        <View key={t.tier} style={styles.row}>
          <TierGlyph tier={t.tier} />
          <AppText variant="bodySmStrong" tabular style={styles.pct}>
            {formatPercent(values[i] ?? 0)}
          </AppText>
          <AppText variant="bodySm" tone="soft">
            {t.label}
          </AppText>
        </View>
      ))}
    </View>
  );
}

/** Field overview legend: three columns, small swatch + uppercase label over a 22 px number. */
export function HealthLegendColumns({ shares }: { shares: HealthShares }) {
  const { colors } = useTheme();
  const items: Array<{ tier: StatusTier; label: string; value: number }> = [
    { tier: "healthy", label: "Healthy", value: shares.healthy },
    { tier: "attention", label: "Needs attention", value: shares.attention },
    { tier: "problem", label: "Problem", value: shares.problem },
  ];
  return (
    <View style={styles.columns}>
      {items.map((item) => (
        <View key={item.tier} style={styles.column}>
          <View style={styles.columnLabel}>
            <Swatch color={colors[item.tier]} size={9} />
            <AppText variant="tagUpper" tone="muted" numberOfLines={1}>
              {item.label}
            </AppText>
          </View>
          <AppText variant="number" tabular>
            {formatPercent(item.value)}
          </AppText>
        </View>
      ))}
    </View>
  );
}

/** Analysis legend: label row with glyph and big number, an 8 px bar, and an acreage note. */
export function HealthLegendBars({ shares, areaHectares }: { shares: HealthShares; areaHectares: number | null }) {
  const { colors } = useTheme();
  const items: Array<{ tier: StatusTier; label: string; value: number }> = [
    { tier: "healthy", label: "Healthy", value: shares.healthy },
    { tier: "attention", label: "Needs attention", value: shares.attention },
    { tier: "problem", label: "Problem", value: shares.problem },
  ];
  return (
    <View style={styles.bars}>
      {items.map((item) => (
        <View key={item.tier}>
          <View style={styles.barHeader}>
            <View style={styles.barLabel}>
              <TierGlyph tier={item.tier} />
              <AppText variant="bodySm">{item.label}</AppText>
            </View>
            <AppText variant="numberSm" tabular>
              {formatPercent(item.value)}
            </AppText>
          </View>
          <View style={[styles.track, { backgroundColor: colors.track }]}>
            <View style={{ height: "100%", width: `${Math.max(0, Math.min(100, item.value))}%`, backgroundColor: colors[item.tier] }} />
          </View>
          <AppText variant="small" tone="muted" style={{ marginTop: 4 }}>
            {areaHectares != null ? `${formatFieldArea((areaHectares * item.value) / 100)} of ${formatFieldArea(areaHectares)}` : "field size not measured yet"}
          </AppText>
        </View>
      ))}
    </View>
  );
}

interface HealthIndicatorProps {
  tier: StatusTier;
  label: string;
  size?: "sm" | "md" | "lg";
}

/** Square swatch + label, e.g. "■ Mostly healthy". */
export function HealthIndicator({ tier, label, size = "md" }: HealthIndicatorProps) {
  const { colors } = useTheme();
  const variant = size === "lg" ? "number" : size === "sm" ? "bodySmStrong" : "headingSm";
  return (
    <View style={styles.indicator} accessibilityRole="text" accessibilityLabel={`Overall health: ${label}`}>
      <Swatch color={colors[tier]} />
      <AppText variant={size === "md" ? "bodyStrong" : variant} style={size === "md" ? { fontSize: 17, lineHeight: 22 } : undefined}>
        {label}
      </AppText>
    </View>
  );
}

interface DonutProps {
  shares: HealthShares;
  size?: number;
  thickness?: number;
  centerLabel?: string;
}

/** Conic health ring (canvas: 118 px ring, 84 px hole) drawn with SVG. */
export function HealthDonut({ shares, size = 118, thickness = 17, centerLabel = "healthy" }: DonutProps) {
  const { colors } = useTheme();
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = Math.max(shares.healthy + shares.attention + shares.problem, 0.0001);
  const segs: Array<{ color: string; frac: number }> = [
    { color: colors.healthy, frac: shares.healthy / total },
    { color: colors.attention, frac: shares.attention / total },
    { color: colors.problem, frac: shares.problem / total },
  ];
  let offset = 0;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }} accessibilityLabel={`${formatPercent(shares.healthy)} healthy`}>
      <Svg width={size} height={size} style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}>
        {segs.map((s, i) => {
          const dash = `${c * s.frac} ${c * (1 - s.frac)}`;
          const el = <Circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness} strokeDasharray={dash} strokeDashoffset={-c * offset} />;
          offset += s.frac;
          return el;
        })}
      </Svg>
      <View style={{ alignItems: "center" }}>
        <AppText variant="stat" tabular>
          {formatPercent(shares.healthy)}
        </AppText>
        <AppText variant="kicker" tone="muted" style={{ letterSpacing: 1 }}>
          {centerLabel}
        </AppText>
      </View>
    </View>
  );
}

export { iconStroke };

const styles = StyleSheet.create({
  bar: { flexDirection: "row", gap: 2, width: "100%" },
  rows: { gap: 9 },
  row: { flexDirection: "row", alignItems: "center", gap: 9 },
  pct: { width: 40 },
  columns: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  column: { gap: 2, flexShrink: 1 },
  columnLabel: { flexDirection: "row", alignItems: "center", gap: 6 },
  bars: { gap: 12 },
  barHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  barLabel: { flexDirection: "row", alignItems: "center", gap: 8 },
  track: { height: 8, marginTop: 6 },
  indicator: { flexDirection: "row", alignItems: "center", gap: 8 },
});
