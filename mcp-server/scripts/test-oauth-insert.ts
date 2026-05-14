/**
 * One-off diagnostic: try to insert a row into oauth_clients using
 * the same service-role credentials Railway uses. Reports the exact
 * Postgres error so we can tell whether it's a missing table, a
 * permission denial, a bad key, or something else.
 *
 * Run from mcp-server/ with the same env vars set as for onboard.ts:
 *   $env:SUPABASE_URL = "..."
 *   $env:SUPABASE_SERVICE_ROLE_KEY = "..."
 *   npx tsx scripts/test-oauth-insert.ts
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log('Testing oauth_clients insert...');
const { data, error } = await sb
  .from('oauth_clients')
  .insert({
    client_id: 'smoke-test-' + Date.now(),
    client_name: 'Smoke test',
    redirect_uris: ['https://example.com/callback'],
  })
  .select()
  .single();

console.log('--- result ---');
console.log('data :', data);
console.log('error:', error);

if (error) {
  console.error('\n>>> FAILED.');
  console.error('Message:', error.message);
  console.error('Hint   :', error.hint ?? '(none)');
  console.error('Details:', error.details ?? '(none)');
  console.error('Code   :', error.code ?? '(none)');
  process.exit(1);
}

console.log('\n>>> Insert succeeded. Cleaning up...');
await sb.from('oauth_clients').delete().eq('client_id', data.client_id);
console.log('Done.');
