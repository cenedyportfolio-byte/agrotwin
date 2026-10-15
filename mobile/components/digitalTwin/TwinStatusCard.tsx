import { StyleSheet, View } from "react-native";
import { immersive } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { Button, AppText } from "@/components/ui";
import type { SplatStatus, TwinMode } from "./digitalTwinBridge";

interface TwinModeCardProps {
  mode: TwinMode;
  ready: boolean;
  splat: { status: SplatStatus; detail?: string } | null;
  splatAvailable: boolean;
  hasMesh: boolean;
  processing: boolean;
  layerError: string | null;
  onOpenPhotorealistic: () => void;
}

const TITLES: Record<TwinMode, string> = { "field-map": "Field map", "3d-twin": "3D twin", photorealistic: "Photorealistic view" };

/**
 * Canvas bottom card in the Digital Twin: status swatch, mode title, an
 * uppercase state on the right, one line of copy, and "Open view" when a
 * photorealistic reconstruction exists and is not the current view.
 */
export function TwinModeCard({ mode, ready, splat, splatAvailable, hasMesh, processing, layerError, onOpenPhotorealistic }: TwinModeCardProps) {
  const { colors } = useTheme();

  let state: { label: string; color: string; copy: string };
  if (layerError) state = { label: "Problem", color: colors.problem, copy: layerError };
  else if (!ready) state = { label: "Loading", color: colors.accent, copy: "The 3D viewer and field imagery are streamed from the AgroTwin server." };
  else if (mode === "photorealistic") {
    const s = splat?.status ?? "idle";
    state =
      s === "loaded"
        ? { label: "Ready", color: colors.healthy, copy: "Gaussian splats reconstructed from this survey's frames, aligned to the RTK camera positions." }
        : s === "loading"
          ? { label: "Loading", color: colors.accent, copy: "Loading the photorealistic reconstruction. Best over Wi-Fi." }
          : s === "missing"
            ? { label: "Not built", color: colors.muted, copy: "No photorealistic 3D view exists for this flight yet — it is built on the AgroTwin server." }
            : s === "error"
              ? { label: "Problem", color: colors.problem, copy: `Could not load the reconstruction: ${splat?.detail ?? "unknown error"}` }
              : { label: "Preparing", color: colors.accent, copy: "Preparing…" };
  } else if (mode === "3d-twin") {
    state = hasMesh
      ? { label: "Ready", color: colors.healthy, copy: "Reality mesh, elevation or point cloud from this survey on 3D terrain." }
      : processing
        ? { label: "Processing", color: colors.accent, copy: "Terrain view is ready; this survey's 3D products are still processing." }
        : { label: "Terrain only", color: colors.attention, copy: "No reconstruction of this survey has been built yet — showing the field on 3D terrain." };
  } else {
    state = { label: "Ready", color: colors.healthy, copy: "Photo map, health zones and photo positions draped on 3D terrain." };
  }

  const showOpen = splatAvailable && mode !== "photorealistic" && ready;

  return (
    <View style={styles.card} accessibilityLabel={`${TITLES[mode]}: ${state.label}`}>
      <View style={styles.head}>
        <View style={{ width: 10, height: 10, backgroundColor: state.color }} />
        <AppText variant="heading" tone="inverse" style={{ flex: 1, fontSize: 18, lineHeight: 20 }}>
          {TITLES[mode]}
        </AppText>
        <AppText variant="tagUpper" tone="inverseMuted">
          {state.label}
        </AppText>
      </View>
      <AppText variant="caption" style={{ color: immersive.textMuted, marginTop: 6 }}>
        {state.copy}
      </AppText>
      {showOpen ? <Button label="Open photorealistic view" size="md" onPress={onOpenPhotorealistic} fullWidth style={{ marginTop: 12 }} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: immersive.panelStrong, borderWidth: 1, borderColor: immersive.border, padding: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
});
