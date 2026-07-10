/**
 * Document review service — backing logic for POST /api/review.
 *
 * The Audrey App taskpane sends the open document as bookmark-addressed
 * paragraphs ({id: '_audrey_p_<n>', text}). We review the draft against
 * the matter's recorded positions (settled + open) plus general drafting
 * quality, then run every model suggestion through the deterministic
 * wordDiff tighten step so the client's apply engine receives minimal,
 * anchor-safe (original, revised) pairs — each citing the paragraph
 * bookmark it belongs to.
 *
 * Trust model: this is an INTERNAL endpoint guarded by the shared
 * INTERNAL_API_KEY secret (enforced at the route in index.ts). Because
 * the caller is the legacy Audrey backend — not an end user — we derive
 * firm_id from the matter row itself via a service-role lookup instead
 * of requiring OAuth context. The repositories are still used for all
 * subsequent reads so firm scoping stays in one place.
 *
 * Anthropic client conventions mirror extraction/extractor.ts: raw
 * fetch against the Messages API with forced tool_use structured
 * output (tool_choice), so we never parse free-text JSON.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mattersRepository } from '../repositories/matters.js';
import { positionsRepository, type Position } from '../repositories/positions.js';
import { tightenPair, tokenize } from '../editing/wordDiff.js';
import { auditAsync } from '../audit.js';
import type { Matter } from '../types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929'; // mirrors extractor.ts; adjust to current at deploy time
const MAX_TOKENS = 8192;

const DEFAULT_MAX_EDITS = 12;
const MAX_EDITS_CAP = 25;

// ============================================================
// Input / output shapes
// ============================================================

export const ReviewInputSchema = z.object({
  matter_id: z.string().uuid().optional(),
  document_name: z.string().optional(),
  paragraphs: z
    .array(
      z.object({
        /** Taskpane bookmark id, e.g. '_audrey_p_12' — echoed back on every edit. */
        id: z.string().min(1),
        text: z.string(),
      })
    )
    .min(1),
  max_edits: z.number().int().min(1).max(MAX_EDITS_CAP).optional(),
  dry_run: z.boolean().optional(),
});

export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export type ReviewSeverity = 'high' | 'medium' | 'low';

export interface ReviewEdit {
  /** Short unique id for the client edit pool. */
  id: string;
  /** The paragraph bookmark the edit anchors to (input paragraph id). */
  bookmark: string;
  /** Verbatim substring of the bookmarked paragraph (tightened). */
  original: string;
  /** Drop-in replacement for `original`. */
  revised: string;
  /** Lawyer-readable margin comment (the suggestion's rationale). */
  comment: string;
  severity: ReviewSeverity;
  /** clause_type of the recorded position this edit enforces, if any. */
  position_ref: string | null;
}

export interface ReviewStats {
  suggestions: number;
  dropped_unverifiable: number;
  edits_after_tighten: number;
  dry_run?: boolean;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ReviewResult {
  edits: ReviewEdit[];
  stats: ReviewStats;
}

/** Error carrying the HTTP status the route should respond with. */
export class ReviewError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

// ============================================================
// Service-role client — firm_id derivation only.
//
// Same lazy-singleton pattern as positions.ts / audit.ts. This is the
// one internal-trust read this endpoint performs (see module header);
// everything after goes through the firm-scoped repositories.
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

interface MatterContext {
  firmId: string | null;
  matter: Matter | null;
  positions: Position[];
}

async function loadMatterContext(matterId: string): Promise<MatterContext> {
  const db = getServiceClient();
  if (!db) {
    throw new ReviewError(
      503,
      'matter store not configured — set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, or omit matter_id'
    );
  }

  const { data, error } = await db
    .from('matters')
    .select('id, firm_id')
    .eq('id', matterId)
    .maybeSingle();

  if (error) {
    console.error('[audrey-review] firm_id lookup failed:', error.message);
    throw new ReviewError(500, `failed to resolve matter: ${error.message}`);
  }
  if (!data) {
    throw new ReviewError(404, 'matter not found');
  }

  const firmId = (data as { firm_id?: string | null }).firm_id ?? null;
  if (!firmId) {
    // Legacy rows pre-dating firm backfill: degrade to a matter-less
    // (drafting-quality only) review rather than failing the button.
    console.warn(
      `[audrey-review] matter ${matterId} has no firm_id — reviewing without matter context`
    );
    return { firmId: null, matter: null, positions: [] };
  }

  const matter = await mattersRepository.findById(firmId, matterId);
  const positions = matter
    ? await positionsRepository.listActive(firmId, matterId)
    : [];
  return { firmId, matter, positions };
}

// ============================================================
// Anthropic call — mirrors extractor.ts (forced tool_use output)
// ============================================================

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new ReviewError(
      503,
      'ANTHROPIC_API_KEY is required for document review. Set it in the ' +
        'server env vars, or use dry_run=true to test plumbing without a model call.'
    );
  }
  return key;
}

interface RawSuggestion {
  paragraph_id: string;
  original: string;
  revised: string;
  rationale: string;
  severity: ReviewSeverity;
  position_ref?: string | null;
}

function reportEditsTool(maxEdits: number) {
  return {
    name: 'report_edits',
    description:
      'Report your suggested edits to the draft. Call this exactly once with the ' +
      `complete list (up to ${maxEdits} suggestions). Pass an empty array if the ` +
      'draft needs no changes.',
    input_schema: {
      type: 'object',
      properties: {
        suggestions: {
          type: 'array',
          description: `Up to ${maxEdits} suggested edits, most important first.`,
          items: {
            type: 'object',
            required: ['paragraph_id', 'original', 'revised', 'rationale', 'severity'],
            properties: {
              paragraph_id: {
                type: 'string',
                description:
                  'The id of the paragraph being edited, exactly as given in the ' +
                  'input (e.g. "_audrey_p_12").',
              },
              original: {
                type: 'string',
                description:
                  'A VERBATIM substring of that paragraph — copy the exact characters, ' +
                  'including spacing and punctuation. The edit is discarded server-side ' +
                  'if this text does not appear verbatim in the cited paragraph.',
              },
              revised: {
                type: 'string',
                description:
                  'The replacement text. Must read as a drop-in substitute for `original` ' +
                  'in its position in the sentence.',
              },
              rationale: {
                type: 'string',
                description:
                  'One or two sentences a lawyer will read as a margin comment explaining ' +
                  'why the change is needed. Reference the recorded position when applicable.',
              },
              severity: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description:
                  "'high' = contradicts a settled position or creates real legal risk; " +
                  "'medium' = undermines an open position or a meaningful drafting problem; " +
                  "'low' = clarity / style improvement.",
              },
              position_ref: {
                type: 'string',
                description:
                  'clause_type of the settled/open position this edit enforces ' +
                  '(e.g. "liability_cap"). Omit for pure drafting-quality edits.',
              },
            },
          },
        },
      },
      required: ['suggestions'],
    },
  };
}

const SYSTEM_PROMPT = [
  "You are Audrey's document-review engine: a senior commercial lawyer reviewing a",
  "colleague's draft before it goes out. You receive the draft as a list of",
  "paragraphs, each with a stable id, plus the matter's recorded positions",
  '(settled and open) when available.',
  '',
  'Propose edits that:',
  "  1. bring the draft in line with the matter's settled positions — severity",
  '     high when the draft contradicts one;',
  '  2. protect or advance open positions still under negotiation — severity medium;',
  '  3. fix genuine drafting problems: ambiguity, undefined or inconsistently used',
  '     terms, internal contradictions, unusually one-sided boilerplate — severity',
  '     medium or low.',
  '',
  'Hard rules:',
  '- `original` MUST be copied verbatim from the cited paragraph. Do not normalise',
  '  quotes, whitespace, or punctuation. Non-verbatim edits are discarded.',
  '- Keep each edit to the smallest span that reads naturally — a clause or a',
  '  sentence, never a whole paragraph.',
  '- `revised` must be a drop-in replacement for `original`.',
  '- Do not invent facts, figures, parties, or terms that the matter context does',
  '  not support. If you are unsure a change is right, leave it out.',
  '- Skip headings, party blocks, and signature boilerplate unless genuinely wrong.',
  '- Set position_ref to the clause_type when an edit enforces a recorded position.',
  '- Call report_edits exactly once. If the draft needs no changes, report an',
  '  empty suggestions array — do not fabricate work.',
].join('\n');

function formatPositionLine(p: {
  clauseType: string;
  value: unknown;
  status?: string;
  partyRole?: string | null;
  counterpartyName?: string | null;
}): string {
  const tags = [p.status, p.partyRole].filter(Boolean).join(', ');
  const cp = p.counterpartyName ? ` (counterparty: ${p.counterpartyName})` : '';
  return `- ${p.clauseType}${tags ? ` [${tags}]` : ''}: ${JSON.stringify(p.value)}${cp}`;
}

function buildUserContent(
  input: ReviewInput,
  matter: Matter | null,
  positions: Position[],
  maxEdits: number
): string {
  const parts: string[] = [];

  if (matter) {
    const header: string[] = ['Matter context:'];
    if (matter.matterName) header.push(`Matter: ${matter.matterName}`);
    if (matter.clientName) header.push(`Client (we represent): ${matter.clientName}`);
    header.push(`Matter type: ${matter.matterType}`);
    header.push(`Stage: ${matter.stage}`);
    parts.push(header.join('\n'));

    // Merge positions-table rows with the flat columns the matter row
    // carries (e.g. governing_law), preferring the positions table.
    const byClause = new Map<string, string>();
    for (const sp of matter.settledPositions) {
      byClause.set(
        sp.clauseType,
        formatPositionLine({ clauseType: sp.clauseType, value: sp.currentValue, status: 'settled' })
      );
    }
    const settled = positions.filter((p) => p.status === 'settled');
    const open = positions.filter((p) => p.status !== 'settled');
    for (const p of settled) {
      byClause.set(
        p.clauseType,
        formatPositionLine({
          clauseType: p.clauseType,
          value: p.value,
          status: p.status,
          partyRole: p.partyRole,
          counterpartyName: p.counterpartyName,
        })
      );
    }

    parts.push(
      byClause.size > 0
        ? `Settled positions (the draft must respect these):\n${[...byClause.values()].join('\n')}`
        : 'Settled positions: none recorded.'
    );
    parts.push(
      open.length > 0
        ? `Open positions (under negotiation — protect these):\n${open
            .map((p) =>
              formatPositionLine({
                clauseType: p.clauseType,
                value: p.value,
                status: p.status,
                partyRole: p.partyRole,
                counterpartyName: p.counterpartyName,
              })
            )
            .join('\n')}`
        : 'Open positions: none recorded.'
    );
  } else {
    parts.push(
      'No matter context available — review for general drafting quality only.'
    );
  }

  if (input.document_name) {
    parts.push(`Document: ${input.document_name}`);
  }

  parts.push(`Suggest at most ${maxEdits} edits.`);

  const paras = input.paragraphs
    .map((p) => `[${p.id}] ${p.text}`)
    .join('\n\n');
  parts.push(`Draft paragraphs (cite paragraph_id exactly as given):\n\n${paras}`);

  return parts.join('\n\n---\n\n');
}

function validSeverity(s: unknown): s is ReviewSeverity {
  return s === 'high' || s === 'medium' || s === 'low';
}

function normaliseSuggestion(raw: Partial<RawSuggestion>): RawSuggestion | null {
  if (
    typeof raw.paragraph_id !== 'string' ||
    typeof raw.original !== 'string' ||
    typeof raw.revised !== 'string' ||
    raw.original.length === 0
  ) {
    return null;
  }
  return {
    paragraph_id: raw.paragraph_id,
    original: raw.original,
    revised: raw.revised,
    rationale: (raw.rationale ?? '').toString().slice(0, 1000) || 'Suggested revision.',
    severity: validSeverity(raw.severity) ? raw.severity : 'medium',
    position_ref:
      typeof raw.position_ref === 'string' && raw.position_ref.trim().length > 0
        ? raw.position_ref
        : null,
  };
}

async function requestSuggestions(
  input: ReviewInput,
  matter: Matter | null,
  positions: Position[],
  maxEdits: number
): Promise<{ suggestions: RawSuggestion[]; usage: { input_tokens: number; output_tokens: number } }> {
  const apiKey = getApiKey();

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [reportEditsTool(maxEdits)],
      tool_choice: { type: 'tool', name: 'report_edits' },
      messages: [
        { role: 'user', content: buildUserContent(input, matter, positions, maxEdits) },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ReviewError(
      502,
      `Anthropic review HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const json = (await response.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const toolUse = json.content.find(
    (c) => c.type === 'tool_use' && c.name === 'report_edits'
  );
  const parsed = (toolUse?.input ?? {}) as { suggestions?: Array<Partial<RawSuggestion>> };
  const raw = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

  const suggestions = raw
    .map(normaliseSuggestion)
    .filter((s): s is RawSuggestion => s !== null);

  return { suggestions, usage: json.usage };
}

// ============================================================
// Dry run — exercises validate + tighten + response shaping with
// no model call, so the full HTTP → proxy → taskpane plumbing can
// be tested without any API keys.
// ============================================================

function fabricateDryRunSuggestions(
  paragraphs: ReviewInput['paragraphs']
): RawSuggestion[] {
  for (const p of paragraphs) {
    const tokens = tokenize(p.text);
    if (tokens.length <= 10) continue;

    // original = the paragraph's first 8 words, sliced verbatim from the
    // source so exotic whitespace survives the substring check.
    const original = p.text.slice(tokens[0].start, tokens[7].end);
    const words = tokens.slice(0, 8).map((t) => t.text);
    words[4] = 'AUDREY-DRY-RUN';
    const revised = words.join(' ');

    return [
      {
        paragraph_id: p.id,
        original,
        revised,
        rationale: 'Dry-run plumbing check — fabricated edit, not a real suggestion.',
        severity: 'low',
        position_ref: null,
      },
    ];
  }
  return [];
}

// ============================================================
// Pipeline
// ============================================================

export async function runReview(input: ReviewInput): Promise<ReviewResult> {
  const maxEdits = Math.min(input.max_edits ?? DEFAULT_MAX_EDITS, MAX_EDITS_CAP);
  const paragraphById = new Map(input.paragraphs.map((p) => [p.id, p.text]));

  // 1. Matter context (internal trust: firm derived from the matter row)
  let firmId: string | null = null;
  let matter: Matter | null = null;
  let positions: Position[] = [];
  if (input.matter_id) {
    ({ firmId, matter, positions } = await loadMatterContext(input.matter_id));
  }

  // 2/3. Suggestions — fabricated (dry run) or from the model
  let suggestions: RawSuggestion[];
  let usage: ReviewStats['usage'];
  if (input.dry_run) {
    suggestions = fabricateDryRunSuggestions(input.paragraphs);
  } else {
    ({ suggestions, usage } = await requestSuggestions(input, matter, positions, maxEdits));
  }
  suggestions = suggestions.slice(0, maxEdits);

  // 4. Validate: paragraph exists AND original is verbatim in it
  const verified: RawSuggestion[] = [];
  let dropped = 0;
  for (const s of suggestions) {
    const text = paragraphById.get(s.paragraph_id);
    if (text === undefined || !text.includes(s.original)) {
      dropped += 1;
      continue;
    }
    verified.push(s);
  }

  // 5. Tighten each surviving suggestion into minimal anchor-safe pairs.
  //    tightenPair slices from the original strings, so every emitted
  //    old_text remains a verbatim substring of the cited paragraph.
  const edits: ReviewEdit[] = [];
  for (const s of verified) {
    const tightened = tightenPair(s.original, s.revised);
    if (tightened.unchanged) continue;
    for (const pair of tightened.edits) {
      edits.push({
        id: `rv_${edits.length + 1}_${randomUUID().slice(0, 4)}`,
        bookmark: s.paragraph_id,
        original: pair.old_text,
        revised: pair.new_text,
        comment: s.rationale,
        severity: s.severity,
        position_ref: s.position_ref ?? null,
      });
    }
  }

  const stats: ReviewStats = {
    suggestions: suggestions.length,
    dropped_unverifiable: dropped,
    edits_after_tighten: edits.length,
  };
  if (input.dry_run) stats.dry_run = true;
  if (usage) stats.usage = usage;

  auditAsync({
    firmId: firmId ?? 'internal',
    action: 'review.run',
    result: 'success',
    resourceType: 'matter',
    resourceId: input.matter_id ?? null,
    payload: {
      document_name: input.document_name ?? null,
      paragraphs: input.paragraphs.length,
      ...stats,
    },
  });

  return { edits, stats };
}
