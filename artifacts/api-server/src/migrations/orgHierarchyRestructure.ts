/**
 * Org hierarchy restructure — Administrator on top, monitoring-only Management.
 *
 * Historically the level-1 root role was named "Management" and held
 * unrestricted access (the level-1 bypass in middleware/permissions.ts).
 * The owner's org design separates the two ideas:
 *
 *   Administrator (root, level 1)  — the system admin. Unrestricted forever.
 *   └── Management (level 2)       — the management team: monitoring, reports
 *       │                            and view access only. NO system admin
 *       │                            rights (settings, permissions, users,
 *       │                            backup/restore, deletes).
 *       └── Owner + Warehouse/Outlet/Accounts/HR/Sales/Purchase Managers
 *
 * The one-time migration RENAMES the existing root row (same id — every
 * employee mapped to it becomes an Administrator with nothing to migrate and
 * no permission rows to move), then builds the standard tree beneath it and
 * reparents any pre-existing non-root roles under the new Management role,
 * where they used to hang off the old "Management" root.
 *
 * Management's rights are seeded as ordinary permission rows (view+download on
 * reports/books/dashboards, view-only on operational pages). Everything NOT
 * seeded is covered by default-deny — the admin-surface denials in the spec
 * are the ABSENCE of rows, not false rows, so the Permissions page shows them
 * exactly like any other unchecked page and an admin can still grant later.
 *
 * `ensureStandardOrgTree` is shared with the factory reset (routes/company.ts):
 * a reset truncates `hierarchies` and `permissions` but not `migration_log`,
 * so without the shared helper a freshly reset company would come back with
 * the root role only and never regain the standard tree.
 */
import type { pool as _pool } from "@workspace/db";
import { PAGE_PERM_KEYS } from "../lib/pagePermissions";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;
/** Anything that can run a parameterised query — the pool or a checked-out client. */
type Querier = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const ADMINISTRATOR_ROLE = "Administrator";
export const MANAGEMENT_ROLE = "Management";

const ADMINISTRATOR_DESC = "System administrator — unrestricted access";
const MANAGEMENT_DESC = "Management team — monitoring, reports and view-only access";

/** The standard manager roles that report to Management. */
const MANAGER_ROLES: ReadonlyArray<[name: string, description: string]> = [
  ["Owner", "Business owner"],
  ["Warehouse Manager", "Runs warehouse operations"],
  ["Outlet Manager", "Runs outlet operations"],
  ["Accounts Manager", "Runs accounting and books"],
  ["HR Manager", "Runs HR, attendance and payroll"],
  ["Sales Manager", "Runs sales and customer relations"],
  ["Purchase Manager", "Runs purchasing and vendors"],
];

// ── Management's seeded permission set ───────────────────────────────────────
// Reports, books, dashboards and the audit log: view + download (download also
// mirrors into the legacy print/share columns — one right for every output
// channel).
const VIEW_DOWNLOAD_PAGES = [
  "page:/",                             // Dashboard
  "page:/production/reports",           // Production reports
  "page:/headoffice/stock-ledger",      // Stock ledger
  "page:/headoffice/inventory-reports", // Inventory reports (incl. valuation)
  "page:/assets/reports",               // Asset reports
  "page:/accounts/ledger",              // Ledger statement
  "page:/accounts/day-book",
  "page:/accounts/cash-book",
  "page:/accounts/bank-book",
  "page:/accounts/trial-balance",       // also carries P&L / Balance Sheet
  "page:/accounts/gst",                 // GST summary
  "page:/accounts/gst-returns",
  "page:/reports/sales",                // Sales/financial reports
  "page:/company/audit",                // Audit log (read-only monitoring)
];

// Operational screens: view only. No add/edit/delete/download — Management
// monitors these modules but cannot write to them or take documents out.
const VIEW_ONLY_PAGES = [
  "page:/sales/pos",
  "page:/sales/quotations",
  "page:/transfers",
  "page:/sales/expenses",
  "page:/accounts/cash-in-outlet",
  "page:/headoffice/stock",
  "page:/customers",
  "page:/production/production",
  "page:/production/purchase",
  "page:/vendors",
  "page:/production/units",
  "page:/production/item-master",
  "page:/headoffice/stock-verification",
  "page:/headoffice/warehouses",
  "page:/headoffice/outlets",
  "page:/headoffice/item-price",
  "page:/assets/purchases",
  "page:/assets/register",
  "page:/assets/categories",
  "page:/assets/transfers",
  "page:/assets/disposal",
  "page:/returns",
  "page:/outstanding",
  "page:/coupons",
  "page:/hr/employees",
  "page:/hr/attendance",
  "page:/hr/payroll",
  "page:/hr/advances",
  "page:/hr/rent",
  "page:/accounts/chart",
  "page:/accounts/cash-bank",
  "page:/accounts/vouchers",
  "page:/accounts/expenses",
  "page:/accounts/reconciliation",
];

// Deliberately NO rows (default-deny): page:/company/settings,
// page:/company/profile, page:/company/permissions, page:/company/login-history,
// page:/company/backup, page:/hr/hierarchy (role/user administration) and the
// two voucher ENTRY surfaces page:/operations/receipt-voucher /
// page:/operations/payment-voucher (pure write forms — the voucher REGISTER is
// covered by page:/accounts/vouchers view).


/** Seed Management's permission rows. Existing rows are never overwritten. */
async function seedManagementPermissions(q: Querier, hierarchyId: number): Promise<void> {
  // Guard against registry drift: a key that no longer exists in
  // PAGE_PERM_KEYS could never be granted/revoked on the Permissions page.
  const known = new Set(PAGE_PERM_KEYS);
  for (const key of [...VIEW_DOWNLOAD_PAGES, ...VIEW_ONLY_PAGES]) {
    if (!known.has(key)) {
      throw new Error(`orgHierarchyRestructure: unknown permission page key '${key}' — update the seed lists to match pagePermissions.ts`);
    }
  }
  const insert = async (module: string, download: boolean) => {
    // Legacy mirror columns follow the five-action fold: print/share mirror
    // download, approve mirrors edit (false here — view-only role).
    await q.query(
      `INSERT INTO permissions
         (hierarchy_id, module, can_view, can_add, can_edit, can_delete,
          can_download, can_print, can_share, can_approve)
       VALUES ($1, $2, true, false, false, false, $3, $3, $3, false)
       ON CONFLICT (hierarchy_id, module) DO NOTHING`,
      [hierarchyId, module, download],
    );
  };
  for (const key of VIEW_DOWNLOAD_PAGES) await insert(key, true);
  for (const key of VIEW_ONLY_PAGES) await insert(key, false);
}

/** Re-derive every role's level from the reporting chain (root = 1). */
async function recomputeLevels(q: Querier): Promise<void> {
  await q.query(`
    WITH RECURSIVE chain AS (
      SELECT id, 1 AS level FROM hierarchies WHERE reports_to_id IS NULL
      UNION ALL
      SELECT h.id, chain.level + 1 FROM hierarchies h JOIN chain ON h.reports_to_id = chain.id
    )
    UPDATE hierarchies h SET level = chain.level
    FROM chain WHERE h.id = chain.id AND h.level <> chain.level
  `);
}

/**
 * Thrown when the existing role data is too ambiguous to restructure safely
 * (duplicate names, a pre-existing "Management" role, a still-unrenamed root).
 * Callers must roll back and NOT record any completion marker, so the attempt
 * repeats after the data is repaired by hand.
 */
export class OrgTreeAmbiguityError extends Error {
  constructor(message: string) {
    super(`org tree restructure refused (fail closed, no marker written): ${message}`);
    this.name = "OrgTreeAmbiguityError";
  }
}

/**
 * Fail closed if ANY two roles share a name case-insensitively (the routes
 * enforce uniqueness, but there is no DB constraint). Restructuring a table
 * with ambiguous names — standard or not — would commit an inconsistent
 * hierarchy behind the one-time marker, with no way to self-correct.
 */
async function assertNoDuplicateRoleNames(client: Querier): Promise<void> {
  const { rows: dupes } = await client.query(
    `SELECT LOWER(TRIM(name)) AS name, COUNT(*)::int AS n
       FROM hierarchies GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 1`,
  );
  if (dupes.length > 0) {
    const list = dupes.map((d: any) => `'${d.name}' x${d.n}`).join(", ");
    throw new OrgTreeAmbiguityError(`duplicate role names found: ${list} — resolve the duplicates, then restart`);
  }
}

/**
 * Build the standard tree beneath the existing root: Management under the
 * root, the seven standard manager roles under Management.
 *
 * Fail-closed contract (throws OrgTreeAmbiguityError, mutating nothing the
 * caller will keep — the caller rolls back):
 *  - the root itself is still named "Management" (a view-only child with the
 *    same name would sit beside a privileged root);
 *  - ANY other role is already named "Management": adopting it would either
 *    retain its configured — possibly write/admin — permission rows behind a
 *    name the owner now reads as monitoring-only, or silently strip rights
 *    someone relies on. Neither is acceptable unattended; rename it first.
 *  - a standard manager name is held by more than one role (uniqueness is
 *    route-enforced only) — picking one arbitrarily would be nondeterministic.
 *
 * A single existing role matching a standard MANAGER name is reparented under
 * Management with its permission rows untouched (those names carry no admin
 * semantics, and the spec puts them there). Management itself is therefore
 * always created fresh here, and always gets exactly the seeded profile.
 *
 * Caller must hold the hierarchies structure advisory lock inside a txn.
 */
async function ensureTreeInTxn(client: Querier): Promise<{ managementId: number | null }> {
  const { rows: [root] } = await client.query(
    `SELECT id, name FROM hierarchies WHERE reports_to_id IS NULL ORDER BY level, id LIMIT 1`,
  );
  if (!root) return { managementId: null };

  await assertNoDuplicateRoleNames(client);

  if (String(root.name).trim().toLowerCase() === MANAGEMENT_ROLE.toLowerCase()) {
    throw new OrgTreeAmbiguityError("the root role is still named 'Management' — it must be renamed (normally to 'Administrator') first");
  }

  const { rows: mgmtClashes } = await client.query(
    `SELECT id, name FROM hierarchies WHERE LOWER(TRIM(name)) = LOWER($1) AND id <> $2`,
    [MANAGEMENT_ROLE, root.id],
  );
  if (mgmtClashes.length > 0) {
    throw new OrgTreeAmbiguityError(`a role named 'Management' already exists (id ${mgmtClashes[0].id}) — rename it, then restart`);
  }

  const { rows: [mgmt] } = await client.query(
    `INSERT INTO hierarchies (name, level, reports_to_id, description)
     VALUES ($1, 2, $2, $3) RETURNING id`,
    [MANAGEMENT_ROLE, root.id, MANAGEMENT_DESC],
  );

  // The seven standard manager roles, under Management.
  for (const [name, description] of MANAGER_ROLES) {
    const { rows: existing } = await client.query(
      `SELECT id, reports_to_id FROM hierarchies WHERE LOWER(TRIM(name)) = LOWER($1) ORDER BY id`,
      [name],
    );
    if (existing.length > 1) {
      throw new OrgTreeAmbiguityError(`${existing.length} roles are named '${name}' — resolve the duplicate names, then restart`);
    }
    const match = existing[0];
    if (!match) {
      await client.query(
        `INSERT INTO hierarchies (name, level, reports_to_id, description)
         VALUES ($1, 3, $2, $3)`,
        [name, mgmt.id, description],
      );
    } else if (match.id !== root.id && match.id !== mgmt.id && match.reports_to_id !== mgmt.id) {
      await client.query(`UPDATE hierarchies SET reports_to_id = $1 WHERE id = $2`, [mgmt.id, match.id]);
    }
  }

  await seedManagementPermissions(client, mgmt.id);
  return { managementId: mgmt.id };
}

/**
 * Standalone tree builder for the factory reset: after `hierarchies` and
 * `permissions` are truncated and the Administrator root is reseeded, this
 * recreates the standard org tree (the one-time migration below cannot re-run
 * because migration_log survives the reset by design).
 */
export async function ensureStandardOrgTree(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Same lock every hierarchy structure edit takes (routes/hr.ts), so the
    // tree cannot be rewired underneath a concurrent create/reparent.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('hierarchies_structure'))`);
    await ensureTreeInTxn(client);
    await recomputeLevels(client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** One-time restructure. Guarded by migration_log — never re-runs. */
export async function runOrgHierarchyRestructure(pool: Pool): Promise<void> {
  const { rows: done } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'org_hierarchy_restructure_v1'`,
  );
  if (done.length > 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('hierarchies_structure'))`);

    // Fail closed on structural corruption: the routes guarantee a single
    // root, but if the data ever disagrees, restructuring an ambiguous forest
    // would pick an arbitrary winner and leave extra level-1 super-admins.
    // Leave everything untouched and DO NOT write the marker — the migration
    // retries on every boot until the tree is repaired by hand.
    const { rows: roots } = await client.query(
      `SELECT id, name FROM hierarchies WHERE reports_to_id IS NULL ORDER BY level, id`,
    );
    if (roots.length > 1) {
      console.error(`[migration] org_hierarchy_restructure_v1 SKIPPED (will retry next boot): ${roots.length} parentless root roles found — repair the hierarchy to a single root first`);
      await client.query("ROLLBACK");
      return;
    }
    const root = roots[0];

    if (root) {
      // Fail closed on ANY duplicate role name — standard or not — BEFORE the
      // first mutation. Throws; the catch below rolls everything back and the
      // marker is never written, so the migration retries after manual repair.
      await assertNoDuplicateRoleNames(client);

      // Rename the root "Management" → "Administrator". Same row, same id:
      // employees mapped to it keep full access through the level-1 bypass.
      // Skipped if the owner already renamed the root to something else.
      if (String(root.name).trim().toLowerCase() === MANAGEMENT_ROLE.toLowerCase()) {
        const { rows: [clash] } = await client.query(
          `SELECT 1 FROM hierarchies WHERE LOWER(TRIM(name)) = LOWER($1) AND id <> $2 LIMIT 1`,
          [ADMINISTRATOR_ROLE, root.id],
        );
        if (clash) {
          // A non-root role already holds the Administrator name (the routes
          // forbid duplicates, so honour that here too). Renaming the root
          // would duplicate it; NOT renaming while continuing would leave a
          // privileged root named "Management" beside a view-only Management —
          // fail closed instead and retry after the clash is resolved.
          console.error("[migration] org_hierarchy_restructure_v1 SKIPPED (will retry next boot): another role is already named 'Administrator' — rename it, then restart");
          await client.query("ROLLBACK");
          return;
        }
        await client.query(
          `UPDATE hierarchies SET name = $1, description = $2 WHERE id = $3`,
          [ADMINISTRATOR_ROLE, ADMINISTRATOR_DESC, root.id],
        );
      }

      // Roles that reported directly to the old "Management" root were
      // reporting to management — after the split they belong under the NEW
      // Management role, not under the system Administrator. Capture them
      // before the tree builder adds the new children.
      const { rows: oldChildren } = await client.query(
        `SELECT id FROM hierarchies WHERE reports_to_id = $1`, [root.id],
      );

      const { managementId } = await ensureTreeInTxn(client);

      if (managementId != null) {
        const moveIds = oldChildren.map((r: any) => r.id).filter((id: number) => id !== managementId);
        if (moveIds.length > 0) {
          await client.query(
            `UPDATE hierarchies SET reports_to_id = $1 WHERE id = ANY($2::int[])`,
            [managementId, moveIds],
          );
        }
      }

      await recomputeLevels(client);

      // Post-condition before the marker commits: exactly one level-1 role
      // (the level-1 bypass makes every extra one a super-admin). A throw
      // rolls back everything, so the migration retries next boot.
      const { rows: [{ n }] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM hierarchies WHERE level = 1`,
      );
      if (n !== 1) throw new Error(`org_hierarchy_restructure_v1: expected exactly 1 level-1 role after restructure, found ${n}`);
    }

    await client.query(
      `INSERT INTO migration_log (name) VALUES ('org_hierarchy_restructure_v1') ON CONFLICT (name) DO NOTHING`,
    );
    await client.query("COMMIT");
    console.log("[migration] org_hierarchy_restructure_v1: root renamed to Administrator, standard org tree ensured");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
