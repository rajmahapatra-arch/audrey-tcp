/**
 * OAuth state repository — DCR clients + authorization codes.
 *
 * Service-role access only. The Supabase client used here is the
 * service role client (separate from the anon client used by
 * end-user-facing tool calls). Service role is required because RLS
 * denies all reads/writes from non-service sessions for these tables.
 *
 * The split client pattern matters: an audit-log review needs to see
 * who wrote oauth_codes, and the answer should always be "the OAuth
 * server's service role", never "user session via anon key".
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

let serviceClient: SupabaseClient | null | undefined;

function getServiceClient(): SupabaseClient | null {
  if (serviceClient !== undefined) return serviceClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      '[audrey-oauth] SUPABASE_SERVICE_ROLE_KEY not set — OAuth state ' +
        'cannot be persisted. OAuth flow will fail.'
    );
    serviceClient = null;
    return null;
  }

  serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}

// ============================================================
// Clients (DCR)
// ============================================================

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scope: string;
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
}

export const oauthRepository = {
  async registerClient(input: {
    clientName: string;
    redirectUris: string[];
    grantTypes?: string[];
    responseTypes?: string[];
    scope?: string;
  }): Promise<OAuthClient> {
    const db = getServiceClient();
    if (!db) throw new Error('OAuth state store unavailable');

    const clientId = `audrey-${randomBytes(16).toString('hex')}`;
    const row = {
      client_id: clientId,
      client_name: input.clientName || 'Unnamed client',
      redirect_uris: input.redirectUris,
      grant_types: input.grantTypes ?? ['authorization_code', 'refresh_token'],
      response_types: input.responseTypes ?? ['code'],
      scope: input.scope ?? 'mcp:tools',
      token_endpoint_auth_method: 'none',
    };

    const { error } = await db.from('oauth_clients').insert(row);
    if (error) throw new Error(`Failed to register client: ${error.message}`);

    return {
      clientId,
      clientName: row.client_name,
      redirectUris: row.redirect_uris,
      grantTypes: row.grant_types,
      responseTypes: row.response_types,
      scope: row.scope,
      tokenEndpointAuthMethod: 'none',
    };
  },

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const db = getServiceClient();
    if (!db) return null;

    const { data, error } = await db
      .from('oauth_clients')
      .select('*')
      .eq('client_id', clientId)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      console.error('[audrey-oauth] getClient error:', error.message);
      return null;
    }
    if (!data) return null;

    return {
      clientId: data.client_id,
      clientName: data.client_name,
      redirectUris: data.redirect_uris,
      grantTypes: data.grant_types,
      responseTypes: data.response_types,
      scope: data.scope,
      tokenEndpointAuthMethod: data.token_endpoint_auth_method,
    };
  },

  // ============================================================
  // Authorization codes
  // ============================================================

  async issueCode(input: {
    clientId: string;
    userId: string;
    firmId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256' | 'plain';
    scope?: string;
    ttlSeconds?: number;
  }): Promise<{ code: string; expiresAt: Date }> {
    const db = getServiceClient();
    if (!db) throw new Error('OAuth state store unavailable');

    const code = randomBytes(32).toString('base64url');
    const ttl = input.ttlSeconds ?? 300; // 5 min default
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const { error } = await db.from('oauth_codes').insert({
      code,
      client_id: input.clientId,
      user_id: input.userId,
      firm_id: input.firmId,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: input.codeChallengeMethod,
      scope: input.scope ?? 'mcp:tools',
      expires_at: expiresAt.toISOString(),
    });

    if (error) throw new Error(`Failed to issue code: ${error.message}`);
    return { code, expiresAt };
  },

  /**
   * Redeem a code. Atomically marks it as used so a second attempt
   * fails. Returns the bound state if valid.
   */
  async redeemCode(code: string): Promise<{
    clientId: string;
    userId: string;
    firmId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256' | 'plain';
    scope: string;
  } | null> {
    const db = getServiceClient();
    if (!db) return null;

    // Single-shot redemption: UPDATE ... WHERE redeemed_at IS NULL
    // RETURNING. If two concurrent token requests arrive with the same
    // code, only one wins.
    const { data, error } = await db
      .from('oauth_codes')
      .update({ redeemed_at: new Date().toISOString() })
      .eq('code', code)
      .is('redeemed_at', null)
      .gt('expires_at', new Date().toISOString())
      .select()
      .maybeSingle();

    if (error) {
      console.error('[audrey-oauth] redeemCode error:', error.message);
      return null;
    }
    if (!data) return null;

    return {
      clientId: data.client_id,
      userId: data.user_id,
      firmId: data.firm_id,
      redirectUri: data.redirect_uri,
      codeChallenge: data.code_challenge,
      codeChallengeMethod: data.code_challenge_method,
      scope: data.scope ?? 'mcp:tools',
    };
  },
};
