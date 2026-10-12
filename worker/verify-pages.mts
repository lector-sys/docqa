/**
 * Citation sanity check: `npm run verify:pages -- some.pdf`
 *
 * Prints what the worker would index, grouped by page, so you can open the real PDF at that
 * page and confirm the text belongs there. Page numbers are the foundation of every citation
 * in the app, and this is the cheapest way to catch a one-off drift before it reaches answers.
 */

import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";
import { chunkDocument } from "./chunk.mts";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run verify:pages -- <file.pdf> [page]");
  process.exit(1);
}

const only = process.argv[3] ? Number(process.argv[3]) : null;

const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });
const chunks = chunkDocument(pages);

console.log(`${path}: ${totalPages} pages, ${chunks.length} chunks\n`);

for (let page = 1; page <= totalPages; page++) {
  if (only && page !== only) continue;

  const onPage = chunks.filter((c) => c.pageNumber === page);
  const source = pages[page - 1] ?? "";

  if (!source.trim()) {
    console.log(`p. ${page}  — no extractable text (image-only page)\n`);
    continue;
  }

  console.log(`p. ${page}  ${onPage.length} chunk(s), ${source.length} chars`);
  for (const chunk of onPage) {
    const found = source.includes(chunk.text.slice(0, 60));
    const opening = chunk.text.slice(0, 100).replace(/\s+/g, " ");
    console.log(`  ${found ? "ok " : "MISMATCH"} [${chunk.chunkIndex}] ${opening}...`);
  }
  console.log();
}
