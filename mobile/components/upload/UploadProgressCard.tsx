import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Check, X } from "lucide-react-native";
import { useTheme } from "@/hooks/useTheme";
import type { UploadProgress } from "@/features/upload/useUploadFlow";
import { formatNumber } from "@/utils/format";
import { Blueprint, Button, ProgressTrack, AppText } from "@/components/ui";

interface UploadProgressCardProps {
  progress: UploadProgress;
  onCancel?: () => void;
  onOpenSurvey?: () => void;
  onRetry?: () => void;
  onReset?: () => void;
}

const TITLES: Record<UploadProgress["state"], string> = {
  IDLE: "Ready",
  SELECTING: "Choosing files",
  UPLOADING: "Uploading to AgroTwin",
  PROCESSING: "Upload complete — making the map",
  COMPLETED: "Upload complete",
  FAILED: "Upload failed",
};

/** Canvas upload progress card: status icon + title, accent progress bar, count, and contextual actions. */
export function UploadProgressCard({ progress, onCancel, onOpenSurvey, onRetry, onReset }: UploadProgressCardProps) {
  const { colors } = useTheme();
  const pct = Math.round(progress.fraction * 100);
  const busy = progress.state === "UPLOADING";
  return (
    <Blueprint accessibilityLabel={`${TITLES[progress.state]}, ${pct} percent`}>
      <View style={styles.header}>
        {busy ? <ActivityIndicator color={colors.accent} /> : progress.state === "FAILED" ? <X size={22} color={colors.problem} strokeWidth={1.8} /> : <Check size={22} color={colors.healthy} strokeWidth={2.2} />}
        <AppText variant="heading" style={{ flex: 1 }}>
          {TITLES[progress.state]}
        </AppText>
      </View>
      <View style={{ marginTop: 12, marginBottom: 8 }}>
        <ProgressTrack fraction={pct / 100} height={10} color={progress.state === "FAILED" ? colors.problem : colors.accent} accessibilityLabel={`${pct}%`} />
      </View>
      <AppText variant="caption" tone="muted">
        {progress.totalFiles > 1
          ? `${formatNumber(Math.min(progress.uploadedFiles, progress.totalFiles))} of ${formatNumber(progress.totalFiles)} files · batch ${progress.currentBatch}/${progress.totalBatches}`
          : `${pct}%`}
      </AppText>
      {progress.error ? (
        <AppText variant="body" tone="problem" style={{ marginTop: 8 }}>
          {progress.error}
        </AppText>
      ) : null}
      <View style={styles.actions}>
        {busy && onCancel ? <Button label="Cancel" variant="secondary" size="sm" onPress={onCancel} /> : null}
        {progress.state === "FAILED" && onRetry ? <Button label="Retry" size="sm" onPress={onRetry} /> : null}
        {(progress.state === "COMPLETED" || progress.state === "PROCESSING") && onOpenSurvey ? <Button label="Open the flight" size="sm" onPress={onOpenSurvey} /> : null}
        {!busy && onReset ? <Button label="Upload more" variant="ghost" size="sm" onPress={onReset} /> : null}
      </View>
    </Blueprint>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
});
