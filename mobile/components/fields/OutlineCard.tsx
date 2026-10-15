import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { FileUp, Map as MapIcon, RotateCcw } from "lucide-react-native";
import { iconStroke } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useFlightPlan } from "@/features/fields/hooks";
import { pickFlightPlanFile } from "@/features/upload/pickers";
import { describeError } from "@/services/errors";
import type { BoundaryFileResult, FieldSummary } from "@/types";
import { formatFieldArea } from "@/utils/format";
import { AppText, Blueprint, Button } from "@/components/ui";

/** Where the field's outline comes from — the flight plan (the exact field) or
 * the photo positions (an estimate) — and adding, replacing or removing the
 * flight plan. Every acre figure and health share of the field uses it.
 * Same as the website's OutlineCard. */
export function OutlineCard({ field }: { field: FieldSummary }) {
  const { colors } = useTheme();
  const { attach, remove } = useFlightPlan(field.id);
  const [message, setMessage] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  const fromPlan = field.boundary_source === "flight_plan";
  const busy = attach.isPending || remove.isPending;
  const failed = attach.error ?? remove.error;

  const done = (res: BoundaryFileResult, what: string) => {
    const area = res.field.area_hectares != null ? ` · ${formatFieldArea(res.field.area_hectares)}` : "";
    const recheck = res.rechecking
      ? ` Crop health is being checked again on the new outline (${res.rechecking} ${res.rechecking === 1 ? "flight" : "flights"}); the numbers update in a few minutes.`
      : "";
    setMessage(`${what}${area}.${recheck}${res.notes.length ? ` ${res.notes.join(" ")}` : ""}`);
  };

  const choose = async () => {
    setPickError(null);
    setMessage(null);
    try {
      const file = await pickFlightPlanFile();
      if (file) attach.mutate(file, { onSuccess: (res) => done(res, `Outline set from the flight plan${res.kind ? ` (${res.kind})` : ""}`) });
    } catch (err) {
      setPickError(err instanceof Error ? err.message : "The file could not be opened.");
    }
  };

  const backToPhotos = () =>
    Alert.alert("Use the photo outline?", "The outline estimated from where the photos were taken is used again. The acres and crop health are worked out again on it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Use it",
        onPress: () => {
          setMessage(null);
          remove.mutate(undefined, { onSuccess: (res) => done(res, "Back to the outline estimated from the photos") });
        },
      },
    ]);

  return (
    <Blueprint style={{ gap: 12 }}>
      <View style={styles.head}>
        <MapIcon size={18} color={colors.accent} strokeWidth={iconStroke} />
        <AppText variant="heading" style={{ flex: 1 }}>
          Field outline
        </AppText>
      </View>
      <View style={{ gap: 2 }}>
        <AppText variant="bodySm">
          {fromPlan ? "From the flight plan" : field.boundary_geojson ? "Estimated from where the photos were taken" : "Not known yet"}
          {field.area_hectares != null ? <AppText variant="bodySm" tone="muted">{` · ${formatFieldArea(field.area_hectares)}`}</AppText> : null}
        </AppText>
        {fromPlan && field.boundary_file ? (
          <AppText variant="caption" tone="muted" numberOfLines={1} ellipsizeMode="middle">
            {field.boundary_file}
          </AppText>
        ) : null}
        {!fromPlan ? (
          <AppText variant="caption" tone="muted">
            Add the flight plan — the area drawn for the mapping mission, as KMZ or KML — for the exact field. Every acre figure and health share uses this outline.
          </AppText>
        ) : null}
      </View>
      <View style={styles.buttons}>
        <Button
          label={fromPlan ? "Replace" : "Add flight plan (KMZ)"}
          variant="secondary"
          size="sm"
          icon={<FileUp size={16} color={colors.text} strokeWidth={iconStroke} />}
          loading={attach.isPending}
          disabled={busy}
          onPress={choose}
        />
        {fromPlan ? (
          <Button
            label="Use the photo outline"
            variant="secondary"
            size="sm"
            icon={<RotateCcw size={16} color={colors.text} strokeWidth={iconStroke} />}
            loading={remove.isPending}
            disabled={busy}
            onPress={backToPhotos}
          />
        ) : null}
      </View>
      {message ? (
        <AppText variant="bodySm" tone="healthy">
          {message}
        </AppText>
      ) : null}
      {pickError || failed ? (
        <AppText variant="bodySm" tone="problem">
          {pickError ?? describeError(failed).message}
        </AppText>
      ) : null}
    </Blueprint>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
