/**
 * Counterparties repository — cross-matter intelligence.
 *
 * This is the repository that proves the architecture scales: it does
 * not have its own root table in Stage A; instead it synthesises
 * counterparty history from the matters repository. Later (migration
 * 006) it gets a dedicated `counterparty_observations` table that's
 * populated by the position-extraction pipeline.
 *
 * Architecture discipline:
 *   - Tool handlers go through this repository, never through other
 *     repositories directly. That way when we cut over to the
 *     observations table, the only change is here.
 */

import { mattersRepository } from './matters.js';
import { getSupabase, isSupabaseConfigured } from '../db/supabase.js';

// ============================================================
// Output type
// ============================================================

export interface CounterpartyClausePosition {
  clause_type: string;
  matter_id: string;
  matter_stage: string;
  // `unknown` mirrors Position.currentValue. JSON-serialised at the tool
  // boundary; matching the domain type avoids lossy coercion here.
  value: unknown;
  status: 'open' | 'settled';
  history?: string;
}

export interface CounterpartyHistory {
  counterparty: string;
  matter_count: number;
  positions_by_clause: Record<string, CounterpartyClausePosition[]>;
}

// ============================================================
// Public API
// ============================================================

export const counterpartiesRepository = {
  /**
   * Return everything the firm has observed about a counterparty: their
   * positions, grouped by clause type, with matter citations.
   *
   * Stage A synthesises this from `matters.openPositions` /
   * `settledPositions`. When migration 006 lands, this method swaps to
   * a single SELECT against `counterparty_observations`.
   */
  async getHistory(
    firmId: string,
    counterparty: string,
    clauseType?: string
  ): Promise<CounterpartyHistory> {
    // Stub mode: synthesise from the stub matters fixture.
    if (!isSupabaseConfigured()) {
      const matters = await mattersRepository.list(firmId, { counterparty });
      return synthesise(counterparty, matters, clauseType);
    }

    // Live mode: same synthesis path, but matters come from Supabase.
    // The list() call applies the counterparty filter (case-insensitive
    // partial match on party name/id).
    const supabase = getSupabase();
    if (!supabase) {
      return { counterparty, matter_count: 0, positions_by_clause: {} };
    }

    const matters = await mattersRepository.list(firmId, { counterparty });
    return synthesise(counterparty, matters, clauseType);
  },
};

// ============================================================
// Internal: synthesis from matter positions
// ============================================================

function synthesise(
  counterparty: string,
  matters: Awaited<ReturnType<typeof mattersRepository.list>>,
  clauseType?: string
): CounterpartyHistory {
  const byClause: Record<string, CounterpartyClausePosition[]> = {};

  for (const matter of matters) {
    // Skip if this matter doesn't actually involve the counterparty
    // we asked about. (list() already filters by name, but defensive.)
    const involved = matter.parties.some(
      (p) =>
        p.kind === 'counterparty' &&
        p.partyId.toLowerCase().includes(counterparty.toLowerCase())
    );
    if (!involved) continue;

    for (const p of matter.openPositions) {
      if (clauseType && p.clauseType !== clauseType) continue;
      (byClause[p.clauseType] ??= []).push({
        clause_type: p.clauseType,
        matter_id: matter.id,
        matter_stage: matter.stage,
        value: p.currentValue,
        status: 'open',
        history: p.history,
      });
    }

    for (const p of matter.settledPositions) {
      if (clauseType && p.clauseType !== clauseType) continue;
      (byClause[p.clauseType] ??= []).push({
        clause_type: p.clauseType,
        matter_id: matter.id,
        matter_stage: matter.stage,
        value: p.currentValue,
        status: 'settled',
      });
    }
  }

  return {
    counterparty,
    matter_count: matters.length,
    positions_by_clause: byClause,
  };
}
