import assert from "node:assert/strict";
import test from "node:test";
import { citedPages, parseAnswer } from "./citations.mts";
import { buildContext, trimOverlap } from "./context.mts";
import { checkRateLimit, describeWait, resetRateLimits } from "./rate-limit.mts";

const chunk = (page: number, index: number, content: string) => ({
  page_number: page,
  chunk_index: index,
  content,
});

test("excerpts come back in document order, not similarity order", () => {
  const { text, pages } = buildContext([
    chunk(9, 20, "Ninth page content."),
    chunk(2, 3, "Second page content."),
    chunk(5, 11, "Fifth page content."),
  ]);

  assert.deepEqual(pages, [2, 5, 9]);
  assert.ok(text.indexOf("[p. 2]") < text.indexOf("[p. 5]"));
  assert.ok(text.indexOf("[p. 5]") < text.indexOf("[p. 9]"));
});

test("every excerpt is labelled with its page", () => {
  const { text } = buildContext([chunk(14, 1, "Some text."), chunk(14, 2, "More text.")]);
  for (const line of text.split("\n\n")) assert.match(line, /^\[p\. 14\] /);
});

test("overlap repeated between consecutive chunks is not sent twice", () => {
  const shared = "The termination clause applies to both parties in equal measure.";
  const { text } = buildContext([
    chunk(3, 1, `Opening sentence of the section. ${shared}`),
    chunk(3, 2, `${shared} And then the section continues onward.`),
  ]);

  assert.equal(text.split(shared).length - 1, 1, "shared sentence appears more than once");
  assert.ok(text.includes("And then the section continues onward."));
});

test("a chunk wholly contained in the previous one is dropped", () => {
  const { text, pages } = buildContext([
    chunk(1, 1, "Alpha bravo charlie delta echo foxtrot golf hotel."),
    chunk(1, 2, "Alpha bravo charlie delta echo foxtrot golf hotel."),
  ]);
  assert.equal(text.split("[p. 1]").length - 1, 1);
  assert.deepEqual(pages, [1]);
});

test("trimOverlap ignores coincidental short matches", () => {
  assert.equal(trimOverlap("...ending in the", "the quick brown fox"), 0);
});

test("no chunks means no context and no pages", () => {
  assert.deepEqual(buildContext([]), { text: "", pages: [] });
});

test("rate limit allows the quota then refuses with a wait", () => {
  resetRateLimits();
  const start = Date.now();
  for (let i = 0; i < 20; i++) {
    assert.equal(checkRateLimit("1.2.3.4", 20, 3_600_000, start).allowed, true, `request ${i + 1}`);
  }

  const blocked = checkRateLimit("1.2.3.4", 20, 3_600_000, start);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 3500 && blocked.retryAfterSeconds <= 3600);

  // A different address is unaffected.
  assert.equal(checkRateLimit("5.6.7.8", 20, 3_600_000, start).allowed, true);
});

test("rate limit window slides", () => {
  resetRateLimits();
  const start = Date.now();
  for (let i = 0; i < 20; i++) checkRateLimit("9.9.9.9", 20, 3_600_000, start);
  assert.equal(checkRateLimit("9.9.9.9", 20, 3_600_000, start).allowed, false);
  // One hour and a second later the oldest hits have aged out.
  assert.equal(checkRateLimit("9.9.9.9", 20, 3_600_000, start + 3_601_000).allowed, true);
});

test("wait times read like something a person would say", () => {
  assert.equal(describeWait(45), "45 seconds");
  assert.equal(describeWait(60), "a minute");
  assert.equal(describeWait(1800), "30 minutes");
});

test("citations become chips, surrounding text is preserved", () => {
  const segments = parseAnswer("The term is five years [p. 14] unless renewed.");
  assert.deepEqual(segments, [
    { type: "text", text: "The term is five years " },
    { type: "citation", page: 14 },
    { type: "text", text: " unless renewed." },
  ]);
});

test("a marker split across stream chunks is held back, never half-rendered", () => {
  // Exactly what the browser sees as bytes arrive.
  const growing = ["The term is", " five years [", "p", ".", " 1", "4", "] unless renewed."];
  let sofar = "";
  for (const piece of growing.slice(0, -1)) {
    sofar += piece;
    const rendered = parseAnswer(sofar, true)
      .map((s) => (s.type === "text" ? s.text : `<${s.page}>`))
      .join("");
    assert.ok(!rendered.includes("["), `leaked a partial marker: ${JSON.stringify(rendered)}`);
  }

  sofar += growing.at(-1);
  assert.deepEqual(parseAnswer(sofar, true), [
    { type: "text", text: "The term is five years " },
    { type: "citation", page: 14 },
    { type: "text", text: " unless renewed." },
  ]);
});

test("a trailing bracket is shown once the stream closes", () => {
  assert.deepEqual(parseAnswer("see the appendix [", true), [
    { type: "text", text: "see the appendix " },
  ]);
  assert.deepEqual(parseAnswer("see the appendix [", false), [
    { type: "text", text: "see the appendix [" },
  ]);
});

test("consecutive and repeated citations", () => {
  assert.deepEqual(parseAnswer("Both apply [p. 3][p. 9]."), [
    { type: "text", text: "Both apply " },
    { type: "citation", page: 3 },
    { type: "citation", page: 9 },
    { type: "text", text: "." },
  ]);
  assert.deepEqual(citedPages("a [p. 3] b [p. 9] c [p. 3]"), [3, 9]);
});

test("things that look like citations but are not", () => {
  const text = "Section [4] and [page 7] and [p.] stay as text.";
  assert.deepEqual(parseAnswer(text), [{ type: "text", text }]);
});
