import type { PropsWithChildren } from "react";
import { RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

interface ScreenProps extends PropsWithChildren {
  /** Scrollable content with optional pull-to-refresh (default). Set false for lists that scroll themselves. */
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /** Extra bottom padding (the canvas pads 120 under the FAB). */
  bottomInset?: number;
  /** Apply the top safe-area inset (tab screens with no header). */
  safeTop?: boolean;
  /** Side padding; 0 when the screen draws its own header edge-to-edge. */
  padded?: boolean;
}

/** Page ground with safe-area handling and pull-to-refresh. */
export function Screen({ children, scroll = true, refreshing = false, onRefresh, style, contentStyle, bottomInset = 0, safeTop = false, padded = true }: ScreenProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const background = { backgroundColor: colors.bg };
  // The top inset lives on the outer container, not on the scroll content:
  // the status bar is translucent (edge-to-edge on Android, notch on iOS), so
  // padding inside the ScrollView only works at scroll offset 0 and content
  // slides under the clock and icons as soon as the page scrolls.
  const safe = safeTop ? { paddingTop: insets.top } : null;
  if (!scroll) {
    return <View style={[styles.flex, background, safe, style]}>{children}</View>;
  }
  const padding = {
    paddingTop: safeTop ? 8 : 0,
    paddingBottom: insets.bottom + 24 + bottomInset,
    paddingHorizontal: padded ? layout.pagePadding : 0,
  };
  return (
    <View style={[styles.flex, background, safe]}>
      <ScrollView
        style={[styles.flex, style]}
        contentContainerStyle={[padding, contentStyle]}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.bg} /> : undefined}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
