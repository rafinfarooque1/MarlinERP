/**
 * Module-level authorization middleware.
 *
 * Server-side mirror of the UI permission rules (marlin-erp usePermission.ts):
 *   • level-1 hierarchy        → full access, always
 *   • no permissions row       → DENIED (default-deny)
 *   • row with can_view=true   → allowed
 *   • row with can_view=false  → denied
 *
 * The one-time seeding migrations in index.ts (permission_seed_existing_v1 and
 * per_link_permissions_v1) inserted all-true rows for hierarchies that existed
 * when default-deny was introduced, preserving their prior effective access.
 * Those migrations are guarded by migration_log and cannot re-run. Hierarchies
 * created after those migrations start with NO permission rows and are therefore
 * denied everywhere until an admin grants access on the Permissions page.
 *
 * To identify rows still holding the seeded all-true baseline, use
 * GET /company/permissions/rbac-audit (admin read-only, no data changes).
 *
 * Accepts one page key or an any-of list. An any-of list is the norm, not the
 * exception: one endpoint often feeds several pages (e.g. /items fills dropdowns
 * on nine of them), and the user needs only one of those pages to have a
 * legitimate reason to call it.
 *
 * Names must EXACTLY match a key in PAGE_PERM_KEYS — `page:` plus a sidebar
 * link's href. A name that is not a registered page can never be granted or
 * revoked, because the Permissions page only lists registered keys; the
 * build-time check (scripts/src/check-permissions.ts) fails on one.
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

export type ModuleAction = "add" | "edit" | "delete" | "download" | "print" | "approve" | "share";

const ACTION_COLUMN: Record<ModuleAction, string> = {
  add: "can_add",
  edit: "can_edit",
  delete: "can_delete",
  download: "can_download",
  print: "can_print",
  approve: "can_approve",
  share: "can_share",
};

const ACTION_VERB: Record<ModuleAction, string> = {
  add: "create records in",
  edit: "edit records in",
  delete: "delete records in",
  download: "download",
  print: "print",
  approve: "approve records in",
  share: "share documents from",
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

/**
 * The same decision the two guards above make, for the handful of places that
 * cannot be expressed as middleware — a permission checked halfway through a
 * request (credit-limit overrides) or one that shapes a response instead of
 * rejecting it (quick search hides groups the role cannot see).
 *
 * Those checks used to be written out by hand, and each hand-written copy
 * drifted: they kept legacy module names and default-ALLOW long after the
 * middleware moved to page keys and default-deny. Route code must call this
 * rather than query the permissions table itself.
 */
export async function hasModuleAction(
  hierarchyId: number | undefined,
  modules: string | string[],
  action: ModuleAction | "view",
): Promise<boolean> {
  if (!hierarchyId) return false;
  const list = Array.isArray(modules) ? modules : [modules];
  const col = action === "view" ? "can_view" : ACTION_COLUMN[action];
  const { rows } = await pool.query<any>(
    `SELECT (SELECT level FROM hierarchies WHERE id = $1) AS level,
            (SELECT json_object_agg(module, ${col}) FROM permissions
              WHERE hierarchy_id = $1 AND module = ANY($2::text[])) AS flags`,
    [hierarchyId, list],
  );
  if (Number(rows[0]?.level ?? 99) === 1) return true;
  const flags: Record<string, boolean | null> = rows[0]?.flags ?? {};
  return list.some((m) => flags[m] === true);
}

/**
 * "Does this role hold ANY of these actions on ANY of these pages?"
 *
 * Documents are why this exists. One endpoint mints the invoice PDF for
 * preview, download, print and WhatsApp alike, and the right that justifies the
 * call depends on which button was pressed — download for a saved file, print
 * for the print dialog, either one for a plain look at it. Expressing that as a
 * single action would either lock print-only roles out of printing or hand
 * download-only roles a print path the UI never offered them.
 */
export async function hasAnyModuleAction(
  hierarchyId: number | undefined,
  modules: string | string[],
  actions: ModuleAction[],
): Promise<boolean> {
  for (const action of actions) {
    if (await hasModuleAction(hierarchyId, modules, action)) return true;
  }
  return false;
}

export const HEAD_OFFICE_ONLY_CODE = "HEAD_OFFICE_ONLY";

/**
 * Location guard for company-wide master data.
 *
 * Orthogonal to the module permissions above: those ask "may this ROLE write
 * here?", this asks "may this LOCATION write here?". Both must pass.
 *
 * Item masters are shared by every location — a warehouse renaming an item or
 * flipping its GST rate would silently change what all other locations sell and
 * invoice. Head Office owns them; everyone else reads them. Read routes are
 * deliberately untouched, so warehouses keep full visibility.
 */
export function requireHeadOffice(what = "these records"): RequestHandler<any> {
  return (req, res, next) => {
    const branchType = req.employee?.branchType;
    if (!branchType) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (branchType !== "headoffice") {
      logActivity({
        action: "PERMISSION_DENIED",
        module: "Items",
        entityType: "location_check",
        description: `Head-Office-only write blocked for a ${branchType} user`,
        metadata: { branchType, branchId: req.employee?.branchId, path: req.path, method: req.method },
      }).catch(() => {});
      res.status(403).json({
        error: `Only Head Office can add, edit or delete ${what}. Ask Head Office to make the change — you can still view everything here.`,
        code: HEAD_OFFICE_ONLY_CODE,
      });
      return;
    }
    next();
  };
}
