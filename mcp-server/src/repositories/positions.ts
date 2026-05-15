/**
 * Positions repository — read and write clause-level positions.
 *
 * Two write paths converge here:
 *   1. Extraction pipeline (server-internal) calls insertExtracted()
 *      with a list of ExtractedPosition + provenance metadata.
 *   2. Lawyer-asserted positions (via the add_position MCP tool)
 *      call assertByUser() — same table, different extracted_by tag.
 *
 * Supersession: when a new position covers the same
 * (matter_id, clause_type, party_role) tuple, the older one is
 * marked superseded_by = <new>. Both rows remain — historical view.
 */

import { getSupabase, isSupabaseConfigured } from '../db/supabase.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  ExtractedPosition,
  PartyRole,
  PositionStatus,
} from '../extraction/extractor.js';

// ============================================================
// Service-role client for writes (bypasses RLS, same pattern as audit.ts)
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

// ============================================================
// Domain types (exposed via tool responses)
// ============================================================

export interface Position {
  id: string;
  firmId: string;
  matterId: string;
  clauseType: string;
  value: Record<string, unknown>;
  status: PositionStatus;
  counterpartyName: string | null;
  partyRole: PartyRole | null;
  sourceDocumentId: string | null;
  sourceChunkText: string | null;
  extractedAt: string;
  extractedBy: string;
  confidence: number | null;
  createdAt: string;
  supersededBy: string | null;
}

interface PositionRow {
  id: string;
  firm_id: string;
  matter_id: string;
  clause_type: string;
  value: Record<string, unknown> | null;
  status: string;
  counterparty_name: string | null;
  party_role: string | null;
  source_document_id: string | null;
  source_chunk_text: string | null;
  extracted_at: string;
  extracted_by: string;
  confidence: number | null;
  created_at: string;
  superseded_by: string | null;
}

function toPosition(row: PositionRow): Position {
  return {
    id: row.id,
    firmId: row.firm_id,
    matterId: row.matter_id,
    clauseType: row.clause_type,
    value: row.value ?? {},
    status: (row.status as PositionStatus) ?? 'open',
    counterpartyName: row.counterparty_name,
    partyRole: (row.party_role as PartyRole | null) ?? null,
    sourceDocumentId: row.source_document_id,
    sourceChunkText: row.source_chunk_text,
    extractedAt: row.extracted_at,
    extractedBy: row.extracted_by,
    confidence: row.confidence,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
  };
}

const SELECT_COLS =
  'id, firm_id, matter_id, clause_type, value, status, counterparty_name, ' +
  'party_role, source_document_id, source_chunk_text, extracted_at, extracted_by, ' +
  'confidence, created_at, superseded_by';

// ============================================================
// Public API
// ============================================================

export const positionsRepository = {
  /**
   * Active positions for a matter (rows where superseded_by IS NULL).
   * Optionally filter to a status.
   */
  async listActive(
    firmId: string,
    matterId: string,
    filter?: { status?: PositionStatus }
  ): Promise<Position[]> {
    if (!isSupabaseConfigured()) return [];
    const supabase = getSupabase();
    if (!supabase) return [];

    let query = supabase
      .from('positions')
      .select(SELECT_COLS)
      .eq('firm_id', firmId)
      .eq('matter_id', matterId)
      .is('superseded_by', null)
      .order('clause_type', { ascending: true });
    if (filter?.status) query = query.eq('status', filter.status);

    const { data, error } = await query;
    if (error) {
      console.error('[audrey-mcp] positionsRepository.listActive error:', error.message);
      throw new Error(`Failed to read positions: ${error.message}`);
    }
    return (data ?? []).map((r) => toPosition(r as unknown as PositionRow));
  },

  /**
   * Full history for a matter (including superseded rows), ordered by
   * created_at ASC so chronological evolution is visible. Optional
   * filter by clause_type.
   */
  async listHistory(
    firmId: string,
    matterId: string,
    filter?: { clauseType?: string }
  ): Promise<Position[]> {
    if (!isSupabaseConfigured()) return [];
    const supabase = getSupabase();
    if (!supabase) return [];

    let query = supabase
      .from('positions')
      .select(SELECT_COLS)
      .eq('firm_id', firmId)
      .eq('matter_id', matterId)
      .order('created_at', { ascending: true });
    if (filter?.clauseType) query = query.eq('clause_type', filter.clauseType);

    const { data, error } = await query;
    if (error) {
      console.error('[audrey-mcp] positionsRepository.listHistory error:', error.message);
      throw new Error(`Failed to read position history: ${error.message}`);
    }
    return (data ?? []).map((r) => toPosition(r as unknown as PositionRow));
  },

  /**
   * Cross-matter view of positions involving a particular counterparty.
   * Used by get_counterparty_history (Stage B will replace its current
   * synthesis-from-matters path with this direct table read once
   * positions are populated).
   */
  async listByCounterparty(
    firmId: string,
    counterparty: string,
    filter?: { clauseType?: string }
  ): Promise<Position[]> {
    if (!isSupabaseConfigured()) return [];
    const supabase = getSupabase();
    if (!supabase) return [];

    let query = supabase
      .from('positions')
      .select(SELECT_COLS)
      .eq('firm_id', firmId)
      .ilike('counterparty_name', `%${counterparty}%`)
      .is('superseded_by', null)
      .order('clause_type', { ascending: true });
    if (filter?.clauseType) query = query.eq('clause_type', filter.clauseType);

    const { data, error } = await query;
    if (error) {
      console.error('[audrey-mcp] positionsRepository.listByCounterparty error:', error.message);
      throw new Error(`Failed to read counterparty positions: ${error.message}`);
    }
    return (data ?? []).map((r) => toPosition(r as unknown as PositionRow));
  },

  // ============================================================
  // Writes — service-role; bypass RLS like audit_log
  // ============================================================

  /**
   * Insert positions extracted by the LLM pipeline. Handles
   * supersession: if a current (non-superseded) row exists for the
   * same (matter_id, clause_type, party_role, counterparty_name)
   * tuple, mark it superseded_by the new one.
   */
  async insertExtracted(args: {
    firmId: string;
    matterId: string;
    sourceDocumentId: string | null;
    positions: ExtractedPosition[];
    extractedBy: string;
  }): Promise<{ inserted: number; superseded: number }> {
    const db = getServiceClient();
    if (!db) throw new Error('positions store unavailable');

    let inserted = 0;
    let superseded = 0;

    for (const p of args.positions) {
      // Find existing active row with the same tuple
      const tupleQuery = db
        .from('positions')
        .select('id')
        .eq('firm_id', args.firmId)
        .eq('matter_id', args.matterId)
        .eq('clause_type', p.clause_type)
        .is('superseded_by', null);

      const { data: existing, error: lookupErr } = await tupleQuery;
      if (lookupErr) {
        console.error('[audrey-positions] supersession lookup failed:', lookupErr.message);
        continue;
      }

      const { data: inserted_row, error: insertErr } = await db
        .from('positions')
        .insert({
          firm_id: args.firmId,
          matter_id: args.matterId,
          clause_type: p.clause_type,
          value: p.value,
          status: p.status,
          counterparty_name: p.counterparty_name,
          party_role: p.party_role,
          source_document_id: args.sourceDocumentId,
          source_chunk_text: p.source_chunk_text,
          extracted_by: args.extractedBy,
          confidence: p.confidence,
        })
        .select('id')
        .single();

      if (insertErr || !inserted_row) {
        console.error('[audrey-positions] insert failed:', insertErr?.message);
        continue;
      }
      inserted++;

      // Supersede prior rows for the same tuple (only if value or status differs)
      if (existing && existing.length > 0) {
        const priorIds = existing.map((r) => r.id as string);
        const { error: supErr } = await db
          .from('positions')
          .update({ superseded_by: inserted_row.id })
          .in('id', priorIds);
        if (supErr) {
          console.error('[audrey-positions] supersession write failed:', supErr.message);
        } else {
          superseded += priorIds.length;
        }
      }
    }

    return { inserted, superseded };
  },

  /**
   * Assert a position from a user (lawyer commit path). Same table,
   * extracted_by tagged with user identity, confidence = 1.0,
   * source_chunk_text may carry the lawyer's note.
   */
  async assertByUser(args: {
    firmId: string;
    userId: string;
    matterId: string;
    clauseType: string;
    value: Record<string, unknown>;
    status: PositionStatus;
    counterpartyName: string | null;
    partyRole: PartyRole | null;
    sourceChunkText: string | null;
    sourceDocumentId: string | null;
  }): Promise<Position> {
    const db = getServiceClient();
    if (!db) throw new Error('positions store unavailable');

    // Find existing active row to supersede
    const { data: existing } = await db
      .from('positions')
      .select('id')
      .eq('firm_id', args.firmId)
      .eq('matter_id', args.matterId)
      .eq('clause_type', args.clauseType)
      .is('superseded_by', null);

    const { data: inserted_row, error: insertErr } = await db
      .from('positions')
      .insert({
        firm_id: args.firmId,
        matter_id: args.matterId,
        clause_type: args.clauseType,
        value: args.value,
        status: args.status,
        counterparty_name: args.counterpartyName,
        party_role: args.partyRole,
        source_document_id: args.sourceDocumentId,
        source_chunk_text: args.sourceChunkText,
        extracted_by: `user:${args.userId}`,
        confidence: 1.0,
      })
      .select(SELECT_COLS)
      .single();

    if (insertErr || !inserted_row) {
      throw new Error(`Failed to assert position: ${insertErr?.message ?? 'unknown'}`);
    }

    if (existing && existing.length > 0) {
      const priorIds = existing.map((r) => r.id as string);
      await db
        .from('positions')
        .update({ superseded_by: (inserted_row as unknown as { id: string }).id })
        .in('id', priorIds);
    }

    return toPosition(inserted_row as unknown as PositionRow);
  },
};
