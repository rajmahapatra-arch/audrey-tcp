/**
 * Embedding generation — OpenAI text-embedding-3-large @ 1536 dims.
 *
 * Why this configuration:
 *   - Your matter_memory.embedding column is sized vector(1536).
 *   - text-embedding-3-large natively returns 3072 dims, but the API
 *     accepts a `dimensions` parameter that returns a higher-quality
 *     reduction. Pinning to 1536 gives -3-large quality without
 *     changing the column type.
 *   - $0.13/1M tokens. Cheap relative to extraction costs.
 *
 * Swap to Voyage AI (voyage-law-2) later by changing only this file:
 *   - Endpoint: https://api.voyageai.com/v1/embeddings
 *   - Different request shape, different auth header
 *   - Voyage native dim is 1024 — would require column resize.
 *
 * Failure modes:
 *   - Missing OPENAI_API_KEY: throws at boot (intentional — embedding
 *     is mandatory for Stage B; we'd rather refuse to start than
 *     silently skip).
 *   - Rate limit / 5xx: retried with exponential backoff up to 3x.
 *   - Per-chunk failures (bad input): logged but don't fail the batch;
 *     we return null for that slot so the caller can decide.
 */

import { approxTokens } from './chunker.js';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const MODEL = 'text-embedding-3-large';
const DIMENSIONS = 1536;
const MAX_BATCH_SIZE = 100;       // OpenAI allows up to 2048 but smaller batches retry better
const MAX_RETRIES = 3;

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY is required for the extraction pipeline. ' +
        'Set it in Railway env vars before running document intake.'
    );
  }
  return key;
}

export interface EmbeddingResult {
  /** 1536-dim float vector */
  embedding: number[] | null;
  /** approximate tokens that would be billed */
  approxTokens: number;
  /** present when generation failed for this slot */
  error?: string;
}

/**
 * Embed an array of texts. Returns a parallel array of results in the
 * same order. Failed slots are null with an error string.
 *
 * Batched internally — caller can pass any number of texts.
 */
export async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const results: EmbeddingResult[] = new Array(texts.length);

  // Process in batches of MAX_BATCH_SIZE
  for (let offset = 0; offset < texts.length; offset += MAX_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + MAX_BATCH_SIZE);
    const batchResults = await embedSingleBatch(batch);
    for (let i = 0; i < batchResults.length; i++) {
      results[offset + i] = batchResults[i];
    }
  }

  return results;
}

async function embedSingleBatch(texts: string[]): Promise<EmbeddingResult[]> {
  const apiKey = getApiKey();

  let lastError: string | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          input: texts,
          dimensions: DIMENSIONS,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        lastError = `OpenAI embedding HTTP ${response.status}: ${body.slice(0, 200)}`;
        // 4xx: don't retry (likely malformed input)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          break;
        }
        // 5xx or 429: retry with backoff
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }

      const json = (await response.json()) as {
        data: Array<{ index: number; embedding: number[] }>;
        usage?: { total_tokens?: number };
      };

      // OpenAI returns embeddings in `data`, indexed by input order
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      const tokensPerInput =
        json.usage?.total_tokens
          ? Math.ceil(json.usage.total_tokens / texts.length)
          : 0;

      return texts.map((t, i): EmbeddingResult => {
        const item = sorted[i];
        if (!item || !Array.isArray(item.embedding)) {
          return {
            embedding: null,
            approxTokens: tokensPerInput || approxTokens(t),
            error: 'OpenAI returned no embedding for this input',
          };
        }
        return {
          embedding: item.embedding,
          approxTokens: tokensPerInput || approxTokens(t),
        };
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(500 * Math.pow(2, attempt));
    }
  }

  // All retries exhausted — return null for every slot
  console.error('[audrey-embed] batch failed after retries:', lastError);
  return texts.map((t) => ({
    embedding: null,
    approxTokens: approxTokens(t),
    error: lastError ?? 'unknown',
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The number of dimensions every embedding has. Caller uses this to
 * validate they're writing to a matching pgvector column.
 */
export const EMBEDDING_DIMS = DIMENSIONS;

/**
 * Model identifier to persist alongside the embedding (so we know
 * what produced it when re-ranking models later).
 */
export const EMBEDDING_MODEL = `${MODEL}@${DIMENSIONS}d`;
