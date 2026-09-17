import { useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Plus, Search, Sprout } from "lucide-react-native";
import { iconStroke, layout, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useRefresh } from "@/hooks/useRefresh";
import { useFields } from "@/features/fields/hooks";
import { useSurveys } from "@/features/surveys/hooks";
import { relativeDay } from "@/utils/format";
import { Button, EmptyState, ErrorState, IconButton, LoadingState, Screen, AppText } from "@/components/ui";
import { FieldCard } from "@/components/fields/FieldCard";
import { AskAiFab } from "@/components/ai/AskAiFab";

export default function FieldsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const fields = useFields();
  const surveys = useSurveys();
  const { refreshing, onRefresh } = useRefresh(fields.refetch, surveys.refetch);

  const lastSurveyByField = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of surveys.data ?? []) if (!map.has(s.field_id)) map.set(s.field_id, s.survey_date ?? s.created_at);
    return map;
  }, [surveys.data]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = fields.data ?? [];
    return q ? list.filter((f) => f.name.toLowerCase().includes(q) || f.crop_type.toLowerCase().includes(q)) : list;
  }, [fields.data, query]);

  const header = (
    <View style={styles.header}>
      <AppText variant="display" style={{ marginBottom: 14 }}>
        My fields
      </AppText>
      <View style={styles.searchRow}>
        <View style={[styles.search, { borderColor: colors.divider }]}>
          <Search size={18} color={colors.text} strokeWidth={iconStroke} style={{ opacity: 0.5 }} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search fields or crops"
            placeholderTextColor={colors.muted}
            style={[styles.input, typography.body, { color: colors.text }]}
            accessibilityLabel="Search fields"
            returnKeyType="search"
          />
        </View>
        <IconButton tone="primary" size={48} icon={<Plus size={22} color={colors.onAccent} strokeWidth={1.6} />} accessibilityLabel="New survey" onPress={() => router.push("/upload")} />
      </View>
    </View>
  );

  let body: React.ReactNode = null;
  if (fields.isPending) body = <LoadingState cards={3} />;
  else if (fields.isError) body = <ErrorState error={fields.error} onRetry={() => fields.refetch()} />;
  else if ((fields.data ?? []).length === 0)
    body = (
      <EmptyState icon={<Sprout size={52} color={colors.accent} strokeWidth={1.2} />} title="No fields yet" message="Add a field and fly it once — we'll take it from there." actionLabel="Add your first field" onAction={() => router.push("/upload")} />
    );
  else if (visible.length === 0)
    body = (
      <View style={styles.noMatch}>
        <AppText variant="cardTitle" style={{ fontSize: 22, textAlign: "center" }}>
          No fields match "{query}"
        </AppText>
        <AppText variant="bodySm" tone="muted" style={{ textAlign: "center", marginTop: 6 }}>
          Try the crop name instead, or clear the search.
        </AppText>
        <Button label="Clear search" variant="secondary" size="md" onPress={() => setQuery("")} style={{ marginTop: 16 }} />
      </View>
    );

  return (
    <Screen scroll={false} safeTop>
      <FlatList
        data={body ? [] : visible}
        keyExtractor={(f) => f.id}
        ListHeaderComponent={header}
        ListEmptyComponent={body ? <View>{body}</View> : null}
        renderItem={({ item }) => (
          <FieldCard
            field={item}
            variant="list"
            lastSurveyLabel={lastSurveyByField.has(item.id) ? relativeDay(lastSurveyByField.get(item.id)) : null}
            onPress={() => router.push({ pathname: "/field/[id]", params: { id: item.id } })}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + layout.bottomClearance }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.bg} />}
        keyboardShouldPersistTaps="handled"
      />
      <AskAiFab aboveTabBar />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 8, marginBottom: 18 },
  searchRow: { flexDirection: "row", gap: 10 },
  search: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, paddingHorizontal: 12, minHeight: 48 },
  input: { flex: 1, minWidth: 0, paddingVertical: 0 },
  content: { paddingHorizontal: layout.pagePadding },
  noMatch: { alignItems: "center", paddingVertical: 50, paddingHorizontal: 20 },
});
