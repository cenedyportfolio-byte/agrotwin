import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Globe2, Map as MapIcon, Sparkles } from "lucide-react-native";
import { immersive } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { AppText } from "@/components/ui";
import type { TwinMode } from "./digitalTwinBridge";

export interface TwinModeSelectorProps {
  mode: TwinMode;
  onSelectMode: (mode: TwinMode) => void;
  tone?: "raised" | "dark";
  style?: StyleProp<ViewStyle>;
}

export const TWIN_MODES: Array<{ key: TwinMode; label: string; icon: typeof MapIcon }> = [
  { key: "field-map", label: "Map", icon: MapIcon },
  { key: "3d-twin", label: "3D", icon: Globe2 },
  { key: "photorealistic", label: "Realistic", icon: Sparkles },
];

/**
 * 3-mode segmented switcher for Field Map (2D) · 3D Twin · Photorealistic (Gaussian splats).
 * Clean floating hairline pill styled after the Industry design system.
 */
export function TwinModeSelector({ mode, onSelectMode, tone = "raised", style }: TwinModeSelectorProps) {
  const { colors } = useTheme();
  const isDark = tone === "dark";

  const containerBg = isDark ? immersive.panel : colors.bg;
  const borderColor = isDark ? immersive.border : colors.divider;
  const inactiveText = isDark ? immersive.textMuted : colors.text;
  const inactiveIcon = isDark ? immersive.textFaint : colors.muted;

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: containerBg, borderColor },
        !isDark && colors.shadowMd,
        style,
      ]}
      accessibilityRole="tablist"
      accessibilityLabel="Map mode selector"
    >
      {TWIN_MODES.map((item) => {
        const active = mode === item.key;
        const Icon = item.icon;
        return (
          <Pressable
            key={item.key}
            testID={`mode-tab-${item.key}`}
            onPress={() => onSelectMode(item.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${item.label} mode`}
            style={({ pressed }) => [
              styles.tab,
              active && { backgroundColor: colors.accent },
              !active && pressed && { backgroundColor: isDark ? "rgba(255,255,255,0.08)" : colors.pressed },
            ]}
          >
            <Icon
              size={14}
              color={active ? colors.onAccent : inactiveIcon}
              strokeWidth={active ? 2.2 : 1.7}
            />
            <AppText
              variant="small"
              style={[
                styles.label,
                { color: active ? colors.onAccent : inactiveText },
                active && styles.activeLabel,
              ]}
              numberOfLines={1}
            >
              {item.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    padding: 3,
    gap: 3,
    alignSelf: "flex-start",
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 32,
  },
  label: {
    fontSize: 13,
    lineHeight: 16,
  },
  activeLabel: {
    fontWeight: "600",
  },
});
