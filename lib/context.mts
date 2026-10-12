/**
 * Turning retrieved chunks into the excerpt block the model sees.
 *
 * Chunks arrive ranked by similarity. The model reads better with them in document order, and
 * consecutive chunks share overlap text by design, so the same sentences would otherwise appear
 * twice inside one prompt and burn context for nothing.
 */

export type RetrievedChunk = {
  content: string;
  page_number: number;
  chunk_index: number;
  /** Cosine similarity from match_chunks. Diagnostic only — nothing is filtered on it. */
  similarity?: number;
};

/**
 * If `next` begins with text `previous` already ended with, drop the repeat.
 * Only looks at a bounded window — this is chunk overlap, not general deduplication.
 */
export function trimOverlap(previous: string, next: string, maxOverlapChars = 600): number {
  const window = Math.min(previous.length, next.length, maxOverlapChars);
  for (let n = window; n >= 30; n--) {
    if (previous.endsWith(next.slice(0, n))) return n;
  }
  return 0;
}

/**
 * The excerpt block, in document order, each line labelled with the page it came from.
 * Returns the page numbers actually included so the caller can hand them to the UI without
 * re-parsing anything out of the model's answer.
 */
export function buildContext(chunks: RetrievedChunk[]): { text: string; pages: number[] } {
  const ordered = [...chunks].sort(
    (a, b) => a.page_number - b.page_number || a.chunk_index - b.chunk_index,
  );

  const lines: string[] = [];
  const pages: number[] = [];
  let previous = "";

  for (const chunk of ordered) {
    const overlap = trimOverlap(previous, chunk.content);
    const text = (overlap > 0 ? chunk.content.slice(overlap) : chunk.content).trim();
    previous = chunk.content;

    if (!text) continue; // wholly contained in the chunk before it
    lines.push(`[p. ${chunk.page_number}] ${text}`);
    if (!pages.includes(chunk.page_number)) pages.push(chunk.page_number);
  }

  return { text: lines.join("\n\n"), pages };
}
