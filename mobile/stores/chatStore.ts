import { create } from "zustand";
import type { KnowledgeSource } from "@/types";

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  /** Which backend responder answered ("template" or "ollama:<model>"). */
  responder?: string;
  /** Structured data the answer was grounded in — shown under "What the assistant looked at". */
  contextUsed?: Record<string, unknown>;
  /** Knowledge-base passages the answer cites. */
  sources?: KnowledgeSource[];
  status?: "sending" | "error";
  errorMessage?: string;
  /** Reserved for voice: set when the message came from speech input. */
  source?: "text" | "voice";
}

interface ChatState {
  /** Conversations keyed by survey id (the assistant is grounded in one survey's analysis). */
  threads: Record<string, ChatMessage[]>;
  append: (surveyId: string, message: ChatMessage) => void;
  update: (surveyId: string, id: string, patch: Partial<ChatMessage>) => void;
  clear: (surveyId: string) => void;
}

let counter = 0;
export function newMessageId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

export const useChatStore = create<ChatState>()((set) => ({
  threads: {},
  append: (surveyId, message) =>
    set((s) => ({ threads: { ...s.threads, [surveyId]: [...(s.threads[surveyId] ?? []), message] } })),
  update: (surveyId, id, patch) =>
    set((s) => ({
      threads: {
        ...s.threads,
        [surveyId]: (s.threads[surveyId] ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
      },
    })),
  clear: (surveyId) => set((s) => ({ threads: { ...s.threads, [surveyId]: [] } })),
}));
