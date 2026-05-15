/**
 * Document chunker for embedding generation.
 *
 * Goals:
 *   - Produce chunks of ~500 tokens (≈2000 characters) for embedding
 *   - Preserve paragraph boundaries where possible — embeddings are
 *     much better when chunks are semantically coherent
 *   - Include ~50 tokens of overlap (≈200 chars) between adjacent
 *     chunks so context-spanning concepts aren't lost
 *
 * Why tokenizer-free heuristic:
 *   We could pull in a tokenizer (tiktoken etc.) to count tokens
 *   precisely, but for chunking purposes char-count is good enough
 *   (1 token ≈ 4 chars for English legal prose). The accuracy
 *   matters when we send to the embedding API — both OpenAI and
 *   Voyage handle a wide range of chunk sizes well, so being off by
 *   ±20% on token count has no practical impact.
 */

const TARGET_CHARS = 2000;        // ~500 tokens
const OVERLAP_CHARS = 200;        // ~50 tokens
const HARD_MAX_CHARS = 3000;      // never exceed this in a single chunk

export interface Chunk {
  /** 0-indexed position within the source document */
  index: number;
  /** The chunk text */
  text: string;
  /** Character offset in the original document where this chunk starts */
  startOffset: number;
  /** Character offset in the original document where this chunk ends */
  endOffset: number;
}

/**
 * Split text into overlapping chunks suitable for embedding.
 *
 * Strategy:
 *   1. Split on double-newline (paragraph) boundaries first
 *   2. Greedily accumulate paragraphs until ~TARGET_CHARS
 *   3. If a single paragraph is >HARD_MAX_CHARS, split it on sentence
 *      boundaries (`. `, `? `, `! `)
 *   4. Add OVERLAP_CHARS of trailing context from each chunk to the
 *      start of the next, so concepts spanning chunk boundaries are
 *      still retrievable
 */
export function chunkText(text: string): Chunk[] {
  const normalised = text.replace(/\r\n/g, '\n').trim();
  if (normalised.length === 0) return [];

  // Pass 1: split into paragraphs (blank-line separated)
  const paragraphs = normalised
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Pass 2: for any paragraph that exceeds HARD_MAX_CHARS, split on
  // sentence boundaries. We use a simple regex — legal text breaks
  // sentences with `. `, `? `, `! ` followed by an uppercase letter
  // or a digit. False splits inside abbreviations are acceptable
  // here — embeddings degrade gracefully.
  const units: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= HARD_MAX_CHARS) {
      units.push(para);
    } else {
      // Split on sentence-ish boundaries
      const sentences = para.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [para];
      // Pack sentences into HARD_MAX_CHARS windows
      let buf = '';
      for (const s of sentences) {
        if (buf.length + s.length > HARD_MAX_CHARS) {
          if (buf) units.push(buf.trim());
          buf = s;
        } else {
          buf += s;
        }
      }
      if (buf.trim()) units.push(buf.trim());
    }
  }

  // Pass 3: greedily pack units into target-sized chunks with offsets
  const chunks: Chunk[] = [];
  let buffer = '';
  let bufferStartOffset = 0;
  let cursor = 0;
  // Re-locate offsets by searching the normalised text for each unit
  // in order (units are non-overlapping subsequences of the text).
  for (const unit of units) {
    const unitOffset = normalised.indexOf(unit, cursor);
    const unitStart = unitOffset >= 0 ? unitOffset : cursor;
    cursor = unitStart + unit.length;

    if (buffer.length === 0) {
      bufferStartOffset = unitStart;
      buffer = unit;
      continue;
    }

    if (buffer.length + 2 + unit.length <= TARGET_CHARS) {
      buffer += '\n\n' + unit;
    } else {
      // Flush the current buffer as a chunk
      chunks.push({
        index: chunks.length,
        text: buffer,
        startOffset: bufferStartOffset,
        endOffset: bufferStartOffset + buffer.length,
      });
      // Start a new buffer with overlap from the tail of the previous
      const overlapTail = buffer.slice(Math.max(0, buffer.length - OVERLAP_CHARS));
      buffer = overlapTail + '\n\n' + unit;
      bufferStartOffset = unitStart - overlapTail.length - 2;
    }
  }
  if (buffer.length > 0) {
    chunks.push({
      index: chunks.length,
      text: buffer,
      startOffset: bufferStartOffset,
      endOffset: bufferStartOffset + buffer.length,
    });
  }

  return chunks;
}

/**
 * Approximate token count for a string (English heuristic: 4 chars / token).
 * Useful for tracking input volumes against API quotas. Not exact —
 * if you need precise counts, use a real tokenizer.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
