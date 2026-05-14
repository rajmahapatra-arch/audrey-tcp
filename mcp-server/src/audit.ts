/**
 * Audit logging for Audrey TCP.
 *
 * Every meaningful action against customer data lands in the
 * append-only `audit_log` table. See migrations/001_audit_log_table.sql
 * for schema and the "why" rationale.
 *
 * Compliance posture:
 *   - Append-only enforced at role level (audit_writer role has INSERT
 *     only — UPDATE/DELETE revoked). Stage A uses the anon role; Stage
 *     B switches to the dedicated audit_writer role.
 *   - Retention: minimum 12 months (per migration COMMENT). Cleanup
 *     policy reviewed in Stage C compliance pass.
 *
 * Failure mode:
 *   - Audit write failures NEVER block the tool response. We log to
 *     stderr and continue. Rationale: a failed audit write is bad
 *     (we'll catch it via monitoring), but failing the user's tool
 *     call because we couldn't log is worse.
 *   - When Supabase isn't configured (stub mode), all writes are
 *     no-ops. That's expected for local development.
 */

import { getSupabase, isSupabaseConfigured } from './db/supabase.js';

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

/**
 * Write an audit entry. Never throws — failures land on stderr.
 *
 * Fire-and-forget by design: callers don't await this in tool handlers
 * (they wrap it in a Promise.resolve().then so the user's response
 * isn't delayed by audit write latency). For tests / debugging you can
 * still await it.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  if (!isSupabaseConfigured()) {
    // Stub mode — log to stderr so devs can see the audit trail they
    // would have written, then no-op.
    console.error('[audrey-audit:stub]', JSON.stringify(entry));
    return;
  }

  const supabase = getSupabase();
  if (!supabase) return;

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
      // Could be: RLS denial, table doesn't exist (migration not
      // applied), connection failure. All non-fatal for the tool call.
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
