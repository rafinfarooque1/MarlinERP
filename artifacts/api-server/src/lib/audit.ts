/**
 * Financial mutations MUST await logActivityInTransaction on their own pg
 * transaction client before COMMIT. An audit failure then rolls back with the
 * mutation. logActivity is only a best-effort helper for non-critical events.
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

type AuditQuery = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/** Caller must supply its open transaction client and await before COMMIT.
 * Errors deliberately propagate; do not catch them outside the rollback path.
 */
export async function logActivityInTransaction(q: AuditQuery, opts: AuditOptions): Promise<void> {
  await q.query(
    `INSERT INTO activity_log
       (action, module, entity_type, entity_id, description, "user", type, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      opts.action, opts.module, opts.entityType, opts.entityId ?? null,
      opts.description, opts.user ?? "system", opts.action,
      JSON.stringify(opts.metadata ?? null),
    ],
  );
}

/**
 * Log an audit event. Returns a promise that resolves once the insert
 * completes. Non-critical events only: failures are logged, not propagated.
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
