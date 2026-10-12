/**
 * The single place embeddings are produced.
 *
 * The worker embeds chunks and the ask endpoint embeds questions. If those two ever disagree on
 * model, pooling, or normalisation, retrieval degrades with no error and no symptom other than
 * bad answers — so neither side is allowed its own copy of this configuration.
 */

import { env as transformersEnv, pipeline } from "@xenova/transformers";
import { EMBEDDING_MODEL } from "./embed-config.mts";

export { EMBEDDING_DIMENSIONS, EMBEDDING_MAX_TOKENS, EMBEDDING_MODEL } from "./embed-config.mts";

async function createExtractor() {
  transformersEnv.allowLocalModels = false;
  // Serverless filesystems are read-only apart from /tmp, so the default cache location
  // inside node_modules silently fails there.
  if (process.env.TRANSFORMERS_CACHE) transformersEnv.cacheDir = process.env.TRANSFORMERS_CACHE;
  return pipeline("feature-extraction", EMBEDDING_MODEL);
}

let loading: ReturnType<typeof createExtractor> | null = null;

/**
 * Loads the model once per process and reuses it. Call at startup to pay the cost up front;
 * calling it again is free.
 */
export function getEmbedder(): ReturnType<typeof createExtractor> {
  loading ??= createExtractor();
  return loading;
}

/**
 * Mean pooling + L2 normalisation, in sub-batches so peak memory stays flat.
 * Returns one 384-dimension vector per input, in order.
 */
export async function embedTexts(texts: string[], batchSize = 16): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getEmbedder();
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const output = await extractor(texts.slice(i, i + batchSize), {
      pooling: "mean",
      normalize: true,
    });
    vectors.push(...(output.tolist() as number[][]));
  }
  return vectors;
}

/** One question in, one vector out — the same way the chunks it will be compared to were made. */
export async function embedQuery(question: string): Promise<number[]> {
  const [vector] = await embedTexts([question]);
  return vector;
}
