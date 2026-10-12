import assert from "node:assert/strict";
import test from "node:test";
import { chunkDocument, chunkPage } from "./chunk.mts";

const sentence = (n: number) => `This is sentence number ${n} and it carries a little filler text.`;
const paragraph = (n: number) =>
  [sentence(n * 3), sentence(n * 3 + 1), sentence(n * 3 + 2)].join(" ");
const page = (paragraphs: number) =>
  Array.from({ length: paragraphs }, (_, i) => paragraph(i)).join("\n\n");

test("page number rides along with every chunk", () => {
  const pages = [page(30), page(30), page(30)];
  const chunks = chunkDocument(pages);

  for (const chunk of chunks) {
    assert.ok(chunk.pageNumber >= 1 && chunk.pageNumber <= 3);
    // The chunk's text must actually be findable on the page it claims.
    const source = pages[chunk.pageNumber - 1];
    const head = chunk.text.slice(0, 40);
    assert.ok(source.includes(head), `chunk claims page ${chunk.pageNumber} but text isn't there`);
  }
});

test("a chunk never spans two pages", () => {
  // Page 1 and page 2 share no vocabulary, so a straddling chunk would contain both markers.
  const chunks = chunkDocument(["alpha ".repeat(400), "bravo ".repeat(400)]);
  for (const chunk of chunks) {
    assert.ok(
      !(chunk.text.includes("alpha") && chunk.text.includes("bravo")),
      "chunk spans a page boundary",
    );
  }
});

test("chunk indexes are unique and in reading order", () => {
  const chunks = chunkDocument([page(20), page(20)]);
  assert.deepEqual(
    chunks.map((c) => c.chunkIndex),
    chunks.map((_, i) => i),
  );
});

test("chunks do not end mid-sentence", () => {
  const chunks = chunkPage(page(40), 1);
  assert.ok(chunks.length > 1, "expected the page to split");
  for (const chunk of chunks.slice(0, -1)) {
    assert.match(chunk.text, /[.!?]["')\]]?$/, `chunk ends mid-sentence: ...${chunk.text.slice(-30)}`);
  }
});

test("consecutive chunks overlap", () => {
  const chunks = chunkPage(page(40), 1);
  for (let i = 1; i < chunks.length; i++) {
    const head = chunks[i].text.slice(0, 30);
    assert.ok(chunks[i - 1].text.includes(head), `no overlap between chunk ${i - 1} and ${i}`);
  }
});

test("one enormous unbroken sentence is cut rather than dropped", () => {
  const runOn = `${"word ".repeat(5000)}end.`;
  const chunks = chunkPage(runOn, 7);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.pageNumber === 7));
  assert.ok(chunks.every((c) => c.text.length < runOn.length));
});

test("empty and whitespace-only pages produce no chunks", () => {
  assert.equal(chunkPage("", 1).length, 0);
  assert.equal(chunkPage("   \n\n  \t ", 1).length, 0);
  // A blank page between two real ones must not shift the numbering.
  const chunks = chunkDocument([page(2), "", page(2)]);
  assert.deepEqual([...new Set(chunks.map((c) => c.pageNumber))], [1, 3]);
});

test("chunks stay near the target size", () => {
  const chunks = chunkPage(page(60), 1, { targetTokens: 800, overlapTokens: 150 });
  for (const chunk of chunks) {
    assert.ok(chunk.text.length / 4 <= 800 * 1.3, `chunk far over target: ${chunk.text.length} chars`);
  }
});
