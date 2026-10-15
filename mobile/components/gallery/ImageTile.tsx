import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { useTheme } from "@/hooks/useTheme";
import type { SurveyImage } from "@/types";
import { formatCoordinate, formatFeet } from "@/utils/format";
import { AppText } from "@/components/ui";
import { authHeaders } from "@/services/apiClient";

interface ImageTileProps {
  image: SurveyImage;
  index: number;
  thumbnailUrl: string;
  onPress: () => void;
  /** `grid`: 4:3 thumbnail with the name and meta below; `list`: 72×54 thumbnail beside the text. */
  layout: "grid" | "list";
  width: number;
}

/** Canvas gallery tile: hairline frame, square corners, filename + "lat · lon · altitude" meta. Memoised for long lists. */
export const ImageTile = memo(function ImageTile({ image, index, thumbnailUrl, onPress, layout, width }: ImageTileProps) {
  const { colors } = useTheme();
  const meta = image.lat != null && image.lon != null ? `${formatCoordinate(image.lat, image.lon)} · ${formatFeet(image.rel_altitude_m ?? image.altitude_m)}` : "No GPS";
  const grid = layout === "grid";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={`Image ${index + 1}, ${image.filename}, ${meta}`}
      style={({ pressed }) => [styles.tile, grid ? { width } : styles.listTile, { borderColor: colors.divider }, pressed && { backgroundColor: colors.pressed }]}
    >
      <View style={[grid ? styles.thumbGrid : styles.thumbList, { backgroundColor: colors.skeleton }]}>
        <Image source={{ uri: thumbnailUrl, headers: authHeaders() }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" recyclingKey={image.id} transition={120} accessibilityIgnoresInvertColors />
      </View>
      <View style={grid ? styles.metaGrid : styles.metaList}>
        <AppText variant="smallStrong" numberOfLines={1}>
          {image.filename}
        </AppText>
        <AppText variant="label" tone="muted" numberOfLines={1}>
          {meta}
        </AppText>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  tile: { borderWidth: 1, borderRadius: 0 },
  listTile: { flexDirection: "row", alignItems: "center", gap: 12, padding: 8, width: "100%" },
  thumbGrid: { width: "100%", aspectRatio: 4 / 3 },
  thumbList: { width: 72, height: 54, flexShrink: 0 },
  metaGrid: { paddingTop: 7, paddingHorizontal: 8, paddingBottom: 9 },
  metaList: { flex: 1, minWidth: 0 },
});
