import { ScrollView, StyleSheet } from "react-native";
import { SUGGESTED_QUESTIONS } from "@/constants/labels";
import { layout } from "@/constants/theme";
import { Chip } from "@/components/ui";

interface SuggestedQuestionsProps {
  onPick: (question: string) => void;
  disabled?: boolean;
}

/** Canvas horizontal chip row above the composer. */
export function SuggestedQuestions({ onPick, disabled }: SuggestedQuestionsProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // A ScrollView grows by default (flexGrow: 1). In the chat column it was sharing
      // the leftover height with the message list, so this one-line chip row became
      // half the screen and the chips stretched to fill it.
      style={styles.scroller}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Suggested questions"
    >
      {SUGGESTED_QUESTIONS.map((q) => (
        <Chip key={q} label={q} onPress={() => onPick(q)} disabled={disabled} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroller: { flexGrow: 0, flexShrink: 0 },
  row: { alignItems: "center", gap: 8, paddingHorizontal: layout.pagePadding, paddingVertical: 8 },
});
