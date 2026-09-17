import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, useWindowDimensions, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Images, LayoutGrid, List } from "lucide-react-native";
import { galleryPageSize } from "@/constants/config";
import { BAND_LABEL } from "@/constants/labels";
import { iconStroke, layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useSurvey, useSurveyImages } from "@/features/surveys/hooks";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";
import { surveysService } from "@/services/surveys";
import type { SurveyImage } from "@/types";
import { formatNumber } from "@/utils/format";
import { Button, Chip, EmptyState, ErrorState, IconButton, LoadingState, Screen, ScreenHeader, AppText } from "@/components/ui";
import { ImageTile } from "@/components/gallery/ImageTile";
import { ImageViewerModal } from "@/components/gallery/ImageViewerModal";

const GAP = 10;

/** More columns on wider screens (large phones landscape, tablets) so tiles don't balloon. */
function gridColumns(width: number): number {
  if (width >= 900) return 4;
  if (width >= 620) return 3;
  return 2;
}

export default function GalleryScreen() {
  const { surveyId, frame } = useLocalSearchParams<{ surveyId: string; frame?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const advanced = useSettingsStore((s) => s.advancedMode);
  const setActiveSurvey = useUiStore((s) => s.setActiveSurvey);

  const survey = useSurvey(surveyId);
  const images = useSurveyImages(surveyId);
  const [band, setBand] = useState<string>("RGB");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [pages, setPages] = useState(1);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    if (surveyId) setActiveSurvey(surveyId);
  }, [surveyId, setActiveSurvey]);

  const bands = useMemo(() => {
    const set = new Set((images.data ?? []).map((i) => i.band));
    return ["RGB", "GREEN", "RED", "RED_EDGE", "NIR", "THERMAL"].filter((b) => set.has(b));
  }, [images.data]);
  const effectiveBand = bands.includes(band) ? band : (bands[0] ?? "RGB");

  const list = useMemo(() => {
    const filtered = (images.data ?? []).filter((i) => i.band === effectiveBand);
    return [...filtered].sort((a, b) => (a.captured_at ?? "").localeCompare(b.captured_at ?? "") || a.filename.localeCompare(b.filename));
  }, [images.data, effectiveBand]);
  const visible = useMemo(() => list.slice(0, pages * galleryPageSize), [list, pages]);

  useEffect(() => {
    if (!frame || list.length === 0) return;
    const i = list.findIndex((img) => (img.frame_key ?? img.id) === frame);
    if (i >= 0) {
      setPages(Math.ceil((i + 1) / galleryPageSize));
      setViewerIndex(i);
    }
  }, [frame, list]);

  const columns = gridColumns(width);
  const tileWidth = Math.floor((width - layout.pagePadding * 2 - GAP * (columns - 1)) / columns);
  const thumbUrl = useCallback((img: SurveyImage) => surveysService.thumbnailUrl(img.survey_id, img.id), []);
  const displayUrl = useCallback((img: SurveyImage) => surveysService.displayUrl(img.survey_id, img.id), []);
  const subtitle = survey.data ? `${formatNumber(list.length || survey.data.image_count)} images · ${survey.data.drone_model ?? "unknown drone"}` : null;

  const header = (
    <ScreenHeader
      title="Survey images"
      subtitle={subtitle}
      right={
        <IconButton
          icon={view === "grid" ? <List size={20} color={colors.text} strokeWidth={iconStroke} /> : <LayoutGrid size={20} color={colors.text} strokeWidth={iconStroke} />}
          accessibilityLabel={view === "grid" ? "Show as list" : "Show as grid"}
          onPress={() => setView((v) => (v === "grid" ? "list" : "grid"))}
        />
      }
    />
  );

  if (images.isPending) {
    return (
      <Screen safeTop padded={false}>
        {header}
        <View style={styles.body}>
          <LoadingState cards={2} />
        </View>
      </Screen>
    );
  }
  if (images.isError) {
    return (
      <Screen safeTop padded={false}>
        {header}
        <ErrorState error={images.error} onRetry={() => images.refetch()} />
      </Screen>
    );
  }
  if ((images.data ?? []).length === 0) {
    return (
      <Screen safeTop padded={false}>
        {header}
        <EmptyState icon={<Images size={52} color={colors.accent} strokeWidth={1.2} />} title="No images in this survey" message="Add drone images from the New survey screen or the web app." actionLabel="Add images" onAction={() => router.push({ pathname: "/upload", params: { surveyId } })} />
      </Screen>
    );
  }

  return (
    <Screen scroll={false} safeTop>
      <FlatList
        key={`${view}-${columns}`}
        data={visible}
        keyExtractor={(i) => i.id}
        numColumns={view === "grid" ? columns : 1}
        columnWrapperStyle={view === "grid" ? styles.row : undefined}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View>
            {header}
            {bands.length > 1 ? (
              <View style={styles.bands}>
                {bands.map((b) => (
                  <Chip
                    key={b}
                    label={BAND_LABEL[b] ?? b}
                    selected={effectiveBand === b}
                    onPress={() => {
                      setBand(b);
                      setPages(1);
                    }}
                  />
                ))}
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item, index }) => <ImageTile image={item} index={index} layout={view} width={tileWidth} thumbnailUrl={thumbUrl(item)} onPress={() => setViewerIndex(index)} />}
        ItemSeparatorComponent={() => <View style={{ height: view === "grid" ? GAP : 8 }} />}
        onEndReached={() => visible.length < list.length && setPages((p) => p + 1)}
        onEndReachedThreshold={0.6}
        ListFooterComponent={
          <View style={styles.footer}>
            <AppText variant="small" tone="muted">
              {visible.length < list.length ? `Showing ${formatNumber(visible.length)} of ${formatNumber(list.length)} · thumbnails load as you scroll` : `All ${formatNumber(list.length)} images listed`}
            </AppText>
            {visible.length < list.length ? <Button label="Load more" variant="secondary" onPress={() => setPages((p) => p + 1)} /> : null}
          </View>
        }
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
      />
      <ImageViewerModal
        images={list}
        index={viewerIndex}
        displayUrl={displayUrl}
        drone={survey.data?.drone_model}
        onClose={() => setViewerIndex(null)}
        onChangeIndex={setViewerIndex}
        advanced={advanced}
        onViewOnMap={(img) => {
          setViewerIndex(null);
          router.push({ pathname: "/map/[surveyId]", params: { surveyId: img.survey_id, image: img.id } });
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: layout.pagePadding },
  content: { paddingHorizontal: layout.pagePadding, paddingBottom: 40 },
  row: { gap: GAP },
  bands: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  footer: { alignItems: "center", gap: 10, paddingVertical: 20 },
});
