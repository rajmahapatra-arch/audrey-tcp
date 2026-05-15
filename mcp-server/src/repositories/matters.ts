/**
 * Matters repository — the data access layer for matters.
 *
 * Architecture discipline (DO NOT VIOLATE):
 *   - This file is the ONLY place that decides how to reach matter data.
 *   - Tool handlers MUST call mattersRepository.X, never Supabase directly.
 *   - All methods take firmId as their first parameter so the routing
 *     layer (shared vs dedicated instance) can dispatch correctly.
 *
 * Schema notes:
 *   The existing Audrey backend's `matters` table predates Audrey TCP's
 *   firm-keyed multi-tenancy. Migration 006 added `firm_id`, `stage`,
 *   `privilege_scope` and backfilled them from `firm_users`. The
 *   columns we now read from `matters` are:
 *
 *     id (uuid), user_id (uuid), firm_id (uuid, added in 006),
 *     client_id (uuid), client_name (text), matter_name (text),
 *     governing_law (text), parties (jsonb), deal_parameters (jsonb),
 *     context (jsonb), created_at (timestamptz), last_accessed (timestamptz),
 *     archived (boolean), stage (text, added in 006),
 *     privilege_scope (text, added in 006)
 */

import { getSupabase, isSupabaseConfigured } from '../db/supabase.js';
import type {
  Matter,
  MatterParty,
  MatterStage,
  PrivilegeScope,
} from '../types.js';

// ============================================================
// Stub fixtures — used when Supabase env vars are not set, or
// when the matter id maps to a known stub for local development.
// ============================================================

const STUB_MATTERS: Record<string, Matter> = {
  '00000000-0000-0000-0000-000000000001': {
    id: '00000000-0000-0000-0000-000000000001',
    firmId: 'stub-firm-id',
    clientId: 'stub-client-acme',
    matterName: 'Acme MSA negotiation',
    clientName: 'Acme Corp',
    matterType: 'msa',
    stage: 'in_negotiation',
    privilegeScope: 'privileged',
    openedAt: '2026-01-15T00:00:00Z',
    closedAt: null,
    parties: [
      { partyId: 'stub-client-acme', kind: 'client', role: 'customer' },
      {
        partyId: 'stub-cp-behemoth',
        kind: 'counterparty',
        role: 'supplier',
      },
    ],
    openPositions: [
      {
        clauseType: 'liability_cap',
        currentValue: '12 months fees',
        history:
          'Counterparty asked 6 months; we countered 24; settling around 12.',
      },
    ],
    settledPositions: [
      {
        clauseType: 'governing_law',
        currentValue: 'England and Wales',
      },
    ],
    state: {
      currentDraftVersion: 3,
      lastExchange: '2026-02-08T14:30:00Z',
    },
  },
};

// ============================================================
// Row → domain mappers
// ============================================================

interface MatterRow {
  id: string;
  firm_id: string | null;
  user_id: string | null;
  client_id: string | null;
  client_name: string | null;
  matter_name: string | null;
  governing_law: string | null;
  parties: unknown;
  deal_parameters: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  created_at: string | null;
  last_accessed: string | null;
  archived: boolean | null;
  stage: string | null;
  privilege_scope: string | null;
}

/** Normalise the jsonb `parties` column to MatterParty[] with sane defaults. */
function normaliseParties(raw: unknown): MatterParty[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => ({
      partyId:
        typeof p.partyId === 'string'
          ? p.partyId
          : typeof p.id === 'string'
            ? p.id
            : typeof p.name === 'string'
              ? p.name
              : 'unknown',
      kind:
        p.kind === 'client' || p.kind === 'counterparty' || p.kind === 'common_interest'
          ? p.kind
          : 'counterparty',
      role: typeof p.role === 'string' ? p.role : 'party',
    }));
}

function toMatter(row: MatterRow): Matter {
  // Derive settledPositions from top-level columns we know about.
  // `governing_law` is a flat column in the existing schema; the rest
  // of "positions" lives in matter_memory / deal_parameters (Stage B
  // wires those properly).
  const settledPositions = row.governing_law
    ? [{ clauseType: 'governing_law', currentValue: row.governing_law }]
    : [];

  return {
    id: row.id,
    firmId: row.firm_id ?? '',
    clientId: row.client_id ?? '',
    matterName: row.matter_name,
    clientName: row.client_name,
    matterType: (row.deal_parameters?.matter_type as string) ?? 'other',
    stage: ((row.stage as MatterStage) ??
      (row.archived ? 'closed' : 'in_negotiation')) as MatterStage,
    privilegeScope: (row.privilege_scope as PrivilegeScope) ?? 'open',
    openedAt: row.created_at ?? new Date(0).toISOString(),
    closedAt: row.archived ? row.last_accessed : null,
    parties: normaliseParties(row.parties),
    // Open positions extracted from matter_memory in Stage B
    openPositions: [],
    settledPositions,
    state: row.context ?? {},
  };
}

const SELECT_COLS =
  'id, firm_id, user_id, client_id, client_name, matter_name, ' +
  'governing_law, parties, deal_parameters, context, created_at, ' +
  'last_accessed, archived, stage, privilege_scope';

// ============================================================
// Public API
// ============================================================

export const mattersRepository = {
  /**
   * Fetch a single matter by id, scoped to the firm.
   */
  async findById(firmId: string, matterId: string): Promise<Matter | null> {
    if (!isSupabaseConfigured()) {
      const stub = STUB_MATTERS[matterId];
      if (!stub) return null;
      if (stub.firmId !== firmId) return null;
      return stub;
    }

    const supabase = getSupabase();
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('matters')
      .select(SELECT_COLS)
      .eq('id', matterId)
      .eq('firm_id', firmId)
      .maybeSingle();

    if (error) {
      console.error('[audrey-mcp] mattersRepository.findById error:', error.message);
      throw new Error(`Failed to read matter: ${error.message}`);
    }

    return data ? toMatter(data as unknown as MatterRow) : null;
  },

  /**
   * Find the matter a given document belongs to. Used by Claude in Word
   * when the user has a document open — Claude calls this with whatever
   * hints it has (Office document ID, filename, content snippet) and
   * gets back the matter context (or a list of plausible candidates).
   *
   * Resolution order:
   *   1. Exact word_doc_id match (most reliable; Office's stable ID)
   *   2. documents.name LIKE document_name (filename)
   *   3. matters.matter_name ILIKE %hint% (semantic match)
   *
   * Returns: matched matter + the source document (so the caller can
   * know if the document is a precedent, what version it is, etc.),
   * or alternatives if multiple matches, or null.
   */
  async findByDocument(
    firmId: string,
    hint: {
      wordDocId?: string;
      documentName?: string;
      contentSnippet?: string;
    }
  ): Promise<{
    matter: Matter | null;
    document: {
      id: string;
      name: string | null;
      isPrecedent: boolean;
      wordDocId: string | null;
    } | null;
    alternatives: Matter[];
    confidence: 'exact' | 'fuzzy' | 'none';
  }> {
    if (!isSupabaseConfigured()) {
      // Stub mode — no document lookup possible
      return { matter: null, document: null, alternatives: [], confidence: 'none' };
    }
    const supabase = getSupabase();
    if (!supabase) {
      return { matter: null, document: null, alternatives: [], confidence: 'none' };
    }

    // === Step 1: try by word_doc_id (Office's stable identifier) ===
    if (hint.wordDocId) {
      const { data: doc, error } = await supabase
        .from('documents')
        .select('id, matter_id, name, is_precedent, word_doc_id')
        .eq('firm_id', firmId)
        .eq('word_doc_id', hint.wordDocId)
        .maybeSingle();

      if (error) {
        console.error('[audrey-mcp] findByDocument (word_doc_id) error:', error.message);
      } else if (doc) {
        const matter = doc.matter_id
          ? await this.findById(firmId, doc.matter_id as string)
          : null;
        return {
          matter,
          document: {
            id: doc.id as string,
            name: (doc.name as string) ?? null,
            isPrecedent: Boolean(doc.is_precedent),
            wordDocId: (doc.word_doc_id as string) ?? null,
          },
          alternatives: [],
          confidence: 'exact',
        };
      }
    }

    // === Step 2: try by document filename (LIKE match) ===
    if (hint.documentName) {
      const { data: docs, error } = await supabase
        .from('documents')
        .select('id, matter_id, name, is_precedent, word_doc_id')
        .eq('firm_id', firmId)
        .ilike('name', `%${hint.documentName.replace(/[%_]/g, '')}%`)
        .limit(5);

      if (error) {
        console.error('[audrey-mcp] findByDocument (name) error:', error.message);
      } else if (docs && docs.length > 0) {
        const exact = docs.find((d) => d.name === hint.documentName);
        const chosen = exact ?? docs[0];
        const matter = chosen.matter_id
          ? await this.findById(firmId, chosen.matter_id as string)
          : null;
        // Also surface other plausible matters for the user
        const otherMatterIds = docs
          .filter((d) => d.id !== chosen.id && d.matter_id)
          .map((d) => d.matter_id as string)
          .slice(0, 3);
        const alternatives = await Promise.all(
          otherMatterIds.map((id) => this.findById(firmId, id))
        );
        return {
          matter,
          document: {
            id: chosen.id as string,
            name: (chosen.name as string) ?? null,
            isPrecedent: Boolean(chosen.is_precedent),
            wordDocId: (chosen.word_doc_id as string) ?? null,
          },
          alternatives: alternatives.filter((m): m is Matter => m !== null),
          confidence: exact ? 'exact' : 'fuzzy',
        };
      }
    }

    // === Step 3: try by matter name (semantic substring of any hint) ===
    const semanticHint =
      hint.documentName ?? hint.contentSnippet?.slice(0, 80) ?? null;
    if (semanticHint) {
      // Strip extensions and common suffixes
      const cleaned = semanticHint
        .replace(/\.(docx?|pdf)$/i, '')
        .replace(/_v\d+|_final|_draft|_clean/gi, '')
        .replace(/[%_]/g, '')
        .trim();
      if (cleaned.length >= 3) {
        const { data: matters, error } = await supabase
          .from('matters')
          .select(SELECT_COLS)
          .eq('firm_id', firmId)
          .ilike('matter_name', `%${cleaned}%`)
          .limit(5);

        if (error) {
          console.error('[audrey-mcp] findByDocument (matter_name) error:', error.message);
        } else if (matters && matters.length > 0) {
          const mapped = matters.map((m) => toMatter(m as unknown as MatterRow));
          return {
            matter: mapped[0],
            document: null,
            alternatives: mapped.slice(1),
            confidence: 'fuzzy',
          };
        }
      }
    }

    return { matter: null, document: null, alternatives: [], confidence: 'none' };
  },

  /**
   * List matters for a firm, optionally filtered by client / stage / counterparty.
   */
  async list(
    firmId: string,
    filters: { clientId?: string; status?: string; counterparty?: string }
  ): Promise<Matter[]> {
    if (!isSupabaseConfigured()) {
      return Object.values(STUB_MATTERS)
        .filter((m) => m.firmId === firmId)
        .filter((m) => !filters.clientId || m.clientId === filters.clientId)
        .filter((m) => !filters.status || m.stage === filters.status);
    }

    const supabase = getSupabase();
    if (!supabase) return [];

    let query = supabase
      .from('matters')
      .select(SELECT_COLS)
      .eq('firm_id', firmId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (filters.clientId) query = query.eq('client_id', filters.clientId);
    if (filters.status) query = query.eq('stage', filters.status);

    const { data, error } = await query;

    if (error) {
      console.error('[audrey-mcp] mattersRepository.list error:', error.message);
      throw new Error(`Failed to list matters: ${error.message}`);
    }

    return (data ?? []).map((row) => toMatter(row as unknown as MatterRow));
  },
};
