-- 005_oauth_codes_table.sql
--
-- OAuth 2.0 authorization codes — single-use, short-lived tokens
-- minted after successful user authentication. The client exchanges
-- them at /token for the real access token (JWT).
--
-- Security properties:
--   - Single-use: redeemed exactly once. Subsequent attempts rejected.
--   - Short TTL: 10 minutes max (we set 5).
--   - PKCE-bound: stores the code_challenge so /token can verify the
--     code_verifier matches. Without PKCE, a leaked code is enough to
--     impersonate the user. With PKCE, the attacker also needs the
--     verifier that only the original client knew.
--
-- Cleanup: expired/redeemed codes can be purged by a scheduled job
-- (Stage B). For Stage A they sit there harmlessly.

CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  text         PRIMARY KEY,
  client_id             text         NOT NULL REFERENCES oauth_clients(client_id),
  user_id               uuid         NOT NULL,            -- the authenticated user
  firm_id               uuid         NOT NULL REFERENCES firms(id),
  redirect_uri          text         NOT NULL,
  code_challenge        text         NOT NULL,
  code_challenge_method text         NOT NULL
                                     CHECK (code_challenge_method IN ('S256', 'plain')),
  scope                 text,
  issued_at             timestamptz  NOT NULL DEFAULT now(),
  expires_at            timestamptz  NOT NULL,
  redeemed_at           timestamptz                       -- non-null after exchange = burnt
);

CREATE INDEX IF NOT EXISTS oauth_codes_unredeemed_idx
  ON oauth_codes (code) WHERE redeemed_at IS NULL;

-- Service-role-only.
ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE oauth_codes IS
  'Single-use OAuth authorization codes. PKCE-bound. Service-role only.';
