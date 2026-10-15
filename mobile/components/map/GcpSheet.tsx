import { Linking, Share, StyleSheet, View } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import type { ViewerGcp } from "@/components/digitalTwin/digitalTwinBridge";
import { formatFeet, formatTargetSize } from "@/utils/format";
import { AppText, BottomSheet, Button, KeyValueRow } from "@/components/ui";

/** 36.0969 → 36°05'48.84"N — what a handheld GPS shows by default. */
export function dms(value: number, positive: string, negative: string): string {
  const a = Math.abs(value);
  const d = Math.floor(a);
  const mFull = (a - d) * 60;
  const m = Math.floor(mFull);
  const s = (mFull - m) * 60;
  return `${d}°${String(m).padStart(2, "0")}'${s.toFixed(2).padStart(5, "0")}"${value >= 0 ? positive : negative}`;
}

function kindLabel(gcp: ViewerGcp): string {
  if (gcp.source === "surveyed") return `Surveyed point · ${gcp.rtk ? "RTK" : "handheld GPS"}`;
  // the small markers (~17 cm) stand apart from the 40–60 cm targets
  return gcp.size_m != null && gcp.size_m < 0.3 ? "Small marker" : "Ground control target";
}

/** A tapped ground control target: where it is, to walk to it or check it with a GPS.
 * Shown by the app (the web viewer's own panel would sit under the map buttons). */
export function GcpSheet({ gcp, onClose }: { gcp: ViewerGcp | null; onClose: () => void }) {
  const { colors } = useTheme();
  const latLon = gcp ? `${gcp.lat.toFixed(7)}, ${gcp.lon.toFixed(7)}` : "";
  return (
    <BottomSheet
      visible={!!gcp}
      onClose={onClose}
      accessibilityLabel={gcp ? `${gcp.name} position` : "Target position"}
      header={
        gcp ? (
          <View style={{ marginBottom: 10 }}>
            <AppText variant="title" style={{ fontSize: 24, lineHeight: 26 }}>
              {gcp.name}
            </AppText>
            <AppText variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {kindLabel(gcp)}
            </AppText>
            {/* side × side and area of the checkerboard, on its own line (as on the website) */}
            {gcp.source !== "surveyed" && gcp.size_m != null ? (
              <AppText variant="caption" tone="muted" numberOfLines={1}>
                {formatTargetSize(gcp.size_m)}
              </AppText>
            ) : null}
          </View>
        ) : null
      }
    >
      {gcp ? (
        <>
          <View style={[styles.box, { borderColor: colors.divider }]}>
            <KeyValueRow label="Latitude" value={gcp.lat.toFixed(7)} />
            <KeyValueRow label="Longitude" value={gcp.lon.toFixed(7)} />
            <KeyValueRow label="On a GPS" value={`${dms(gcp.lat, "N", "S")}  ${dms(gcp.lon, "E", "W")}`} last={gcp.height_m == null} />
            {gcp.height_m != null ? <KeyValueRow label={gcp.source === "surveyed" ? "Elevation (your file)" : "Surface height"} value={formatFeet(gcp.height_m, 1)} last /> : null}
          </View>
          <AppText variant="small" tone="muted" style={{ marginTop: 8 }}>
            {gcp.source === "surveyed" ? "WGS84, as in your ground control points file." : "WGS84, the centre of the target as found in the detailed map."}
          </AppText>
          <View style={styles.actions}>
            <Button
              label="Open in Maps"
              minHeight={50}
              onPress={() => void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${gcp.lat.toFixed(7)},${gcp.lon.toFixed(7)}`)}
              style={{ flex: 1 }}
            />
            <Button label="Share" variant="secondary" minHeight={50} onPress={() => void Share.share({ message: `${gcp.name}: ${latLon}` })} style={{ flex: 1 }} />
          </View>
        </>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, paddingHorizontal: 12 },
  actions: { flexDirection: "row", gap: 8, marginTop: 14 },
});
