/**
 * In-process database keep-alive.
 *
 * Supabase free-tier projects pause after ~7 days without database
 * activity (and their contents are eventually deleted if never
 * restored — we got that warning in July 2026). The first line of
 * defence was a GitHub Actions cron, which promptly demonstrated why
 * best-effort schedulers shouldn't guard hard deadlines: it fired
 * days late on this quiet private repo.
 *
 * This module is the reliable replacement: the TCP server runs 24/7
 * on Railway (its /health answered right through the July pause), so
 * a trivial query from inside the running process once a day keeps
 * the project active with no external scheduler involved.
 *
 * The GitHub workflow is retained as a MONITOR (it fails loudly when
 * the API serves an empty dataset) where lateness is tolerable.
 *
 * Retire both when the project moves to a paid tier (no pausing +
 * daily backups — recommended before the first pilot).
 */

import { getSupabase, isSupabaseConfigured } from './supabase.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { embedBatch, EMBEDDING_MODEL } from '../extraction/embedder.js';
import { queueExtractionJob, runPendingJobs } from '../extraction/jobRunner.js';

const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily — 7x margin on the pause threshold

type MinimalLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

async function ping(logger: MinimalLogger): Promise<void> {
  try {
    const supabase = getSupabase();
    if (!supabase) return;
    const { count, error } = await supabase
      .from('matters')
      .select('id', { count: 'exact', head: true });
    if (error) {
      logger.warn({ error: error.message }, 'db keepalive ping failed');
    } else {
      logger.info({ matters: count }, 'db keepalive ok');
    }
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'db keepalive ping threw'
    );
  }
}

// ============================================================
// Re-embed sweep (AUD-606)
// ============================================================
//
// Storage is never gated on embedding success, so rows can exist
// with embedding IS NULL (OpenAI hiccup / missing key) or with a
// stale embedding_model (the 3-large -> 3-small switch). The daily
// tick converges them. Batch cap keeps a single tick bounded; the
// whole corpus converges within a few ticks after a model change.

const SWEEP_BATCH = 1000;

let serviceClient: SupabaseClient | null | undefined;
function getServiceClientForSweep(): SupabaseClient | null {
  if (serviceClient !== undefined) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  serviceClient =
    url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return serviceClient;
}

async function sweepEmbeddings(logger: MinimalLogger): Promise<void> {
  try {
    if (!process.env.OPENAI_API_KEY) return; // degraded mode: nothing to do
    const db = getServiceClientForSweep();
    if (!db) return;

    const { data: rows, error } = await db
      .from('matter_memory')
      .select('id, content')
      .or(`embedding.is.null,embedding_model.neq.${EMBEDDING_MODEL}`)
      .order('created_at', { ascending: true })
      .limit(SWEEP_BATCH);
    if (error) {
      logger.warn({ error: error.message }, 'embed sweep query failed');
      return;
    }
    if (!rows || rows.length === 0) return;

    const results = await embedBatch(rows.map((r) => (r.content as string).slice(0, 8000)));
    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      const emb = results[i]?.embedding;
      if (!emb) continue;
      const { error: upErr } = await db
        .from('matter_memory')
        .update({ embedding: emb, embedding_model: EMBEDDING_MODEL })
        .eq('id', rows[i].id);
      if (!upErr) updated++;
    }
    logger.info(
      { candidates: rows.length, updated, model: EMBEDDING_MODEL },
      'embed sweep complete'
    );
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'embed sweep threw'
    );
  }
}

// ============================================================
// Extraction retry sweep (Stage 2a)
// ============================================================
//
// Documents can hold content yet have no extracted positions: rows
// that predate the extraction pipeline, upload-time queueing that
// failed, or jobs that died mid-run (API hiccup, deploy restart).
// The daily tick converges them: scan the oldest documents, queue a
// 'scheduled_backfill' extraction job for each one never attempted
// or whose last attempt failed, then drain the queue in-process.
// Caps bound a single tick; the backlog converges across ticks.

/** Jobs queued (and run) per tick — each one costs an LLM extraction call. */
const EXTRACTION_SWEEP_QUEUE_LIMIT = 10;

/**
 * Oldest candidate documents examined per tick while hunting for the
 * few above. Without this look-ahead the sweep would stall forever
 * once the N oldest documents all reach a terminal job status.
 */
const EXTRACTION_SWEEP_SCAN_LIMIT = 500;

/** Chunk size for extraction_jobs lookups (bounds the PostgREST URL). */
const EXTRACTION_SWEEP_JOBS_CHUNK = 100;

/**
 * Job statuses that make a document ineligible for re-queueing: done,
 * in flight, or deliberately terminal. 'failed' — and no job at all —
 * is what this sweep exists to retry. 'cancelled' was a human decision
 * and 'skipped' a runner decision ("too short to extract"); daily
 * resurrection of either would be noise, so both block too.
 */
const SWEEP_BLOCKING_STATUSES = new Set([
  'completed',
  'pending',
  'running',
  'cancelled',
  'skipped',
]);

interface SweepCandidateDoc {
  id: string;
  firm_id: string | null;
  matter_id: string | null;
  added_at: string | null;
}

async function sweepExtractions(logger: MinimalLogger): Promise<void> {
  try {
    // Extraction is an Anthropic call; without the key every queued job
    // would fail today and be retried tomorrow, forever. Degraded mode:
    // do nothing (mirrors the OPENAI_API_KEY gate on the embed sweep).
    if (!process.env.ANTHROPIC_API_KEY) return;
    const db = getServiceClientForSweep();
    if (!db) return;

    // 1. Candidate documents: have content and a matter, oldest first.
    //    (documents uses added_at — there is no created_at column.)
    //    firm_id is deliberately NOT filtered in SQL: the legacy app
    //    can still create unstamped rows until its own fix deploys,
    //    and we want to count + warn on them, not crash or hide them.
    const { data: docs, error: docErr } = await db
      .from('documents')
      .select('id, firm_id, matter_id, added_at')
      .not('content', 'is', null)
      .neq('content', '')
      .not('matter_id', 'is', null)
      .order('added_at', { ascending: true })
      .limit(EXTRACTION_SWEEP_SCAN_LIMIT);
    if (docErr) {
      logger.warn({ error: docErr.message }, 'extraction sweep document query failed');
      return;
    }
    const scanned = (docs ?? []) as SweepCandidateDoc[];

    // 2. Existing jobs for those documents (chunked .in() lookups),
    //    reduced in code to the set of blocked document ids.
    const blockedDocIds = new Set<string>();
    for (let i = 0; i < scanned.length; i += EXTRACTION_SWEEP_JOBS_CHUNK) {
      const chunkIds = scanned
        .slice(i, i + EXTRACTION_SWEEP_JOBS_CHUNK)
        .map((d) => d.id);
      const { data: jobs, error: jobsErr } = await db
        .from('extraction_jobs')
        .select('document_id, status')
        .in('document_id', chunkIds);
      if (jobsErr) {
        // Can't tell what's already queued or extracted — bail out
        // rather than risk double-queueing the whole scan window.
        logger.warn({ error: jobsErr.message }, 'extraction sweep jobs query failed');
        return;
      }
      for (const j of (jobs ?? []) as Array<{ document_id: string; status: string }>) {
        if (SWEEP_BLOCKING_STATUSES.has(j.status)) blockedDocIds.add(j.document_id);
      }
    }

    // 3. Filter in code. NULL firm_id rows are skipped with a warn —
    //    extraction_jobs.firm_id is NOT NULL, so queueing one would
    //    fail anyway; the sweep must outlive the legacy bug, not trip
    //    on it.
    const eligible: SweepCandidateDoc[] = [];
    const nullFirmSample: string[] = [];
    let skippedNullFirm = 0;
    for (const doc of scanned) {
      if (blockedDocIds.has(doc.id)) continue;
      if (!doc.firm_id) {
        skippedNullFirm++;
        if (nullFirmSample.length < 5) nullFirmSample.push(doc.id);
        continue;
      }
      eligible.push(doc);
    }
    if (skippedNullFirm > 0) {
      logger.warn(
        { count: skippedNullFirm, sample: nullFirmSample },
        'extraction sweep: documents without firm_id skipped (legacy app can still create unstamped rows)'
      );
    }

    // 4. Queue the oldest eligible documents, individually fenced so
    //    one bad row never aborts the batch.
    let queued = 0;
    let queueFailed = 0;
    for (const doc of eligible.slice(0, EXTRACTION_SWEEP_QUEUE_LIMIT)) {
      try {
        await queueExtractionJob({
          documentId: doc.id,
          firmId: doc.firm_id as string, // non-null: filtered above
          matterId: doc.matter_id,
          triggeredBy: 'scheduled_backfill',
        });
        queued++;
      } catch (err) {
        queueFailed++;
        logger.warn(
          { documentId: doc.id, error: err instanceof Error ? err.message : String(err) },
          'extraction sweep: queueing job failed'
        );
      }
    }

    // 5. Drain the queue. Runs even when nothing was queued this tick:
    //    it also finishes pending jobs stranded by a crashed run, which
    //    step 3 deliberately refuses to re-queue.
    let completed = 0;
    let failed = 0;
    try {
      const results = await runPendingJobs({ maxJobs: EXTRACTION_SWEEP_QUEUE_LIMIT });
      for (const r of results) {
        if (r.status === 'failed') failed++;
        else completed++;
      }
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'extraction sweep: job run threw'
      );
    }

    logger.info(
      {
        scanned: scanned.length,
        candidates: eligible.length,
        queued,
        queueFailed,
        skippedNullFirm,
        completed,
        failed,
      },
      'extraction sweep complete'
    );
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'extraction sweep threw'
    );
  }
}

/**
 * Fire one ping at boot, then daily. The interval is unref'd so it
 * never holds the process open, and every failure path is swallowed
 * into a warn log — the keep-alive must never take the server down.
 * Each tick also runs the AUD-606 re-embed sweep and the Stage 2a
 * extraction retry sweep.
 */
export function startDbKeepalive(logger: MinimalLogger): void {
  if (!isSupabaseConfigured()) return;
  const tick = async () => {
    await ping(logger);
    await sweepEmbeddings(logger);
    await sweepExtractions(logger);
  };
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref();
}
