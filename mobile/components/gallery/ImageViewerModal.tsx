import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, ChevronRight, Info, X } from "lucide-react-native";
import { immersive } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { SurveyImage } from "@/types";
import { Button, IconButton, AppText } from "@/components/ui";
import { ImageMetadata } from "./ImageMetadata";
import { authHeaders } from "@/services/apiClient";

interface ImageViewerModalProps {
  images: SurveyImage[];
  index: number | null;
  displayUrl: (image: SurveyImage) => string;
  drone?: string | null;
  onClose: () => void;
  onChangeIndex: (index: number) => void;
  onViewOnMap?: (image: SurveyImage) => void;
  advanced?: boolean;
}

/**
 * Canvas image viewer: #0e1012 ground, 46 px outlined close/info buttons,
 * "N of M · name" label, 4:3 stage, prev/next with "Swipe or pinch to zoom",
 * and the "Image details" sheet.
 */
export function ImageViewerModal({ images, index, displayUrl, drone, onClose, onChangeIndex, onViewOnMap, advanced }: ImageViewerModalProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [showInfo, setShowInfo] = useState(false);
  const [loading, setLoading] = useState(true);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const reset = () => {
    scale.value = withTiming(1);
    savedScale.value = 1;
    tx.value = withTiming(0);
    ty.value = withTiming(0);
    savedTx.value = 0;
    savedTy.value = 0;
  };
  useEffect(() => {
    reset();
    setLoading(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const image = index != null ? images[index] : undefined;
  const visible = index != null && !!image;
  const hasPrev = index != null && index > 0;
  const hasNext = index != null && index < images.length - 1;

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(Math.max(savedScale.value * e.scale, 1), 6);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1.02) {
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
      }
    });
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (scale.value <= 1) return;
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd((e) => {
      if (scale.value <= 1) {
        // Swipe between images when not zoomed.
        if (e.translationX < -60 && hasNext && index != null) onChangeIndex(index + 1);
        else if (e.translationX > 60 && hasPrev && index != null) onChangeIndex(index - 1);
        return;
      }
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    })
    .runOnJS(true);
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = scale.value > 1 ? 1 : 2.5;
      scale.value = withTiming(next);
      savedScale.value = next;
      if (next === 1) {
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
      }
    });
  const composed = Gesture.Simultaneous(pinch, pan, doubleTap);
  const animated = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }] }));

  const stageWidth = width - 24;

  return (
    <Modal visible={visible} onRequestClose={onClose} animationType="fade" statusBarTranslucent presentationStyle="fullScreen">
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <IconButton tone="dark" size={46} icon={<X size={20} color={immersive.text} strokeWidth={1.6} />} accessibilityLabel="Close image" onPress={onClose} style={styles.outlined} />
          <AppText variant="caption" tone="inverse" tabular style={{ flex: 1, textAlign: "center" }} numberOfLines={1}>
            {index != null && image ? `${index + 1} of ${images.length} · ${image.filename}` : ""}
          </AppText>
          <IconButton tone="dark" size={46} selected={showInfo} icon={<Info size={20} color={immersive.text} strokeWidth={1.6} />} accessibilityLabel={showInfo ? "Hide image details" : "Image details"} onPress={() => setShowInfo((v) => !v)} style={styles.outlined} />
        </View>

        <View style={styles.stageWrap}>
          {image ? (
            <GestureDetector gesture={composed}>
              <Animated.View style={[styles.stage, { width: stageWidth, height: (stageWidth * 3) / 4 }, animated]}>
                <Image
                  source={{ uri: displayUrl(image), headers: authHeaders() }}
                  style={StyleSheet.absoluteFill}
                  contentFit="contain"
                  cachePolicy="memory-disk"
                  onLoadStart={() => setLoading(true)}
                  onLoadEnd={() => setLoading(false)}
                  accessibilityLabel={`Drone image ${image.filename}`}
                />
                {loading ? (
                  <View style={styles.loadingOverlay} pointerEvents="none">
                    <ActivityIndicator size="large" color={immersive.text} />
                  </View>
                ) : null}
              </Animated.View>
            </GestureDetector>
          ) : null}
        </View>

        <View style={[styles.nav, { paddingBottom: insets.bottom + 22 }]}>
          <IconButton tone="dark" size={50} disabled={!hasPrev} icon={<ChevronLeft size={22} color={immersive.text} strokeWidth={1.6} />} accessibilityLabel="Previous" onPress={() => index != null && onChangeIndex(index - 1)} style={styles.outlined} />
          <AppText variant="small" tone="inverseMuted">
            Swipe or pinch to zoom
          </AppText>
          <IconButton tone="dark" size={50} disabled={!hasNext} icon={<ChevronRight size={22} color={immersive.text} strokeWidth={1.6} />} accessibilityLabel="Next" onPress={() => index != null && onChangeIndex(index + 1)} style={styles.outlined} />
        </View>

        {showInfo && image ? (
          <View style={styles.infoBackdrop}>
            <View style={{ flex: 1 }} onTouchEnd={() => setShowInfo(false)} accessibilityRole="button" accessibilityLabel="Close details" />
            <View style={[styles.sheet, { backgroundColor: colors.bg, paddingBottom: insets.bottom + 26 }]}>
              <View style={[styles.handle, { backgroundColor: colors.corner }]} />
              <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
                <ImageMetadata image={image} drone={drone} advanced={advanced} />
              </ScrollView>
              {onViewOnMap && image.lat != null ? <Button label="View on map" size="md" fullWidth style={{ marginTop: 14 }} onPress={() => onViewOnMap(image)} /> : null}
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: immersive.viewerBg },
  topBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  outlined: { backgroundColor: "transparent" },
  stageWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  stage: { borderWidth: 1, borderColor: immersive.borderSoft, overflow: "hidden" },
  loadingOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 14 },
  infoBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { paddingTop: 10, paddingHorizontal: 18 },
  handle: { width: 44, height: 4, alignSelf: "center", marginBottom: 14, opacity: 0.5 },
});
