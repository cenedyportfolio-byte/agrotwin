import { StyleSheet, View } from "react-native";
import { Check, Clock } from "lucide-react-native";
import { useTheme } from "@/hooks/useTheme";
import type { SurveyAvailability } from "@/types";
import type { SplatAvailability } from "@/features/digitalTwin/hooks";
import { formatNumber } from "@/utils/format";
import { AppText } from "@/components/ui";

type Mark = "done" | "run" | "wait" | "none";

interface Item {
  label: string;
  mark: Mark;
  note: string;
  advancedOnly?: boolean;
}

interface SurveyAssetListProps {
  availability: SurveyAvailability;
  hasAnalysis: boolean;
  processing: boolean;
  imageCount: number;
  zoneCount: number | null;
  splat: SplatAvailability | undefined;
  advanced?: boolean;
}

/**
 * Canvas "Available data": hairline list, 48 px rows, a glyph per state
 * (✓ done in ok, ◷ running in accent, □ waiting / not available), label,
 * muted note. Every value comes from the backend availability endpoint.
 */
export function SurveyAssetList({ availability, hasAnalysis, processing, imageCount, zoneCount, splat, advanced = false }: SurveyAssetListProps) {
  const { colors } = useTheme();
  const run = (ready: boolean): Mark => (ready ? "done" : processing ? "run" : "wait");
  const ifAvail = (ready: boolean): Mark => (ready ? "done" : "none");
  const items: Item[] = ([
    { label: "Drone photos", mark: ifAvail(imageCount > 0), note: imageCount > 0 ? formatNumber(imageCount) : "None uploaded" },
    { label: "Photo positions (GPS)", mark: ifAvail(availability.gps_metadata), note: availability.gps_metadata ? "Complete" : "Missing" },
    { label: "Field map", mark: run(availability.orthomosaic), note: availability.orthomosaic ? "Ready" : processing ? "Building" : "Not made" },
    { label: "Crop health check", mark: run(hasAnalysis), note: hasAnalysis ? "Done" : processing ? "Running" : "Not run" },
    { label: "Spots to check", mark: run(hasAnalysis), note: zoneCount != null ? `${zoneCount} found` : "" },
    { label: "3D view", mark: availability.model_3d ? "done" : processing ? "run" : "wait", note: availability.model_3d ? "3D model" : "Terrain only" },
    { label: "Photorealistic view", mark: ifAvail(splat === "available"), note: splat === "available" ? "Ready" : splat === "missing" ? "Not built" : "Unknown" },
    { label: "Heat (thermal) map", mark: ifAvail(availability.thermal), note: availability.thermal ? "Available" : "Not flown" },
    { label: "Crop-health camera bands", mark: ifAvail(availability.multispectral), note: availability.multispectral ? "Available" : "Colour photos only", advancedOnly: true },
    { label: "Elevation (DSM)", mark: ifAvail(availability.dsm), note: availability.dsm ? "Available" : "Not built", advancedOnly: true },
    { label: "Point cloud", mark: ifAvail(availability.pointcloud), note: availability.pointcloud ? "Available" : "Not built", advancedOnly: true },
    { label: "PPK / RTK corrections", mark: ifAvail(availability.gnss_ppk), note: availability.gnss_ppk ? "Imported" : "None", advancedOnly: true },
  ] satisfies Item[]).filter((i) => advanced || !i.advancedOnly);

  return (
    <View style={[styles.list, { borderColor: colors.divider }]} accessibilityRole="list">
      {items.map((item, i) => {
        const color = item.mark === "done" ? colors.healthy : item.mark === "run" ? colors.accent : colors.muted;
        return (
          <View key={item.label} style={[styles.row, i < items.length - 1 && { borderBottomColor: colors.hairline, borderBottomWidth: 1 }]} accessibilityLabel={`${item.label}: ${item.note || item.mark}`}>
            <View style={styles.glyph}>
              {item.mark === "done" ? (
                <Check size={16} color={color} strokeWidth={2.2} />
              ) : item.mark === "run" ? (
                <Clock size={16} color={color} strokeWidth={1.8} />
              ) : (
                <View style={{ width: 9, height: 9, borderWidth: 1, borderColor: color }} />
              )}
            </View>
            <AppText variant="bodySm" style={{ flex: 1 }}>
              {item.label}
            </AppText>
            <AppText variant="small" tone="muted">
              {item.note}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { borderWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 11, minHeight: 48, paddingHorizontal: 14, paddingVertical: 6 },
  glyph: { width: 22, alignItems: "center", justifyContent: "center" },
});
