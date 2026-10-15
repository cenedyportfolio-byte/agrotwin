import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { Check, Clock } from "lucide-react-native";
import { useTheme } from "@/hooks/useTheme";
import { isJobActive, jobKind } from "@/services/processing";
import type { ProcessingJob } from "@/types";
import { formatNumber } from "@/utils/format";
import { Blueprint, Button, IconBox, ProgressTrack, AppText } from "@/components/ui";

function jobTitle(job: ProcessingJob): string {
  const kind = jobKind(job);
  if (job.status === "FAILED") {
    if (kind === "detailed") return "The detailed map could not be made";
    if (kind === "gcp") return "The map could not be lined up";
    return "Making the map failed";
  }
  if (job.status === "COMPLETED") return kind === "detailed" ? "Your detailed map is ready" : kind === "full" ? "Your field map is ready" : "Done";
  switch (kind) {
    case "detailed":
      return "Making the detailed map";
    case "gcp":
      return "Lining the map up with your surveyed points";
    case "full":
      return "Making your field map";
    case "mosaic":
      return "Rebuilding the field map";
    default:
      return "Re-checking crop health";
  }
}

/** What to expect while it runs (the detailed map takes hours). */
function jobNote(job: ProcessingJob): string {
  if (jobKind(job) === "detailed") return "Usually a few hours. The quick map stays until then — you can use it meanwhile.";
  return "You can leave this screen — progress updates automatically.";
}

/** Slowly rotating dashed reticle (canvas `agroSpin` 3.4 s). */
function Reticle({ color, spinning }: { color: string; spinning: boolean }) {
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = spinning ? withRepeat(withTiming(360, { duration: 3400, easing: Easing.linear }), -1, false) : 0;
  }, [rotation, spinning]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Svg width={34} height={34} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.2}>
        <Circle cx="12" cy="12" r="9" strokeDasharray="4 6" />
        <Circle cx="12" cy="12" r="3" />
      </Svg>
    </Animated.View>
  );
}

interface ProcessingHeroProps {
  job: ProcessingJob;
  surveyName?: string | null;
  imageCount?: number | null;
}

/** Canvas processing hero card: 74 px reticle box, 26 px title, note, progress bar, "Step N of M · current". */
export function ProcessingHero({ job, surveyName, imageCount }: ProcessingHeroProps) {
  const { colors } = useTheme();
  const active = isJobActive(job);
  const failed = job.status === "FAILED";
  const total = Math.max(job.steps.length, 1);
  const done = job.steps.filter((s) => s.status === "complete").length;
  const currentIndex = job.steps.findIndex((s) => s.key === job.current_step);
  const stepNo = failed ? Math.max(currentIndex + 1, 1) : Math.min(done + 1, total);
  const currentStep = job.steps[Math.max(currentIndex, 0)];
  const current = currentStep?.label ?? (job.status === "COMPLETED" ? "Complete" : "Waiting");
  const note = [surveyName, imageCount != null ? `${formatNumber(imageCount)} images` : null].filter(Boolean).join(" · ");

  return (
    <Blueprint padding={18} style={{ alignItems: "center", paddingVertical: 20 }}>
      <IconBox size={74} borderColor={colors.divider}>
        {failed ? <Clock size={30} color={colors.problem} strokeWidth={1.2} /> : <Reticle color={colors.accent} spinning={active} />}
      </IconBox>
      <AppText variant="title" style={{ fontSize: 26, lineHeight: 29, marginTop: 14, textAlign: "center" }}>
        {jobTitle(job)}
      </AppText>
      <AppText variant="bodySm" tone="muted" style={{ marginTop: 6, textAlign: "center" }}>
        {failed
          ? `${job.error_message ?? "Something went wrong on the server."}${jobKind(job) === "detailed" ? " The quick map is still there." : ""}`
          : `${note}${note ? ". " : ""}${jobNote(job)}`}
      </AppText>
      <View style={{ width: "100%", marginTop: 18 }}>
        <ProgressTrack fraction={done / total} color={failed ? colors.problem : colors.accent} accessibilityLabel={`Step ${stepNo} of ${total}`} />
      </View>
      <View style={styles.stepLine}>
        <AppText variant="small" tone="muted">
          Step {stepNo} of {total}
        </AppText>
        <AppText variant="small" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
          {current}
        </AppText>
      </View>
      {active && currentStep?.note ? (
        <AppText variant="small" tone="muted" style={{ alignSelf: "flex-end", marginTop: 2 }} numberOfLines={1}>
          {currentStep.note}
        </AppText>
      ) : null}
    </Blueprint>
  );
}

interface ProcessingStepsProps {
  job: ProcessingJob;
}

/** Canvas stage list: 56 px hairline rows, glyph (✓ done / ◷ working / □ waiting), label, note; the running row is tinted. */
export function ProcessingSteps({ job }: ProcessingStepsProps) {
  const { colors } = useTheme();
  const active = isJobActive(job);
  return (
    <View style={styles.steps}>
      {job.steps.map((step) => {
        const running = step.key === job.current_step && active;
        const done = step.status === "complete";
        const failed = step.status === "failed";
        const color = done ? colors.healthy : failed ? colors.problem : running ? colors.accent : colors.muted;
        const note = done ? "Done" : failed ? "Failed" : running ? "Working" : "Waiting";
        return (
          <View key={step.key} style={[styles.step, { borderColor: colors.divider, backgroundColor: running ? colors.accentTintSoft : "transparent" }]} accessibilityLabel={`${step.label}: ${note}`}>
            <View style={styles.glyph}>
              {done ? <Check size={16} color={color} strokeWidth={2.2} /> : running || failed ? <Clock size={16} color={color} strokeWidth={1.8} /> : <View style={{ width: 9, height: 9, borderWidth: 1, borderColor: color }} />}
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant={running ? "bodyStrong" : "body"}>{step.label}</AppText>
              {running && step.note ? (
                <AppText variant="small" tone="muted">
                  {step.note}
                </AppText>
              ) : null}
            </View>
            <AppText variant="small" tone="muted">
              {note}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}

interface ProcessingProgressProps {
  job: ProcessingJob;
  onRetry?: () => void;
  retrying?: boolean;
  /** Hero + bar only (embedded on survey / field / home). */
  compact?: boolean;
  surveyName?: string | null;
  imageCount?: number | null;
}

/** Full processing block: hero card, step list, retry when failed. */
export function ProcessingProgress({ job, onRetry, retrying = false, compact = false, surveyName, imageCount }: ProcessingProgressProps) {
  return (
    <View style={{ gap: 20 }}>
      <ProcessingHero job={job} surveyName={surveyName} imageCount={imageCount} />
      {!compact ? <ProcessingSteps job={job} /> : null}
      {job.status === "FAILED" && onRetry ? <Button label="Try again" size="lg" onPress={onRetry} loading={retrying} fullWidth /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stepLine: { flexDirection: "row", justifyContent: "space-between", width: "100%", marginTop: 8, gap: 12 },
  steps: { gap: 1 },
  step: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1 },
  glyph: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
});
