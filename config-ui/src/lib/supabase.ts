/**
 * Supabase client — singleton for the config UI.
 *
 * Uses the anon key. RLS policies (migration 009 in the shared schema)
 * enforce per-user isolation; this client carries the signed-in user's
 * JWT automatically once auth.signIn* resolves, so PostgREST applies
 * the right policies without any explicit user_id filtering in app
 * code.
 *
 * Migration to firm-scoped RLS (memo: phase1 tech debt) doesn't change
 * this file — only the policy expressions in SQL.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail fast in dev so a missing .env.local surfaces immediately,
  // rather than silently giving 401s at query time.
  // eslint-disable-next-line no-console
  console.error(
    '[supabase] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in .env.local. ' +
      'Copy .env.example and fill in.'
  );
}

export const supabase: SupabaseClient = createClient(url ?? '', anonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
