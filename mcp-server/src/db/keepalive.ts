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

/**
 * Fire one ping at boot, then daily. The interval is unref'd so it
 * never holds the process open, and every failure path is swallowed
 * into a warn log — the keep-alive must never take the server down.
 */
export function startDbKeepalive(logger: MinimalLogger): void {
  if (!isSupabaseConfigured()) return;
  void ping(logger);
  const timer = setInterval(() => void ping(logger), INTERVAL_MS);
  timer.unref();
}
