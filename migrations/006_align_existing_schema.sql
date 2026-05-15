-- 006_align_existing_schema.sql
--
-- Bridges the existing Audrey schema (user-keyed multi-tenancy) with
-- the Audrey TCP firm-keyed model.
--
-- Why this is needed:
--   The original Audrey Word add-in tagged every row (matters,
--   matter_memory, documents, clients) with `user_id`. There was no
--   `firm_id` column anywhere. Now that Audrey TCP introduces the
--   firms / firm_users abstraction, we need `firm_id` on these tables
--   so the firm-scoped repository queries work without rewriting all
--   the existing data access paths.
--
-- Strategy:
--   1. ADD COLUMN firm_id uuid (nullable for now) to each affected table.
--   2. Backfill firm_id by joining through firm_users / parent tables.
--   3. Add the Stage A "intent" columns mentioned in the migrations
--      README (matters.stage, matters.privilege_scope) with defaults.
--   4. Indexes on firm_id for the query patterns.
--
-- Rows that aren't covered by firm_users (e.g. matters belonging to a
-- user we haven't onboarded yet) keep firm_id = NULL. They'll be picked
-- up next time that user runs through onboarding (we can also add a
-- nightly backfill in Stage B).
--
-- Forward-only, idempotent (IF NOT EXISTS guards everywhere).

-- ============================================================
-- 1. matters
-- ============================================================

ALTER TABLE matters
  ADD COLUMN IF NOT EXISTS firm_id uuid,
  ADD COLUMN IF NOT EXISTS stage text
    CHECK (stage IS NULL OR stage IN ('pre_draft','in_negotiation','settled','executed','closed')),
  ADD COLUMN IF NOT EXISTS privilege_scope text
    CHECK (privilege_scope IS NULL OR privilege_scope IN ('privileged','work_product','common_interest','open'));

CREATE INDEX IF NOT EXISTS matters_firm_id_idx ON matters (firm_id) WHERE firm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS matters_user_id_idx ON matters (user_id) WHERE user_id IS NOT NULL;

-- Backfill firm_id from firm_users (user_id → firm_id)
UPDATE matters m
SET firm_id = fu.firm_id
FROM firm_users fu
WHERE m.user_id = fu.user_id
  AND m.firm_id IS NULL
  AND fu.status = 'active';

-- Default stage = 'in_negotiation' for non-archived, 'closed' for archived
UPDATE matters
SET stage = CASE WHEN archived THEN 'closed' ELSE 'in_negotiation' END
WHERE stage IS NULL;

-- Default privilege_scope = 'open' (Audrey TCP's default — workspaces
-- select privilege explicitly when needed)
UPDATE matters SET privilege_scope = 'open' WHERE privilege_scope IS NULL;

-- ============================================================
-- 2. matter_memory (firm_id derived from parent matter)
-- ============================================================

ALTER TABLE matter_memory
  ADD COLUMN IF NOT EXISTS firm_id uuid;

CREATE INDEX IF NOT EXISTS matter_memory_firm_id_idx
  ON matter_memory (firm_id) WHERE firm_id IS NOT NULL;

UPDATE matter_memory mm
SET firm_id = m.firm_id
FROM matters m
WHERE mm.matter_id = m.id
  AND mm.firm_id IS NULL
  AND m.firm_id IS NOT NULL;

-- ============================================================
-- 3. documents (firm_id derived from parent matter)
-- ============================================================

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS firm_id uuid;

CREATE INDEX IF NOT EXISTS documents_firm_id_idx
  ON documents (firm_id) WHERE firm_id IS NOT NULL;

UPDATE documents d
SET firm_id = m.firm_id
FROM matters m
WHERE d.matter_id = m.id
  AND d.firm_id IS NULL
  AND m.firm_id IS NOT NULL;

-- ============================================================
-- 4. clients (firm_id from firm_users via user_id)
-- ============================================================

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS firm_id uuid;

CREATE INDEX IF NOT EXISTS clients_firm_id_idx
  ON clients (firm_id) WHERE firm_id IS NOT NULL;

UPDATE clients c
SET firm_id = fu.firm_id
FROM firm_users fu
WHERE c.user_id = fu.user_id
  AND c.firm_id IS NULL
  AND fu.status = 'active';

-- ============================================================
-- Verification (read-only — uncomment to inspect)
-- ============================================================

-- SELECT 'matters' AS t, count(*) AS total, count(firm_id) AS firm_tagged FROM matters
-- UNION ALL SELECT 'matter_memory', count(*), count(firm_id) FROM matter_memory
-- UNION ALL SELECT 'documents', count(*), count(firm_id) FROM documents
-- UNION ALL SELECT 'clients', count(*), count(firm_id) FROM clients;
