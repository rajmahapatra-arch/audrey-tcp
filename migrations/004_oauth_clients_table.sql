-- 004_oauth_clients_table.sql
--
-- OAuth 2.0 Dynamic Client Registration (RFC 7591) storage.
--
-- When Claude.ai (or Claude for Word, or Cowork, or any MCP-capable
-- surface) discovers our server, it registers itself via POST /register.
-- We mint a client_id, store its metadata here, and return it. From
-- then on the client_id appears in every /authorize and /token request
-- so we can look it up here and validate things like redirect_uri.
--
-- We don't issue client_secrets — PKCE is mandatory per the MCP OAuth
-- profile (2025-06-18). Public clients only.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id       text         PRIMARY KEY,
  client_name     text         NOT NULL,
  redirect_uris   text[]       NOT NULL,
  grant_types     text[]       NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
  response_types  text[]       NOT NULL DEFAULT ARRAY['code'],
  scope           text         NOT NULL DEFAULT 'mcp:tools',
  token_endpoint_auth_method text NOT NULL DEFAULT 'none'
                              CHECK (token_endpoint_auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  metadata        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  -- For revocation / admin actions
  status          text         NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'revoked'))
);

CREATE INDEX IF NOT EXISTS oauth_clients_active_idx
  ON oauth_clients (client_id) WHERE status = 'active';

-- Service-role-only table; no RLS policies needed because no user
-- session should ever query it directly. ALTER TABLE ... ENABLE RLS
-- with no policies = deny-all-by-default for non-service-role.
ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE oauth_clients IS
  'OAuth 2.0 DCR client records. Public clients only (PKCE mandatory). '
  'Service-role only — never queried via end-user sessions.';
