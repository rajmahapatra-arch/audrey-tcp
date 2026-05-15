/**
 * revoke_my_session — let the user invalidate their current JWT.
 *
 * Use case: lawyer wants to "sign out" or "reset" their connection
 * to Audrey from any surface (Claude.ai, Claude for Word, Claude
 * Desktop). After calling this, the existing JWT becomes invalid
 * within ~30 seconds (cache TTL), Claude's connector surfaces the
 * disconnect, the user re-authenticates fresh.
 *
 * Implementation:
 *   - Sets firm_users.min_token_iat = now() for this (user, firm) row
 *   - Invalidates the in-memory cache so subsequent /mcp calls
 *     immediately see the new value
 *   - Does NOT proactively notify Claude.ai — the connector finds out
 *     when its next tool call returns "token revoked"
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
  content: [{ type: 'text' as const, text: JSON.stringify(s, null, 2) }],
});

// ============================================================
// Tool definition
// ============================================================

export const revokeMySessionTool: Tool = {
  name: 'revoke_my_session',
  description: [
    "Revoke the user's current Audrey JWT and force a fresh sign-in.",
    'Use this when the user asks to "sign out of Audrey", "reset my',
    'session", "force re-auth", or wants to test the sign-in flow fresh.',
    '',
    'After calling this, the existing token becomes invalid within',
    'about 30 seconds. Claude.ai (or Claude for Word) will surface the',
    "disconnect and prompt the user to reconnect — they'll go through",
    'the magic-link email flow again.',
    '',
    'Per-user only — does not affect other members of the firm.',
  ].join(' '),
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
