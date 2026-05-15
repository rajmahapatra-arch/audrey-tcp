/**
 * Auth & firm-id resolution for Audrey TCP.
 *
 * Two transports, two auth models — but the tool handlers see the same
 * shape: they call `resolveFirmId(context)` and get back firmId+userId
 * or an error. Tool handlers never touch tokens or headers.
 *
 *   - stdio (Claude Desktop): the user's local Claude session.
 *     Claude Desktop doesn't broker OAuth into the spawned MCP
 *     subprocess. We read AUDREY_FIRM_ID from env (set in
 *     claude_desktop_config.json's `env` block). Fallback to
 *     'stub-firm-id' for unconfigured local dev.
 *
 *   - HTTP (Railway / Claude for Word / Claude.ai / Cowork): Bearer
 *     JWT in the Authorization header. We verify the signature using
 *     our own public key (the token is one we issued via /token).
 *     firm_id is read from the JWT's `firm_id` claim. user_id from
 *     `sub`.
 *
 * Revocation:
 *   - After cryptographic JWT validation, we look up firm_users.
 *     min_token_iat for this user. If JWT.iat < min_token_iat, the
 *     token is rejected.
 *   - Used by the revoke_my_session MCP tool. The user calls it,
 *     min_token_iat gets stamped to now(), all existing JWTs become
 *     invalid within ~30 seconds (the cache TTL below).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyAccessToken } from './oauth/jwt.js';
import { getBaseUrl } from './oauth/metadata.js';

export interface AuthContext {
  /** The Bearer token, if any. HTTP transport only. */
  bearerToken?: string;
  /** Source label for logging. */
  source: 'stdio' | 'http';
}

export interface ResolvedAuth {
  firmId: string;
  userId: string | null;
  authenticated: boolean;
}

const STUB_FIRM_ID = 'stub-firm-id';

// ============================================================
// Service-role client for min_token_iat lookup
// ============================================================

let serviceClient: SupabaseClient | null | undefined;
function getServiceClient(): SupabaseClient | null {
  if (serviceClient !== undefined) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    serviceClient = null;
    return null;
  }
  serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}

// ============================================================
// In-memory cache for min_token_iat
// ============================================================
//
// Without this cache, every /mcp call would hit the DB for the
// revocation check (~10-20ms latency). The cache keeps it sub-ms
// for the common case. Trade-off: up to CACHE_TTL_MS delay between
// revoke_my_session and JWT actually being rejected, which is fine
// for the demo / dev workflow.
//
// Note: this cache is per-process. Multi-instance deployments would
// need either shared cache (Redis) or shorter TTL. Acceptable for
// Stage A single-instance Railway.

interface CacheEntry {
  minIat: Date | null; // null = never revoked
  fetchedAt: number;
}

const minIatCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

function cacheKey(userId: string, firmId: string): string {
  return `${userId}:${firmId}`;
}

async function getMinTokenIat(
  userId: string,
  firmId: string
): Promise<Date | null> {
  const key = cacheKey(userId, firmId);
  const cached = minIatCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.minIat;
  }

  const db = getServiceClient();
  if (!db) {
    // No service role available — fall back to permissive (no revocation
    // check). Cache the null so we don't hammer the DB.
    minIatCache.set(key, { minIat: null, fetchedAt: Date.now() });
    return null;
  }

  const { data, error } = await db
    .from('firm_users')
    .select('min_token_iat')
    .eq('user_id', userId)
    .eq('firm_id', firmId)
    .maybeSingle();

  if (error) {
    console.error('[audrey-auth] min_token_iat lookup failed:', error.message);
    // Fail open — don't block legitimate users due to a DB hiccup
    minIatCache.set(key, { minIat: null, fetchedAt: Date.now() });
    return null;
  }

  const value = (data as { min_token_iat?: string | null } | null)?.min_token_iat;
  const parsed = value ? new Date(value) : null;
  minIatCache.set(key, { minIat: parsed, fetchedAt: Date.now() });
  return parsed;
}

/**
 * Invalidate the in-memory cache for a user. Called by
 * revoke_my_session after stamping the DB so the next request
 * picks up the new value immediately rather than waiting for
 * TTL expiry.
 */
export function invalidateMinTokenIatCache(
  userId: string,
  firmId: string
): void {
  minIatCache.delete(cacheKey(userId, firmId));
}

// ============================================================
// Main resolver
// ============================================================

export async function resolveFirmId(ctx: AuthContext): Promise<ResolvedAuth> {
  // 1. Try the Bearer token (HTTP path)
  if (ctx.bearerToken) {
    const base = getBaseUrl();
    let claims;
    try {
      claims = await verifyAccessToken(ctx.bearerToken, `${base}/mcp`, base);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid bearer token: ${msg}`);
    }

    // 2. Revocation check
    const minIat = await getMinTokenIat(claims.sub, claims.firm_id);
    if (minIat && claims.iat !== undefined) {
      const tokenIssuedAt = new Date(claims.iat * 1000);
      if (tokenIssuedAt < minIat) {
        throw new Error(
          'Token has been revoked. Please sign in again via your Claude connector.'
        );
      }
    }

    return {
      firmId: claims.firm_id,
      userId: claims.sub,
      authenticated: true,
    };
  }

  // 3. Env-var fallback (stdio + dev HTTP)
  const envFirmId = process.env.AUDREY_FIRM_ID;
  if (envFirmId) {
    return { firmId: envFirmId, userId: null, authenticated: false };
  }

  // 4. Stub fallback — only acceptable when not in production
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'No firm_id resolvable. Provide a valid Bearer token (HTTP) or AUDREY_FIRM_ID env (stdio).'
    );
  }
  return { firmId: STUB_FIRM_ID, userId: null, authenticated: false };
}
