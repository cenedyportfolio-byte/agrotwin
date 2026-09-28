import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Bot } from "lucide-react-native";
import { iconStroke } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { responderLabel } from "@/services/ai";
import type { ChatMessage } from "@/stores/chatStore";
import { parseInline, parseMarkdownBlocks } from "@/utils/markdown";
import { Button, Disclosure, IconBox, KeyValueRow, AppText } from "@/components/ui";

interface ChatBubbleProps {
  message: ChatMessage;
  onRetry?: () => void;
  showContext?: boolean;
}

/** Renders "some **bold** text" as mixed-weight spans in one wrapped line. */
function InlineMarkdown({ text, tone = "default" as const }: { text: string; tone?: "default" | "muted" }) {
  const segments = parseInline(text);
  return (
    <AppText variant="body" tone={tone}>
      {segments.map((s, i) =>
        s.bold ? (
          <AppText key={i} variant="bodyStrong" tone={tone}>
            {s.text}
          </AppText>
        ) : (
          s.text
        )
      )}
    </AppText>
  );
}

/** Turns the assistant's (light) markdown into bubble-friendly blocks: bold
 * spans, short bullet/numbered lists, the odd heading — never literal
 * "**"/"-"/"#" characters. See utils/markdown.ts for the parser. */
function MarkdownMessage({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <View style={styles.blocks}>
      {blocks.map((block, i) => {
        if (block.type === "heading") {
          return (
            <AppText key={i} variant="bodyStrong">
              {block.text}
            </AppText>
          );
        }
        if (block.type === "paragraph") {
          return <InlineMarkdown key={i} text={block.text} />;
        }
        const items = block.items;
        return (
          <View key={i} style={styles.list}>
            {items.map((item, j) => (
              <View key={j} style={styles.listRow}>
                <AppText variant="body">{block.type === "numbered" ? `${j + 1}.` : "•"}</AppText>
                <View style={styles.listItemText}>
                  <InlineMarkdown text={item} />
                </View>
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

/** Canvas chat bubble: "me" messages are an accent-tinted box on the right; assistant replies sit beside a bot avatar. */
export function ChatBubble({ message, onRetry, showContext = true }: ChatBubbleProps) {
  const { colors } = useTheme();
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <View style={[styles.row, styles.rowUser]}>
        <View style={[styles.bubble, { backgroundColor: colors.accentTint, borderColor: colors.accent }]} accessibilityLabel={`You asked: ${message.text}`}>
          <AppText variant="body">{message.text}</AppText>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <IconBox size={32} borderColor={colors.divider}>
        <Bot size={16} color={colors.accent} strokeWidth={iconStroke} />
      </IconBox>
      <View style={styles.assistantColumn}>
        <View style={[styles.bubble, { borderColor: colors.divider }]} accessibilityLabel={message.status === "sending" ? "Assistant is thinking" : `Assistant: ${message.text}`}>
          {message.status === "sending" ? (
            <View style={styles.thinking}>
              <ActivityIndicator size="small" color={colors.accent} />
              <AppText variant="body" tone="muted">
                Looking at the survey's measurements…
              </AppText>
            </View>
          ) : message.status === "error" ? (
            <View style={styles.thinking}>
              <AppText variant="body" tone="problem" style={styles.flex}>
                {message.errorMessage ?? "The assistant could not answer."}
              </AppText>
              {onRetry ? <Button label="Retry" size="sm" variant="secondary" onPress={onRetry} /> : null}
            </View>
          ) : (
            <MarkdownMessage text={message.text} />
          )}
        </View>
        {message.sources && message.sources.length > 0 ? (
          <View style={styles.sources} accessibilityLabel="Knowledge-base sources for this answer">
            <AppText variant="small" tone="muted">
              Sources (local knowledge base)
            </AppText>
            {message.sources.map((s, i) => (
              <AppText key={i} variant="small" tone="muted">
                {s.title} — {s.section}
              </AppText>
            ))}
          </View>
        ) : null}
        {message.responder ? (
          <AppText variant="small" tone="muted" style={styles.meta}>
            Answered by {responderLabel(message.responder)}
          </AppText>
        ) : null}
        {showContext && message.contextUsed && Object.keys(message.contextUsed).length > 0 ? (
          <Disclosure showLabel="What the assistant looked at" hideLabel="Hide what the assistant looked at">
            {Object.entries(message.contextUsed)
              .filter(([, v]) => v != null && typeof v !== "object")
              .map(([k, v], i, arr) => (
                <KeyValueRow key={k} label={k.replace(/_/g, " ")} value={String(v)} last={i === arr.length - 1} />
              ))}
          </Disclosure>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, alignItems: "flex-end" },
  rowUser: { justifyContent: "flex-end" },
  assistantColumn: { flex: 1, gap: 4, maxWidth: "88%" },
  bubble: { borderWidth: 1, borderRadius: 0, padding: 12 },
  thinking: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  meta: { paddingLeft: 4 },
  sources: { paddingLeft: 4, gap: 2 },
  flex: { flex: 1, minWidth: 120 },
  blocks: { gap: 8 },
  list: { gap: 4 },
  listRow: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
  listItemText: { flex: 1 },
});
