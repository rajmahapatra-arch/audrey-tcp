-- 001_audit_log_table.sql
--
-- Append-only audit log for Audrey TCP. Captures every meaningful
-- action against customer data: tool calls, configuration changes,
-- authentication events, document ingest.
--
-- This is the FIRST schema migration to commit. It needs to exist
-- before any other table is touched in production, because:
--   1. SOC2 / ISO27001 auditors require evidence of audit logging from
--      day one — not "started logging when we got our first customer"
--   2. Without audit_log in place, debugging production incidents
--      means reading the wrong sources (Railway logs, Supabase logs)
--      that have shorter retention.
--
-- Append-only is enforced at the role level: the audit_writer role
-- (used by the MCP server) has INSERT-only grant. Even the service
-- role does not have UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS audit_log (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid         NOT NULL,
  user_id         uuid,                              -- nullable for system events
  action          text         NOT NULL,            -- 'tool.get_matter', 'auth.login', etc.
  resource_type   text,                             -- 'matter', 'document', 'position'
  resource_id     uuid,                             -- the specific record affected
  result          text         NOT NULL,            -- 'success' | 'denied' | 'error'
  ip_address      inet,
  user_agent      text,
  request_id      uuid,                             -- correlate across log entries
  payload         jsonb,                            -- additional context (e.g. tool args, error msg)
  occurred_at     timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT audit_log_result_valid CHECK (result IN ('success', 'denied', 'error'))
);

-- Indexes for the queries we'll actually run
CREATE INDEX IF NOT EXISTS audit_log_firm_id_occurred_at_idx
  ON audit_log (firm_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_user_id_occurred_at_idx
  ON audit_log (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_log_resource_idx
  ON audit_log (resource_type, resource_id)
  WHERE resource_id IS NOT NULL;

-- Enable RLS — firms can only see their own audit entries
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_firm_isolation ON audit_log
  FOR SELECT
  USING (firm_id = current_setting('audrey.firm_id', true)::uuid);

-- Insert policy: any authenticated session can insert into its own firm's audit log
CREATE POLICY audit_log_insert_own_firm ON audit_log
  FOR INSERT
  WITH CHECK (firm_id = current_setting('audrey.firm_id', true)::uuid);

-- Append-only enforcement at the role level
-- (Run separately under a superuser context, not inside this migration:)
--
--   CREATE ROLE audit_writer LOGIN PASSWORD '...';
--   GRANT INSERT ON audit_log TO audit_writer;
--   REVOKE UPDATE, DELETE ON audit_log FROM audit_writer;
--
-- The MCP server connects as audit_writer when writing audit entries,
-- using a separate connection pool from its main read/write role.

COMMENT ON TABLE audit_log IS
  'Append-only audit log. Append-only enforced at role level (audit_writer role has INSERT only). '
  'Retention: minimum 12 months. Cleanup policy TBD by Stage C compliance review.';
