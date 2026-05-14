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
 */

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
  /** True when firmId came from a verified token; false when from env fallback. */
  authenticated: boolean;
}

const STUB_FIRM_ID = 'stub-firm-id';

/**
 * Resolve firmId + userId from request context.
 *
 * Order of precedence:
 *   1. Verified Bearer JWT (HTTP only)
 *   2. AUDREY_FIRM_ID env var (stdio, or HTTP dev with no token)
 *   3. STUB_FIRM_ID (non-production only)
 */
export async function resolveFirmId(ctx: AuthContext): Promise<ResolvedAuth> {
  // 1. Try the Bearer token (HTTP path)
  if (ctx.bearerToken) {
    const base = getBaseUrl();
    try {
      const claims = await verifyAccessToken(ctx.bearerToken, `${base}/mcp`, base);
      return {
        firmId: claims.firm_id,
        userId: claims.sub,
        authenticated: true,
      };
    } catch (err) {
      // Bad token. Don't silently downgrade — the caller might rely on
      // auth being real. Throw and let the transport translate to 401.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid bearer token: ${msg}`);
    }
  }

  // 2. Env-var fallback (stdio + dev HTTP)
  const envFirmId = process.env.AUDREY_FIRM_ID;
  if (envFirmId) {
    return { firmId: envFirmId, userId: null, authenticated: false };
  }

  // 3. Stub fallback — only acceptable when not in production
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'No firm_id resolvable. Provide a valid Bearer token (HTTP) or AUDREY_FIRM_ID env (stdio).'
    );
  }
  return { firmId: STUB_FIRM_ID, userId: null, authenticated: false };
}
