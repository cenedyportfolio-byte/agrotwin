/** The agreement's text, written as plain text or simple Markdown: "#" headings,
 * "-" or "*" list items, paragraphs split by blank lines. Rendered as text only. */
export function AgreementText({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter((l) => l.trim());
        if (!lines.length) return null;
        if (lines.length === 1 && lines[0].startsWith("#")) {
          const level = lines[0].match(/^#+/)![0].length;
          const words = lines[0].replace(/^#+\s*/, "");
          return level === 1 ? null : (
            <h3 key={i} className="pt-1 font-semibold">
              {words}
            </h3>
          );
        }
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*[-*]\s+/, "")}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{lines.join(" ")}</p>;
      })}
    </div>
  );
}
