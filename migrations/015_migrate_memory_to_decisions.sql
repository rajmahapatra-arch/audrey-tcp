-- 015_migrate_memory_to_decisions.sql  (AUD-605)
--
-- RUN ONLY AFTER: (1) migration 014, and (2) Raj has reviewed the
-- dry-run report (node scripts/aud605-dry-run.mjs) per the Stage 1
-- gate in the Matter Memory spec §8.
--
-- Mapping (signed off in the schema proposal §5, amended 2026-10-01
-- after the dry run surfaced ~30% duplicate rows from legacy
-- chat-era saves):
--   matter_memory rows with memory_type='decision' AND status='endorsed'
--   are DEDUPLICATED on (matter_id, trimmed content) — the earliest
--   copy becomes one settled matter_decision (reasons = ['reasons not
--   recorded'], source_tool/settled_via = 'migration', timestamps
--   from that earliest row). EVERY copy, duplicate or not, gets
--   promoted_to set to that decision — nothing is deleted, and the
--   promoted_to IS NULL guard keeps re-runs no-ops.
--   Dry-run measured 2026-10-01: 240 candidates -> 169 decisions.

-- 0a. Tag legacy-created MATTERS (the legacy backend stamps firm_id on
--     nothing): 5 matters created Jun-Aug 2026 were firm_id NULL and
--     therefore invisible to every firm-scoped connector tool.
--     Single-firm era: hardcoded to the only firm in firm_users.
UPDATE matters
SET firm_id = '715b66f5-f7fb-4abe-b4f6-f5676c0117cd'
WHERE firm_id IS NULL;

-- 0b. Backfill memory rows from their (now-tagged) parent matter
--     (also fixes their invisibility to firm-scoped search):
UPDATE matter_memory mm
SET firm_id = m.firm_id
FROM matters m
WHERE mm.matter_id = m.id AND mm.firm_id IS NULL;

WITH keepers AS (
  -- NOTE: matter_memory has no user_id column (the dual-tag lives on
  -- matters); migrated decisions carry user_id NULL with attribution
  -- via source_tool='migration'.
  SELECT DISTINCT ON (mm.matter_id, btrim(mm.content))
         mm.id, mm.firm_id, mm.matter_id, mm.content,
         mm.source_document_id, mm.created_at,
         gen_random_uuid() AS new_id
  FROM matter_memory mm
  WHERE mm.memory_type = 'decision'
    AND mm.status = 'endorsed'
    AND mm.promoted_to IS NULL
    AND mm.firm_id IS NOT NULL
  ORDER BY mm.matter_id, btrim(mm.content), mm.created_at ASC
),
ins AS (
  INSERT INTO matter_decisions
    (id, firm_id, matter_id, decision, reasons,
     source_document_id, status, source_tool, proposed_at,
     settled_via, settled_at, created_at)
  -- matter_memory.source_document_id is TEXT (legacy); resolve it to
  -- a real documents.id or NULL so the uuid FK can never violate.
  SELECT k.new_id, k.firm_id, k.matter_id, k.content,
         ARRAY['reasons not recorded'],
         (SELECT d.id FROM documents d WHERE d.id::text = k.source_document_id),
         'settled', 'migration', k.created_at,
         'migration', k.created_at, k.created_at
  FROM keepers k
  RETURNING id
)
UPDATE matter_memory mm
SET promoted_to = k.new_id
FROM keepers k
WHERE mm.memory_type = 'decision'
  AND mm.status = 'endorsed'
  AND mm.promoted_to IS NULL
  AND mm.matter_id = k.matter_id
  AND btrim(mm.content) = btrim(k.content);

-- Verification (run separately):
--   SELECT count(*) FROM matter_decisions WHERE source_tool = 'migration';
--     -- expect ~169
--   SELECT count(*) FROM matter_memory
--     WHERE memory_type='decision' AND status='endorsed' AND promoted_to IS NULL;
--     -- expect 0
