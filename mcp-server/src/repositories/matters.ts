/**
 * Matters repository — the data access layer for matters.
 *
 * Architecture discipline (DO NOT VIOLATE):
 *   - This file is the ONLY place that decides how to reach matter data.
 *   - Tool handlers MUST call mattersRepository.X, never Supabase directly.
 *   - All methods take firmId as their first parameter so the routing
 *     layer (shared vs dedicated instance) can dispatch correctly.
 *
 * Stage A: stub implementation returning hardcoded data.
 * Stage B: real Supabase-backed implementation; multi-tenant routing
 *          via `getDbForFirm(firmId)`.
 * Stage post-C: dedicated-instance support added here (one switch on
 *               tenant config), tool handlers unchanged.
 */

import type { Matter } from '../types.js';

// ============================================================
// Stub fixtures (Stage A only — replaced in Stage B)
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
        history: 'Counterparty asked 6 months; we countered 24; settling around 12.',
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
// Public API
// ============================================================

export const mattersRepository = {
  /**
   * Fetch a single matter by id. Returns null if not found in firm's
   * workspace.
   */
  async findById(firmId: string, matterId: string): Promise<Matter | null> {
    // Stage A: stub — match against hardcoded fixtures
    // Stage B: const db = await getDbForFirm(firmId);
    //          const { data } = await db.from('matters')
    //            .select('...').eq('id', matterId).eq('firm_id', firmId).maybeSingle();
    //          return data ? toMatter(data) : null;
    const matter = STUB_MATTERS[matterId];
    if (!matter) return null;
    if (matter.firmId !== firmId) return null; // workspace isolation
    return matter;
  },

  /**
   * Stage B: list matters filtered by client, status, counterparty.
   * Stub for now.
   */
  async list(
    _firmId: string,
    _filters: { clientId?: string; status?: string; counterparty?: string }
  ): Promise<Matter[]> {
    return [];
  },
};
