import { StyleSheet, View } from "react-native";
import { AlertTriangle, ChevronRight, Sprout } from "lucide-react-native";
import { iconStroke, layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { FieldSummary } from "@/types";
import { cropLabel, formatHectares, formatPercent } from "@/utils/format";
import { overallHealth, sharesFromPercents } from "@/utils/health";
import { surveyStatusLabel } from "@/constants/labels";
import { Blueprint, HealthBar, IconBox, StatusBadge, Swatch, AppText } from "@/components/ui";

interface FieldCardProps {
  field: FieldSummary;
  onPress: () => void;
  /** Flagged zones in the latest analysis, when known (null = no analysis yet). */
  zoneCount?: number | null;
  /** "Today", "Sep 6" … */
  lastSurveyLabel?: string | null;
  /**
   * `home` — icon box, name, crop · size, chevron, status swatch row, bar,
   * "Last survey · X" / zone note (canvas Home "Your fields").
   * `list` — name, crop · size, outlined status tag, bar, "66% healthy ·
   * Sep 14 last survey", rule, warning row (canvas "My fields").
   */
  variant?: "home" | "list";
}

export function FieldCard({ field, onPress, zoneCount, lastSurveyLabel, variant = "home" }: FieldCardProps) {
  const { colors } = useTheme();
  const shares = sharesFromPercents(field.healthy_area_percent, field.attention_area_percent, field.problem_area_percent);
  const processing = !!field.latest_survey_status && !["COMPLETED", "FAILED"].includes(field.latest_survey_status);
  const health = overallHealth(shares);
  const statusTier = processing ? "info" : health.tier;
  const statusLabel = processing ? surveyStatusLabel(field.latest_survey_status ?? "PROCESSING") : health.label;
  // The field summary already carries the analysis percentages, so "not analysed"
  // is only true when those are missing too — not merely when the caller did not
  // pass a zone count (the Fields tab never does).
  const analysed = shares != null;
  const zoneNote = processing
    ? "Analysis in progress"
    : zoneCount == null
      ? field.latest_survey_id
        ? analysed
          ? shares && shares.attention + shares.problem > 0
            ? `${formatPercent(shares.attention + shares.problem)} of the area needs attention`
            : "No issues found"
          : "Not analysed yet"
        : "No surveys yet"
      : zoneCount === 0
        ? "No issues found"
        : `${zoneCount} ${zoneCount === 1 ? "area needs" : "areas need"} attention`;
  const flagged = zoneCount ? true : zoneCount == null && analysed && !!shares && shares.attention + shares.problem > 0;
  const zoneTone = flagged ? colors.attention : colors.muted;
  const meta = `${cropLabel(field.crop_type)} · ${field.area_hectares != null ? formatHectares(field.area_hectares) : "size not measured"}`;

  if (variant === "list") {
    return (
      <Blueprint onPress={onPress} accessibilityLabel={`${field.name}, ${meta}, ${statusLabel}. Open field`}>
        <View style={styles.headRow}>
          <View style={styles.titles}>
            <AppText variant="cardTitle" style={{ fontSize: 22 }} numberOfLines={1}>
              {field.name}
            </AppText>
            <AppText variant="caption" tone="muted" numberOfLines={1}>
              {meta}
            </AppText>
          </View>
          <StatusBadge tier={statusTier} label={statusLabel} />
        </View>
        {shares ? (
          <View style={{ marginTop: 14 }}>
            <HealthBar shares={shares} height={8} />
          </View>
        ) : null}
        <View style={styles.facts}>
          <AppText variant="caption">
            <AppText variant="captionStrong">{shares ? formatPercent(shares.healthy) : "—"}</AppText>
            <AppText variant="caption" tone="muted">
              {" "}
              healthy
            </AppText>
          </AppText>
          <AppText variant="caption">
            <AppText variant="captionStrong">{lastSurveyLabel ?? "—"}</AppText>
            <AppText variant="caption" tone="muted">
              {" "}
              last survey
            </AppText>
          </AppText>
        </View>
        <View style={[styles.zoneRow, { borderTopColor: colors.divider }]}>
          <AlertTriangle size={16} color={zoneTone} strokeWidth={iconStroke} />
          <AppText variant="caption" style={{ color: zoneTone }}>
            {zoneNote}
          </AppText>
        </View>
      </Blueprint>
    );
  }

  return (
    <Blueprint onPress={onPress} accessibilityLabel={`${field.name}, ${meta}, ${statusLabel}. Open field`}>
      <View style={styles.headRow}>
        <IconBox size={40}>
          <Sprout size={22} color={colors.accent} strokeWidth={iconStroke} />
        </IconBox>
        <View style={styles.titles}>
          <AppText variant="cardTitle" numberOfLines={1}>
            {field.name}
          </AppText>
          <AppText variant="caption" tone="muted" numberOfLines={1}>
            {meta}
          </AppText>
        </View>
        <ChevronRight size={20} color={colors.text} strokeWidth={iconStroke} style={{ opacity: 0.45, marginTop: 10 }} />
      </View>
      <View style={styles.statusRow}>
        <Swatch color={colors[statusTier]} />
        <AppText variant="bodyStrong">{statusLabel}</AppText>
      </View>
      {shares ? (
        <View style={{ marginTop: 10 }}>
          <HealthBar shares={shares} height={8} />
        </View>
      ) : null}
      <View style={styles.footer}>
        <AppText variant="small" tone="muted">
          Last survey · {lastSurveyLabel ?? "none"}
        </AppText>
        <AppText variant="small" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
          {zoneNote}
        </AppText>
      </View>
    </Blueprint>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: "row", alignItems: "flex-start", gap: layout.cardGap },
  titles: { flex: 1, minWidth: 0 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 },
  facts: { flexDirection: "row", gap: 16, marginTop: 12 },
  zoneRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  footer: { flexDirection: "row", justifyContent: "space-between", gap: 10, marginTop: 12 },
});
