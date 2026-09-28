import { useCallback } from "react";
import { aiService } from "@/services/ai";
import { describeError } from "@/services/errors";
import { newMessageId, useChatStore, type ChatMessage } from "@/stores/chatStore";

// Stable fallback so the selector below never hands Zustand a fresh array
// reference when a thread doesn't exist yet. Returning `s.threads[key] ?? []`
// directly creates a new [] on every read, which useSyncExternalStore treats
// as "the snapshot changed" on every render — an infinite render loop (React
// DOM enforces this strictly; it silently wastes renders on native).
const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Chat thread for one survey. Sends the farmer's question to the backend
 * assistant and records both the answer and which responder produced it.
 */
export function useChat(surveyId: string | null | undefined) {
  const key = surveyId ?? "";
  const messages = useChatStore((s) => s.threads[key] ?? EMPTY_MESSAGES);
  const append = useChatStore((s) => s.append);
  const update = useChatStore((s) => s.update);
  const clear = useChatStore((s) => s.clear);

  const pending = messages.some((m) => m.status === "sending");

  const send = useCallback(
    async (question: string, source: "text" | "voice" = "text") => {
      const text = question.trim();
      if (!text || !surveyId) return;
      append(surveyId, { id: newMessageId(), role: "user", text, createdAt: Date.now(), source });
      const replyId = newMessageId();
      append(surveyId, { id: replyId, role: "assistant", text: "", createdAt: Date.now(), status: "sending" });
      try {
        const res = await aiService.ask(surveyId, text);
        update(surveyId, replyId, {
          text: res.answer,
          responder: res.responder,
          contextUsed: res.context_used,
          sources: res.sources ?? [],
          status: undefined,
        });
      } catch (err) {
        const d = describeError(err);
        update(surveyId, replyId, { status: "error", errorMessage: `${d.title}. ${d.message}`, text: "" });
      }
    },
    [surveyId, append, update]
  );

  const retryLast = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) void send(lastUser.text, lastUser.source);
  }, [messages, send]);

  return { messages, pending, send, retryLast, clear: () => surveyId && clear(surveyId) };
}
