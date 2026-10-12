/**
 * Seeds the demo document: `npm run seed:demo`
 *
 * Repeatable — running it again replaces the existing demo rather than stacking duplicates.
 * It only uploads the file and queues the row; the worker does the actual indexing, so start
 * the worker (or leave it running) and watch the status go pending -> processing -> ready.
 *
 * Override the document with DEMO_PDF_URL / DEMO_PDF_NAME, or pass a local path as an argument.
 * If you swap the document, swap DEMO_QUESTIONS below too — they are chosen to land on
 * well-cited answers in this particular one.
 */

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

/**
 * IRS Publication 17, "Your Federal Income Tax" — a ~140-page US government reference work,
 * public domain, and the kind of dense procedural document this app is actually for. The URL
 * is stable and always serves the current edition.
 */
const DEFAULT_URL = "https://www.irs.gov/pub/irs-pdf/p17.pdf";
const DEFAULT_NAME = "IRS Publication 17 — Your Federal Income Tax.pdf";

const DEMO_QUESTIONS = [
  "Who counts as a qualifying child for tax purposes?",
  "What are the filing statuses, and how do I know which one applies to me?",
  "What is the standard deduction and who cannot claim it?",
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env var ${name}. Copy .env.example to .env.local and fill it in.`);
    process.exit(1);
  }
  return value;
}

const db = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

async function loadPdf(): Promise<{ bytes: Uint8Array; filename: string }> {
  const localPath = process.argv[2];

  if (localPath) {
    console.log(`reading ${localPath}`);
    const bytes = new Uint8Array(await readFile(localPath));
    return { bytes, filename: process.env.DEMO_PDF_NAME ?? localPath.split(/[\\/]/).pop()! };
  }

  const url = process.env.DEMO_PDF_URL ?? DEFAULT_URL;
  console.log(`downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(
      `Download failed (${response.status}). Pass a local path instead: npm run seed:demo -- ./file.pdf`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, filename: process.env.DEMO_PDF_NAME ?? DEFAULT_NAME };
}

async function main() {
  const { bytes, filename } = await loadPdf();

  if (bytes.length < 1000 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("That download isn't a PDF. Check DEMO_PDF_URL.");
  }
  console.log(`got ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);

  // Clear out any previous demo so re-running replaces rather than accumulates.
  const { data: existing } = await db.from("documents").select("id, storage_path").eq("is_demo", true);
  for (const old of existing ?? []) {
    await db.storage.from("pdfs").remove([old.storage_path]);
    await db.from("documents").delete().eq("id", old.id); // chunks cascade
    console.log(`removed previous demo ${old.id}`);
  }

  const docId = crypto.randomUUID();
  const path = `demo/${docId}.pdf`;

  const { error: uploadError } = await db.storage
    .from("pdfs")
    .upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

  const { error: insertError } = await db.from("documents").insert({
    id: docId,
    filename,
    storage_path: path,
    session_id: null, // demo documents belong to nobody and are readable by everyone
    is_demo: true,
    status: "pending",
    starter_questions: DEMO_QUESTIONS,
  });
  if (insertError) {
    await db.storage.from("pdfs").remove([path]);
    throw new Error(`Insert failed: ${insertError.message}`);
  }

  console.log(`\nqueued "${filename}" as the demo document (${docId})`);
  console.log("starter questions:");
  for (const question of DEMO_QUESTIONS) console.log(`  - ${question}`);
  console.log("\nStart the worker if it isn't running: npm run worker");
  console.log("Then ask each starter question and confirm the citations land on the right pages.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
