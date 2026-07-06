/**
 * Session revocation tools.
 *
 * revoke_my_session — self-serve: the calling user invalidates their
 *   own JWT. Anyone authenticated can call it.
 *
 * revoke_user_session — admin: revoke another user's JWT by email.
 *   Caller must hold role 'owner' or 'admin' in their firm. Target
 *   must be a member of the same firm. Cross-firm revocation is not
 *   allowed (deliberately — admin scope is per-firm, not global).
 *
 * Both end up doing the same thing: stamp firm_users.min_token_iat
 * = now() for the target user, bust the in-memory cache. After ~30s
 * the target's existing JWT becomes invalid and Claude.ai surfaces
 * the disconnect.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { invalidateMinTokenIatCache } from '../auth.js';

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

const text = (s: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(s) }],
});

// ============================================================
// Tool definition
// ============================================================

export const revokeMySessionTool: Tool = {
  name: 'revoke_my_session',
  description:
    'Sign the current user out of Audrey: their JWT is rejected within ~30s and they ' +
    're-authenticate via magic link. Per-user only.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description:
          'Optional note explaining why the user wants to revoke (logged ' +
          'in audit trail, e.g. "testing fresh sign-in", "device lost").',
      },
    },
  },
};

const Input = z.object({
  reason: z.string().max(500).optional(),
});

// ============================================================
// Handler
// ============================================================

export async function handleRevokeMySession(
  args: unknown,
  firmId: string,
  userId: string | null
) {
  if (!userId) {
    return text({
      error:
        'Authenticated user required. revoke_my_session is only available ' +
        'when called via an HTTP-authenticated session — not stdio dev mode.',
    });
  }

  const parsed = Input.safeParse(args);
  if (!parsed.success) {
    return text({ error: parsed.error.message });
  }

  const db = getServiceClient();
  if (!db) {
    return text({
      error:
        'Revocation store unavailable (no service-role key). Operator ' +
        'should check SUPABASE_SERVICE_ROLE_KEY env var.',
    });
  }

  const now = new Date().toISOString();

  // Stamp min_token_iat to now — any JWT with iat before this is rejected
  const { error: updateErr } = await db
    .from('firm_users')
    .update({ min_token_iat: now })
    .eq('user_id', userId)
    .eq('firm_id', firmId);

  if (updateErr) {
    return text({
      error: `Failed to revoke session: ${updateErr.message}`,
    });
  }

  // Bust the in-memory cache so the next request sees the new value
  invalidateMinTokenIatCache(userId, firmId);

  return text({
    result: 'revoked',
    revoked_at: now,
    reason: parsed.data.reason ?? null,
    message:
      'Your session has been revoked. Your current JWT will be rejected ' +
      'within ~30 seconds. Claude will then show the connector as ' +
      'disconnected — click Connect (or re-add the connector) and you will ' +
      'receive a fresh magic-link sign-in email.',
  });
}

// ============================================================
// revoke_user_session — admin tool (firm owner / admin only)
// ============================================================

export const revokeUserSessionTool: Tool = {
  name: 'revoke_user_session',
  description:
    "Admin only (firm owner/admin): revoke another same-firm user's session by email " +
    '(lost device, departure, reset). Effective within ~30s; they sign back in via magic link.',
  inputSchema: {
    type: 'object',
    required: ['email'],
    properties: {
      email: {
        type: 'string',
        description: 'Email of the user whose session you want to revoke.',
      },
      reason: {
        type: 'string',
        description:
          'Optional note explaining why (e.g. "Sam left the firm", "Anna ' +
          'asked for a reset"). Logged in audit trail.',
      },
    },
  },
};

const AdminInput = z.object({
  email: z.string().email(),
  reason: z.string().max(500).optional(),
});

export async function handleRevokeUserSession(
  args: unknown,
  firmId: string,
  callerUserId: string | null
) {
  if (!callerUserId) {
    return text({
      error:
        'Authenticated user required. revoke_user_session is admin-only ' +
        'and cannot be called from stdio dev mode without a real session.',
    });
  }

  const parsed = AdminInput.safeParse(args);
  if (!parsed.success) {
    return text({ error: parsed.error.message });
  }

  const db = getServiceClient();
  if (!db) {
    return text({
      error: 'Revocation store unavailable (no service-role key).',
    });
  }

  // 1. Verify caller's role in this firm is owner or admin
  const { data: callerMembership, error: callerErr } = await db
    .from('firm_users')
    .select('role, status')
    .eq('user_id', callerUserId)
    .eq('firm_id', firmId)
    .maybeSingle();

  if (callerErr) {
    return text({ error: `Authorization check failed: ${callerErr.message}` });
  }
  const callerRole = (callerMembership as { role?: string } | null)?.role;
  const callerStatus = (callerMembership as { status?: string } | null)?.status;
  if (callerStatus !== 'active' || (callerRole !== 'owner' && callerRole !== 'admin')) {
    return text({
      error:
        'Permission denied. revoke_user_session requires firm owner or admin role. ' +
        `Your current role: ${callerRole ?? 'unknown'}.`,
    });
  }

  // 2. Resolve the target email to a user_id
  const targetUserId = await findUserIdByEmail(db, parsed.data.email);
  if (!targetUserId) {
    return text({
      error: `No Audrey user found with email "${parsed.data.email}".`,
    });
  }

  // 3. Confirm target is a member of this firm
  const { data: targetMembership, error: targetErr } = await db
    .from('firm_users')
    .select('role, status')
    .eq('user_id', targetUserId)
    .eq('firm_id', firmId)
    .maybeSingle();

  if (targetErr) {
    return text({
      error: `Failed to look up target user's firm membership: ${targetErr.message}`,
    });
  }
  if (!targetMembership) {
    return text({
      error:
        `User "${parsed.data.email}" exists but is not a member of your firm. ` +
        'Cross-firm revocation is not permitted.',
    });
  }

  // 4. Stamp min_token_iat on the target
  const now = new Date().toISOString();
  const { error: updateErr } = await db
    .from('firm_users')
    .update({ min_token_iat: now })
    .eq('user_id', targetUserId)
    .eq('firm_id', firmId);

  if (updateErr) {
    return text({ error: `Failed to revoke target session: ${updateErr.message}` });
  }

  invalidateMinTokenIatCache(targetUserId, firmId);

  return text({
    result: 'revoked',
    target_email: parsed.data.email,
    target_user_id: targetUserId,
    target_role: (targetMembership as { role?: string }).role,
    revoked_at: now,
    revoked_by_user_id: callerUserId,
    revoked_by_role: callerRole,
    reason: parsed.data.reason ?? null,
    message:
      `Session revoked for ${parsed.data.email}. Their current JWT will be ` +
      'rejected within ~30 seconds. Claude.ai will surface the disconnect ' +
      'on their next tool call; they will then need to sign in again via ' +
      'the magic-link flow.',
  });
}

// ============================================================
// Helper: find a Supabase Auth user by email
// ============================================================
//
// Supabase JS SDK's auth.admin.listUsers doesn't support an email
// filter, so we paginate. For a firm of dozens of users this is
// fast enough; if firms grow into hundreds we cache or add a denorm
// column. Same pattern as scripts/onboard.ts.

async function findUserIdByEmail(
  db: SupabaseClient,
  email: string
): Promise<string | null> {
  const perPage = 200;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error('[audrey-revoke] listUsers failed:', error.message);
      return null;
    }
    const match = data.users.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );
    if (match) return match.id;
    if (data.users.length < perPage) break; // last page
  }
  return null;
}
