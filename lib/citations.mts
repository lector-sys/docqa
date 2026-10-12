/**
 * Turning a streamed answer into text and citation chips.
 *
 * The answer arrives a few characters at a time, so a marker is routinely split across chunks:
 * one render sees "...clause [p. 1" and the next sees "4] applies". Rendering the first as
 * literal text and then swapping it out flickers, and worse, a half-parsed "[p. 1" reads as a
 * mistake. While the stream is open, an unfinished marker at the very end is held back instead.
 */

export type AnswerSegment = { type: "text"; text: string } | { type: "citation"; page: number };

const CITATION = /\[p\.\s*(\d{1,5})\s*\]/g;
/** A suffix that could still turn into a citation once more characters arrive. */
const UNFINISHED = /\[(?:p(?:\.[ \t]*\d{0,5})?)?$/;

/**
 * `streaming` should be true while more text may still arrive. Once the stream closes,
 * everything is shown as-is — a trailing "[" really was just a bracket.
 */
export function parseAnswer(answer: string, streaming = false): AnswerSegment[] {
  const unfinished = streaming ? answer.match(UNFINISHED) : null;
  const visible = unfinished ? answer.slice(0, unfinished.index) : answer;

  const segments: AnswerSegment[] = [];
  let cursor = 0;

  for (const match of visible.matchAll(CITATION)) {
    if (match.index > cursor) {
      segments.push({ type: "text", text: visible.slice(cursor, match.index) });
    }
    segments.push({ type: "citation", page: Number(match[1]) });
    cursor = match.index + match[0].length;
  }

  if (cursor < visible.length) segments.push({ type: "text", text: visible.slice(cursor) });
  return segments;
}

/** Every page cited in the answer, in order of first appearance. */
export function citedPages(answer: string): number[] {
  const pages: number[] = [];
  for (const match of answer.matchAll(CITATION)) {
    const page = Number(match[1]);
    if (!pages.includes(page)) pages.push(page);
  }
  return pages;
}
