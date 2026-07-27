/**
 * Module-level authorization middleware.
 *
 * Server-side mirror of the UI permission rules (marlin-erp usePermission.ts):
 *   • level-1 hierarchy        → full access, always
 *   • no permissions row       → DENIED (default-deny; see seeding migration)
 *   • row with can_view=true   → allowed
 *   • row with can_view=false  → denied
 *
 * The seeding migration in index.ts inserts all-true rows for every existing
 * non-level-1 hierarchy so that the switch to default-deny does not revoke
 * access for users that were relying on the old default-allow behaviour.
 * New hierarchies created after the migration start with no rows → denied until
 * an admin explicitly grants access on the Permissions page.
 *
 * Accepts one module name or an any-of list (for endpoints shared by several
 * UI surfaces, e.g. /stock/transfers). Module names must EXACTLY match a `key`
 * in the frontend module registry (marlin-erp src/lib/moduleRegistry.ts).
 */
import { RequestHandler } from "express";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";

// RequestHandler<any> so the guard composes with parameterized routes (e.g. /customers/:id/ledger)
export function requireModuleView(modules: string | string[]): RequestHandler<any> {
  const list = Array.isArray(modules) ? modules : [modules];
  return async (req, res, next) => {
    try {
      const hierarchyId = req.employee?.hierarchyId;
      if (!hierarchyId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const { rows } = await pool.query<any>(
        `SELECT (SELECT level FROM hierarchies WHERE id = $1) AS level,
                (SELECT json_object_agg(module, can_view) FROM permissions
                  WHERE hierarchy_id = $1 AND module = ANY($2::text[])) AS views`,
        [hierarchyId, list],
      );
      const level = Number(rows[0]?.level ?? 99);
      if (level === 1) {
        next();
        return;
      }
      const views: Record<string, boolean | null> = rows[0]?.views ?? {};
      // Default-deny: a missing row is treated as denied, not allowed.
      // Access is granted only when an explicit can_view=true row exists.
      const allowed = list.some((m) => views[m] === true);
      if (allowed) {
        next();
        return;
      }
      // Audit the denial so admins can see what permissions are missing.
      logActivity({
        action: "PERMISSION_DENIED",
        module: list[0] ?? "unknown",
        entityType: "permission_check",
        description: `View denied for module(s) [${list.join(", ")}] — hierarchy ${hierarchyId}`,
        metadata: { modules: list, hierarchyId, path: req.path, method: req.method },
      }).catch(() => {});
      res.status(403).json({
        error: `You don't have permission to view this data (requires ${list.join(" or ")})`,
      });
    } catch (e) {
      next(e);
    }
  };
}

export type ModuleAction = "add" | "edit" | "delete";

const ACTION_COLUMN: Record<ModuleAction, string> = {
  add: "can_add",
  edit: "can_edit",
  delete: "can_delete",
};

const ACTION_VERB: Record<ModuleAction, string> = {
  add: "create records in",
  edit: "edit records in",
  delete: "delete records in",
};

/**
 * Granular write-action authorization.
 *
 * Default-deny semantics — a MISSING permissions row is now denied.
 * The seeding migration ensures all existing hierarchies have explicit rows
 * so no one is accidentally locked out by this change.
 *
 * Rules:
 *   • level-1 hierarchy   → always allowed
 *   • no permissions row  → DENIED
 *   • row with can_<action>=true  → allowed
 *   • row with can_<action>=false → denied
 *
 * Any-of list: allowed when ANY listed module grants the action.
 */
export function requireModuleAction(modules: string | string[], action: ModuleAction): RequestHandler<any> {
  const list = Array.isArray(modules) ? modules : [modules];
  const col = ACTION_COLUMN[action];
  return async (req, res, next) => {
    try {
      const hierarchyId = req.employee?.hierarchyId;
      if (!hierarchyId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const { rows } = await pool.query<any>(
        `SELECT (SELECT level FROM hierarchies WHERE id = $1) AS level,
                (SELECT json_object_agg(module, ${col}) FROM permissions
                  WHERE hierarchy_id = $1 AND module = ANY($2::text[])) AS flags`,
        [hierarchyId, list],
      );
      const level = Number(rows[0]?.level ?? 99);
      if (level === 1) {
        next();
        return;
      }
      const flags: Record<string, boolean | null> = rows[0]?.flags ?? {};
      // Default-deny: only an explicit true row grants the action.
      const allowed = list.some((m) => flags[m] === true);
      if (allowed) {
        next();
        return;
      }
      // Audit the denial.
      logActivity({
        action: "PERMISSION_DENIED",
        module: list[0] ?? "unknown",
        entityType: "permission_check",
        description: `Action '${action}' denied for module(s) [${list.join(", ")}] — hierarchy ${hierarchyId}`,
        metadata: { modules: list, action, hierarchyId, path: req.path, method: req.method },
      }).catch(() => {});
      res.status(403).json({
        error: `You don't have permission to ${ACTION_VERB[action]} ${list.join(" or ")}`,
      });
    } catch (e) {
      next(e);
    }
  };
}
