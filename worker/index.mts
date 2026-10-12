/**
 * Ingestion worker.
 *
 * Long-running process, deliberately not serverless: embedding a 200-page PDF locally takes
 * minutes, which no serverless platform will allow. Polls Supabase for pending documents,
 * extracts text page by page, chunks it, embeds it locally, and reports progress as it goes.
 *
 * Run with `npm run worker`.
 */

import { createClient } from "@supabase/supabase-js";
import { extractText, getDocumentProxy } from "unpdf";
import { EMBEDDING_MODEL, embedTexts, getEmbedder } from "../lib/embed.mts";
import { chunkDocument } from "./chunk.mts";
import { startEmbedServer } from "./embed-server.mts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env var ${name}. Copy .env.example to .env.local and fill it in.`);
    process.exit(1);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const db = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

const POLL_MS = numberEnv("WORKER_POLL_MS", 3000);
/** Rows per insert, and the granularity of the progress bar. */
const INSERT_BATCH = numberEnv("WORKER_INSERT_BATCH", 100);
/** ponytail: kept well under the insert batch so peak memory stays small enough for a
 *  512 MB free-tier container. Raise it on a bigger box for throughput. */
const EMBED_BATCH = numberEnv("WORKER_EMBED_BATCH", 16);
const STALE_MS = numberEnv("WORKER_STALE_MINUTES", 15) * 60_000;
/**
 * CEILING: all-MiniLM-L6-v2 truncates its input at 256 tokens. Text beyond that is stored and
 * shown as context but contributes nothing to the chunk's vector, so raising CHUNK_TOKENS past
 * ~250 quietly degrades retrieval rather than improving it. 220 leaves headroom for the
 * 4-chars-per-token estimate running short. Change the embedding model before raising this.
 */
const CHUNK_OPTIONS = {
  targetTokens: numberEnv("CHUNK_TOKENS", 220),
  overlapTokens: numberEnv("CHUNK_OVERLAP_TOKENS", 40),
};

const DOC_COLUMNS = "id, filename, storage_path";
type Doc = { id: string; filename: string; storage_path: string };

/** An error whose message is safe and useful to show a visitor. */
class UserFacingError extends Error {}

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

let stopping = false;

/** A worker that died mid-document leaves it stuck in `processing`; hand it back to the queue. */
async function reclaimStale() {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data, error } = await db
    .from("documents")
    .update({ status: "pending", chunks_done: 0, chunks_total: 0 })
    .eq("status", "processing")
    .lt("claimed_at", cutoff)
    .select("id");

  if (error) {
    console.error("reclaim failed", error.message);
    return;
  }
  if (data?.length) log(`reclaimed ${data.length} stale document(s)`);
}

/**
 * Take the oldest pending document. The conditional update is the lock: only one worker can
 * flip a given row out of `pending`, so two instances can never process the same document.
 */
async function claimNext(): Promise<Doc | null> {
  const { data: candidates, error } = await db
    .from("documents")
    .select("id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);

  if (error) {
    console.error("poll failed", error.message);
    return null;
  }

  for (const candidate of candidates ?? []) {
    const { data: claimed } = await db
      .from("documents")
      .update({
        status: "processing",
        claimed_at: now(),
        chunks_done: 0,
        chunks_total: 0,
        error_message: null,
      })
      .eq("id", candidate.id)
      .eq("status", "pending")
      .select(DOC_COLUMNS)
      .maybeSingle();

    if (claimed) return claimed as Doc;
    // Lost the race to another worker; try the next candidate.
  }
  return null;
}

/** Text of each page, index 0 being page 1. */
async function extractPages(bytes: Uint8Array, filename: string) {
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch {
    throw new UserFacingError("This file couldn't be opened as a PDF. It may be corrupted or password-protected.");
  }

  const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });

  pages.forEach((text, i) => {
    if (!text.trim()) console.warn(`  ! ${filename}: page ${i + 1} yielded no text`);
  });

  if (pages.every((text) => !text.trim())) {
    throw new UserFacingError(
      "No text could be extracted from this PDF. It looks like a scan of a printed document, which needs OCR before it can be searched.",
    );
  }

  return { totalPages, pages };
}

type Embedder = (texts: string[]) => Promise<number[][]>;

async function processDocument(doc: Doc, embed: Embedder) {
  const startedAt = Date.now();
  log(`▶ ${doc.filename} (${doc.id})`);

  const fail = async (message: string) => {
    await db.from("chunks").delete().eq("document_id", doc.id);
    await db.from("documents").update({ status: "failed", error_message: message }).eq("id", doc.id);
  };

  try {
    // Crash recovery: always start from a clean slate rather than resuming. Reprocessing a
    // document costs minutes; a half-indexed document costs wrong answers with no symptom.
    await db.from("chunks").delete().eq("document_id", doc.id);

    const { data: blob, error: downloadError } = await db.storage.from("pdfs").download(doc.storage_path);
    if (downloadError || !blob) {
      throw new UserFacingError("The uploaded file couldn't be read. Please upload it again.");
    }

    const { totalPages, pages } = await extractPages(new Uint8Array(await blob.arrayBuffer()), doc.filename);
    await db.from("documents").update({ page_count: totalPages, claimed_at: now() }).eq("id", doc.id);

    const chunks = chunkDocument(pages, CHUNK_OPTIONS);
    if (chunks.length === 0) {
      throw new UserFacingError("This PDF has pages but no readable text to index.");
    }
    await db.from("documents").update({ chunks_total: chunks.length, chunks_done: 0 }).eq("id", doc.id);

    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH) {
      if (stopping) {
        log(`… releasing ${doc.filename} back to the queue`);
        await db.from("chunks").delete().eq("document_id", doc.id);
        await db
          .from("documents")
          .update({ status: "pending", chunks_done: 0, chunks_total: 0 })
          .eq("id", doc.id);
        return;
      }

      const batch = chunks.slice(offset, offset + INSERT_BATCH);
      const vectors = await embed(batch.map((c) => c.text));

      const { error: insertError } = await db.from("chunks").insert(
        batch.map((chunk, i) => ({
          document_id: doc.id,
          content: chunk.text,
          page_number: chunk.pageNumber, // straight from extraction; never re-derived
          chunk_index: chunk.chunkIndex,
          embedding: vectors[i],
        })),
      );
      if (insertError) {
        console.error("insert failed", insertError.message);
        throw new UserFacingError("The processed text couldn't be saved. Please try again.");
      }

      // Doubles as a heartbeat so a long document is never mistaken for a stalled one.
      await db
        .from("documents")
        .update({ chunks_done: offset + batch.length, claimed_at: now() })
        .eq("id", doc.id);
    }

    await db
      .from("documents")
      .update({ status: "ready", chunks_done: chunks.length, error_message: null })
      .eq("id", doc.id);

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`✔ ${doc.filename} — ${totalPages} pages, ${chunks.length} chunks, ${seconds}s`);
  } catch (error) {
    const message =
      error instanceof UserFacingError
        ? error.message
        : "Something went wrong while processing this document. Please try uploading it again.";
    console.error(`✖ ${doc.filename} — ${error instanceof Error ? error.message : error}`);
    await fail(message);
  }
}

async function main() {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(1);
      stopping = true;
      log(`${signal} received — finishing up, press again to force quit`);
    });
  }

  log(`loading ${EMBEDDING_MODEL} (first run downloads ~90 MB)`);
  // Loaded once for the life of the process, from the same module the ask endpoint uses, so
  // questions and chunks can never be embedded with different settings.
  await getEmbedder();
  log("model ready");

  // The model is resident here for the life of the process, so the ask endpoint borrows it
  // rather than loading its own copy on every cold serverless instance.
  startEmbedServer(log);

  const embed: Embedder = (texts) => embedTexts(texts, EMBED_BATCH);

  log(`polling every ${POLL_MS}ms`);
  while (!stopping) {
    await reclaimStale();
    const doc = await claimNext();
    if (!doc) {
      await sleep(POLL_MS);
      continue;
    }
    await processDocument(doc, embed);
  }

  log("stopped");
  process.exit(0);
}

main().catch((error) => {
  console.error("worker crashed", error);
  process.exit(1);
});
