import { useState } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { AlertTriangle, ChevronRight, CircleCheck, Info, Plane } from "lucide-react-native";
import { iconStroke } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useFlightCheck } from "@/features/surveys/hooks";
import type { FlightCheckItem } from "@/types";
import { AppText, Blueprint, Button } from "@/components/ui";

/** How the flight was flown — height, detail, overlap, camera angle, sun, GPS,
 * bands — measured from the photos, with what to change for the next flight.
 * Advice only: processing goes ahead whatever it says. Same as the website's
 * FlightCheckCard. */
export function FlightCheckCard({ surveyId, photos, style }: { surveyId: string; photos: number; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  const router = useRouter();
  const check = useFlightCheck(surveyId, photos);
  const [open, setOpen] = useState<boolean | null>(null);
  const data = check.data;
  if (!data || data.status === "unknown") return null;
  const expanded = open ?? data.status === "check";
  const good = data.status === "good";
  const tone = good ? colors.healthy : colors.attention;

  return (
    <Blueprint style={[{ gap: 12 }, style]}>
      <Pressable onPress={() => setOpen(!expanded)} accessibilityRole="button" accessibilityState={{ expanded }} style={styles.head}>
        <Plane size={18} color={colors.accent} strokeWidth={iconStroke} />
        <View style={{ flex: 1 }}>
          <AppText variant="heading">Flight check</AppText>
          <View style={[styles.row, { marginTop: 2 }]}>
            {good ? <CircleCheck size={15} color={tone} strokeWidth={iconStroke} /> : <AlertTriangle size={15} color={tone} strokeWidth={iconStroke} />}
            <AppText variant="bodySm" tone={good ? "healthy" : "attention"} style={{ flex: 1 }}>
              {data.summary}
            </AppText>
          </View>
        </View>
        <ChevronRight size={18} color={colors.muted} strokeWidth={iconStroke} style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }} />
      </Pressable>

      {expanded ? (
        <>
          <View>
            {data.items.map((item, i) => (
              <Row key={item.key} item={item} first={i === 0} />
            ))}
          </View>
          <AppText variant="caption" tone="muted">
            {"Measured from the photos' own flight data. Advice for the next flight — this map is made either way."}
          </AppText>
          <Button label="How to fly for a good map" variant="ghost" align="start" minHeight={36} onPress={() => router.push("/flight-guide")} />
        </>
      ) : null}
    </Blueprint>
  );
}

function Row({ item, first }: { item: FlightCheckItem; first: boolean }) {
  const { colors } = useTheme();
  const color = item.status === "ok" ? colors.healthy : item.status === "warn" ? colors.attention : colors.muted;
  const Icon = item.status === "ok" ? CircleCheck : item.status === "warn" ? AlertTriangle : Info;
  return (
    <View style={[styles.item, !first && { borderTopWidth: 1, borderTopColor: colors.hairline }]}>
      <Icon size={15} color={color} strokeWidth={iconStroke} style={{ marginTop: 3 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.line}>
          <AppText variant="bodySm" tone="muted">
            {item.label}
          </AppText>
          <AppText variant="bodySmStrong" style={{ flexShrink: 1, textAlign: "right" }}>
            {item.value}
          </AppText>
        </View>
        {item.status === "warn" && item.target ? (
          <AppText variant="small" tone="muted">
            Aim for: {item.target}
          </AppText>
        ) : null}
        {item.message ? (
          <AppText variant="caption" tone={item.status === "warn" ? "attention" : "muted"}>
            {item.message}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  item: { flexDirection: "row", gap: 8, paddingVertical: 8 },
  line: { flexDirection: "row", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
});
