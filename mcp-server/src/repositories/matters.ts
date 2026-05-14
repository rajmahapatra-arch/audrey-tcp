/**
 * Matters repository — the data access layer for matters.
 *
 * Architecture discipline (DO NOT VIOLATE):
 *   - This file is the ONLY place that decides how to reach matter data.
 *   - Tool handlers MUST call mattersRepository.X, never Supabase directly.
 *   - All methods take firmId as their first parameter so the routing
 *     layer (shared vs dedicated instance) can dispatch correctly.
 *
 * Stage A (now):
 *   - If Supabase is configured: read from `matters` table, RLS-scoped.
 *   - If Supabase is NOT configured: fall back to STUB_MATTERS so the
 *     Day-1 spike still works locally without creds.
 *
 * Stage post-C: dedicated-instance support added here (one switch on
 *               tenant config), tool handlers unchanged.
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

/**
 * The existing Audrey backend stores matters with snake_case columns.
 * This mapper is the single point where we translate to the camelCase
 * domain type. Keeping it isolated means schema drift hits one place.
 */
interface MatterRow {
  id: string;
  firm_id: string;
  client_id: string | null;
  matter_type: string | null;
  stage: string | null;
  privilege_scope: string | null;
  opened_at: string | null;
  closed_at: string | null;
  parties: MatterParty[] | null;
  state: Record<string, unknown> | null;
}

function toMatter(row: MatterRow): Matter {
  return {
    id: row.id,
    firmId: row.firm_id,
    clientId: row.client_id ?? '',
    matterType: row.matter_type ?? 'other',
    stage: (row.stage ?? 'in_negotiation') as MatterStage,
    privilegeScope: (row.privilege_scope ?? 'open') as PrivilegeScope,
    openedAt: row.opened_at ?? new Date(0).toISOString(),
    closedAt: row.closed_at,
    parties: row.parties ?? [],
    // Positions are populated by the positions repository in Stage B
    // when migration 003 lands. Until then they come back empty.
    openPositions: [],
    settledPositions: [],
    state: row.state ?? {},
  };
}

// ============================================================
// Public API
// ============================================================

export const mattersRepository = {
  /**
   * Fetch a single matter by id. Returns null if not found in firm's
   * workspace (or if RLS denies the read).
   */
  async findById(firmId: string, matterId: string): Promise<Matter | null> {
    // Stub fallback path — only used when Supabase isn't configured at
    // all. We don't fall through to stubs on Supabase errors; those
    // should surface so we notice misconfiguration.
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
      .select(
        'id, firm_id, client_id, matter_type, stage, privilege_scope, opened_at, closed_at, parties, state'
      )
      .eq('id', matterId)
      .eq('firm_id', firmId)
      .maybeSingle();

    if (error) {
      console.error('[audrey-mcp] mattersRepository.findById error:', error.message);
      throw new Error(`Failed to read matter: ${error.message}`);
    }

    return data ? toMatter(data as MatterRow) : null;
  },

  /**
   * List matters filtered by client, status, counterparty. Stage A
   * returns an empty array when Supabase isn't configured.
   */
  async list(
    firmId: string,
    filters: { clientId?: string; status?: string; counterparty?: string }
  ): Promise<Matter[]> {
    if (!isSupabaseConfigured()) {
      // Return stubbed matter(s) that belong to this firm, filtered.
      return Object.values(STUB_MATTERS)
        .filter((m) => m.firmId === firmId)
        .filter((m) => !filters.clientId || m.clientId === filters.clientId)
        .filter((m) => !filters.status || m.stage === filters.status);
    }

    const supabase = getSupabase();
    if (!supabase) return [];

    let query = supabase
      .from('matters')
      .select(
        'id, firm_id, client_id, matter_type, stage, privilege_scope, opened_at, closed_at, parties, state'
      )
      .eq('firm_id', firmId)
      .order('opened_at', { ascending: false })
      .limit(50);

    if (filters.clientId) query = query.eq('client_id', filters.clientId);
    if (filters.status) query = query.eq('stage', filters.status);

    const { data, error } = await query;

    if (error) {
      console.error('[audrey-mcp] mattersRepository.list error:', error.message);
      throw new Error(`Failed to list matters: ${error.message}`);
    }

    return (data ?? []).map((row) => toMatter(row as MatterRow));
  },
};
