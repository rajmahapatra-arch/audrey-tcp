/**
 * Decision records — the authoritative layer of matter memory.
 *
 * Spec: docs/matter-memory-spec.md §3.2; schema: migration 014.
 *
 * Discipline:
 *   - settle()/its supersession coupling go through the
 *     audrey_settle_decision() SQL function — the ONLY writer of
 *     chain state (one supersession chain, atomically projected onto
 *     linked positions).
 *   - Service client with explicit firm scoping on every query
 *     (lesson of fix #46: the tables are RLS deny-all for anon).
 *   - source_tool / source_session_id are stamped by the CALLER's
 *     transport layer from the authenticated client (AUD-604) —
 *     never accepted from model-supplied arguments.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isSupabaseConfigured } from '../db/supabase.js';

let serviceClient: SupabaseClient | null | undefined;
function getServiceClient(): SupabaseClient | null {
  if (serviceClient !== undefined) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  serviceClient =
    url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return serviceClient;
}

export interface MatterDecision {
  id: string;
  matterId: string;
  decision: string;
  reasons: string[];
  alternativesRejected: Array<{ option: string; why_rejected: string }>;
  reopenConditions: string | null;
  positionId: string | null;
  sourceDocumentId: string | null;
  status: 'proposed' | 'settled' | 'superseded' | 'dismissed';
  sourceTool: string;
  proposedAt: string;
  settledVia: string | null;
  settledAt: string | null;
  confirmationText: string | null;
  supersedesId: string | null;
  supersededById: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function transform(row: any): MatterDecision {
  return {
    id: row.id,
    matterId: row.matter_id,
    decision: row.decision,
    reasons: row.reasons ?? [],
    alternativesRejected: row.alternatives_rejected ?? [],
    reopenConditions: row.reopen_conditions ?? null,
    positionId: row.position_id ?? null,
    sourceDocumentId: row.source_document_id ?? null,
    status: row.status,
    sourceTool: row.source_tool,
    proposedAt: row.proposed_at,
    settledVia: row.settled_via ?? null,
    settledAt: row.settled_at ?? null,
    confirmationText: row.confirmation_text ?? null,
    supersedesId: row.supersedes_id ?? null,
    supersededById: row.superseded_by_id ?? null,
  };
}

function requireDb(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error('matter_decisions unavailable in stub mode');
  }
  const db = getServiceClient();
  if (!db) {
    throw new Error(
      'matter_decisions requires SUPABASE_SERVICE_ROLE_KEY (RLS is deny-all for anon)'
    );
  }
  return db;
}

export const decisionsRepository = {
  /** Settled + proposed decisions for a matter, newest first. */
  async listActive(firmId: string, matterId: string): Promise<MatterDecision[]> {
    const db = requireDb();
    const { data, error } = await db
      .from('matter_decisions')
      .select('*')
      .eq('firm_id', firmId)
      .eq('matter_id', matterId)
      .in('status', ['proposed', 'settled'])
      .order('created_at', { ascending: false });
    if (error) throw new Error(`listActive failed: ${error.message}`);
    return (data ?? []).map(transform);
  },

  /** Create a proposed decision. Settling is a separate explicit act. */
  async propose(args: {
    firmId: string;
    matterId: string;
    userId: string | null;
    decision: string;
    reasons?: string[];
    alternativesRejected?: Array<{ option: string; why_rejected: string }>;
    reopenConditions?: string | null;
    positionId?: string | null;
    sourceDocumentId?: string | null;
    /** stamped by the transport layer, never by the model (AUD-604) */
    sourceTool: string;
    sourceSessionId?: string | null;
  }): Promise<MatterDecision> {
    const db = requireDb();
    const { data, error } = await db
      .from('matter_decisions')
      .insert({
        firm_id: args.firmId,
        matter_id: args.matterId,
        user_id: args.userId,
        decision: args.decision,
        reasons: args.reasons ?? [],
        alternatives_rejected: args.alternativesRejected ?? [],
        reopen_conditions: args.reopenConditions ?? null,
        position_id: args.positionId ?? null,
        source_document_id: args.sourceDocumentId ?? null,
        source_tool: args.sourceTool,
        source_session_id: args.sourceSessionId ?? null,
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(`propose failed: ${error?.message ?? 'unknown'}`);
    return transform(data);
  },

  /**
   * Settle a proposed decision — the explicit user act. Atomic with
   * any supersession (decision chain + linked-position projection)
   * via the SQL function.
   */
  async settle(args: {
    firmId: string;
    decisionId: string;
    settledVia: string;
    confirmationText?: string | null;
    supersedesId?: string | null;
  }): Promise<MatterDecision> {
    const db = requireDb();
    // Firm check first: the RPC trusts its caller, so scope here.
    const { data: own, error: ownErr } = await db
      .from('matter_decisions')
      .select('id')
      .eq('id', args.decisionId)
      .eq('firm_id', args.firmId)
      .maybeSingle();
    if (ownErr) throw new Error(`settle scope check failed: ${ownErr.message}`);
    if (!own) throw new Error('decision not found for this firm');

    const { data, error } = await db.rpc('audrey_settle_decision', {
      p_decision_id: args.decisionId,
      p_settled_via: args.settledVia,
      p_confirmation_text: args.confirmationText ?? null,
      p_supersedes_id: args.supersedesId ?? null,
    });
    if (error) throw new Error(`settle failed: ${error.message}`);
    return transform(data);
  },

  /** Dismiss a proposed decision (content lives on as working record). */
  async dismiss(firmId: string, decisionId: string): Promise<void> {
    const db = requireDb();
    const { error } = await db
      .from('matter_decisions')
      .update({ status: 'dismissed', updated_at: new Date().toISOString() })
      .eq('id', decisionId)
      .eq('firm_id', firmId)
      .eq('status', 'proposed');
    if (error) throw new Error(`dismiss failed: ${error.message}`);
  },
};
