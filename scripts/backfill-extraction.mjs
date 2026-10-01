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
import { queueExtractionJob, runPendingJobs } from '../mcp-server/dist/extraction/jobRunner.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const limit = Number(opt('limit', 1000));
const only = opt('docs', null)?.split(',');

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const resp = await fetch(
  `${process.env.SUPABASE_URL}/rest/v1/documents?select=id,name,matter_id,firm_id&matter_id=not.is.null&order=added_at.asc&limit=${limit}`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
);
if (!resp.ok) { console.error('doc query failed:', resp.status, await resp.text()); process.exit(1); }
const docs = await resp.json();

const targets = only ? docs.filter((d) => only.includes(d.id)) : docs;
console.log(`backfill: queueing ${targets.length} documents`);
for (const d of targets) {
  const { jobId } = await queueExtractionJob({ documentId: d.id, firmId: d.firm_id, triggeredBy: 'scheduled_backfill' });
  console.log(`  queued ${jobId.slice(0, 8)}  ${d.name}`);
}

console.log('draining job queue…');
const res = await runPendingJobs({ maxJobs: targets.length + 5 });
console.log('=== backfill complete ===');
console.log(JSON.stringify(res, null, 2).slice(0, 2000));
