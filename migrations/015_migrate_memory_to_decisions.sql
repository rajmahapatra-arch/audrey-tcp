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

WITH keepers AS (
  -- NOTE: matter_memory has no user_id column (the dual-tag lives on
  -- matters); migrated decisions carry user_id NULL with attribution
  -- via source_tool='migration'.
  SELECT DISTINCT ON (matter_id, btrim(content))
         id, firm_id, matter_id, content,
         source_document_id, created_at,
         gen_random_uuid() AS new_id
  FROM matter_memory
  WHERE memory_type = 'decision'
    AND status = 'endorsed'
    AND promoted_to IS NULL
  ORDER BY matter_id, btrim(content), created_at ASC
),
ins AS (
  INSERT INTO matter_decisions
    (id, firm_id, matter_id, decision, reasons,
     source_document_id, status, source_tool, proposed_at,
     settled_via, settled_at, created_at)
  SELECT new_id, firm_id, matter_id, content,
         ARRAY['reasons not recorded'],
         source_document_id, 'settled', 'migration', created_at,
         'migration', created_at, created_at
  FROM keepers
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
