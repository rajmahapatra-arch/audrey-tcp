/**
 * Document handoff tool — per-document conversational memory.
 *
 * Claude for Word doesn't persist context between sessions on the same
 * document. The lawyer opens a contract today, talks through twenty
 * turns of analysis with Audrey, closes Word, and tomorrow comes back
 * to a Claude that knows nothing about the prior session. This tool
 * bridges that gap by storing a 2–5 sentence handoff per document and
 * serving it back when the same doc is opened again.
 *
 * One tool, two actions:
 *   - action="get"    — at conversation start, retrieve any prior
 *                       handoff for this doc so Claude can recap.
 *   - action="update" — at conversation end or every ~10 turns, save a
 *                       fresh handoff capturing what was discussed,
 *                       decided, and what's still pending.
 *
 * Doc matching strategy (v1, loose-tuple):
 *   We deliberately do NOT use cryptographic hashing of the body. A
 *   single typo fix between sessions would invalidate a content hash
 *   and lose the handoff — defeating the whole point. Instead we match
 *   on:
 *     - normalised filename (lowercase, version-suffix stripped)
 *     - paragraph_count (with tolerance)
 *     - word_count (with tolerance)
 *
 *   Renames following common patterns ("v3", "(2)", "_final") are
 *   normalised away. Small edits (typos, single-sentence rewrites)
 *   stay well within tolerance. Heavy restructuring (50% rewrite) is
 *   meant to miss — that's a genuinely different draft.
 *
 *   V2 will add MinHash sketches for content-similarity matching when
 *   v1 misses turn out to be common.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Service client (lazy singleton; same pattern as sessionTools)
// ============================================================

let serviceClient: SupabaseClient | null | undefined;
function getServiceClient(): SupabaseClient | null {
  if (serviceClient !== undefined) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    serviceClient = null;
    return null;
  }
  serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}

const text = (s: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(s) }],
});

// ============================================================
// Title normalisation
// ============================================================
//
// Goal: collapse cosmetic naming variations of the same document.
// Common patterns we want to ignore:
//   - "Contract v3.docx" vs "contract.docx"
//   - "NDA (2).docx" vs "NDA.docx"
//   - "Agreement_final.docx" vs "Agreement.docx"
//   - "Order Form_DRAFT.docx" vs "Order Form.docx"
// Patterns we keep:
//   - Substantive name changes ("Contract" vs "Amendment 1") — these
//     should NOT collapse, they're different documents conceptually.

export function normaliseDocTitle(raw: string): string {
  let s = raw.toLowerCase().trim();

  // Strip Office file extensions (we don't care .docx vs .doc).
  s = s.replace(/\.(docx?|dotx?|rtf)$/i, '');

  // Iteratively strip trailing version markers. Run multiple passes so
  // "Contract_final_v3 (2)" collapses through "_v3 (2)" then " (2)"
  // then trailing whitespace.
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s
      .replace(/\s*\([0-9]+\)\s*$/, '') // " (2)", " (12)"
      .replace(/[\s_-]*v\d+(\.\d+)*\s*$/i, '') // "_v3", " v1.2", "-V10"
      .replace(/[\s_-]*(final|draft|signed|executed|clean|redline|markup|wip)\s*$/i, '');
    if (s === before) break;
  }

  // Collapse internal whitespace and remove leading/trailing.
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

// ============================================================
// Match scoring
// ============================================================
//
// Given a candidate handoff row and the incoming doc signals, score
// how close a match it is. Lower score = closer match.

interface DocSignals {
  paragraph_count: number;
  word_count: number;
}

interface HandoffRow {
  id: string;
  doc_title: string;
  doc_title_normalised: string;
  paragraph_count: number;
  word_count: number;
  summary: string;
  turn_count: number;
  last_active: string;
}

type Confidence = 'exact' | 'close' | 'loose';

interface ScoredMatch {
  row: HandoffRow;
  paragraphDelta: number; // absolute
  wordDeltaPct: number; // 0-1
  confidence: Confidence;
}

function scoreMatch(row: HandoffRow, sig: DocSignals): ScoredMatch | null {
  const paragraphDelta = Math.abs(row.paragraph_count - sig.paragraph_count);
  const wordDelta = Math.abs(row.word_count - sig.word_count);
  // Pct of the larger of the two so symmetric and well-behaved when one is 0.
  const wordDeltaPct =
    Math.max(row.word_count, sig.word_count) === 0
      ? 0
      : wordDelta / Math.max(row.word_count, sig.word_count);

  // Exact: paragraphs identical, word_count within 1%.
  if (paragraphDelta === 0 && wordDeltaPct <= 0.01) {
    return { row, paragraphDelta, wordDeltaPct, confidence: 'exact' };
  }

  // Close: paragraphs within ±2 (or ±10%, whichever is larger), word
  // count within ±5% (or ±20 words on small docs).
  const paragraphTolerance = Math.max(2, Math.ceil(sig.paragraph_count * 0.1));
  const wordToleranceAbs = Math.max(20, sig.word_count * 0.05);
  if (paragraphDelta <= paragraphTolerance && wordDelta <= wordToleranceAbs) {
    return { row, paragraphDelta, wordDeltaPct, confidence: 'close' };
  }

  // Loose: same normalised title but sizes have drifted. Still useful
  // — Claude can ask the user "is this the same doc as last week?"
  // and let them confirm. Cap at 50% word drift; beyond that it's
  // clearly a different doc that happens to share a normalised name.
  if (wordDeltaPct <= 0.5) {
    return { row, paragraphDelta, wordDeltaPct, confidence: 'loose' };
  }

  return null;
}

// ============================================================
// Tool definition
// ============================================================

export const documentHandoffTool: Tool = {
  name: 'audrey_document_handoff',
  description:
    'Per-document memory across sessions. action="get": call silently at the start of any ' +
    "document conversation; returns the prior session's summary with match confidence. " +
    'action="update": call silently at session end (or every ~10 turns) with a 2-5 sentence ' +
    'recap of what was discussed, decided, and pending. Matching tolerates small edits and renames.',
  inputSchema: {
    type: 'object',
    required: ['action', 'doc_title', 'paragraph_count', 'word_count'],
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'update'],
        description: '"get" to retrieve any prior handoff; "update" to save a fresh one.',
      },
      doc_title: {
        type: 'string',
        description:
          'The document filename as shown in Word, e.g. "SOW 2026 002 - Amendment 1 (2).docx".',
      },
      paragraph_count: {
        type: 'integer',
        minimum: 0,
        description: 'Paragraph count from Claude for Word\'s doc_state.',
      },
      word_count: {
        type: 'integer',
        minimum: 0,
        description: 'Approximate word count from Claude for Word\'s doc_state.',
      },
      summary: {
        type: 'string',
        description:
          'Required for action="update". 2–5 sentences covering what was discussed, ' +
          'what was decided, what\'s pending, and any user-flagged remembers. Write ' +
          'as if briefing the next session\'s Claude, not the user.',
      },
      turn_count: {
        type: 'integer',
        minimum: 0,
        description:
          'Optional for action="update". Number of substantive turns so far in the ' +
          'current session. Helpful context for the next session.',
      },
    },
  },
};

// ============================================================
// Input validation
// ============================================================

const GetInput = z.object({
  action: z.literal('get'),
  doc_title: z.string().min(1).max(500),
  paragraph_count: z.number().int().min(0),
  word_count: z.number().int().min(0),
});

const UpdateInput = z.object({
  action: z.literal('update'),
  doc_title: z.string().min(1).max(500),
  paragraph_count: z.number().int().min(0),
  word_count: z.number().int().min(0),
  summary: z.string().min(1).max(4000),
  turn_count: z.number().int().min(0).optional(),
});

const Input = z.discriminatedUnion('action', [GetInput, UpdateInput]);

// ============================================================
// Handler
// ============================================================

export async function handleDocumentHandoff(
  args: unknown,
  firmId: string,
  userId: string | null
) {
  const parsed = Input.safeParse(args);
  if (!parsed.success) {
    return text({ error: parsed.error.message });
  }

  const db = getServiceClient();
  if (!db) {
    // Stub mode — surface a friendly null so Claude can proceed without
    // a handoff rather than erroring the whole tool call.
    if (parsed.data.action === 'get') {
      return text({ found: false, reason: 'handoff store not configured' });
    }
    return text({
      saved: false,
      reason: 'handoff store not configured — operator should set SUPABASE_SERVICE_ROLE_KEY',
    });
  }

  const normalised = normaliseDocTitle(parsed.data.doc_title);

  if (parsed.data.action === 'get') {
    return handleGet(db, firmId, normalised, {
      paragraph_count: parsed.data.paragraph_count,
      word_count: parsed.data.word_count,
    });
  }

  return handleUpdate(db, firmId, userId, normalised, parsed.data);
}

// ----------------------------------------------------------------
// get
// ----------------------------------------------------------------

async function handleGet(
  db: SupabaseClient,
  firmId: string,
  normalised: string,
  sig: DocSignals
) {
  // Pull candidates with matching normalised title; we'll score
  // application-side. Limit defensively — we don't expect dozens of
  // versions per doc but a runaway loop could create them.
  const { data, error } = await db
    .from('document_handoffs')
    .select(
      'id, doc_title, doc_title_normalised, paragraph_count, word_count, summary, turn_count, last_active'
    )
    .eq('firm_id', firmId)
    .eq('doc_title_normalised', normalised)
    .order('last_active', { ascending: false })
    .limit(20);

  if (error) {
    return text({ error: `Lookup failed: ${error.message}` });
  }

  if (!data || data.length === 0) {
    return text({ found: false });
  }

  // Score each candidate; pick the best (lowest combined delta).
  const scored: ScoredMatch[] = [];
  for (const row of data as HandoffRow[]) {
    const m = scoreMatch(row, sig);
    if (m) scored.push(m);
  }

  if (scored.length === 0) {
    return text({ found: false, candidates_seen: data.length });
  }

  // Sort: exact > close > loose, then by combined delta within tier.
  const confidenceRank: Record<Confidence, number> = { exact: 0, close: 1, loose: 2 };
  scored.sort((a, b) => {
    const tier = confidenceRank[a.confidence] - confidenceRank[b.confidence];
    if (tier !== 0) return tier;
    const combinedA = a.paragraphDelta + a.wordDeltaPct * 100;
    const combinedB = b.paragraphDelta + b.wordDeltaPct * 100;
    return combinedA - combinedB;
  });

  const best = scored[0];
  return text({
    found: true,
    confidence: best.confidence,
    handoff: {
      doc_title: best.row.doc_title,
      summary: best.row.summary,
      last_active: best.row.last_active,
      turn_count: best.row.turn_count,
      paragraph_count_then: best.row.paragraph_count,
      word_count_then: best.row.word_count,
    },
    // Surface if there's ambiguity so Claude can hedge appropriately.
    other_candidates: scored.length > 1 ? scored.length - 1 : 0,
  });
}

// ----------------------------------------------------------------
// update — upsert by best match (or insert new)
// ----------------------------------------------------------------

async function handleUpdate(
  db: SupabaseClient,
  firmId: string,
  userId: string | null,
  normalised: string,
  args: z.infer<typeof UpdateInput>
) {
  // Find best existing match to update. Reuse get's matching logic so
  // we don't accidentally insert a duplicate after a small edit.
  const { data: candidates, error: lookupErr } = await db
    .from('document_handoffs')
    .select(
      'id, doc_title, doc_title_normalised, paragraph_count, word_count, summary, turn_count, last_active'
    )
    .eq('firm_id', firmId)
    .eq('doc_title_normalised', normalised)
    .order('last_active', { ascending: false })
    .limit(20);

  if (lookupErr) {
    return text({ error: `Pre-update lookup failed: ${lookupErr.message}` });
  }

  const sig = {
    paragraph_count: args.paragraph_count,
    word_count: args.word_count,
  };

  let matchRow: HandoffRow | null = null;
  for (const row of (candidates ?? []) as HandoffRow[]) {
    const scored = scoreMatch(row, sig);
    // For update, only collapse onto exact or close — loose matches
    // are too risky (might be a different draft on a similar name).
    if (scored && scored.confidence !== 'loose') {
      matchRow = row;
      break; // first close+exact wins (rows are sorted by recency)
    }
  }

  const nowIso = new Date().toISOString();
  const payload = {
    firm_id: firmId,
    doc_title: args.doc_title,
    doc_title_normalised: normalised,
    paragraph_count: args.paragraph_count,
    word_count: args.word_count,
    summary: args.summary,
    turn_count: args.turn_count ?? 0,
    last_active: nowIso,
    last_active_user_id: userId,
  };

  if (matchRow) {
    const { error: updErr } = await db
      .from('document_handoffs')
      .update(payload)
      .eq('id', matchRow.id)
      .eq('firm_id', firmId);
    if (updErr) {
      return text({ error: `Update failed: ${updErr.message}` });
    }
    return text({
      saved: true,
      created: false,
      handoff_id: matchRow.id,
    });
  }

  const { data: inserted, error: insErr } = await db
    .from('document_handoffs')
    .insert(payload)
    .select('id')
    .single();
  if (insErr) {
    return text({ error: `Insert failed: ${insErr.message}` });
  }
  return text({
    saved: true,
    created: true,
    handoff_id: inserted?.id,
  });
}
