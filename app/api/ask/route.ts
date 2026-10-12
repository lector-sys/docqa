import { NextResponse } from "next/server";
import { buildContext, type RetrievedChunk } from "@/lib/context.mts";
import { embedQuestion } from "@/lib/embed-remote.mts";
import { streamAnswer } from "@/lib/llm.mts";
import { checkRateLimit, clientIp, describeWait } from "@/lib/rate-limit.mts";
import { requestSessionId } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

const TOP_K = Number(process.env.ASK_TOP_K) || 12;
const MAX_QUESTION_CHARS = 1000;
const REQUESTS_PER_HOUR = Number(process.env.ASK_RATE_LIMIT) || 20;

/** The exact wording the model is told to use, reused when there is nothing to send it. */
const REFUSAL = "I couldn't find this in the document.";

/**
 * Retrieval is deliberately unfiltered — match_chunks is pure top-k, with no similarity floor.
 * Weak context is passed to the model on purpose: it will refuse honestly having seen the
 * excerpts, which is better than refusing before it sees anything.
 *
 * So an empty result is never "everything scored too low" — it means the document has no
 * indexed chunks, or every match collapsed into overlap. Both are silent from the outside:
 * the visitor sees a confident refusal and nothing looks wrong. Counted, and logged with the
 * best score available, so the ratio is visible rather than inferred from complaints.
 */
let asksServed = 0;
let emptyRetrievals = 0;
/** Not a filter. Below this, the log says so and the excerpts are sent anyway. */
const WEAK_SIMILARITY = 0.35;

const SYSTEM_PROMPT = `You answer questions using ONLY the excerpts below.

Rules:
- Cite the page number for every claim, in the form [p. 14].
- If the excerpts do not contain the answer, reply exactly:
  "${REFUSAL}"
  Do not guess, and do not use outside knowledge.
- Be concise. Do not pad the answer.`;

function bad(message: string, status: number, headers?: HeadersInit) {
  return NextResponse.json({ error: message }, { status, headers });
}

function streamOf(source: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const text of source) controller.enqueue(encoder.encode(text));
      } catch (error) {
        // The connection dropped after the answer began; a provider switch is no longer possible.
        console.error("ask: stream broke mid-answer", error);
        controller.enqueue(
          encoder.encode("\n\n(The connection dropped before this answer finished. Please ask again.)"),
        );
      } finally {
        controller.close();
      }
    },
  });
}

async function* just(text: string) {
  yield text;
}

/**
 * Answers stream back as plain text. The pages that were actually retrieved ride along in the
 * `x-source-pages` header rather than inside the body, so the UI can render citation chips
 * immediately without waiting for the answer or parsing anything out of it.
 */
function answerResponse(body: ReadableStream<Uint8Array>, pages: number[], provider: string) {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-source-pages": pages.join(","),
      "x-provider": provider,
      "x-accel-buffering": "no",
    },
  });
}

export async function POST(req: Request) {
  const limit = checkRateLimit(clientIp(req), REQUESTS_PER_HOUR);
  if (!limit.allowed) {
    return bad(
      `You've reached the limit of ${REQUESTS_PER_HOUR} questions an hour. Try again in ${describeWait(limit.retryAfterSeconds)}.`,
      429,
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

  const sessionId = requestSessionId(req);
  if (!sessionId) return bad("Missing session. Reload the page and try again.", 400);

  let body: { documentId?: unknown; question?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("Malformed request.", 400);
  }

  const { documentId, question } = body;
  if (typeof documentId !== "string" || typeof question !== "string") {
    return bad("Malformed request.", 400);
  }
  const trimmed = question.trim();
  if (!trimmed) return bad("Ask a question first.", 400);
  if (trimmed.length > MAX_QUESTION_CHARS) {
    return bad(`Questions are limited to ${MAX_QUESTION_CHARS} characters.`, 413);
  }

  const db = supabaseAdmin();

  // The service role bypasses RLS, so the ownership check the database would normally make
  // has to be made here, explicitly.
  const { data: doc, error: docError } = await db
    .from("documents")
    .select("id, status, is_demo, session_id")
    .eq("id", documentId)
    .maybeSingle();

  if (docError) {
    console.error("ask: document lookup failed", docError);
    return bad("Couldn't reach the document. Please try again.", 500);
  }
  // Same response whether it is missing or simply not theirs — no probing for other people's ids.
  if (!doc || !(doc.is_demo || doc.session_id === sessionId)) {
    return bad("That document isn't available.", 404);
  }
  if (doc.status !== "ready") {
    return bad(
      doc.status === "failed"
        ? "This document couldn't be processed, so it can't be searched."
        : "This document is still being prepared. Try again once it's ready.",
      409,
    );
  }

  let matches: RetrievedChunk[];
  try {
    const embedding = await embedQuestion(trimmed);
    const { data, error } = await db.rpc("match_chunks", {
      query_embedding: embedding,
      doc_id: documentId,
      match_count: TOP_K,
    });
    if (error) throw new Error(error.message);
    matches = (data ?? []) as RetrievedChunk[];
  } catch (error) {
    console.error("ask: retrieval failed", error);
    return bad("Couldn't search this document right now. Please try again.", 500);
  }

  asksServed += 1;
  const topScore = matches[0]?.similarity;
  const scoreLabel = typeof topScore === "number" ? topScore.toFixed(3) : "n/a";
  const asked = `doc ${documentId}, "${trimmed.slice(0, 80)}"`;

  const { text: excerpts, pages } = buildContext(matches);

  // Nothing retrieved means there is nothing to ground an answer in. Say so directly rather
  // than paying for a model call to produce the same sentence.
  if (!excerpts) {
    emptyRetrievals += 1;
    const cause =
      matches.length === 0
        ? "no chunks indexed for this document"
        : `all ${matches.length} matches collapsed into overlap`;
    console.warn(
      `ask: nothing to ground on — ${emptyRetrievals}/${asksServed} asks so far; ` +
        `${cause}; top similarity ${scoreLabel} (${asked})`,
    );
    return answerResponse(streamOf(just(REFUSAL)), [], "none");
  }

  if (typeof topScore === "number" && topScore < WEAK_SIMILARITY) {
    console.warn(
      `ask: weak retrieval, top similarity ${scoreLabel} — sending it to the model anyway (${asked})`,
    );
  }

  const userPrompt = `EXCERPTS:\n${excerpts}\n\nQUESTION: ${trimmed}`;
  const answer = await streamAnswer(SYSTEM_PROMPT, userPrompt);

  if (!answer) {
    return answerResponse(
      streamOf(
        just(
          "The answering service is busy right now — both providers are rate limited. Please try again in a minute.",
        ),
      ),
      pages,
      "none",
    );
  }

  return answerResponse(streamOf(answer.tokens), pages, answer.provider);
}
