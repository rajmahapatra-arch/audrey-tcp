-- 011_firm_users_min_token_iat.sql
--
-- Adds a "minimum acceptable JWT issued-at" column to firm_users.
-- When a user calls revoke_my_session, we set this to now(). The
-- auth.ts JWT validation reads this and rejects any JWT whose iat
-- is before it. Effect: existing token becomes invalid; the user
-- has to go through the OAuth flow again to get a fresh JWT.
--
-- Per-user revocation (not per-firm) — avoids accidentally taking
-- out other firm members when one user wants to test re-auth.
--
-- Idempotent.

ALTER TABLE firm_users
  ADD COLUMN IF NOT EXISTS min_token_iat timestamptz;

CREATE INDEX IF NOT EXISTS firm_users_min_token_iat_idx
  ON firm_users (user_id, firm_id)
  WHERE min_token_iat IS NOT NULL;

COMMENT ON COLUMN firm_users.min_token_iat IS
  'When non-null, JWTs issued before this timestamp are rejected for '
  'this user. Set by the revoke_my_session MCP tool; cleared on demand '
  'or simply left in place (next legitimate sign-in gets a JWT with '
  'iat > min_token_iat).';
