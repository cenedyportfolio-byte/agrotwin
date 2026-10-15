import { useState } from "react";
import { ActivityIndicator, StyleSheet, Switch, TextInput, View } from "react-native";
import { FileText } from "lucide-react-native";
import { iconStroke, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { pickGcpFile } from "@/features/upload/pickers";
import type { LocalFile } from "@/services/surveys";
import type { GcpFileInfo } from "@/types";
import { AppText, Button } from "@/components/ui";

const FORMAT_LABEL: Record<GcpFileInfo["format"], string> = {
  "csv-latlon": "latitude / longitude",
  "csv-projected": "easting / northing",
  odm: "OpenDroneMap gcp_list.txt",
};

interface GcpFileFieldsProps {
  file: LocalFile | null;
  onFile: (file: LocalFile | null) => void;
  rtk: boolean;
  onRtk: (rtk: boolean) => void;
  epsg: string;
  onEpsg: (epsg: string) => void;
  info: GcpFileInfo | null;
  error: string | null;
  checking: boolean;
  disabled?: boolean;
}

/** The optional GCP file: the file, whether it was measured with RTK, the
 * coordinate system when it uses UTM / State Plane, and what was read from it.
 * Same fields as the website's GcpFileFields. */
export function GcpFileFields({ file, onFile, rtk, onRtk, epsg, onEpsg, info, error, checking, disabled = false }: GcpFileFieldsProps) {
  const { colors } = useTheme();
  const [pickError, setPickError] = useState<string | null>(null);
  const askEpsg = !!epsg || info?.format === "csv-projected" || (error?.includes("EPSG") ?? false);

  const choose = async () => {
    setPickError(null);
    try {
      const picked = await pickGcpFile();
      if (picked) onFile(picked);
    } catch (err) {
      setPickError(err instanceof Error ? err.message : "The file could not be opened.");
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.row}>
        <Button
          label={file ? file.name : "Choose the file (CSV or gcp_list.txt)"}
          variant="secondary"
          icon={<FileText size={16} color={colors.text} strokeWidth={iconStroke} />}
          onPress={choose}
          disabled={disabled}
          align="start"
          style={{ flex: 1 }}
        />
        {file && !disabled ? <Button label="Remove" variant="ghost" size="sm" onPress={() => onFile(null)} /> : null}
      </View>
      {pickError ? (
        <AppText variant="caption" tone="problem">
          {pickError}
        </AppText>
      ) : null}

      {file ? (
        <>
          <View style={[styles.row, { alignItems: "flex-start" }]}>
            <Switch value={rtk} onValueChange={onRtk} disabled={disabled} trackColor={{ true: colors.accent }} accessibilityLabel="Measured with an RTK GPS" />
            <View style={{ flex: 1 }}>
              <AppText variant="bodyStrong">Measured with an RTK GPS (accurate to about an inch)</AppText>
              <AppText variant="caption" tone="muted" style={{ marginTop: 2 }}>
                Then the detailed map is lined up with these points. Leave it off for a handheld GPS or phone — the points are then only compared, because they are less
                accurate than the map.
              </AppText>
            </View>
          </View>

          {askEpsg ? (
            <View style={{ gap: 4 }}>
              <AppText variant="caption" tone="muted">
                Coordinate system (EPSG code, for UTM or State Plane)
              </AppText>
              <TextInput
                value={epsg}
                onChangeText={onEpsg}
                editable={!disabled}
                placeholder="e.g. 6576 — Tennessee State Plane, US feet"
                placeholderTextColor={colors.muted}
                keyboardType="number-pad"
                accessibilityLabel="EPSG code"
                style={[styles.input, typography.body, { color: colors.text, borderColor: colors.divider }]}
              />
            </View>
          ) : null}

          {checking ? (
            <View style={styles.row}>
              <ActivityIndicator size="small" color={colors.muted} />
              <AppText variant="caption" tone="muted">
                Reading the file…
              </AppText>
            </View>
          ) : null}
          {error ? (
            <AppText variant="bodySm" tone="problem">
              {error}
            </AppText>
          ) : null}
          {info && !error ? (
            <AppText variant="caption" tone="muted">
              <AppText variant="caption" tone="healthy">
                {info.points.length} {info.points.length === 1 ? "point" : "points"} read
              </AppText>{" "}
              ({FORMAT_LABEL[info.format]}):{" "}
              {info.points
                .slice(0, 6)
                .map((p) => p.name)
                .join(", ")}
              {info.points.length > 6 ? ", …" : ""}
              {info.notes.length > 0 ? ` · ${info.notes.join(" ")}` : ""}
            </AppText>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  input: { height: 48, borderWidth: 1, paddingHorizontal: 12 },
});
