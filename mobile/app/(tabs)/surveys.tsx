import { useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Camera } from "lucide-react-native";
import { layout } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useRefresh } from "@/hooks/useRefresh";
import { useFields } from "@/features/fields/hooks";
import { useSurveys } from "@/features/surveys/hooks";
import { Button, EmptyState, ErrorState, LoadingState, Screen, SegmentedBar, AppText } from "@/components/ui";
import { SurveyCard } from "@/components/surveys/SurveyCard";
import { AskAiFab } from "@/components/ai/AskAiFab";

type Filter = "all" | "processing" | "completed" | "failed";
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "processing", label: "Processing" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function matches(status: string, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "completed") return status === "COMPLETED";
  if (filter === "failed") return status === "FAILED";
  return !["COMPLETED", "FAILED"].includes(status);
}

export default function SurveysScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>("all");
  const surveys = useSurveys();
  const fields = useFields();
  const { refreshing, onRefresh } = useRefresh(surveys.refetch, fields.refetch);

  const fieldName = useMemo(() => new Map((fields.data ?? []).map((f) => [f.id, f.name])), [fields.data]);
  const visible = useMemo(() => (surveys.data ?? []).filter((s) => matches(s.status, filter)), [surveys.data, filter]);

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <AppText variant="display">Surveys</AppText>
        <Button label="New survey" onPress={() => router.push("/upload")} />
      </View>
      <SegmentedBar options={FILTERS} value={filter} onChange={setFilter} />
    </View>
  );

  let body: React.ReactNode = null;
  if (surveys.isPending) body = <LoadingState cards={3} />;
  else if (surveys.isError) body = <ErrorState error={surveys.error} onRetry={() => surveys.refetch()} />;
  else if ((surveys.data ?? []).length === 0)
    body = (
      <EmptyState
        icon={<Camera size={52} color={colors.accent} strokeWidth={1.2} />}
        title="No surveys yet"
        message="Upload a drone flight to create your first survey. Large flights are best uploaded from the AgroTwin web app."
        actionLabel="New survey"
        onAction={() => router.push("/upload")}
      />
    );
  else if (visible.length === 0) body = <EmptyState compact title={`No ${filter} surveys`} message="Try another filter." />;

  return (
    <Screen scroll={false} safeTop>
      <FlatList
        data={body ? [] : visible}
        keyExtractor={(s) => s.id}
        ListHeaderComponent={header}
        ListEmptyComponent={body ? <View>{body}</View> : null}
        renderItem={({ item }) => (
          <SurveyCard
            survey={item}
            fieldName={fieldName.get(item.field_id)}
            onPress={() =>
              !["COMPLETED", "FAILED", "PENDING", "UPLOADING"].includes(item.status)
                ? router.push({ pathname: "/processing/[surveyId]", params: { surveyId: item.id } })
                : router.push({ pathname: "/survey/[id]", params: { id: item.id } })
            }
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + layout.bottomClearance }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.bg} />}
      />
      <AskAiFab aboveTabBar />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 8, gap: 14, marginBottom: 18 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  content: { paddingHorizontal: layout.pagePadding },
});
