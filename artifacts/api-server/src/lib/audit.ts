/**
 * Lightweight fire-and-forget audit logging helper.
 * Call this after every successful mutation — never await in the hot path
 * (unless you explicitly want to block). Errors are swallowed so a logging
 * failure never breaks the request.
 */
import { db, activityLogTable } from "@workspace/db";

export type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "PERMISSION_DENIED";

export interface AuditOptions {
  action: AuditAction;
  module: string;       // e.g. "sales" | "purchases" | "production" | "hr" | "payroll"
  entityType: string;   // e.g. "sale" | "employee" | "production"
  entityId?: number;
  description: string;  // human-readable summary
  user?: string;        // username / employee name
  metadata?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

/**
 * Log an audit event. Returns a promise that resolves once the insert
 * completes, but callers should generally fire-and-forget with `.catch(()=>{})`.
 */
export async function logActivity(opts: AuditOptions): Promise<void> {
  try {
    await db.insert(activityLogTable).values({
      action: opts.action,
      module: opts.module,
      entityType: opts.entityType,
      entityId: opts.entityId ?? null,
      description: opts.description,
      user: opts.user ?? "system",
      type: opts.action,            // keep legacy type field in sync
      metadata: (opts.metadata as any) ?? null,
    });
  } catch (err) {
    // Never let logging errors propagate to the caller
    console.error("[audit] Failed to write log:", err);
  }
}
