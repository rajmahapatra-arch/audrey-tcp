/**
 * Auth & firm-id resolution for Audrey TCP.
 *
 * Two transports, two auth models — but the tool handlers see the same
 * shape: they call `resolveFirmId(context)` and get back a firmId (or
 * an error). Tool handlers never touch tokens or headers.
 *
 *   - stdio (Claude Desktop): the user's local Claude session.
 *     Claude Desktop doesn't broker OAuth into the spawned MCP
 *     subprocess. We read AUDREY_FIRM_ID from env (set in
 *     claude_desktop_config.json's `env` block). Fallback to
 *     'stub-firm-id' for unconfigured local dev.
 *
 *   - HTTP (Railway / Claude for Word / Cowork): Bearer token in the
 *     Authorization header. We validate via Supabase Auth and read
 *     firm_id from the user's app_metadata. (Until a token validator
 *     is wired, this still falls back to env in dev.)
 *
 * The full OAuth flow (PKCE for Desktop once Anthropic ships the
 * broker, OAuth client-credentials for Word/Cowork) is a separate
 * workstream — tracked in docs/audrey-tcp-plan.md Stage A polish.
 */

import { getSupabase, isSupabaseConfigured } from './db/supabase.js';

export interface AuthContext {
  /** The Bearer token, if any. HTTP transport only. */
  bearerToken?: string;
  /** Source label for logging (e.g. 'stdio', 'http'). */
  source: 'stdio' | 'http';
}

export interface ResolvedAuth {
  firmId: string;
  userId: string | null;
  /** True when the firmId came from a verified token; false when from env fallback. */
  authenticated: boolean;
}

const STUB_FIRM_ID = 'stub-firm-id';

/**
 * Resolve firmId (and userId, if known) from request context.
 *
 * Order of precedence:
 *   1. Validated Bearer token (HTTP only)
 *   2. AUDREY_FIRM_ID env var (stdio, or HTTP dev with no token)
 *   3. STUB_FIRM_ID fallback (with warning)
 */
export async function resolveFirmId(ctx: AuthContext): Promise<ResolvedAuth> {
  // 1. Try the Bearer token (HTTP path)
  if (ctx.bearerToken && isSupabaseConfigured()) {
    const supabase = getSupabase();
    if (supabase) {
      const { data, error } = await supabase.auth.getUser(ctx.bearerToken);
      if (!error && data.user) {
        const meta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
        const firmId = typeof meta.firm_id === 'string' ? meta.firm_id : null;
        if (firmId) {
          return { firmId, userId: data.user.id, authenticated: true };
        }
        // Token valid but user has no firm_id assigned. This is a
        // misconfigured user record — better to error than silently
        // give them stub data.
        throw new Error(
          'Authenticated user has no firm_id in app_metadata. ' +
            'Contact your firm admin or check the user-provisioning script.'
        );
      }
      // Bad token. Don't silently downgrade — the caller might rely on
      // auth being real. Throw and let the transport translate to 401.
      throw new Error(`Invalid bearer token: ${error?.message ?? 'unknown'}`);
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
      'No firm_id resolvable. In production, AUDREY_FIRM_ID must be set or a valid bearer token provided.'
    );
  }
  return { firmId: STUB_FIRM_ID, userId: null, authenticated: false };
}
