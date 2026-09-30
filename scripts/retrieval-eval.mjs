#!/usr/bin/env node
/**
 * AUD-607 — Retrieval eval: does semantic search actually beat lexical
 * on Audrey's real corpus?
 *
 * Compares three retrievers over live matter_memory rows:
 *   1. lexical  — Postgres websearch full-text search (PostgREST `wfts`)
 *   2. large    — OpenAI text-embedding-3-large @ 1536 dims (current prod)
 *   3. small    — OpenAI text-embedding-3-small @ 1536 dims (6.5x cheaper)
 * Vector modes embed BOTH corpus and query with the same model
 * (in-memory cosine over a corpus snapshot — no schema changes, no
 * writes, fair comparison, ~$0.01 total).
 *
 * Modes:
 *   node scripts/retrieval-eval.mjs sample --out <file> [--per-matter 4]
 *       Dump a corpus sample to write ground-truth questions against.
 *   node scripts/retrieval-eval.mjs run --questions <file> [--k 8]
 *       Score all three retrievers. Questions file format:
 *       [{"question": "...", "expected": ["<row-uuid>", ...]}, ...]
 *       (see eval/questions.example.json). Metrics: hit@1/3/8, MRR.
 *
 * Env (first found wins): SUPABASE_URL + SUPABASE_SERVICE_KEY (or
 * _ROLE_KEY / ANON_KEY) and OPENAI_API_KEY — from process.env, then
 * mcp-server/.env, then the legacy backend/.env.
 *
 * OUTPUT FILES CONTAIN MATTER TEXT — keep them out of the repo.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const sources = [
    process.env,
    ...['mcp-server/.env', '../word-ai-assistant/word-ai-assistant/backend/.env',
      'C:/Users/rajma/OneDrive/Desktop/Word AI tool/word-ai-assistant/word-ai-assistant/backend/.env']
      .map((p) => resolve(ROOT, p))
      .filter(existsSync)
      .map((p) =>
        Object.fromEntries(
          readFileSync(p, 'utf8')
            .split(/\r?\n/)
            .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
            .filter(Boolean)
            .map((m) => [m[1], m[2]])
        )
      ),
  ];
  const isPlaceholder = (v) => /your-project|your-key|your-openai|changeme|<.*>/i.test(v);
  const pick = (...names) => {
    for (const src of sources)
      for (const n of names) if (src[n] && !isPlaceholder(src[n])) return src[n];
    return null;
  };
  return {
    url: pick('SUPABASE_URL')?.replace(/\/$/, ''),
    key: pick('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'),
    openai: pick('OPENAI_API_KEY'),
  };
}

async function sb(env, path) {
  const r = await fetch(`${env.url}/rest/v1/${path}`, {
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function fetchCorpus(env) {
  // Everything a working-record/notes search could target. Chunks
  // included: they're what search_matter_text actually serves.
  const rows = await sb(
    env,
    `matter_memory?select=id,matter_id,memory_type,status,content&order=created_at.asc&limit=5000`
  );
  return rows.filter((r) => r.content && r.content.trim().length > 0);
}

async function embedAll(env, model, texts, dims) {
  const out = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.openai}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch, dimensions: dims }),
    });
    if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    for (const d of j.data) out.push(d.embedding);
    process.stderr.write(`  embedded ${Math.min(i + 100, texts.length)}/${texts.length} (${model})\r`);
  }
  process.stderr.write('\n');
  return out;
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => Math.sqrt(dot(a, a));
function cosineRank(queryVec, corpusVecs, k) {
  const qn = norm(queryVec);
  return corpusVecs
    .map((v, i) => ({ i, score: dot(queryVec, v) / (qn * norm(v) || 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

async function lexicalRank(env, question, k) {
  // Postgres websearch_to_tsquery via PostgREST — the real production
  // alternative, not a toy scorer.
  const q = encodeURIComponent(question);
  const rows = await sb(env, `matter_memory?select=id&content=wfts.${q}&limit=${k}`);
  return rows.map((r) => r.id);
}

function score(rankedIds, expected, k) {
  const pos = rankedIds.findIndex((id) => expected.includes(id));
  return {
    hit1: pos === 0 ? 1 : 0,
    hit3: pos > -1 && pos < 3 ? 1 : 0,
    hitK: pos > -1 && pos < k ? 1 : 0,
    rr: pos > -1 ? 1 / (pos + 1) : 0,
  };
}

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : dflt;
};

const env = loadEnv();
if (!env.url || !env.key) {
  console.error('Missing SUPABASE_URL / key (checked process.env, mcp-server/.env, backend/.env)');
  process.exit(1);
}

if (mode === 'sample') {
  const perMatter = Number(opt('per-matter', 4));
  const out = opt('out', null);
  if (!out) { console.error('--out <file> required (keep outside the repo)'); process.exit(1); }
  const corpus = await fetchCorpus(env);
  const byMatter = new Map();
  for (const r of corpus) {
    const arr = byMatter.get(r.matter_id) ?? [];
    if (arr.length < perMatter) { arr.push(r); byMatter.set(r.matter_id, arr); }
  }
  const sample = [...byMatter.values()].flat().map((r) => ({
    id: r.id, matter_id: r.matter_id, type: r.memory_type,
    content: r.content.slice(0, 240),
  }));
  writeFileSync(out, JSON.stringify(sample, null, 2));
  console.log(`corpus: ${corpus.length} rows across ${byMatter.size} matters`);
  console.log(`sample: ${sample.length} rows -> ${out}`);
  console.log('Write eval questions against these rows (id = ground truth).');
} else if (mode === 'run') {
  const qFile = opt('questions', null);
  const k = Number(opt('k', 8));
  if (!qFile) { console.error('--questions <file> required'); process.exit(1); }
  if (!env.openai) { console.error('OPENAI_API_KEY missing'); process.exit(1); }
  const questions = JSON.parse(readFileSync(qFile, 'utf8'));
  const corpus = await fetchCorpus(env);
  console.error(`corpus: ${corpus.length} rows; questions: ${questions.length}; k=${k}`);

  const texts = corpus.map((r) => r.content.slice(0, 2000));
  const vecs = {};
  for (const [label, model] of [['large', 'text-embedding-3-large'], ['small', 'text-embedding-3-small']]) {
    vecs[label] = await embedAll(env, model, texts, 1536);
  }

  const totals = {};
  const rowsOut = [];
  for (const q of questions) {
    const per = {};
    per.lexical = score(await lexicalRank(env, q.question, k), q.expected, k);
    for (const label of ['large', 'small']) {
      const [qv] = await embedAll(env, `text-embedding-3-${label === 'large' ? 'large' : 'small'}`, [q.question], 1536);
      const ranked = cosineRank(qv, vecs[label], k).map(({ i }) => corpus[i].id);
      per[label] = score(ranked, q.expected, k);
    }
    rowsOut.push({ question: q.question.slice(0, 60), ...Object.fromEntries(Object.entries(per).map(([m, s]) => [m, s.rr.toFixed(2)])) });
    for (const [m, s] of Object.entries(per)) {
      totals[m] ??= { hit1: 0, hit3: 0, hitK: 0, rr: 0 };
      for (const key of Object.keys(s)) totals[m][key] += s[key];
    }
  }
  console.table(rowsOut);
  const n = questions.length;
  console.log(`\n=== Summary (n=${n}) ===`);
  for (const [m, t] of Object.entries(totals)) {
    console.log(
      `${m.padEnd(8)} hit@1 ${(t.hit1 / n).toFixed(2)}  hit@3 ${(t.hit3 / n).toFixed(2)}  hit@${k} ${(t.hitK / n).toFixed(2)}  MRR ${(t.rr / n).toFixed(2)}`
    );
  }
  console.log('\nDecision rule (AUD-607): semantic must beat lexical materially at hit@3 to stay load-bearing.');
} else {
  console.error('usage: retrieval-eval.mjs sample --out <file> | run --questions <file> [--k 8]');
  process.exit(1);
}
