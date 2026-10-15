import { View } from "react-native";
import { AppText } from "@/components/ui";

/** The agreement's text, written as plain text or simple Markdown: "#" headings,
 * "-" or "*" list items, paragraphs split by blank lines. Same as the website's AgreementText. */
export function AgreementText({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter((l) => l.trim());
        const first = lines[0];
        if (!first) return null;
        if (lines.length === 1 && first.startsWith("#")) {
          if (/^#\s/.test(first)) return null; // the title, shown above
          return (
            <AppText key={i} variant="headingSm" style={{ marginTop: 4 }}>
              {first.replace(/^#+\s*/, "")}
            </AppText>
          );
        }
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <View key={i} style={{ gap: 4 }}>
              {lines.map((l, j) => (
                <AppText key={j} variant="bodySm">
                  {"•  "}
                  {l.replace(/^\s*[-*]\s+/, "")}
                </AppText>
              ))}
            </View>
          );
        }
        return (
          <AppText key={i} variant="bodySm">
            {lines.join(" ")}
          </AppText>
        );
      })}
    </View>
  );
}
