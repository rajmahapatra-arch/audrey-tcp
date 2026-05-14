-- 003_firm_users_table.sql
--
-- Link table: which Supabase Auth users belong to which firm.
--
-- The Supabase user's `raw_app_meta_data.firm_id` is the SOURCE OF
-- TRUTH for auth/JWT purposes (it's what the OAuth /token endpoint
-- reads). This table is the QUERYABLE MIRROR for admin operations:
-- "show me everyone in firm X", "who provisioned this user", etc.
--
-- Why both? Because admin queries against Supabase auth.users metadata
-- are awkward (JSONB columns, no good indexing). A flat link table is
-- 100x easier to reason about for SOC2 evidence and day-2 ops.

CREATE TABLE IF NOT EXISTS firm_users (
  user_id     uuid         NOT NULL,
  firm_id     uuid         NOT NULL REFERENCES firms(id),
  role        text         NOT NULL DEFAULT 'member'
                           CHECK (role IN ('owner', 'admin', 'member')),
  added_at    timestamptz  NOT NULL DEFAULT now(),
  added_by    uuid,                                -- the user who added this membership
  status      text         NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'suspended', 'removed')),
  PRIMARY KEY (user_id, firm_id)
);

CREATE INDEX IF NOT EXISTS firm_users_firm_active_idx
  ON firm_users (firm_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS firm_users_user_active_idx
  ON firm_users (user_id) WHERE status = 'active';

-- RLS: members can see their own firm's membership.
ALTER TABLE firm_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY firm_users_self_firm_select ON firm_users
  FOR SELECT
  USING (firm_id = current_setting('audrey.firm_id', true)::uuid);

-- INSERT/UPDATE/DELETE remain service-role-only on purpose.

COMMENT ON TABLE firm_users IS
  'Queryable mirror of Supabase auth.users.raw_app_meta_data.firm_id. '
  'Kept in sync by the onboarding script (scripts/onboard.ts).';
