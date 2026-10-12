"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseAnswer } from "@/lib/citations.mts";
import { clientSessionId } from "@/lib/session";

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Pages retrieved for this answer, straight from the response header. */
  pages?: number[];
  streaming?: boolean;
  failed?: boolean;
};

type Doc = { id: string; filename: string; status: string };

type Props = {
  doc: Doc;
  /** Suggested openers carried by the document itself; only the demo has them. */
  starterQuestions: string[];
  messages: Message[];
  setMessages: (update: (previous: Message[]) => Message[]) => void;
  onCitationClick: (page: number) => void;
};

export default function ChatPanel({
  doc,
  starterQuestions,
  messages,
  setMessages,
  onCitationClick,
}: Props) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Abandon an in-flight answer when the document changes out from under it.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [doc.id]);

  // Follow new messages, but don't yank the view on every token of a long answer.
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "end" });
  }, [messages.length]);

  const ask = useCallback(
    async (text: string) => {
      const answerId = crypto.randomUUID();
      setMessages((previous) => [
        ...previous,
        { id: crypto.randomUUID(), role: "user", text },
        { id: answerId, role: "assistant", text: "", streaming: true },
      ]);

      const patch = (change: Partial<Message>) =>
        setMessages((previous) =>
          previous.map((m) => (m.id === answerId ? { ...m, ...change } : m)),
        );

      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);

      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", "x-session-id": clientSessionId() },
          body: JSON.stringify({ documentId: doc.id, question: text }),
        });

        if (!response.ok || !response.body) {
          const data = await response.json().catch(() => null);
          patch({
            text: data?.error ?? "Something went wrong. Please try again.",
            streaming: false,
            failed: true,
          });
          return;
        }

        // Available before the first token, so the Sources row renders immediately.
        const pages = (response.headers.get("x-source-pages") ?? "")
          .split(",")
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0);
        patch({ pages });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let answer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          answer += decoder.decode(value, { stream: true });
          patch({ text: answer });
        }
        patch({ text: answer, streaming: false });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("ask failed", error);
        patch({
          text: "The connection dropped. Please ask again.",
          streaming: false,
          failed: true,
        });
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [doc.id, setMessages],
  );

  const ready = doc.status === "ready";

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <ol className="space-y-5">
        {messages.length === 0 && (
          <li className="rounded-lg border border-line bg-surface px-5 py-8">
            <p className="text-center text-sm font-medium">Ask anything about this document</p>
            <p className="mx-auto mt-1 max-w-sm text-center text-sm text-muted">
              Answers come only from the pages of{" "}
              <span className="text-ink">{doc.filename}</span>, and every claim links back to the
              page it came from.
            </p>

            {ready && starterQuestions.length > 0 && (
              <div className="mt-6">
                <p className="mb-2 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                  Try one of these
                </p>
                <ul className="mx-auto flex max-w-md flex-col gap-2">
                  {starterQuestions.map((starter) => (
                    <li key={starter}>
                      <button
                        type="button"
                        onClick={() => void ask(starter)}
                        className="w-full rounded-lg border border-line px-3.5 py-2.5 text-left text-sm transition-colors hover:border-accent hover:text-accent"
                      >
                        {starter}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        )}

        {messages.map((message) =>
          message.role === "user" ? (
            <li key={message.id} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent-soft px-4 py-2.5 text-sm text-ink">
                {message.text}
              </p>
            </li>
          ) : (
            <li key={message.id} className="space-y-3">
              <div
                className={`text-sm leading-relaxed whitespace-pre-wrap ${
                  message.failed ? "text-danger" : ""
                }`}
              >
                {message.text ? (
                  parseAnswer(message.text, message.streaming).map((segment, i) =>
                    segment.type === "text" ? (
                      <span key={i}>{segment.text}</span>
                    ) : (
                      <CitationChip
                        key={i}
                        page={segment.page}
                        onClick={() => onCitationClick(segment.page)}
                      />
                    ),
                  )
                ) : (
                  <ThinkingDots />
                )}
                {message.streaming && message.text && <Caret />}
              </div>

              {!message.failed && !message.streaming && (message.pages?.length ?? 0) > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    Sources
                  </span>
                  {message.pages?.map((page) => (
                    <CitationChip key={page} page={page} onClick={() => onCitationClick(page)} />
                  ))}
                </div>
              )}
            </li>
          ),
        )}
        <div ref={endRef} />
      </ol>

      <form
        className="sticky bottom-0 mt-6 bg-canvas pt-3 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          const text = question.trim();
          if (!text || busy || !ready) return;
          setQuestion("");
          void ask(text);
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-2 focus-within:border-accent">
          <label className="sr-only" htmlFor="question">
            Your question
          </label>
          <textarea
            id="question"
            rows={1}
            value={question}
            disabled={!ready}
            placeholder={ready ? "Ask a question…" : "This document isn't ready yet"}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted disabled:cursor-not-allowed"
          />
          <button
            type="submit"
            disabled={busy || !ready || !question.trim()}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-opacity disabled:opacity-40"
          >
            {busy ? "…" : "Ask"}
          </button>
        </div>
        {!ready && (
          <p className="mt-2 px-1 text-xs text-muted">
            {doc.status === "failed"
              ? "This document couldn't be processed, so it can't be searched."
              : "Still being prepared — the question box unlocks when it's ready."}
          </p>
        )}
      </form>
    </section>
  );
}

function CitationChip({ page, onClick }: { page: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Show page ${page} of the document`}
      className="mx-0.5 inline-flex -translate-y-px items-center rounded border border-accent/30 bg-accent-soft px-1.5 py-0.5 align-middle font-mono text-[11px] leading-none text-accent transition-colors hover:border-accent hover:bg-accent hover:text-canvas"
    >
      p. {page}
    </button>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex gap-1 py-1" aria-label="Thinking">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function Caret() {
  return <span className="ml-0.5 inline-block h-4 w-px animate-pulse bg-accent align-middle" />;
}
