"""Local retrieval over the agronomy knowledge base (§18 RAG, first milestone).

The knowledge base is plain Markdown under backend/app/knowledge/: one file
per topic, split into sections at "## " headings. Retrieval is BM25 over the
section text — no embedding model, no network, deterministic — which is
enough for the question types the assistant handles (field status, stress,
weeds, scouting, survey practice). Passages are returned with their source so
the UI can show where guidance came from; the LLM (when one runs) gets the
same passages as reference notes.

Swapping in vector search later means replacing `search`; callers only see
KnowledgePassage objects.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

KNOWLEDGE_DIR = Path(__file__).resolve().parent.parent / "knowledge"

STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "be", "it", "this", "that",
    "with", "as", "by", "at", "from", "my", "your", "our", "how", "what", "which", "where", "when", "why",
    "do", "does", "did", "can", "should", "i", "we", "you", "me", "us", "there", "their", "its", "if",
    "than", "then", "so", "not", "no", "any", "all", "about", "into", "over", "under", "up", "out", "show",
    "field", "survey",  # every question mentions these; they carry no signal here
}
K1, B = 1.5, 0.75
MIN_SCORE = 1.0
SNIPPET_CHARS = 420


@dataclass
class KnowledgePassage:
    title: str
    section: str
    text: str
    score: float

    def snippet(self) -> str:
        t = " ".join(self.text.split())
        return t if len(t) <= SNIPPET_CHARS else t[:SNIPPET_CHARS].rsplit(" ", 1)[0] + "…"

    def as_dict(self) -> dict:
        return {"title": self.title, "section": self.section, "snippet": self.snippet(), "score": round(self.score, 2)}


def _tokens(text: str) -> list[str]:
    out = []
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if w in STOPWORDS or len(w) < 2:
            continue
        if len(w) > 4 and w.endswith("ies"):
            w = w[:-3] + "y"
        elif len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.append(w)
    return out


@dataclass
class _Doc:
    title: str
    section: str
    text: str
    tf: dict[str, int]
    length: int


def _load_sections() -> list[_Doc]:
    docs: list[_Doc] = []
    for path in sorted(KNOWLEDGE_DIR.glob("*.md")):
        title, section, buf = path.stem.replace("_", " ").title(), "", []

        def flush():
            body = "\n".join(buf).strip()
            if body:
                toks = _tokens(f"{title} {section} {body}")
                tf: dict[str, int] = {}
                for t in toks:
                    tf[t] = tf.get(t, 0) + 1
                docs.append(_Doc(title, section or title, body, tf, len(toks)))

        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
            elif line.startswith("## "):
                flush()
                section, buf = line[3:].strip(), []
            else:
                buf.append(line)
        flush()
    return docs


def _knowledge_stamp() -> tuple:
    """Changes whenever a knowledge file is added, removed or edited, so the
    index rebuilds on the next question without a backend restart."""
    return tuple(sorted((p.name, p.stat().st_mtime_ns) for p in KNOWLEDGE_DIR.glob("*.md")))


@lru_cache(maxsize=1)
def _build_index(stamp: tuple):
    docs = _load_sections()
    df: dict[str, int] = {}
    for d in docs:
        for t in d.tf:
            df[t] = df.get(t, 0) + 1
    avg_len = sum(d.length for d in docs) / max(len(docs), 1)
    return docs, df, avg_len


def _index():
    return _build_index(_knowledge_stamp())


def search(query: str, k: int = 3) -> list[KnowledgePassage]:
    docs, df, avg_len = _index()
    if not docs:
        return []
    q = _tokens(query)
    n = len(docs)
    scored = []
    for d in docs:
        s = 0.0
        for t in set(q):
            f = d.tf.get(t)
            if not f:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.length / avg_len))
        if s >= MIN_SCORE:
            scored.append((s, d))
    scored.sort(key=lambda x: -x[0])
    return [KnowledgePassage(d.title, d.section, d.text, s) for s, d in scored[:k]]


def topics() -> list[dict]:
    docs, _, _ = _index()
    seen: dict[str, list[str]] = {}
    for d in docs:
        seen.setdefault(d.title, []).append(d.section)
    return [{"title": t, "sections": s} for t, s in seen.items()]
