/**
 * Extraction job runner.
 *
 * Pulls pending extraction_jobs rows, runs the full intake pipeline
 * for each (chunk → embed → write chunks → extract → write positions),
 * and updates the job row with results.
 *
 * Stage A: in-process. Triggered by:
 *   - Newly-uploaded documents (via a future doc-upload tool)
 *   - The backfill script
 *   - The extract_positions admin tool
 *
 * Stage C: move to a separate worker process or Supabase Edge
 *   Function so the MCP server can stay responsive under load.
 *
 * Failure isolation: each job runs in its own try/catch. A failing
 * job marks itself 'failed' with the error message and the runner
 * continues.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { chunkText } from './chunker.js';
import { embedBatch, EMBEDDING_MODEL } from './embedder.js';
import { extractPositions, EXTRACTION_MODEL, type ExtractionContext } from './extractor.js';
import { positionsRepository } from '../repositories/positions.js';
import { matterMemoryRepository } from '../repositories/matterMemory.js';

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

export interface JobResult {
  jobId: string;
  documentId: string;
  status: 'completed' | 'failed' | 'skipped';
  positionsExtracted?: number;
  positionsSuperseded?: number;
  chunksEmbedded?: number;
  errorMessage?: string;
  durationMs: number;
}

// ============================================================
// Queue a job (called by uploaders / backfill / admin tools)
// ============================================================

export async function queueExtractionJob(args: {
  firmId: string;
  documentId: string;
  matterId?: string | null;
  triggeredBy: 'document_upload' | 'manual_reextract' | 'tool_call' | 'scheduled_backfill';
  triggeredByUser?: string | null;
}): Promise<{ jobId: string }> {
  const db = getServiceClient();
  if (!db) throw new Error('extraction jobs store unavailable');

  const { data, error } = await db
    .from('extraction_jobs')
    .insert({
      firm_id: args.firmId,
      document_id: args.documentId,
      matter_id: args.matterId ?? null,
      triggered_by: args.triggeredBy,
      triggered_by_user: args.triggeredByUser ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to queue job: ${error?.message ?? 'unknown'}`);

  return { jobId: (data as { id: string }).id };
}

// ============================================================
// Run pending jobs (one at a time, in order)
// ============================================================

/**
 * Process up to `maxJobs` pending extraction_jobs. Returns one
 * JobResult per processed job. Called by:
 *   - The backfill script (drainQueue: true)
 *   - The admin extract_positions tool (single job)
 *   - A future scheduler / HTTP trigger
 */
export async function runPendingJobs(opts?: {
  maxJobs?: number;
}): Promise<JobResult[]> {
  const db = getServiceClient();
  if (!db) throw new Error('extraction jobs store unavailable');

  const max = opts?.maxJobs ?? 1;
  const results: JobResult[] = [];

  for (let i = 0; i < max; i++) {
    // Claim the next pending job atomically — UPDATE … WHERE status='pending'
    // RETURNING. Postgres makes this serializable; first writer wins.
    const { data: claimed, error: claimErr } = await db
      .from('extraction_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('status', 'pending')
      .order('queued_at', { ascending: true })
      .limit(1)
      .select('*')
      .maybeSingle();

    if (claimErr) {
      console.error('[audrey-extract] job claim failed:', claimErr.message);
      break;
    }
    if (!claimed) break; // no more pending jobs

    const result = await runOneJob(db, claimed);
    results.push(result);
  }

  return results;
}

// ============================================================
// Run one job (the actual pipeline)
// ============================================================

interface JobRow {
  id: string;
  firm_id: string;
  document_id: string;
  matter_id: string | null;
}

async function runOneJob(db: SupabaseClient, job: JobRow): Promise<JobResult> {
  const started = Date.now();

  try {
    // 1. Fetch the document
    const { data: doc, error: docErr } = await db
      .from('documents')
      .select('id, name, content, matter_id, firm_id, doc_type, is_precedent')
      .eq('id', job.document_id)
      .maybeSingle();

    if (docErr || !doc) {
      return await markFailed(db, job.id, `document not found: ${docErr?.message ?? 'no row'}`);
    }

    const content = (doc.content as string | null) ?? '';
    if (content.trim().length < 50) {
      // Too short to be meaningful — skip
      return await markCompleted(db, job.id, started, {
        positions_extracted: 0,
        chunks_embedded: 0,
      }, 'skipped');
    }

    // 2. Chunk
    const chunks = chunkText(content);

    // 3. Embed (parallel-batched inside embedBatch)
    const embeddings = await embedBatch(chunks.map((c) => c.text));

    // 4. Write chunks to matter_memory (only those with successful embeddings)
    const matterIdForWrite = (doc.matter_id as string | null) ?? job.matter_id;
    let chunksEmbedded = 0;
    if (matterIdForWrite && chunks.length > 0) {
      const writeResult = await matterMemoryRepository.insertChunks({
        firmId: doc.firm_id as string,
        matterId: matterIdForWrite,
        sourceDocumentId: doc.id as string,
        chunks: chunks.map((c, i) => ({
          text: c.text,
          embedding: embeddings[i]?.embedding ?? null,
        })),
        embeddingModel: EMBEDDING_MODEL,
      });
      chunksEmbedded = writeResult.inserted;
    }

    // 5. Extract positions (Anthropic call)
    let positionsExtracted = 0;
    let positionsSuperseded = 0;
    if (matterIdForWrite) {
      const ctx = await loadExtractionContext(db, doc as DocumentRow);
      const extracted = await extractPositions(content, ctx);
      if (extracted.positions.length > 0) {
        const writeResult = await positionsRepository.insertExtracted({
          firmId: doc.firm_id as string,
          matterId: matterIdForWrite,
          sourceDocumentId: doc.id as string,
          positions: extracted.positions,
          extractedBy: EXTRACTION_MODEL,
        });
        positionsExtracted = writeResult.inserted;
        positionsSuperseded = writeResult.superseded;
      }
    }

    return await markCompleted(db, job.id, started, {
      positions_extracted: positionsExtracted,
      chunks_embedded: chunksEmbedded,
    });

    void positionsSuperseded; // surfaced in logs in markCompleted if needed
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[audrey-extract] job failed:', msg);
    return await markFailed(db, job.id, msg);
  }
}

// ============================================================
// Helpers
// ============================================================

interface DocumentRow {
  id: string;
  name: string | null;
  content: string | null;
  matter_id: string | null;
  firm_id: string | null;
  doc_type: string | null;
  is_precedent: boolean | null;
}

async function loadExtractionContext(
  db: SupabaseClient,
  doc: DocumentRow
): Promise<ExtractionContext> {
  if (!doc.matter_id) return { documentType: doc.doc_type ?? undefined };
  const { data: matter } = await db
    .from('matters')
    .select('matter_name, client_name')
    .eq('id', doc.matter_id)
    .maybeSingle();
  return {
    matterName: (matter?.matter_name as string | null) ?? null,
    clientName: (matter?.client_name as string | null) ?? null,
    ourSide: (matter?.client_name as string | null) ?? null, // best guess; lawyer can override
    documentType: doc.doc_type ?? undefined,
  };
}

async function markCompleted(
  db: SupabaseClient,
  jobId: string,
  started: number,
  results: { positions_extracted: number; chunks_embedded: number },
  status: 'completed' | 'skipped' = 'completed'
): Promise<JobResult> {
  const durationMs = Date.now() - started;
  const { error } = await db
    .from('extraction_jobs')
    .update({
      status,
      completed_at: new Date().toISOString(),
      positions_extracted: results.positions_extracted,
      chunks_embedded: results.chunks_embedded,
      embedding_model: EMBEDDING_MODEL,
      extraction_model: EXTRACTION_MODEL,
    })
    .eq('id', jobId);
  if (error) console.error('[audrey-extract] markCompleted update failed:', error.message);

  return {
    jobId,
    documentId: '', // caller can join if needed
    status,
    positionsExtracted: results.positions_extracted,
    chunksEmbedded: results.chunks_embedded,
    durationMs,
  };
}

async function markFailed(
  db: SupabaseClient,
  jobId: string,
  errorMessage: string
): Promise<JobResult> {
  const { error } = await db
    .from('extraction_jobs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: errorMessage.slice(0, 2000),
    })
    .eq('id', jobId);
  if (error) console.error('[audrey-extract] markFailed update failed:', error.message);

  return { jobId, documentId: '', status: 'failed', errorMessage, durationMs: 0 };
}
