/**
 * Embedding constants, kept apart from the implementation so callers can read them without
 * pulling onnxruntime into their module graph. lib/embed.mts re-exports them.
 */

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;
/** Inputs longer than this are truncated by the model. See the CEILING note in .env.example. */
export const EMBEDDING_MAX_TOKENS = 256;
