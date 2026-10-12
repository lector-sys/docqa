"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { clientSessionId } from "@/lib/session";

// Bundled rather than pulled from a CDN: one less thing to be offline, blocked, or version-skewed.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

export type ViewerTarget = { page: number; nonce: number };

type Props = {
  documentId: string;
  filename: string;
  target: ViewerTarget;
  onClose: () => void;
};

/**
 * Single page at a time, on purpose. A citation jump has to land on the right page instantly and
 * unmistakably; scrolling a 150-page continuous view to an offset is slower, less certain, and
 * renders pages nobody asked for.
 */
function PdfViewer({ documentId, filename, target, onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [page, setPage] = useState(target.page);
  const [pageDraft, setPageDraft] = useState(String(target.page));
  const [scale, setScale] = useState(1);
  const [width, setWidth] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);

  // A new jump — even to the page already showing — re-runs the highlight. Adjusting state
  // during render is the documented way to follow a prop; an effect would render the old page
  // once first, which is exactly the flicker this interaction cannot afford.
  const [lastTarget, setLastTarget] = useState(target);
  if (target !== lastTarget) {
    setLastTarget(target);
    setPage(target.page);
    setPageDraft(String(target.page));
  }

  // Mounted per document (the parent keys on it), so there is no previous state to clear.
  useEffect(() => {
    let cancelled = false;

    fetch(`/api/document/${documentId}/url`, { headers: { "x-session-id": clientSessionId() } })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "Couldn't open this document.");
        return data.url as string;
      })
      .then((signed) => {
        if (!cancelled) setUrl(signed);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("viewer: signed url failed", error);
        setUrlError(error instanceof Error ? error.message : "Couldn't open this document.");
      });

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(1, next), numPages ?? next);
      setPage(clamped);
      setPageDraft(String(clamped));
    },
    [numPages],
  );

  const commitDraft = () => {
    const parsed = Number(pageDraft);
    if (Number.isInteger(parsed) && parsed >= 1) goTo(parsed);
    else setPageDraft(String(page));
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-xs font-medium" title={filename}>
          {filename}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close document viewer"
          className="rounded px-2 py-1 text-xs text-muted hover:bg-accent-soft hover:text-accent"
        >
          Close
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2 text-xs">
        <button
          type="button"
          onClick={() => goTo(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className="rounded border border-line px-2 py-1 disabled:opacity-40 enabled:hover:border-accent"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => goTo(page + 1)}
          disabled={numPages !== null && page >= numPages}
          aria-label="Next page"
          className="rounded border border-line px-2 py-1 disabled:opacity-40 enabled:hover:border-accent"
        >
          ›
        </button>

        <label className="ml-1 flex items-center gap-1.5 text-muted">
          <span className="sr-only">Page number</span>
          <input
            value={pageDraft}
            inputMode="numeric"
            onChange={(e) => setPageDraft(e.target.value.replace(/\D/g, ""))}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
              }
            }}
            className="w-12 rounded border border-line bg-canvas px-1.5 py-1 text-center font-mono text-ink"
          />
          <span className="font-mono">/ {numPages ?? "—"}</span>
        </label>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(MIN_SCALE, +(s - 0.2).toFixed(2)))}
            disabled={scale <= MIN_SCALE}
            aria-label="Zoom out"
            className="rounded border border-line px-2 py-1 disabled:opacity-40 enabled:hover:border-accent"
          >
            −
          </button>
          <span className="w-11 text-center font-mono text-muted">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(MAX_SCALE, +(s + 0.2).toFixed(2)))}
            disabled={scale >= MAX_SCALE}
            aria-label="Zoom in"
            className="rounded border border-line px-2 py-1 disabled:opacity-40 enabled:hover:border-accent"
          >
            +
          </button>
        </div>
      </div>

      <div ref={frameRef} className="flex-1 overflow-auto bg-canvas p-4">
        {urlError && <ViewerMessage title="Couldn't open this document" detail={urlError} />}

        {!urlError && !url && <ViewerMessage title="Opening document…" detail="" pulse />}

        {url && (
          <Document
            file={url}
            onLoadSuccess={({ numPages: total }) => {
              setNumPages(total);
              setLoadError(false);
            }}
            onLoadError={(error) => {
              console.error("viewer: pdf failed to load", error);
              setLoadError(true);
            }}
            loading={<ViewerMessage title="Opening document…" detail="" pulse />}
            error={
              <ViewerMessage
                title="This document couldn't be displayed"
                detail="The answer above is still valid — only the preview failed."
              />
            }
            className="flex justify-center"
          >
            {!loadError && width > 0 && (
              // Keyed on the jump, so clicking the same citation twice replays the highlight.
              <div key={`${target.nonce}-${page}`} className="page-flash inline-block shadow-sm">
                <Page
                  pageNumber={page}
                  width={Math.max(200, Math.round((width - 32) * scale))}
                  renderAnnotationLayer={false}
                  loading={<div className="h-96 w-full animate-pulse rounded bg-line" />}
                />
              </div>
            )}
          </Document>
        )}
      </div>
    </div>
  );
}

function ViewerMessage({ title, detail, pulse }: { title: string; detail: string; pulse?: boolean }) {
  return (
    <div className={`px-4 py-16 text-center ${pulse ? "animate-pulse" : ""}`}>
      <p className="text-sm font-medium">{title}</p>
      {detail && <p className="mx-auto mt-1 max-w-xs text-xs text-muted">{detail}</p>}
    </div>
  );
}

// The parent re-renders on every streamed token; the viewer must not.
export default memo(PdfViewer);
