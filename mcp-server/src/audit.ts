/**
 * Audit logging for Audrey TCP.
 *
 * Every meaningful action against customer data lands in the
 * append-only `audit_log` table. See migrations/001_audit_log_table.sql
 * for schema and the "why" rationale.
 *
 * Compliance posture:
 *   - Append-only enforced at role level (audit_writer role with
 *     INSERT only, UPDATE/DELETE revoked). Stage B creates that
 *     dedicated role; Stage A uses the service-role key to bypass
 *     audit_log's RLS — the safety property we care about today is
 *     "audit writes always succeed", not "the writer role itself is
 *     constrained to INSERT".
 *
 *   - Why NOT the anon client: audit_log has an RLS insert policy
 *     that requires `current_setting('audrey.firm_id')` to match the
 *     row's firm_id. We don't set that variable per-request (it
 *     requires either a custom RPC or a connection-per-request
 *     pattern). Service-role bypasses RLS entirely, which is the
 *     correct behaviour for a privileged auditor.
 *
 *   - Retention: minimum 12 months (per migration COMMENT). Cleanup
 *     policy reviewed in Stage C compliance pass.
 *
 * Failure mode:
 *   - Audit write failures NEVER block the tool response. We log to
 *     stderr and continue. Rationale: a failed audit write is bad
 *     (we'll catch it via monitoring), but failing the user's tool
 *     call because we couldn't log is worse.
 *   - When Supabase isn't configured (stub mode), all writes are
 *     no-ops with a [audrey-audit:stub] log line.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type AuditResult = 'success' | 'denied' | 'error';

export interface AuditEntry {
  firmId: string;
  userId?: string | null;
  action: string; // e.g. 'tool.get_matter', 'auth.login'
  resourceType?: string | null; // 'matter', 'document', 'position'
  resourceId?: string | null;
  result: AuditResult;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  payload?: Record<string, unknown> | null;
}

// ============================================================
// Service-role audit client (singleton, lazy)
// ============================================================

let serviceClient: SupabaseClient | null | undefined;

function getAuditClient(): SupabaseClient | null {
  if (serviceClient !== undefined) return serviceClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    // Stub mode — caller logs the [audrey-audit:stub] line instead.
    serviceClient = null;
    return null;
  }

  serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}

/**
 * Write an audit entry. Never throws — failures land on stderr.
 *
 * Fire-and-forget by design: callers don't await this in tool handlers
 * (they wrap it in a Promise.resolve().then so the user's response
 * isn't delayed by audit write latency). For tests / debugging you can
 * still await it.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  const supabase = getAuditClient();
  if (!supabase) {
    // Stub mode — log to stderr so devs can see the audit trail they
    // would have written, then no-op.
    console.error('[audrey-audit:stub]', JSON.stringify(entry));
    return;
  }

  try {
    const { error } = await supabase.from('audit_log').insert({
      firm_id: entry.firmId,
      user_id: entry.userId ?? null,
      action: entry.action,
      resource_type: entry.resourceType ?? null,
      resource_id: entry.resourceId ?? null,
      result: entry.result,
      ip_address: entry.ipAddress ?? null,
      user_agent: entry.userAgent ?? null,
      request_id: entry.requestId ?? null,
      payload: entry.payload ?? null,
    });

    if (error) {
      console.error(
        '[audrey-audit] write failed:',
        error.message,
        '— entry:',
        JSON.stringify(entry)
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[audrey-audit] unexpected error:', msg);
  }
}

/**
 * Helper for tool handlers: emit an audit entry without awaiting.
 * Use this in the request handler so audit latency never blocks the
 * tool response.
 */
export function auditAsync(entry: AuditEntry): void {
  // Fire-and-forget; writeAudit swallows its own errors.
  void writeAudit(entry);
}
