#!/usr/bin/env node
/**
 * AUD-605 dry run — what WOULD migrate from matter_memory into
 * settled matter_decisions (migration 015), for Raj's review per the
 * Stage 1 gate. Read-only; prints per-matter counts + full candidate
 * content. Run before executing 015 in the Supabase SQL editor.
 *
 * Env: SUPABASE_URL + a key — process.env first, then the legacy
 * backend/.env (same tolerant loader as retrieval-eval).
 */
import { readFileSync, existsSync } from 'node:fs';

function loadEnv() {
  const files = [
    'C:/Users/rajma/OneDrive/Desktop/Word AI tool/word-ai-assistant/word-ai-assistant/backend/.env',
  ].filter(existsSync);
  const parsed = files.map((p) =>
    Object.fromEntries(
      readFileSync(p, 'utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((l) => l.match(/^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')])
    )
  );
  const pick = (...names) => {
    for (const src of [process.env, ...parsed])
      for (const n of names) if (src[n] && !/your-/.test(src[n])) return src[n];
    return null;
  };
  return {
    url: pick('SUPABASE_URL')?.replace(/\/$/, ''),
    key: pick('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'),
  };
}

const env = loadEnv();
if (!env.url || !env.key) {
  console.error('Missing SUPABASE_URL / key');
  process.exit(1);
}
const headers = { apikey: env.key, Authorization: `Bearer ${env.key}` };

const rows = await (
  await fetch(
    `${env.url}/rest/v1/matter_memory?select=id,matter_id,content,created_at,matters(matter_name,client_name)` +
      `&memory_type=eq.decision&status=eq.endorsed&promoted_to=is.null&order=created_at.asc&limit=2000`,
    { headers }
  )
).json();

if (!Array.isArray(rows)) {
  console.error('Query failed:', JSON.stringify(rows).slice(0, 300));
  process.exit(1);
}

console.log(`AUD-605 DRY RUN — ${rows.length} rows would become SETTLED decisions`);
console.log(`(reasons: ['reasons not recorded'], settled_via: 'migration')\n`);

const byMatter = new Map();
for (const r of rows) {
  const m = r.matters ?? {};
  const k = `${m.client_name ?? '?'} · ${m.matter_name ?? r.matter_id}`;
  if (!byMatter.has(k)) byMatter.set(k, []);
  byMatter.get(k).push(r);
}
for (const [k, list] of [...byMatter.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n=== ${k} (${list.length}) ===`);
  for (const r of list) {
    console.log(`  [${r.created_at.slice(0, 10)}] ${r.content.replace(/\s+/g, ' ').slice(0, 150)}`);
  }
}
console.log(
  `\nReview the list above. If correct, run migrations/015_migrate_memory_to_decisions.sql in the Supabase SQL editor.`
);
