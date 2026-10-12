/**
 * Streaming generation across two free-tier providers.
 *
 * Free tiers throttle without warning, so a 429 is an expected condition, not an incident: it is
 * retried with backoff, then the request moves to the other provider. A rate limit must never
 * reach the visitor as an error.
 *
 * Model names come from the environment because free-tier model availability changes without
 * notice — a hardcoded model id is a time bomb.
 */

export type ProviderName = "groq" | "gemini";

export type AnswerStream = {
  provider: ProviderName;
  model: string;
  tokens: AsyncIterable<string>;
};

const CONNECT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
/** Consecutive failures before giving up on a provider and trying the other one. */
const SWITCH_AFTER = 2;

type ProviderSpec = {
  name: ProviderName;
  model: string;
  request: (system: string, user: string, signal: AbortSignal) => Promise<Response>;
  /** One SSE `data:` payload in, the text it contributes out. */
  delta: (payload: string) => string;
};

function specs(): ProviderSpec[] {
  const available: ProviderSpec[] = [];

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
    available.push({
      name: "groq",
      model,
      request: (system, user, signal) =>
        fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          signal,
          headers: { authorization: `Bearer ${groqKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            stream: true,
            temperature: 0,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
        }),
      delta: (payload) => JSON.parse(payload)?.choices?.[0]?.delta?.content ?? "",
    });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
    available.push({
      name: "gemini",
      model,
      request: (system, user, signal) =>
        fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
          {
            method: "POST",
            signal,
            headers: { "x-goog-api-key": geminiKey, "content-type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: user }] }],
              generationConfig: { temperature: 0 },
            }),
          },
        ),
      delta: (payload) =>
        (JSON.parse(payload)?.candidates?.[0]?.content?.parts ?? [])
          .map((part: { text?: string }) => part.text ?? "")
          .join(""),
    });
  }

  return available;
}

/** Server-sent events, reduced to the text the model is producing. */
async function* readSse(body: ReadableStream<Uint8Array>, delta: ProviderSpec["delta"]) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const text = delta(payload);
          if (text) yield text;
        } catch {
          // A malformed frame is not worth abandoning a good answer for.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number, response?: Response): number {
  const header = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0 && header <= 30) return header * 1000;
  const base = 500 * 2 ** attempt;
  return base + Math.random() * 250; // jitter, so retries don't march in step
}

/**
 * Connect to the first provider that answers. Returns null only when every configured provider
 * has been exhausted — the caller is expected to say something friendly in that case.
 */
export async function streamAnswer(system: string, user: string): Promise<AnswerStream | null> {
  const providers = specs();
  if (providers.length === 0) {
    console.error("ask: no LLM provider configured (set GROQ_API_KEY and/or GEMINI_API_KEY)");
    return null;
  }

  for (const [index, spec] of providers.entries()) {
    const isLast = index === providers.length - 1;
    let consecutiveFailures = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await spec.request(system, user, AbortSignal.timeout(CONNECT_TIMEOUT_MS));

        if (response.status === 429 || response.status >= 500) {
          consecutiveFailures += 1;
          console.warn(`ask: ${spec.name} returned ${response.status} (attempt ${attempt + 1})`);
          void response.body?.cancel();
          if (attempt === MAX_ATTEMPTS - 1) break;
          if (!isLast && consecutiveFailures >= SWITCH_AFTER) break;
          await sleep(backoffMs(attempt, response));
          continue;
        }

        if (!response.ok || !response.body) {
          // Bad key, unknown model, malformed request: retrying changes nothing.
          const detail = await response.text().catch(() => "");
          console.error(`ask: ${spec.name} failed ${response.status} ${detail.slice(0, 300)}`);
          break;
        }

        console.log(`ask: served by ${spec.name} (${spec.model})`);
        return { provider: spec.name, model: spec.model, tokens: readSse(response.body, spec.delta) };
      } catch (error) {
        consecutiveFailures += 1;
        console.warn(`ask: ${spec.name} unreachable — ${error instanceof Error ? error.message : error}`);
        if (attempt === MAX_ATTEMPTS - 1) break;
        if (!isLast && consecutiveFailures >= SWITCH_AFTER) break;
        await sleep(backoffMs(attempt));
      }
    }

    if (!isLast) console.warn(`ask: falling back from ${spec.name}`);
  }

  console.error("ask: every provider failed");
  return null;
}
