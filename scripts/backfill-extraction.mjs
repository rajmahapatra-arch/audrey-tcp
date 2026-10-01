#!/usr/bin/env node
/**
 * Moat backfill: re-extract positions from every stored document on
 * the CURRENT generation model (the long-promised Stage B backfill —
 * the original only ever existed in the ghost PR #18).
 *
 * Safe to re-run: chunk writes are guarded (jobRunner skips docs
 * whose chunks exist) and positions supersede per clause tuple.
 *
 * Usage: node scripts/backfill-extraction.mjs [--limit N] [--docs id,id]
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
 *      OPENAI_API_KEY (inject before running).
 * Runs against the BUILT dist — run `npm run build` in mcp-server first.
 */
import { createClient } from '@supabase/supabase-js';
import { queueExtractionJob, runPendingJobs } from '../mcp-server/dist/extraction/jobRunner.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const limit = Number(opt('limit', 1000));
const only = opt('docs', null)?.split(',');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: docs, error } = await db
  .from('documents')
  .select('id, name, matter_id, firm_id')
  .not('matter_id', 'is', null)
  .order('created_at', { ascending: true })
  .limit(limit);
if (error) { console.error('doc query failed:', error.message); process.exit(1); }

const targets = only ? docs.filter((d) => only.includes(d.id)) : docs;
console.log(`backfill: queueing ${targets.length} documents`);
for (const d of targets) {
  const { jobId } = await queueExtractionJob({ documentId: d.id, firmId: d.firm_id, requestedBy: 'backfill-2026-10' });
  console.log(`  queued ${jobId.slice(0, 8)}  ${d.name}`);
}

console.log('draining job queue…');
const res = await runPendingJobs({ maxJobs: targets.length + 5 });
console.log('=== backfill complete ===');
console.log(JSON.stringify(res, null, 2).slice(0, 2000));
