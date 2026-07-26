/**
 * Module-level authorization middleware.
 *
 * Server-side mirror of the UI permission rules (marlin-erp usePermission.ts):
 *   • level-1 hierarchy        → full access, always
 *   • no permissions row       → viewable by default (matches UI)
 *   • row with can_view=false  → 403
 *
 * Accepts one module name or an any-of list (for endpoints shared by several
 * UI surfaces, e.g. /stock/transfers). Module names must match the Permissions
 * page MODULE_GROUPS exactly.
 */
import { RequestHandler } from "express";
import { pool } from "@workspace/db";

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
      // Allow if ANY of the modules is viewable (no row → default allow, like the UI)
      const allowed = list.some((m) => views[m] !== false);
      if (allowed) {
        next();
        return;
      }
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
 * Granular write-action authorization (Phase 7).
 *
 * Same default-allow semantics as requireModuleView — today every authenticated
 * user can write, so a MISSING permissions row must keep allowing writes
 * (existing behavior preserved). The guard only bites when an admin explicitly
 * saves per-action toggles on the Permissions page:
 *   • level-1 hierarchy   → always allowed
 *   • no permissions row  → allowed (default)
 *   • row with can_<action>=false → 403
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
      const allowed = list.some((m) => flags[m] !== false);
      if (allowed) {
        next();
        return;
      }
      res.status(403).json({
        error: `You don't have permission to ${ACTION_VERB[action]} ${list.join(" or ")}`,
      });
    } catch (e) {
      next(e);
    }
  };
}
