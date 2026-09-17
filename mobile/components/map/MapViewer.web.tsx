import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import type { Geometry } from "geojson";
import type { DetectionZone, SurveyAsset, SurveyImage } from "@/types";
import type { BBox, LatLng } from "@/utils/geo";
import { useTheme } from "@/hooks/useTheme";
import { AppText } from "@/components/ui";

/**
 * Web has no supported build of react-native-maps (it ships `codegenNativeComponent`
 * native specs that crash under react-native-web). Expo Router loads every route
 * module up front to build its route tree, so importing react-native-maps
 * anywhere — even from a screen the user never opens — crashes the whole web
 * bundle. This file (picked automatically for the web platform, same exports
 * as MapViewer.tsx) keeps `npm run web` usable for every other screen; the
 * real map is Android/iOS only, via Expo Go or a device.
 */
export interface MapViewerHandle {
  fitToField: (animated?: boolean) => void;
  focusOn: (bbox: BBox | LatLng, animated?: boolean) => void;
}

interface MapViewerProps {
  boundary: Geometry | null | undefined;
  zones: DetectionZone[];
  images: SurveyImage[];
  assets: SurveyAsset[] | undefined;
  selectedZoneId?: string | null;
  onSelectZone?: (zone: DetectionZone | null) => void;
  highlightImageId?: string | null;
  showsUserLocation?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  onMapReady?: () => void;
  onBaseMapStalled?: () => void;
  onBaseMapLoaded?: () => void;
  edgePadding?: { top: number; right: number; bottom: number; left: number };
}

export const MapViewer = forwardRef<MapViewerHandle, MapViewerProps>(function MapViewer({ style, onMapReady }, ref) {
  const { colors } = useTheme();

  useImperativeHandle(ref, () => ({ fitToField: () => {}, focusOn: () => {} }), []);
  // Screens wait on this before hiding their loading state — fire it once mounted.
  useEffect(() => onMapReady?.(), [onMapReady]);

  return (
    <View style={[styles.fill, { backgroundColor: colors.surface }, style]}>
      <AppText variant="heading" style={{ textAlign: "center", paddingHorizontal: 24 }}>
        Field map is available in the mobile app
      </AppText>
      <AppText variant="body" tone="muted" style={{ textAlign: "center", paddingHorizontal: 24, marginTop: 8 }}>
        Open AgroTwin in Expo Go on an Android or iOS device to view the field boundary, health zones and imagery layers.
      </AppText>
    </View>
  );
});

const styles = StyleSheet.create({ fill: { flex: 1, alignItems: "center", justifyContent: "center" } });
