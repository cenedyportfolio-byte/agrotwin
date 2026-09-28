/** Minimal markdown parsing for assistant chat replies. Not a general-purpose
 * renderer — just enough to turn the light markdown the LLM occasionally
 * still uses (bold, short bullet/numbered lists, the odd heading) into
 * structured blocks, instead of showing literal "**"/"-"/"#" to the farmer.
 * See components/ai/ChatBubble.tsx for the rendering side. */

export type MdBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; items: string[] }
  | { type: "numbered"; items: string[] };

const HEADING_RE = /^#{1,6}\s+(.*)/;
const BULLET_RE = /^[-*]\s+(.*)/;
const NUMBERED_RE = /^\d+[.)]\s+(.*)/;

export function parseMarkdownBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ type: "heading", text: (heading[1] ?? "").trim() });
      i++;
      continue;
    }

    if (BULLET_RE.test(line)) {
      const items: string[] = [];
      let cur = lines[i] ?? "";
      while (i < lines.length && BULLET_RE.test(cur)) {
        items.push((cur.match(BULLET_RE)?.[1] ?? "").trim());
        i++;
        cur = lines[i] ?? "";
      }
      blocks.push({ type: "bullet", items });
      continue;
    }

    if (NUMBERED_RE.test(line)) {
      const items: string[] = [];
      let cur = lines[i] ?? "";
      while (i < lines.length && NUMBERED_RE.test(cur)) {
        items.push((cur.match(NUMBERED_RE)?.[1] ?? "").trim());
        i++;
        cur = lines[i] ?? "";
      }
      blocks.push({ type: "numbered", items });
      continue;
    }

    const para: string[] = [];
    let cur = lines[i] ?? "";
    while (i < lines.length && cur.trim() && !HEADING_RE.test(cur) && !BULLET_RE.test(cur) && !NUMBERED_RE.test(cur)) {
      para.push(cur.trim());
      i++;
      cur = lines[i] ?? "";
    }
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }

  return blocks;
}

export interface InlineSegment {
  text: string;
  bold: boolean;
}

/** Splits "some **bold** text" into plain/bold runs for inline rendering. */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), bold: false });
    if (m[1]) segments.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) segments.push({ text: text.slice(last), bold: false });
  return segments.length ? segments : [{ text, bold: false }];
}
