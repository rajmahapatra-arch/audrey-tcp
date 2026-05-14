-- 002_firms_table.sql
--
-- The parent table that firm_id columns (already used by audit_log,
-- and by the existing matter_memory rows) should be pointing at.
--
-- Why this lands now and not earlier:
--   - Stage A day-one didn't need it; firm_id was just a stub UUID.
--   - The OAuth/onboarding work needs a place to store firm metadata
--     (name, status, created_by) so the demo script can do
--     "create firm + create user + send magic link" in one shot.
--
-- Forward-only convention: no retroactive foreign keys on existing
-- tables that reference firm_id (audit_log, matter_memory). Backfill
-- happens in Stage B's migration phase.

CREATE TABLE IF NOT EXISTS firms (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text         NOT NULL,
  status      text         NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'suspended', 'archived')),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  created_by  uuid,                                -- the user who provisioned this firm
  metadata    jsonb        NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS firms_active_idx ON firms (id) WHERE status = 'active';

-- RLS: firms can only see themselves (read).
ALTER TABLE firms ENABLE ROW LEVEL SECURITY;

CREATE POLICY firms_self_select ON firms
  FOR SELECT
  USING (id = current_setting('audrey.firm_id', true)::uuid);

-- Inserts/updates happen via the service role (out-of-band onboarding
-- script), not via RLS-scoped sessions. No INSERT/UPDATE policies on
-- purpose — restrict to admin paths.

COMMENT ON TABLE firms IS
  'Parent table for firm_id. Created Stage A; existing firm_id values '
  'in audit_log/matter_memory are not retroactively foreign-keyed. '
  'Backfill happens in Stage B migration phase.';
