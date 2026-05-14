/**
 * Supabase client factory for Audrey TCP.
 *
 * Discipline:
 *   - Tool handlers NEVER import this directly. They go through the
 *     repository layer (src/repositories/*). This keeps the routing
 *     concern (shared vs dedicated instance, stub vs live) in one place.
 *   - We use the anon key from inside tool calls. RLS enforces firm
 *     isolation; the service role is reserved for migrations and runs
 *     out-of-band (psql, Supabase dashboard).
 *   - `audrey.firm_id` GUC is set per request so the RLS policies on
 *     audit_log (and future tables) resolve to the correct firm.
 *
 * Fallback mode:
 *   - If SUPABASE_URL / SUPABASE_ANON_KEY are not set, getSupabase()
 *     returns null. Repositories fall back to stub fixtures. This keeps
 *     the Day-1 stdio spike working without Supabase creds locally.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null | undefined;

/**
 * Returns a Supabase client, or null if env vars are not configured.
 * Caches the client across calls (singleton per process).
 */
export function getSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Allowed in Stage A; tools fall back to stub fixtures.
    cached = null;
    return null;
  }

  cached = createClient(url, anonKey, {
    auth: {
      // MCP server is stateless from Supabase's perspective; we don't
      // want it persisting any session.
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: 'public',
    },
  });

  return cached;
}

/**
 * True when Supabase is wired up. Use this to decide whether to log a
 * "running in stub mode" warning at boot.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

/**
 * Set the `audrey.firm_id` session variable so RLS policies that read
 * `current_setting('audrey.firm_id')` resolve correctly for this firm.
 *
 * Called at the start of every authenticated tool handler. Stage A:
 * firmId is the stub value; Stage B: the OAuth'd user's firm.
 *
 * NOTE: Supabase-js doesn't expose raw SET LOCAL. We use an RPC
 * (`set_firm_context`) defined in a future migration. Until that
 * migration ships, this is a no-op when Supabase is configured but the
 * RPC doesn't exist — RLS will simply deny reads, which is the safe
 * failure mode.
 */
export async function setFirmContext(firmId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.rpc('set_firm_context', { p_firm_id: firmId });
  if (error) {
    // Log but don't throw — RLS will fall back to denying reads, which
    // surfaces as null/empty results in repositories. That's the safe
    // failure mode for Stage A.
    console.error('[audrey-mcp] set_firm_context failed:', error.message);
  }
}
