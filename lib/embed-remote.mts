/**
 * How the ask endpoint gets a question vector.
 *
 * Preference is the worker, which already has the model resident, so a cold serverless instance
 * doesn't have to fetch ~90 MB before it can answer. If the worker is unreachable the endpoint
 * embeds in-process instead — slower, but local dev works with the worker stopped and a worker
 * outage degrades latency rather than breaking search.
 *
 * Either way the vector comes from lib/embed.mts. There is still only one implementation.
 */

import { EMBEDDING_DIMENSIONS } from "./embed-config.mts";

const TIMEOUT_MS = 10_000;

function isVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

async function remoteEmbed(baseUrl: string, text: string): Promise<number[]> {
  const response = await fetch(new URL("/embed", baseUrl), {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.WORKER_EMBED_TOKEN ?? ""}`,
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) throw new Error(`worker responded ${response.status}`);

  const { vector } = await response.json();
  if (!isVector(vector)) throw new Error("worker returned a malformed vector");
  return vector;
}

export async function embedQuestion(question: string): Promise<number[]> {
  const baseUrl = process.env.WORKER_EMBED_URL;

  if (baseUrl) {
    try {
      return await remoteEmbed(baseUrl, question);
    } catch (error) {
      console.warn(
        `ask: worker embed unavailable (${error instanceof Error ? error.message : error}), embedding in-process`,
      );
    }
  }

  // Imported lazily on purpose: a static import would pull onnxruntime into every cold start,
  // which is the whole cost this module exists to avoid.
  const { embedQuery } = await import("./embed.mts");
  return embedQuery(question);
}
