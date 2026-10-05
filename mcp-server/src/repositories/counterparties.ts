/**
 * Counterparties repository — cross-matter intelligence.
 *
 * Stage 2a: history is built from REAL extracted position rows
 * (positions table via positionsRepository.listByCounterparty),
 * including superseded rows so negotiation evolution is visible —
 * each entry carries a `superseded` flag so live positions are
 * clearly distinguishable from history. Matter-level context (names,
 * stages, count) still comes from the matters repository.
 *
 * Fallbacks:
 *   - Stub mode (no Supabase): synthesise from the stub matters
 *     fixture, exactly as Stage A did.
 *   - Live mode with zero position rows (extraction backlog not yet
 *     swept): fall back to the Stage A matter-metadata synthesis so
 *     the tool degrades to the old thin-but-honest behaviour.
 *
 * Architecture discipline:
 *   - Tool handlers go through this repository, never through other
 *     repositories directly. Cross-repo reads (matters, positions)
 *     happen HERE, so when the dedicated `counterparty_observations`
 *     table lands the only change is in this file.
 */

import { mattersRepository } from './matters.js';
import { positionsRepository, type Position } from './positions.js';
import { isSupabaseConfigured } from '../db/supabase.js';
import type { Matter } from '../types.js';

// ============================================================
// Output types — compact: this payload travels through MCP results
// ============================================================

export interface CounterpartyPositionEntry {
  /** Matter name when resolvable, else the matter id (citable via `matters`). */
  matter: string;
  // `unknown` mirrors Position.value / Matter position currentValue.
  // JSON-serialised at the tool boundary; no lossy coercion here.
  value: unknown;
  /** 'proposed' | 'open' | 'settled' | 'rejected' (positions table CHECK). */
  status: string;
  extracted_at: string;
  /** true = historical row a later extraction/assertion replaced. */
  superseded: boolean;
  /** Free-text negotiation note (matter-synthesis fallback path only). */
  history?: string;
}

export interface CounterpartyMatterSummary {
  id: string;
  name: string | null;
  stage: string;
}

export interface CounterpartyHistory {
  counterparty: string;
  matter_count: number;
  matters: CounterpartyMatterSummary[];
  positions_by_clause: Record<string, CounterpartyPositionEntry[]>;
}

// ============================================================
// Tuning
// ============================================================

/** Per-clause cap. Current rows always survive the cap ahead of superseded ones. */
const MAX_ENTRIES_PER_CLAUSE = 8;

/**
 * Position rows can cite matters outside the recent-50 list the
 * matters repository returns; those names are resolved one findById
 * each. Bounded so a pathological corpus can't fan out.
 */
const MAX_NAME_LOOKUPS = 20;

// ============================================================
// Public API
// ============================================================

export const counterpartiesRepository = {
  /**
   * Return everything the firm has observed about a counterparty:
   * their positions grouped by clause type (newest first, superseded
   * history flagged), plus the matters involved for citation.
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

    // Live mode: real position rows are the source of truth. Superseded
    // rows are included so the per-clause view shows evolution.
    let positions: Position[] = [];
    try {
      positions = await positionsRepository.listByCounterparty(firmId, counterparty, {
        ...(clauseType ? { clauseType } : {}),
        includeSuperseded: true,
      });
    } catch (err) {
      // Degrade to matter synthesis rather than failing the tool call.
      console.error(
        '[audrey-mcp] counterparty positions read failed:',
        err instanceof Error ? err.message : String(err)
      );
    }

    // Matter context: names/stages for citations + involvement check.
    let matters: Matter[] = [];
    try {
      matters = await mattersRepository.list(firmId, { counterparty });
    } catch (err) {
      console.error(
        '[audrey-mcp] counterparty matters read failed:',
        err instanceof Error ? err.message : String(err)
      );
    }

    if (positions.length === 0) {
      return synthesise(counterparty, matters, clauseType);
    }

    // Resolve matter names for the position rows. Most come free from
    // the list() call; stragglers get a bounded findById each.
    const matterInfo = new Map<string, { name: string | null; stage: string }>();
    for (const m of matters) matterInfo.set(m.id, { name: m.matterName, stage: m.stage });
    const unresolved = [...new Set(positions.map((p) => p.matterId))].filter(
      (id) => !matterInfo.has(id)
    );
    for (const id of unresolved.slice(0, MAX_NAME_LOOKUPS)) {
      try {
        const m = await mattersRepository.findById(firmId, id);
        if (m) matterInfo.set(m.id, { name: m.matterName, stage: m.stage });
      } catch {
        // Name stays unresolved; the entry falls back to the raw id.
      }
    }

    // Group by clause type. Within a clause: current rows first, then
    // superseded history, each newest-first, capped per clause.
    const grouped = new Map<string, Position[]>();
    for (const p of positions) {
      const list = grouped.get(p.clauseType) ?? [];
      list.push(p);
      grouped.set(p.clauseType, list);
    }

    const byClause: Record<string, CounterpartyPositionEntry[]> = {};
    for (const [clause, rows] of grouped) {
      const newestFirst = [...rows].sort(
        (a, b) => new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime()
      );
      const current = newestFirst.filter((r) => r.supersededBy === null);
      const replaced = newestFirst.filter((r) => r.supersededBy !== null);
      byClause[clause] = [...current, ...replaced]
        .slice(0, MAX_ENTRIES_PER_CLAUSE)
        .map((r) => ({
          matter: matterInfo.get(r.matterId)?.name ?? r.matterId,
          value: r.value,
          status: r.status,
          extracted_at: r.extractedAt,
          superseded: r.supersededBy !== null,
        }));
    }

    // Matter summaries: matters whose parties name the counterparty,
    // plus any matter a position row cites (party arrays on legacy
    // rows are not always stamped).
    const summaries: CounterpartyMatterSummary[] = [];
    const seen = new Set<string>();
    for (const m of matters) {
      if (!involvesCounterparty(m, counterparty)) continue;
      summaries.push({ id: m.id, name: m.matterName, stage: m.stage });
      seen.add(m.id);
    }
    for (const p of positions) {
      if (seen.has(p.matterId)) continue;
      seen.add(p.matterId);
      const info = matterInfo.get(p.matterId);
      summaries.push({
        id: p.matterId,
        name: info?.name ?? null,
        stage: info?.stage ?? 'unknown',
      });
    }

    return {
      counterparty,
      matter_count: summaries.length,
      matters: summaries,
      positions_by_clause: byClause,
    };
  },
};

// ============================================================
// Internal: fallback synthesis from matter metadata
// ============================================================

function involvesCounterparty(matter: Matter, counterparty: string): boolean {
  const needle = counterparty.toLowerCase();
  return matter.parties.some(
    (p) => p.kind === 'counterparty' && p.partyId.toLowerCase().includes(needle)
  );
}

function synthesise(
  counterparty: string,
  matters: Matter[],
  clauseType?: string
): CounterpartyHistory {
  const involved = matters.filter((m) => involvesCounterparty(m, counterparty));
  const byClause: Record<string, CounterpartyPositionEntry[]> = {};

  for (const matter of involved) {
    const matterName = matter.matterName ?? matter.id;

    for (const p of matter.openPositions) {
      if (clauseType && p.clauseType !== clauseType) continue;
      const entry: CounterpartyPositionEntry = {
        matter: matterName,
        value: p.currentValue,
        status: 'open',
        extracted_at: matter.openedAt,
        superseded: false,
      };
      if (p.history) entry.history = p.history;
      (byClause[p.clauseType] ??= []).push(entry);
    }

    for (const p of matter.settledPositions) {
      if (clauseType && p.clauseType !== clauseType) continue;
      (byClause[p.clauseType] ??= []).push({
        matter: matterName,
        value: p.currentValue,
        status: 'settled',
        extracted_at: matter.openedAt,
        superseded: false,
      });
    }
  }

  return {
    counterparty,
    matter_count: involved.length,
    matters: involved.map((m) => ({ id: m.id, name: m.matterName, stage: m.stage })),
    positions_by_clause: byClause,
  };
}
