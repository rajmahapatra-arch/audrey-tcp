-- 015_migrate_memory_to_decisions.sql  (AUD-605)
--
-- RUN ONLY AFTER: (1) migration 014, and (2) Raj has reviewed the
-- dry-run report (node scripts/aud605-dry-run.mjs) per the Stage 1
-- gate in the Matter Memory spec §8.
--
-- Mapping (signed off in the schema proposal §5):
--   matter_memory rows with memory_type='decision' AND status='endorsed'
--   → settled matter_decisions with reasons = ['reasons not recorded'],
--     source_tool/settled_via = 'migration', timestamps from the
--     original row. The original row is RETAINED and linked via
--     promoted_to — nothing is deleted.
--   'preference'/'context'/'term' rows stay in the working record.
--
-- Idempotent: promoted_to IS NULL guard means a re-run moves nothing
-- already migrated.

WITH src AS (
  SELECT id, firm_id, matter_id, user_id, content, source_document_id,
         created_at, gen_random_uuid() AS new_id
  FROM matter_memory
  WHERE memory_type = 'decision'
    AND status = 'endorsed'
    AND promoted_to IS NULL
),
ins AS (
  INSERT INTO matter_decisions
    (id, firm_id, matter_id, user_id, decision, reasons,
     source_document_id, status, source_tool, proposed_at,
     settled_via, settled_at, created_at)
  SELECT new_id, firm_id, matter_id, user_id, content,
         ARRAY['reasons not recorded'],
         source_document_id, 'settled', 'migration', created_at,
         'migration', created_at, created_at
  FROM src
  RETURNING id
)
UPDATE matter_memory mm
SET promoted_to = src.new_id
FROM src
WHERE mm.id = src.id;

-- Verification (run separately):
--   SELECT count(*) FROM matter_decisions WHERE source_tool = 'migration';
--   SELECT count(*) FROM matter_memory
--     WHERE memory_type='decision' AND status='endorsed' AND promoted_to IS NULL;
--   -- second count should be 0 after migration.
