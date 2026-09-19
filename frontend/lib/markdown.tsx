/** Minimal markdown rendering for assistant chat replies. Not a general-
 * purpose renderer — just enough to turn the light markdown the LLM
 * occasionally still uses (bold, short bullet/numbered lists, the odd
 * heading) into real elements instead of showing literal "**"/"-"/"#"
 * characters. Mirrors mobile/utils/markdown.ts's parsing. */

type MdBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; items: string[] }
  | { type: "numbered"; items: string[] };

const HEADING_RE = /^#{1,6}\s+(.*)/;
const BULLET_RE = /^[-*]\s+(.*)/;
const NUMBERED_RE = /^\d+[.)]\s+(.*)/;

function parseBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ type: "heading", text: heading[1].trim() });
      i++;
      continue;
    }

    if (BULLET_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) {
        items.push(lines[i].match(BULLET_RE)![1].trim());
        i++;
      }
      blocks.push({ type: "bullet", items });
      continue;
    }

    if (NUMBERED_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && NUMBERED_RE.test(lines[i])) {
        items.push(lines[i].match(NUMBERED_RE)![1].trim());
        i++;
      }
      blocks.push({ type: "numbered", items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !HEADING_RE.test(lines[i]) && !BULLET_RE.test(lines[i]) && !NUMBERED_RE.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }

  return blocks;
}

/** Splits "some **bold** text" into plain/bold runs for inline rendering. */
function renderInline(text: string, keyPrefix: string) {
  const nodes: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) nodes.push(<strong key={`${keyPrefix}-${n++}`}>{m[1]}</strong>);
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Renders an assistant reply's light markdown as real elements. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`space-y-2 ${className ?? ""}`}>
      {blocks.map((block, i) => {
        if (block.type === "heading") {
          return (
            <div key={i} className="font-semibold">
              {renderInline(block.text, `h${i}`)}
            </div>
          );
        }
        if (block.type === "paragraph") {
          return <p key={i}>{renderInline(block.text, `p${i}`)}</p>;
        }
        const Tag = block.type === "numbered" ? "ol" : "ul";
        return (
          <Tag key={i} className={block.type === "numbered" ? "list-decimal pl-5 space-y-0.5" : "list-disc pl-5 space-y-0.5"}>
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item, `li${i}-${j}`)}</li>
            ))}
          </Tag>
        );
      })}
    </div>
  );
}
