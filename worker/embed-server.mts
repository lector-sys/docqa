/**
 * Tiny HTTP front door on the worker, so the ask endpoint doesn't have to load the embedding
 * model itself.
 *
 * A cold serverless instance would otherwise fetch ~90 MB before it could answer anything, and
 * `/tmp` doesn't survive between instances — on a low-traffic demo that means the *first*
 * question a visitor asks is the one that stalls. The worker already holds the model resident.
 */

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { EMBEDDING_DIMENSIONS, embedTexts } from "../lib/embed.mts";

const MAX_BODY_BYTES = 32 * 1024;

function authorised(header: string | undefined, secret: string): boolean {
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  // Length must be compared separately; timingSafeEqual throws on a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    stream.on("data", (part: Buffer) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        return;
      }
      parts.push(part);
    });
    stream.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    stream.on("error", reject);
  });
}

/**
 * Starts the embed endpoint. Returns without listening if no secret is configured, so a purely
 * local setup can run the worker without one.
 */
export function startEmbedServer(log: (message: string) => void) {
  const secret = process.env.WORKER_EMBED_TOKEN;
  const port = Number(process.env.PORT) || 8080;

  if (!secret) {
    log("WORKER_EMBED_TOKEN not set — embed endpoint disabled, the app will embed in-process");
    return;
  }

  const server = createServer(async (req, res) => {
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && req.url === "/health") return json(200, { ok: true });

    if (req.method !== "POST" || req.url !== "/embed") return json(404, { error: "not found" });

    if (!authorised(req.headers.authorization, secret)) {
      return json(401, { error: "unauthorized" });
    }

    try {
      const body = JSON.parse(await readBody(req));
      const text = body?.text;
      if (typeof text !== "string" || !text.trim()) {
        return json(400, { error: "text is required" });
      }

      const [vector] = await embedTexts([text.slice(0, 4000)]);
      if (vector?.length !== EMBEDDING_DIMENSIONS) {
        return json(500, { error: "embedding failed" });
      }
      return json(200, { vector });
    } catch (error) {
      console.error("embed endpoint failed", error);
      return json(400, { error: "bad request" });
    }
  });

  server.listen(port, () => log(`embed endpoint listening on :${port}`));
  return server;
}
