/**
 * scripts/backfill-extraction.ts
 *
 * One-shot backfill: queue an extraction job for every document the
 * given firm has, then drain the queue serially. Use this after
 * shipping Stage B to populate positions for all historical matters.
 *
 * Usage (with env vars set the same way as scripts/onboard.ts):
 *   npx tsx scripts/backfill-extraction.ts --firm-id 715b66f5-... [--limit 10] [--dry-run]
 *
 * Safety:
 *   - --dry-run: just lists what would be queued, doesn't insert.
 *   - --limit N: only queue N jobs (useful for sanity-checking on a
 *     small sample before letting it loose on 38 matters).
 *   - Skips documents that already have a 'completed' extraction_job.
 */

import { createClient } from '@supabase/supabase-js';
import { parseArgs } from 'node:util';
import { runPendingJobs, queueExtractionJob } from '../src/extraction/jobRunner.js';

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      'firm-id': { type: 'string' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: npx tsx scripts/backfill-extraction.ts --firm-id <uuid> [--limit N] [--dry-run]'
    );
    process.exit(0);
  }
  if (!values['firm-id']) {
    console.error('Error: --firm-id is required');
    process.exit(1);
  }
  return {
    firmId: values['firm-id'],
    limit: values.limit ? Number.parseInt(values.limit, 10) : Infinity,
    dryRun: values['dry-run'] ?? false,
  };
}

async function main() {
  const args = parseCliArgs();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env');
    process.exit(1);
  }

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Find documents that need extraction: have content + firm_id + not
  // already covered by a 'completed' job.
  console.log(`\n--- Audrey Stage B backfill ---`);
  console.log(`  Firm    : ${args.firmId}`);
  console.log(`  Limit   : ${args.limit === Infinity ? 'unlimited' : args.limit}`);
  console.log(`  Dry-run : ${args.dryRun ? 'YES' : 'no'}\n`);

  const { data: docs, error } = await db
    .from('documents')
    .select('id, name, matter_id, firm_id, content')
    .eq('firm_id', args.firmId)
    .not('content', 'is', null)
    .not('matter_id', 'is', null)
    .limit(args.limit === Infinity ? 1000 : args.limit);

  if (error) {
    console.error(`Failed to list documents: ${error.message}`);
    process.exit(1);
  }
  if (!docs || docs.length === 0) {
    console.log('No documents found. Nothing to backfill.');
    return;
  }
  console.log(`Found ${docs.length} candidate documents.\n`);

  // Skip docs already completed
  const docIds = docs.map((d) => d.id as string);
  const { data: completedJobs } = await db
    .from('extraction_jobs')
    .select('document_id')
    .in('document_id', docIds)
    .eq('status', 'completed');

  const completedSet = new Set((completedJobs ?? []).map((r) => r.document_id as string));
  const remaining = docs.filter((d) => !completedSet.has(d.id as string));

  console.log(`${completedSet.size} already completed, ${remaining.length} to queue.\n`);

  if (remaining.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Queue jobs
  let queued = 0;
  for (const doc of remaining) {
    if (args.dryRun) {
      console.log(`  [dry-run] would queue: ${doc.id} (${doc.name ?? 'unnamed'})`);
      continue;
    }
    try {
      const { jobId } = await queueExtractionJob({
        firmId: args.firmId,
        documentId: doc.id as string,
        matterId: (doc.matter_id as string | null) ?? null,
        triggeredBy: 'scheduled_backfill',
      });
      console.log(`  queued: ${doc.id} (${doc.name ?? 'unnamed'}) → job ${jobId}`);
      queued++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED to queue ${doc.id}: ${msg}`);
    }
  }

  if (args.dryRun) {
    console.log('\nDry-run complete. No jobs queued.');
    return;
  }

  console.log(`\nQueued ${queued} jobs. Draining the queue serially...\n`);

  // Drain
  const allResults: { completed: number; failed: number; skipped: number } = {
    completed: 0,
    failed: 0,
    skipped: 0,
  };
  while (true) {
    const results = await runPendingJobs({ maxJobs: 1 });
    if (results.length === 0) break;
    for (const r of results) {
      const status = r.status;
      console.log(
        `  job ${r.jobId} → ${status}` +
          (r.positionsExtracted !== undefined ? ` (${r.positionsExtracted} positions)` : '') +
          (r.chunksEmbedded !== undefined ? ` (${r.chunksEmbedded} chunks)` : '') +
          (r.errorMessage ? ` — ${r.errorMessage}` : '') +
          ` [${r.durationMs}ms]`
      );
      allResults[status]++;
    }
  }

  console.log(`\n--- Backfill complete ---`);
  console.log(`  Completed : ${allResults.completed}`);
  console.log(`  Skipped   : ${allResults.skipped}`);
  console.log(`  Failed    : ${allResults.failed}`);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
