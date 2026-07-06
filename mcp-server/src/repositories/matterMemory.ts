/**
 * matter_memory repository — vector search + chunk persistence.
 *
 * matter_memory was an existing Audrey-backend table for free-text
 * "memories" (notes, summaries) attached to a matter. Stage B extends
 * its use: every embedded document chunk also lands here with
 * memory_type='chunk' so that vector search can find them. The
 * existing pgvector index (`matter_memory_embedding_idx`) makes this
 * fast out of the box.
 *
 * Service-role for writes; anon for reads (RLS firm-scoped).
 */

import { getSupabase, isSupabaseConfigured } from '../db/supabase.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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
// Types
// ============================================================

export interface ChunkRecord {
  id: string;
  matterId: string | null;
  content: string;
  memoryType: string;
  sourceDocumentId: string | null;
  embeddingModel: string | null;
  createdAt: string;
  /** cosine distance to the query embedding when returned from vector search */
  distance?: number;
}

export const matterMemoryRepository = {
  /**
   * Bulk-insert embedded chunks. Used by the extraction pipeline.
   * Each chunk gets memory_type='chunk' to distinguish from notes.
   */
  async insertChunks(args: {
    firmId: string;
    matterId: string;
    sourceDocumentId: string;
    chunks: Array<{
      text: string;
      embedding: number[] | null;
    }>;
    embeddingModel: string;
  }): Promise<{ inserted: number; skipped: number }> {
    const db = getServiceClient();
    if (!db) throw new Error('matter_memory store unavailable');

    const validChunks = args.chunks.filter((c) => c.embedding !== null);
    const skipped = args.chunks.length - validChunks.length;

    if (validChunks.length === 0) return { inserted: 0, skipped };

    const rows = validChunks.map((c) => ({
      firm_id: args.firmId,
      matter_id: args.matterId,
      memory_type: 'chunk',
      content: c.text,
      source_document_id: args.sourceDocumentId,
      embedding: c.embedding,
      embedding_model: args.embeddingModel,
      status: 'active',
    }));

    const { error } = await db.from('matter_memory').insert(rows);
    if (error) {
      console.error('[audrey-mm] insertChunks failed:', error.message);
      throw new Error(`Failed to insert chunks: ${error.message}`);
    }
    return { inserted: rows.length, skipped };
  },

  /**
   * Insert a single lawyer-authored note. status='pending' so the
   * Audrey App's LearnedMemories panel surfaces it for curation
   * (its default view filters to endorsed+pending; Stage B chunks
   * use status='active' and stay out of that view).
   */
  async addNote(args: {
    firmId: string;
    matterId: string;
    content: string;
    memoryType: 'decision' | 'preference' | 'context';
    scope: 'matter' | 'client';
    embedding: number[] | null;
    embeddingModel: string | null;
  }): Promise<{ id: string; createdAt: string }> {
    const db = getServiceClient();
    if (!db) throw new Error('matter_memory store unavailable');

    const { data, error } = await db
      .from('matter_memory')
      .insert({
        firm_id: args.firmId,
        matter_id: args.matterId,
        memory_type: args.memoryType,
        content: args.content,
        scope: args.scope,
        status: 'pending',
        embedding: args.embedding,
        embedding_model: args.embedding ? args.embeddingModel : null,
      })
      .select('id, created_at')
      .single();

    if (error || !data) {
      throw new Error(`Failed to save note: ${error?.message ?? 'unknown'}`);
    }
    return { id: data.id as string, createdAt: data.created_at as string };
  },

  /**
   * Vector search across a firm's matter_memory rows.
   *
   * Uses pgvector's cosine-distance operator (`<=>`) via a Supabase
   * RPC `match_matter_memory` that we define alongside this code
   * (see migrations/009_match_matter_memory_function.sql).
   */
  async searchByEmbedding(args: {
    firmId: string;
    queryEmbedding: number[];
    matterId?: string;
    limit?: number;
  }): Promise<ChunkRecord[]> {
    if (!isSupabaseConfigured()) return [];
    const supabase = getSupabase();
    if (!supabase) return [];

    const { data, error } = await supabase.rpc('match_matter_memory', {
      p_firm_id: args.firmId,
      p_query_embedding: args.queryEmbedding,
      p_match_count: args.limit ?? 8,
      p_matter_id: args.matterId ?? null,
    });

    if (error) {
      console.error('[audrey-mm] searchByEmbedding error:', error.message);
      throw new Error(`Vector search failed: ${error.message}`);
    }

    type MatchRow = {
      id: string;
      matter_id: string | null;
      content: string;
      memory_type: string;
      source_document_id: string | null;
      embedding_model: string | null;
      created_at: string;
      distance: number;
    };
    return (data as MatchRow[] | null ?? []).map((r) => ({
      id: r.id,
      matterId: r.matter_id,
      content: r.content,
      memoryType: r.memory_type,
      sourceDocumentId: r.source_document_id,
      embeddingModel: r.embedding_model,
      createdAt: r.created_at,
      distance: r.distance,
    }));
  },
};
