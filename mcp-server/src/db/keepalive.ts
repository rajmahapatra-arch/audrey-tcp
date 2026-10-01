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

/**
 * Fire one ping at boot, then daily. The interval is unref'd so it
 * never holds the process open, and every failure path is swallowed
 * into a warn log — the keep-alive must never take the server down.
 * Each tick also runs the AUD-606 re-embed sweep.
 */
export function startDbKeepalive(logger: MinimalLogger): void {
  if (!isSupabaseConfigured()) return;
  const tick = async () => {
    await ping(logger);
    await sweepEmbeddings(logger);
  };
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref();
}
