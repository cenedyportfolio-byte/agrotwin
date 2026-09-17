import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { Building2, CircleHelp, Cog, Layers, Upload, Wifi } from "lucide-react-native";
import { iconStroke, layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useAuth } from "@/providers/AuthProvider";
import { useFields } from "@/features/fields/hooks";
import { useTestConnection } from "@/features/settings/hooks";
import { useShallow } from "zustand/react/shallow";
import { effectiveUrls, useSettingsStore, type ThemePreference } from "@/stores/settingsStore";
import { Blueprint, CheckRow, IconBox, ListGroup, ListRow, Screen, SectionHeader, StatusBadge, AppText } from "@/components/ui";
import { AskAiFab } from "@/components/ai/AskAiFab";

const MODES: Array<{ key: ThemePreference; label: string }> = [
  { key: "light", label: "Light — bright sunlight" },
  { key: "dark", label: "Dark — early morning and night" },
  { key: "system", label: "Match my phone" },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export default function ProfileScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { userName } = useAuth();
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const advanced = useSettingsStore((s) => s.advancedMode);
  const urls = useSettingsStore(useShallow((s) => effectiveUrls(s)));
  const fields = useFields();
  const test = useTestConnection();

  const farm = useMemo(() => {
    const list = fields.data ?? [];
    const ha = list.reduce((sum, f) => sum + (f.area_hectares ?? 0), 0);
    return { count: list.length, ha };
  }, [fields.data]);
  const name = userName ?? "Farmer";
  const serverHost = urls.apiUrl ? urls.apiUrl.replace(/^https?:\/\//, "") : "Not set";

  return (
    <Screen safeTop bottomInset={layout.bottomClearance}>
      <AppText variant="display" style={{ marginBottom: 16 }}>
        Profile
      </AppText>

      <Blueprint padding={16} style={styles.hero}>
        <IconBox size={58} borderColor={colors.divider}>
          <AppText variant="number" tone="accent" style={{ fontSize: 24 }}>
            {initials(name) || "AT"}
          </AppText>
        </IconBox>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="cardTitle" style={{ fontSize: 22 }} numberOfLines={1}>
            {name}
          </AppText>
          <AppText variant="caption" tone="muted">
            {fields.isPending ? "Loading fields…" : `AgroTwin · ${farm.ha.toFixed(1)} ha · ${farm.count} ${farm.count === 1 ? "field" : "fields"}`}
          </AppText>
        </View>
      </Blueprint>

      <View style={{ marginTop: 20 }}>
        <SectionHeader title="Appearance" />
        <ListGroup>
          {MODES.map((m, i) => (
            <CheckRow key={m.key} label={m.label} checked={theme === m.key} onPress={() => setTheme(m.key)} last={i === MODES.length - 1} />
          ))}
        </ListGroup>
      </View>

      <View style={{ marginTop: 20 }}>
        <SectionHeader title="Settings" />
        <ListGroup>
          <ListRow
            icon={<Wifi size={20} color={colors.accent} strokeWidth={iconStroke} />}
            label="AgroTwin computer"
            note={serverHost}
            onPress={() => router.push("/settings")}
            right={
              test.isSuccess ? <StatusBadge tier="healthy" label="Connected" /> : test.isError ? <StatusBadge tier="problem" label="Unreachable" /> : undefined
            }
          />
          <ListRow icon={<Building2 size={20} color={colors.accent} strokeWidth={iconStroke} />} label="Fields" note={`${farm.count} ${farm.count === 1 ? "field" : "fields"} on this server`} onPress={() => router.push("/(tabs)/fields")} />
          <ListRow icon={<Upload size={20} color={colors.accent} strokeWidth={iconStroke} />} label="New survey" note="Upload a small flight or import results" onPress={() => router.push("/upload")} />
          <ListRow icon={<Layers size={20} color={colors.accent} strokeWidth={iconStroke} />} label="Detail level" note={advanced ? "Advanced — methods and technical names shown" : "Simple — farmer wording"} onPress={() => router.push("/settings")} />
          <ListRow icon={<CircleHelp size={20} color={colors.accent} strokeWidth={iconStroke} />} label="Help & support" note="Setup and troubleshooting in mobile/README.md" onPress={() => router.push("/settings")} />
          <ListRow icon={<Cog size={20} color={colors.accent} strokeWidth={iconStroke} />} label="About" note={`AgroTwin Mobile ${Constants.expoConfig?.version ?? ""} · local, no cloud`} last />
        </ListGroup>
      </View>

      <AskAiFab aboveTabBar />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: "row", alignItems: "center", gap: 14 },
});
