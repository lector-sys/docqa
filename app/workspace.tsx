"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { clientSessionId } from "@/lib/session";
import { supabaseBrowser } from "@/lib/supabase";
import ChatPanel, { type Message } from "./chat-panel";
import type { ViewerTarget } from "./pdf-viewer";

// react-pdf touches the DOM at import time, so it never runs on the server.
const PdfViewer = dynamic(() => import("./pdf-viewer"), {
  ssr: false,
  loading: () => (
    <div className="h-full animate-pulse bg-surface" aria-label="Loading document viewer" />
  ),
});

const MAX_BYTES = 50 * 1024 * 1024;
const DOC_FIELDS =
  "id, filename, status, page_count, chunks_done, chunks_total, error_message, is_demo, starter_questions, created_at";

type Doc = {
  id: string;
  filename: string;
  status: string;
  page_count: number | null;
  chunks_done: number | null;
  chunks_total: number | null;
  error_message: string | null;
  is_demo: boolean;
  starter_questions: string[] | null;
  created_at: string;
};

const isBusy = (d: Doc) => d.status === "pending" || d.status === "processing";

function formatSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function postJson(url: string, sessionId: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? "Something went wrong. Please try again.");
  return data;
}

export default function Workspace() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, Message[]>>({});
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const dragDepth = useRef(0);
  const autoSelected = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Poll while anything is in flight; go quiet once every document has settled.
  useEffect(() => {
    const sessionId = clientSessionId();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const { data, error } = await supabaseBrowser(sessionId)
        .from("documents")
        .select(DOC_FIELDS)
        .order("created_at", { ascending: false });

      if (cancelled) return;
      if (error) {
        console.error("documents: load failed", error);
        setListError("Couldn't reach the server. Retrying...");
        timer = setTimeout(poll, 5000);
        return;
      }

      const list = (data ?? []) as Doc[];
      setListError(null);
      setDocs(list);

      // Land on something answerable without making the visitor pick first. A visitor's own
      // document wins; a first-time visitor gets the demo and can ask straight away.
      if (!autoSelected.current) {
        const ready = list.filter((d) => d.status === "ready");
        const landing = ready.find((d) => !d.is_demo) ?? ready[0];
        if (landing) {
          autoSelected.current = true;
          setSelectedId(landing.id);
        }
      }

      if (list.some(isBusy)) timer = setTimeout(poll, 2000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshKey]);

  const upload = useCallback(
    async (file: File) => {
      if (uploading) return;
      setUploadError(null);

      const looksPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (!looksPdf) {
        setUploadError(`"${file.name}" isn't a PDF. Only PDF files can be uploaded.`);
        return;
      }
      if (file.size === 0) {
        setUploadError(`"${file.name}" is empty.`);
        return;
      }
      if (file.size > MAX_BYTES) {
        setUploadError(`"${file.name}" is ${formatSize(file.size)}. The limit is 50 MB.`);
        return;
      }

      setUploading(file.name);
      const sessionId = clientSessionId();
      try {
        const start = await postJson("/api/upload", sessionId, {
          filename: file.name,
          size: file.size,
        });
        const { error } = await supabaseBrowser(sessionId)
          .storage.from("pdfs")
          .uploadToSignedUrl(start.path, start.token, file, { contentType: "application/pdf" });
        if (error) {
          console.error("upload: transfer failed", error);
          throw new Error("The upload didn't finish. Check your connection and try again.");
        }
        await postJson("/api/upload/complete", sessionId, {
          docId: start.docId,
          filename: file.name,
        });
        setRefreshKey((k) => k + 1);
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : "Upload failed. Please try again.");
      } finally {
        setUploading(null);
      }
    },
    [uploading],
  );

  const takeFiles = useCallback(
    (files: FileList | null) => {
      const first = files?.[0];
      if (!first) return;
      if (files.length > 1) setUploadError("One file at a time - uploading the first one.");
      void upload(first);
    },
    [upload],
  );

  const retry = useCallback(async (id: string) => {
    setActionError(null);
    setRetrying(id);
    try {
      await postJson(`/api/document/${id}/retry`, clientSessionId(), {});
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't retry that document.");
    } finally {
      setRetrying(null);
    }
  }, []);

  const selectDoc = useCallback((id: string) => {
    setSelectedId(id);
    autoSelected.current = true;
    setViewer(null); // a thread's citations don't apply to a different document
  }, []);

  const setMessages = useCallback(
    (update: (previous: Message[]) => Message[]) => {
      setThreads((previous) => {
        if (!selectedId) return previous;
        return { ...previous, [selectedId]: update(previous[selectedId] ?? []) };
      });
    },
    [selectedId],
  );

  /** Every jump carries a nonce so clicking the same page twice replays the highlight. */
  const openViewer = useCallback((page: number) => {
    setViewer((current) => ({ page, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const closeViewer = useCallback(() => setViewer(null), []);

  const selected = docs?.find((d) => d.id === selectedId) ?? null;
  const busy = uploading !== null;

  return (
    <div className="flex min-h-screen w-full">
      <div className="min-w-0 flex-1">
        <div className="mx-auto flex w-full max-w-2xl flex-col px-6 py-12 sm:py-16">
          <header className="mb-10 space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Docsense</h1>
            <p className="max-w-md text-sm text-muted">
              Upload a PDF, then ask questions about it. Every answer cites the page it came from.
            </p>
          </header>

          <section>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(e) => {
                takeFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              onDragEnter={(e) => {
                e.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={(e) => {
                e.preventDefault();
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dragDepth.current = 0;
                setDragging(false);
                takeFiles(e.dataTransfer.files);
              }}
              className={`flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center transition-colors disabled:cursor-wait ${
                dragging
                  ? "border-accent bg-accent-soft"
                  : "border-line bg-surface hover:border-accent/60"
              }`}
            >
              {uploading ? (
                <>
                  <Spinner />
                  <span className="text-sm font-medium">Uploading {uploading}...</span>
                  <span className="text-xs text-muted">Keep this tab open.</span>
                </>
              ) : (
                <>
                  <span className="text-sm font-medium">
                    Drop a PDF here, or <span className="text-accent underline">browse</span>
                  </span>
                  <span className="text-xs text-muted">PDF only &middot; up to 50 MB</span>
                </>
              )}
            </button>

            {uploadError && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {uploadError}
              </p>
            )}
          </section>

          <section aria-live="polite" className="mt-8">
            <h2 className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-muted">
              Documents
            </h2>

            {listError && <p className="text-sm text-danger">{listError}</p>}

            {docs === null && !listError && (
              <div className="space-y-2">
                {[0, 1].map((i) => (
                  <div
                    key={i}
                    className="h-16 animate-pulse rounded-lg border border-line bg-surface"
                  />
                ))}
              </div>
            )}

            {docs?.length === 0 && (
              <div className="rounded-lg border border-line bg-surface px-6 py-12 text-center">
                <p className="text-sm font-medium">No documents yet</p>
                <p className="mx-auto mt-1 max-w-xs text-sm text-muted">
                  Upload a PDF and it will be prepared for questions. A 150-page document takes a
                  couple of minutes.
                </p>
              </div>
            )}

            {actionError && (
              <p role="alert" className="mb-3 text-sm text-danger">
                {actionError}
              </p>
            )}

            {docs && docs.length > 0 && (
              <ul className="space-y-2">
                {docs.map((doc) => {
                  const selectable = doc.status === "ready";
                  const isSelected = doc.id === selectedId;
                  return (
                    <li
                      key={doc.id}
                      className={`rounded-lg border px-4 py-3 transition-colors ${
                        isSelected ? "border-accent bg-accent-soft" : "border-line bg-surface"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          {selectable ? (
                            <button
                              type="button"
                              aria-pressed={isSelected}
                              onClick={() => selectDoc(doc.id)}
                              className="block w-full truncate rounded text-left text-sm font-medium hover:text-accent"
                            >
                              {doc.filename}
                            </button>
                          ) : (
                            <p className="truncate text-sm font-medium text-muted">{doc.filename}</p>
                          )}
                          <p className="mt-0.5 text-xs text-muted">
                            {doc.is_demo && <span className="text-accent">Demo &middot; </span>}
                            {doc.page_count ? `${doc.page_count} pages` : "Page count pending"}
                            {isSelected && <span className="text-accent"> &middot; asking</span>}
                          </p>
                        </div>
                        <StatusBadge status={doc.status} />
                      </div>

                      {doc.status === "processing" && (doc.chunks_total ?? 0) > 0 && (
                        <Progress done={doc.chunks_done ?? 0} total={doc.chunks_total ?? 0} />
                      )}

                      {doc.status === "failed" && (
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <p className="min-w-0 flex-1 text-xs text-danger">
                            {doc.error_message ?? "Processing failed."}
                          </p>
                          <button
                            type="button"
                            disabled={retrying === doc.id}
                            onClick={() => void retry(doc.id)}
                            className="shrink-0 rounded border border-line px-2 py-1 text-xs hover:border-accent hover:text-accent disabled:opacity-50"
                          >
                            {retrying === doc.id ? "Retrying..." : "Try again"}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {selected && (
            <div className="mt-10 border-t border-line pt-8">
              <ChatPanel
                key={selected.id}
                doc={selected}
                starterQuestions={selected.starter_questions ?? []}
                messages={threads[selected.id] ?? []}
                setMessages={setMessages}
                onCitationClick={openViewer}
              />
            </div>
          )}
        </div>
      </div>

      {viewer && selected && (
        <aside
          aria-label="Document viewer"
          className="fixed inset-0 z-50 lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:w-[44%] lg:max-w-3xl lg:shrink-0 lg:border-l lg:border-line"
        >
          <PdfViewer
            key={selected.id}
            documentId={selected.id}
            filename={selected.filename}
            target={viewer}
            onClose={closeViewer}
          />
        </aside>
      )}
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = Math.min(100, Math.round((done / total) * 100));
  return (
    <div className="mt-3">
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Processing progress"
        className="h-1 w-full overflow-hidden rounded-full bg-line"
      >
        <div
          className="h-full bg-accent transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-muted">
        {done} / {total} chunks embedded
      </p>
    </div>
  );
}

const BADGE: Record<string, string> = {
  pending: "border-line text-muted",
  processing: "border-accent/40 text-accent bg-accent-soft",
  ready: "border-accent bg-accent text-canvas",
  failed: "border-danger/40 text-danger",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[11px] tracking-wide ${
        BADGE[status] ?? BADGE.pending
      }`}
    >
      {status}
    </span>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent"
    />
  );
}
