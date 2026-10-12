/**
 * Page-bound chunking.
 *
 * Every chunk belongs to exactly one page, and the page number travels with the text from
 * extraction to insertion. Citations are only as trustworthy as this mapping, so chunks are
 * produced *per page* and the page number is never inferred, re-derived, or looked up later.
 *
 * Boundaries, in order of preference: paragraph, then sentence. Never mid-sentence, unless a
 * single "sentence" is so long it must be cut (bad extraction of a table, usually).
 */

export type Chunk = {
  text: string;
  pageNumber: number;
  chunkIndex: number;
};

export type ChunkOptions = {
  /** Target chunk size. */
  targetTokens: number;
  /** How much of the previous chunk to repeat at the start of the next one. */
  overlapTokens: number;
};

/** See the CEILING note in worker/index.mts before raising targetTokens. */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetTokens: 220,
  overlapTokens: 40,
};

/** A half-open [start, end) range into the page's text. Slicing keeps the original whitespace. */
type Range = { start: number; end: number };

// ponytail: 4 chars/token is the usual English approximation, and it costs nothing.
// Swap in the model's real tokenizer if chunk sizes ever need to be exact.
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// A blank line ends a paragraph.
const PARAGRAPH = /\n[ \t]*\n\s*/g;
// ponytail: naive sentence split — "Mr." and "3.14" will fool it. Good enough for chunk
// boundaries (a slightly early cut costs nothing); use a real segmenter if it ever matters.
const SENTENCE = /(?<=[.!?]["')\]]?)\s+/g;

/**
 * Cut a range at every separator match, keeping the separator at the end of the piece before it.
 * Empty pieces are dropped.
 */
function splitRange(text: string, range: Range, separator: RegExp): Range[] {
  const slice = text.slice(range.start, range.end);
  const re = new RegExp(separator.source, separator.flags.includes("g") ? separator.flags : `${separator.flags}g`);
  const pieces: Range[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(slice)) !== null) {
    const cut = match.index + match[0].length;
    if (cut === last) {
      re.lastIndex += 1; // zero-width match; don't spin
      continue;
    }
    pieces.push({ start: range.start + last, end: range.start + cut });
    last = cut;
  }
  if (last < slice.length) pieces.push({ start: range.start + last, end: range.end });

  return pieces.filter((p) => text.slice(p.start, p.end).trim().length > 0);
}

/** Last resort for a single run of text with no sentence break in it: cut at whitespace. */
function hardSplit(text: string, range: Range, targetTokens: number): Range[] {
  const maxChars = targetTokens * 4;
  const pieces: Range[] = [];
  let start = range.start;

  while (range.end - start > maxChars) {
    const limit = start + maxChars;
    const space = text.lastIndexOf(" ", limit);
    const cut = space > start ? space : limit;
    pieces.push({ start, end: cut });
    start = cut;
  }
  pieces.push({ start, end: range.end });
  return pieces;
}

/**
 * The atoms a chunk is assembled from: whole paragraphs where they fit, sentences where they
 * don't, and character runs only when a single sentence is unreasonably long.
 */
function splitUnits(text: string, targetTokens: number): Range[] {
  const whole: Range = { start: 0, end: text.length };
  const units: Range[] = [];

  for (const paragraph of splitRange(text, whole, PARAGRAPH)) {
    if (estimateTokens(text.slice(paragraph.start, paragraph.end)) <= targetTokens) {
      units.push(paragraph);
      continue;
    }
    for (const sentence of splitRange(text, paragraph, SENTENCE)) {
      if (estimateTokens(text.slice(sentence.start, sentence.end)) <= targetTokens) {
        units.push(sentence);
        continue;
      }
      units.push(...hardSplit(text, sentence, targetTokens));
    }
  }

  return units;
}

/** Chunks for a single page. Page number is attached here and never recomputed. */
export function chunkPage(
  pageText: string,
  pageNumber: number,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Omit<Chunk, "chunkIndex">[] {
  const { targetTokens, overlapTokens } = options;
  const units = splitUnits(pageText, targetTokens);
  const chunks: Omit<Chunk, "chunkIndex">[] = [];

  let current: Range[] = [];
  let currentTokens = 0;

  const tokensOf = (r: Range) => estimateTokens(pageText.slice(r.start, r.end));

  const flush = () => {
    if (current.length === 0) return;
    const text = pageText.slice(current[0].start, current[current.length - 1].end).trim();
    if (text) chunks.push({ text, pageNumber });
  };

  for (const unit of units) {
    const size = tokensOf(unit);

    if (currentTokens > 0 && currentTokens + size > targetTokens) {
      flush();

      // Carry the tail of the chunk we just emitted into the next one.
      const tail: Range[] = [];
      let tailTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const t = tokensOf(current[i]);
        const wouldExceed = tailTokens + t > overlapTokens;
        // Overlap is a target, not a cap: always carry at least one unit across the boundary,
        // or a paragraph larger than the overlap budget would leave consecutive chunks with no
        // shared context at all. The exception is a unit big enough to crowd out the next chunk.
        if (wouldExceed && (tail.length > 0 || t > targetTokens / 2)) break;
        tail.unshift(current[i]);
        tailTokens += t;
      }
      // If the overlap would be the entire chunk, we'd emit the same text forever.
      if (tail.length === current.length) {
        tail.length = 0;
        tailTokens = 0;
      }

      current = tail;
      currentTokens = tailTokens;
    }

    current.push(unit);
    currentTokens += size;
  }

  flush();
  return chunks;
}

/**
 * Chunks for a whole document. `pages[i]` is the text of page `i + 1`.
 * Chunk indexes run in reading order across the document.
 */
export function chunkDocument(pages: string[], options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const chunks: Chunk[] = [];
  pages.forEach((pageText, i) => {
    for (const chunk of chunkPage(pageText, i + 1, options)) {
      chunks.push({ ...chunk, chunkIndex: chunks.length });
    }
  });
  return chunks;
}
