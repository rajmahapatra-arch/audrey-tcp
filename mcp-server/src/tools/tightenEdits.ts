/**
 * tighten_edits — deterministic surgical-markup service.
 *
 * The model sends its planned document edits as (old_text, new_text)
 * pairs, as wide as it likes; this tool returns the minimal word-level
 * replacements to stage instead. Pure function: no DB, no model calls,
 * no firm context needed. See ../editing/wordDiff.ts for the engine
 * and the field evidence that motivated it.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { tightenPair, tokenize } from '../editing/wordDiff.js';

const text = (s: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(s) }],
});

const MAX_PAIRS = 20;
const MAX_TOKENS_PER_SIDE = 2000; // paragraph-scale; keeps the LCS table small

export const tightenEditsTool: Tool = {
  name: 'tighten_edits',
  description:
    'ALWAYS call this before staging or applying tracked-change edits to a document. ' +
    'Converts wide (old_text, new_text) pairs into minimal word-level replacements so ' +
    'redlines are surgical — one changed word produces a one-word redline, the way a ' +
    'senior lawyer marks up. Send all planned edits in one call; stage the returned ' +
    'pairs instead of your originals.',
  inputSchema: {
    type: 'object',
    required: ['pairs'],
    properties: {
      pairs: {
        type: 'array',
        description: 'Your planned edits, each as the full old and new text (any width).',
        items: {
          type: 'object',
          required: ['old_text', 'new_text'],
          properties: {
            old_text: { type: 'string', description: 'Text as it currently reads.' },
            new_text: { type: 'string', description: 'Text as it should read.' },
          },
        },
      },
      context_words: {
        type: 'integer',
        minimum: 1,
        maximum: 6,
        description:
          'Unchanged words kept on each side of a change for anchoring (default 2). ' +
          'Raise if an apply step reports an ambiguous / duplicate anchor.',
      },
    },
  },
};

const Input = z.object({
  pairs: z
    .array(
      z.object({
        old_text: z.string().min(1).max(50_000),
        new_text: z.string().max(50_000),
      })
    )
    .min(1)
    .max(MAX_PAIRS),
  context_words: z.number().int().min(1).max(6).optional(),
});

export async function handleTightenEdits(args: unknown) {
  const parsed = Input.safeParse(args);
  if (!parsed.success) {
    return text({ error: parsed.error.message });
  }

  const contextWords = parsed.data.context_words ?? 2;
  const results = parsed.data.pairs.map((pair, index) => {
    if (
      tokenize(pair.old_text).length > MAX_TOKENS_PER_SIDE ||
      tokenize(pair.new_text).length > MAX_TOKENS_PER_SIDE
    ) {
      return {
        pair_index: index,
        error:
          `Pair exceeds ${MAX_TOKENS_PER_SIDE} words per side. Split the edit into ` +
          'smaller sections (e.g. per clause) and call again.',
      };
    }
    const r = tightenPair(pair.old_text, pair.new_text, contextWords);
    return {
      pair_index: index,
      unchanged: r.unchanged,
      edits: r.edits,
      stats: r.stats,
    };
  });

  return text({
    results,
    note:
      'Stage each returned edit as its own tracked change, in order. If an apply step ' +
      'reports an anchor matching more than once, re-run with a higher context_words.',
  });
}
