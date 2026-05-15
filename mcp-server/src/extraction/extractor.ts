/**
 * Position extractor — Anthropic Claude API call that reads a
 * document and returns structured clause-level positions.
 *
 * Design notes:
 *   - Uses Claude's tool-use feature for guaranteed structured output.
 *     We define a tool `report_positions(positions: Position[])` and
 *     instruct the model to call it exactly once. The tool input
 *     schema enforces the shape; we never have to parse free-text
 *     JSON.
 *   - One call per document (not per chunk). The doc is sent whole
 *     up to Claude's context window. For documents longer than
 *     ~100K tokens we'd chunk-and-merge — out of scope for now,
 *     legal docs are almost always shorter.
 *   - The prompt is intentionally pragmatic about "what counts as a
 *     position": anything where one side has stated a value or
 *     stance on a clause type. Lists of common clause types are
 *     embedded in the prompt so the model gravitates toward the
 *     terms we already query against.
 *
 * Cost: ~$0.003 per 10K-token doc against Claude Sonnet. Cheap
 * compared to the value of populating the positions table.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929'; // adjust to current at deploy time
const MAX_TOKENS = 4096;

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for the extraction pipeline. ' +
        'Set it in Railway env vars before running document intake.'
    );
  }
  return key;
}

// ============================================================
// Position shape (mirrors positions table columns)
// ============================================================

export type PositionStatus = 'proposed' | 'open' | 'settled' | 'rejected';
export type PartyRole = 'our_side' | 'counterparty' | 'neutral' | 'mutual';

export interface ExtractedPosition {
  clause_type: string;
  value: Record<string, unknown>;   // structured value, e.g. {amount: '12 months fees'}
  status: PositionStatus;
  counterparty_name: string | null;
  party_role: PartyRole | null;
  source_chunk_text: string;        // verbatim excerpt from the doc
  confidence: number;               // 0..1
}

export interface ExtractionResult {
  positions: ExtractedPosition[];
  /** Raw tool input from Claude (for audit / debugging) */
  rawExtract: unknown;
  /** Token usage so callers can track cost */
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  /** The model identifier that produced this — persisted with each position */
  extracted_by: string;
}

// ============================================================
// Tool definition (the structured-output schema)
// ============================================================

const REPORT_POSITIONS_TOOL = {
  name: 'report_positions',
  description:
    'Report all clause-level positions you identified in the document. Call this exactly ' +
    'once with the complete list. Each position represents one party\'s stated value or stance ' +
    'on one type of clause.',
  input_schema: {
    type: 'object',
    properties: {
      positions: {
        type: 'array',
        description:
          'Every position you identified. Empty array if the document contains no ' +
          'identifiable positions (e.g. a cover page, signature block, or boilerplate).',
        items: {
          type: 'object',
          required: [
            'clause_type',
            'value',
            'status',
            'party_role',
            'source_chunk_text',
            'confidence',
          ],
          properties: {
            clause_type: {
              type: 'string',
              description:
                'A canonical, snake_case identifier for the clause type. Use one of these ' +
                'when applicable: liability_cap, ip_indemnity, ip_ownership, ' +
                'confidentiality, term_length, payment_terms, termination_for_convenience, ' +
                'termination_for_cause, governing_law, jurisdiction, dispute_resolution, ' +
                'warranties, exclusivity, non_compete, non_solicit, audit_rights, ' +
                'data_protection, change_control, assignment, force_majeure, ' +
                'limitation_of_liability, insurance, indemnification, sla, ' +
                'milestones, fees, credits, deliverables, scope. If none fit, invent a ' +
                'short snake_case identifier.',
            },
            value: {
              type: 'object',
              description:
                'Structured representation of the position. Use sensible keys like ' +
                '{amount: "12 months fees"}, {scope: "unlimited"}, {jurisdiction: "England and Wales"}, ' +
                '{period_months: 24}. Capture exact text the parties used where possible.',
              additionalProperties: true,
            },
            status: {
              type: 'string',
              enum: ['proposed', 'open', 'settled', 'rejected'],
              description:
                "'proposed' = a party put this forward in their draft; 'open' = under " +
                "active negotiation; 'settled' = agreed and not under discussion; " +
                "'rejected' = explicitly refused.",
            },
            party_role: {
              type: 'string',
              enum: ['our_side', 'counterparty', 'neutral', 'mutual'],
              description:
                "'our_side' = position held by the party we represent (client or co-counsel); " +
                "'counterparty' = position held by the other side; 'neutral' = factual / " +
                "structural clause (e.g. governing_law) with no clear party preference; " +
                "'mutual' = symmetric obligation both parties accept.",
            },
            counterparty_name: {
              type: ['string', 'null'],
              description:
                'Name of the counterparty if visible in the document, otherwise null. Use ' +
                'the form the document uses (e.g. "KBR", "Acme Inc.").',
            },
            source_chunk_text: {
              type: 'string',
              description:
                'A verbatim excerpt from the document (typically 1-3 sentences) showing ' +
                'where this position was stated. Used for provenance and audit.',
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description:
                '0.9-1.0: explicit and unambiguous. 0.6-0.9: clear but with minor inference. ' +
                '0.3-0.6: significant inference required. <0.3: speculative.',
            },
          },
        },
      },
    },
    required: ['positions'],
  },
};

// ============================================================
// Extraction
// ============================================================

export interface ExtractionContext {
  /** Helps the model orient — provide what you know */
  matterName?: string | null;
  clientName?: string | null;
  /** Who we represent — disambiguates 'our_side' tagging */
  ourSide?: string | null;
  /** Document type hint (e.g. 'msa', 'amendment', 'sow', 'nda') */
  documentType?: string | null;
}

const SYSTEM_PROMPT = [
  "You are Audrey's position-extraction engine. You read legal documents and identify ",
  'every clause-level position that one of the parties has taken.',
  '',
  'A "position" is a stated value or stance on a contract term. Examples:',
  '  - "Liability is capped at 12 months of fees" → liability_cap, value: {amount: "12 months fees"}',
  '  - "Governed by English law" → governing_law, value: {jurisdiction: "England and Wales"}',
  '  - "Each party indemnifies the other for IP claims arising from its own contributions" → ip_indemnity, value: {scope: "contributions only"}, party_role: "mutual"',
  '',
  'Capture every position you can identify. Be precise about value structure: use keyed ',
  "objects, not free text, so the firm can query them. If you're inferring rather than ",
  'reading explicitly, lower the confidence.',
  '',
  'Call the report_positions tool exactly once with the complete list. If the document ',
  'contains no identifiable positions (cover sheet, signature page, boilerplate), return ',
  'an empty array — do not fabricate.',
].join('\n');

/**
 * Extract structured positions from a document.
 *
 * Throws on infrastructure failures (missing API key, network error
 * after retries). Returns an empty positions array if the model
 * declined to identify any (which is a valid outcome for boilerplate
 * or signature pages).
 */
export async function extractPositions(
  documentText: string,
  context: ExtractionContext = {}
): Promise<ExtractionResult> {
  const apiKey = getApiKey();

  const userMessage = buildUserMessage(documentText, context);

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
      tools: [REPORT_POSITIONS_TOOL],
      tool_choice: { type: 'tool', name: 'report_positions' },
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic extraction HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  const json = (await response.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const toolUse = json.content.find(
    (c) => c.type === 'tool_use' && c.name === 'report_positions'
  );
  if (!toolUse || !toolUse.input) {
    return {
      positions: [],
      rawExtract: json.content,
      usage: json.usage,
      extracted_by: MODEL,
    };
  }

  const parsed = toolUse.input as { positions?: ExtractedPosition[] };
  const positions = Array.isArray(parsed.positions) ? parsed.positions : [];

  // Defensive: clamp confidence into [0,1], coerce missing fields
  const normalised = positions.map(normalisePosition);

  return {
    positions: normalised,
    rawExtract: toolUse.input,
    usage: json.usage,
    extracted_by: MODEL,
  };
}

function buildUserMessage(text: string, ctx: ExtractionContext): string {
  const header: string[] = [];
  if (ctx.matterName) header.push(`Matter: ${ctx.matterName}`);
  if (ctx.clientName) header.push(`Client: ${ctx.clientName}`);
  if (ctx.ourSide) header.push(`We represent: ${ctx.ourSide}`);
  if (ctx.documentType) header.push(`Document type: ${ctx.documentType}`);

  const ctxBlock = header.length > 0 ? `Context:\n${header.join('\n')}\n\n---\n\n` : '';

  return `${ctxBlock}Document to extract positions from:\n\n${text}`;
}

function normalisePosition(raw: Partial<ExtractedPosition>): ExtractedPosition {
  return {
    clause_type: (raw.clause_type ?? 'other').toString(),
    value: raw.value && typeof raw.value === 'object' ? raw.value : { raw: String(raw.value ?? '') },
    status: validStatus(raw.status) ? raw.status : 'open',
    counterparty_name:
      typeof raw.counterparty_name === 'string' ? raw.counterparty_name : null,
    party_role: validRole(raw.party_role) ? raw.party_role : null,
    source_chunk_text: (raw.source_chunk_text ?? '').toString().slice(0, 2000),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
  };
}

function validStatus(s: unknown): s is PositionStatus {
  return s === 'proposed' || s === 'open' || s === 'settled' || s === 'rejected';
}

function validRole(r: unknown): r is PartyRole {
  return r === 'our_side' || r === 'counterparty' || r === 'neutral' || r === 'mutual';
}

export const EXTRACTION_MODEL = MODEL;
