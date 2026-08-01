import { Router } from "express";
import { db, pool, accountLedgersTable, cashBankAccountsTable, expensesTable, salesTable, purchasesTable, warehousesTable } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { isIsoDate } from "../lib/dateInput";
import { optionalMoney } from "../lib/numericInput";
import { validationMessage } from "../lib/validationMessage";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import {
  CreateAccountLedgerBody, UpdateAccountLedgerBody,
  CreateCashBankAccountBody, CreateExpenseBody,
  GetLedgerStatementQueryParams,
} from "@workspace/api-zod";
import { nextVoucherNumber, VOUCHER_TYPE_LABELS } from "../lib/voucherNumber";
import { lineTaxHeads } from "../lib/gst";
import { logActivity } from "../lib/audit";
import { closingStockValuation } from "../lib/valuation";
import { buildBooks } from "../lib/books";
import { buildDerivedPostings } from "./journal";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { getUserDataScope, scopeSalesWhere, scopeBranchWhere } from "../lib/dataScope";
import { parseDateRange, pushDateRange, pushLocationFilter } from "../lib/queryFilters";
import { getLocationFilter, getPostingLocationFilter } from "../lib/requestLocation";
import { parsePaging, setPagingHeaders, applyPaging } from "../lib/paging";
import {
  callerLocation, ownLocationScope, scopeLedgerIds, scopeCashLedgerIds, scopeMoneyWhere,
  checkVoucherLegs, foreignLocationLedgerIds,
} from "../lib/moneyScope";
import { loadLedgerUsage, deleteBlockReason } from "../lib/chartGroups";
import { parsePostingLocationFilter, companyLevelSummary, type PostingLocationFilter } from "../lib/postingLocation";
import { resolveGstScope, salesScopeCond, purchaseScopeCond } from "../lib/gstinScope";

/**
 * Location condition on a SOURCE DOCUMENT row, mirroring how the derived
 * posting stream stamps that document's postings (lib/postingLocation.ts):
 *
 *  - `fallback: 'headoffice'` for tables whose unstamped rows have always been
 *    treated as Head Office (payments, receipts, expenses, purchases).
 *  - `fallback: null` for tables where an unstamped row is company-level
 *    (sales) — such rows match only the 'company' filter.
 *  - 'headoffice' matches on type alone; the placeholder id differs per table.
 *
 * Returns " AND ..." to splice after an existing WHERE, pushing bind values
 * onto `params`.
 */
function documentLocationCond(
  f: PostingLocationFilter | null,
  alias: string,
  params: unknown[],
  fallback: "headoffice" | null,
): string {
  if (!f) return "";
  const typeExpr = fallback ? `COALESCE(${alias}.location_type, '${fallback}')` : `${alias}.location_type`;
  if (f.type === "company") return fallback ? ` AND FALSE` : ` AND ${alias}.location_type IS NULL`;
  if (f.type === "headoffice") return ` AND ${typeExpr} = 'headoffice'`;
  params.push(f.type);
  const t = `$${params.length}`;
  params.push(f.id);
  const i = `$${params.length}`;
  return ` AND ${typeExpr} = ${t} AND COALESCE(${alias}.location_id, 0) = ${i}::int`;
}

const router = Router();

// ── Chart of Accounts (tree) ───────────────────────────────────────────────
// Consumers: Chart of Accounts page, and the Expenses page's ledger dropdown.
router.get("/accounts/chart", requireModuleView(["page:/accounts/chart", "page:/accounts/expenses"]), async (_req, res): Promise<void> => {
  const [result, usage] = await Promise.all([
    pool.query(`SELECT * FROM account_ledgers ORDER BY name`),
    loadLedgerUsage(pool),
  ]);
  const rows = result.rows;

  // Build tree in memory
  const map = new Map<number, any>();
  rows.forEach((r: any) => map.set(r.id, {
    id: r.id,
    name: r.name,
    type: r.type,
    parentId: r.parent_id ?? null,
    description: r.description ?? null,
    code: r.code ?? null,
    section: r.section ?? null,
    isSystemGroup: r.is_system_group ?? false,
    isGroup: r.is_group ?? false,
    isActive: r.is_active ?? true,
    createdAt: r.created_at,
    children: [],
    balance: 0,
  }));
  const roots: any[] = [];
  rows.forEach((r: any) => {
    const node = map.get(r.id)!;
    if (r.parent_id && map.has(r.parent_id)) {
      map.get(r.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });

  // Structure management needs to know what may be edited BEFORE offering the
  // action: a delete button that fails on click is worse than no button.
  // Computed after the tree so child counts are known.
  for (const node of map.values()) {
    const u = usage.get(node.id);
    node.transactionCount = u?.transactions ?? 0;
    node.childCount = node.children.length;
    node.canRename = !node.code && !node.isSystemGroup;
    node.deleteBlockedReason = deleteBlockReason(
      { isSystemGroup: node.isSystemGroup, code: node.code, childCount: node.children.length },
      u,
    );
  }
  res.json(roots);
});

// Also expose flat list for dropdowns
// Fills account dropdowns on Journal, Contra/Notes, Vouchers and Ledger.
router.get("/accounts/chart/flat", requireModuleView(["page:/accounts/vouchers", "page:/accounts/ledger", "page:/operations/receipt-voucher", "page:/operations/payment-voucher"]), async (_req, res): Promise<void> => {
  // Deactivated ledgers are withheld: this list exists to be selected from, and
  // a deactivated ledger must not attract new postings.
  const result = await pool.query(`SELECT * FROM account_ledgers WHERE COALESCE(is_active, true) ORDER BY id`);
  res.json(result.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    parentId: r.parent_id ?? null,
    description: r.description ?? null,
    code: r.code ?? null,
    section: r.section ?? null,
    isSystemGroup: r.is_system_group ?? false,
    isGroup: r.is_group ?? false,
    bankDetails: r.bank_details ?? null,
    balance: 0,
  })));
});

// Cash/Bank ledgers only — for Received In / Paid From dropdowns
// Serves Cash & Bank and Expenses pages.
router.get("/accounts/cash-bank-ledgers", requireModuleView(["page:/accounts/cash-bank", "page:/accounts/expenses", "page:/accounts/vouchers", "page:/vendors", "page:/sales/expenses", "page:/hr/payroll", "page:/hr/advances", "page:/operations/receipt-voucher", "page:/operations/payment-voucher"]), async (req, res): Promise<void> => {
  const { rows } = await pool.query(`SELECT * FROM account_ledgers ORDER BY id`);
  const bankRoot = rows.find((r: any) => r.code === 'STD-BANK');
  const cashRoot = rows.find((r: any) => r.code === 'STD-CASH');
  const ids = new Set<number>();
  if (bankRoot) ids.add(bankRoot.id);
  if (cashRoot) ids.add(cashRoot.id);
  // Multi-level descendant walk (up to 4 levels)
  for (let i = 0; i < 4; i++) {
    for (const r of rows) {
      if (r.parent_id && ids.has(r.parent_id)) ids.add(r.id);
    }
  }
  // LBAC: this list populates the "money account" pickers on Payments and
  // Receipts. A branch may only move its OWN cash, so it sees exactly one
  // account: its own till. Head Office keeps the full cash + bank tree.
  const cbScope = ownLocationScope((req as any).employee);
  if (!cbScope.isHeadOffice) {
    const own = await scopeCashLedgerIds(cbScope);
    for (const id of Array.from(ids)) if (!own.includes(id)) ids.delete(id);
  }
  // Deactivated tills and bank accounts stay out of the picker.
  res.json(rows.filter((r: any) => ids.has(r.id) && (r.is_active ?? true)).map((r: any) => ({
    id: r.id, name: r.name, type: r.type,
    parentId: r.parent_id ?? null, code: r.code ?? null,
    bankDetails: r.bank_details ?? null,
  })));
});

// Manual structure creation. AUTOMATIC provisioning (a ledger per customer,
// vendor, employee, location and standard chart account) is unchanged and still
// the primary path — this only lets an authorised administrator/accountant hand-
// build valid structure alongside it.
//
// Four shapes are accepted, all keyed off `isGroup` plus the parent's own shape:
//
//   · GROUP / SUB-GROUP  (isGroup === true)  — a container, holds no postings.
//     Parent must be another group (system head or user sub-group).
//
//   · LEDGER             (isGroup !== true)  — a postable leaf under a GROUP.
//     Parent must be a group; you cannot file a ledger directly under another
//     postable ledger's group head unless that head is a group (all SYS/STD
//     heads are). This is what makes it a valid posting ledger under a valid
//     parent.
//
//   · SUB-LEDGER         (isGroup !== true)  — a postable leaf under a LEDGER,
//     mirroring how Cash / Bank carry a sub-ledger per till or bank account.
//     Parent is a leaf ledger (is_group = false) that is NOT system-owned via a
//     code check below is relaxed: sub-ledgers under STD-CASH / STD-BANK are a
//     first-class, supported shape, so any non-system-*group* leaf is allowed.
//
// The `code` is NEVER read from the body. A code is the sole marker that makes a
// ledger system-owned (it drives the rename block, the delete/deactivate block
// and every provisioning lookup in lib/chartGroups.ts). Hand-made accounts are
// therefore codeless, exactly like hand-made groups: that is what keeps them
// renamable, movable, deactivatable and — while empty — deletable, and it keeps
// the existing delete guard (loadLedgerUsage → deleteBlockReason) fully in force
// for them, so one with transaction history can never be destroyed.
router.post("/accounts/chart", requireModuleAction("page:/accounts/chart", "add"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const wantGroup = body.isGroup === true;
  const kindWord = wantGroup ? "group" : "ledger";

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2)  { res.status(400).json({ error: `Give the ${kindWord} a name of at least 2 characters.` }); return; }
  if (name.length > 120) { res.status(400).json({ error: `${wantGroup ? "Group" : "Ledger"} names are limited to 120 characters.` }); return; }

  const parentId = Number(body.parentId);
  if (!Number.isFinite(parentId)) { res.status(400).json({ error: "Choose the account this sits inside." }); return; }

  const { rows: [parent] } = await pool.query(
    `SELECT id, type, section, is_group, is_system_group, is_active FROM account_ledgers WHERE id = $1`, [parentId],
  );
  if (!parent) { res.status(404).json({ error: "That parent no longer exists — reload the page." }); return; }

  const parentIsGroup = parent.is_group || parent.is_system_group;

  // Parent validity — the backend decides this, never the client.
  if (wantGroup) {
    // A sub-group belongs inside a group only.
    if (!parentIsGroup) {
      res.status(400).json({ error: "A sub-group can only be added inside a group, not under a ledger." });
      return;
    }
  } else {
    // A ledger belongs under a group (→ posting ledger) OR under a postable
    // leaf ledger (→ sub-ledger). Both are valid; nothing else is.
    if (parent.is_system_group === false && parent.is_group === false) {
      // parent is a leaf ledger → sub-ledger. Allowed.
    } else if (parentIsGroup) {
      // parent is a group → posting ledger. Allowed.
    } else {
      res.status(400).json({ error: "A ledger must sit inside a group, or under another ledger as a sub-ledger." });
      return;
    }
  }

  // Do not hang new structure off a deactivated parent — it would be born
  // unreachable for new entries.
  if (parent.is_active === false) {
    res.status(400).json({ error: "That parent is deactivated. Reactivate it first, or pick another parent." });
    return;
  }

  const { rows: [dupe] } = await pool.query(
    `SELECT id FROM account_ledgers WHERE parent_id = $1 AND lower(name) = lower($2) LIMIT 1`, [parentId, name],
  );
  if (dupe) { res.status(409).json({ error: `"${name}" already exists here.` }); return; }

  // A user-made account carries no code, which is what keeps it renamable and
  // deletable — the same rule that protects the system groups/ledgers.
  const description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : null;
  const { rows: [created] } = await pool.query(
    `INSERT INTO account_ledgers (name, type, parent_id, section, description, is_group, is_system_group, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, false, true)
     RETURNING id, name, type, parent_id, section, description, is_group`,
    [name, parent.type, parentId, parent.section ?? null, description, wantGroup],
  );

  await logActivity({
    action: "CREATE", module: "accounts",
    entityType: wantGroup ? "account_group" : "account_ledger", entityId: created.id,
    description:
      `Added chart ${wantGroup ? "group" : "ledger"} "${name}" ` +
      `[before: none · after: name="${name}", type=${created.type}, parentId=${parentId}, isGroup=${wantGroup}]`,
    user: (req as any).employee?.username ?? "system",
  });

  res.status(201).json({
    id: created.id, name: created.name, type: created.type,
    parentId: created.parent_id ?? null, section: created.section ?? null,
    description: created.description ?? null,
    code: null, isGroup: created.is_group ?? wantGroup, isSystemGroup: false, isActive: true,
    canRename: true, deleteBlockedReason: null, transactionCount: 0, childCount: 0,
    children: [], balance: 0,
  });
});

router.patch("/accounts/chart/:id", requireModuleAction("page:/accounts/chart", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const raw = (req.body ?? {}) as Record<string, unknown>;

  // ── Activate / deactivate ─────────────────────────────────────────────────
  // The sanctioned alternative to deleting a ledger that carries history: it
  // keeps every posting and every report intact, and only stops the ledger
  // being offered for new entries. Handled before the zod parse because zod
  // strips keys it does not declare.
  if (raw.isActive !== undefined) {
    const { rows: [target] } = await pool.query(
      `SELECT is_system_group, name FROM account_ledgers WHERE id = $1`, [id],
    );
    if (!target) { res.status(404).json({ error: "Not found" }); return; }
    if (target.is_system_group) {
      res.status(400).json({ error: "System groups cannot be deactivated — the statements are built from them." });
      return;
    }
    const active = raw.isActive === true;
    await pool.query(`UPDATE account_ledgers SET is_active = $1 WHERE id = $2`, [active, id]);
    await logActivity({
      action: "UPDATE", module: "accounts", entityType: "account_ledger", entityId: id,
      description: `${active ? "Reactivated" : "Deactivated"} ledger "${target.name}"`,
      user: (req as any).employee?.username ?? "system",
    });

    // Nothing else to change — answer with the fresh row.
    if (Object.keys(raw).length === 1) {
      const { rows: [row] } = await pool.query(`SELECT * FROM account_ledgers WHERE id = $1`, [id]);
      res.json({
        id: row.id, name: row.name, type: row.type, parentId: row.parent_id ?? null,
        description: row.description ?? null, code: row.code ?? null, section: row.section ?? null,
        isGroup: row.is_group ?? false, isSystemGroup: row.is_system_group ?? false,
        isActive: row.is_active ?? true, children: [], balance: 0,
      });
      return;
    }
  }

  const parsed = UpdateAccountLedgerBody.safeParse(raw);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Block rename of system ledgers (those with a code)
  if (parsed.data.name !== undefined) {
    const { rows: [ledger] } = await pool.query(`SELECT code FROM account_ledgers WHERE id = $1`, [id]);
    if (!ledger) { res.status(404).json({ error: "Not found" }); return; }
    if (ledger.code) { res.status(400).json({ error: "System ledger name cannot be changed." }); return; }
  }

  // A body holding nothing this route accepts (e.g. only the rejected `code`)
  // must not reach drizzle — an empty SET is a syntax error, which surfaced as a
  // 500. Read the row back instead and report it unchanged.
  const fields = parsed.data;
  const [row] = Object.keys(fields).length > 0
    ? await db.update(accountLedgersTable).set(fields).where(eq(accountLedgersTable.id, id)).returning()
    : await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, id));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  // `code` is deliberately NOT writable here. It is the marker that makes a
  // ledger system-owned: it drives the rename block, the delete block, and every
  // provisioning lookup. Accepting it from the body let a caller with edit
  // rights strip a system ledger's code and then delete the ledger the
  // statements are built from. Codes are assigned by provisioning and boot
  // migrations only.
  const { rows: [current] } = await pool.query(`SELECT code, is_active FROM account_ledgers WHERE id = $1`, [id]);
  res.json({
    ...row, code: current?.code ?? null, isActive: current?.is_active ?? true,
    parentName: null, children: [], balance: 0,
  });
});

// ── Move account to a different parent (drag-and-drop reparent) ───────────────
router.patch("/accounts/chart/:id/move", requireModuleAction("page:/accounts/chart", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { parentId } = req.body as { parentId: number };
  if (!parentId) { res.status(400).json({ error: "parentId is required" }); return; }

  // Node must exist and must not be a system group
  const { rows: [node] } = await pool.query(
    `SELECT is_system_group, code FROM account_ledgers WHERE id = $1`, [id]
  );
  if (!node) { res.status(404).json({ error: "Account not found" }); return; }
  if (node.is_system_group) { res.status(400).json({ error: "System groups cannot be moved" }); return; }

  // Target parent must exist and must be a group (container)
  const { rows: [parent] } = await pool.query(
    `SELECT id, is_group, is_active FROM account_ledgers WHERE id = $1`, [parentId]
  );
  if (!parent) { res.status(404).json({ error: "Target parent not found" }); return; }
  if (!parent.is_group) { res.status(400).json({ error: "Target must be a group or sub-group, not a leaf ledger" }); return; }
  // Same lifecycle rule as creating under a parent: a deactivated group is not
  // a valid home, or a move would quietly park live accounts under a dead head.
  if (parent.is_active === false) {
    res.status(400).json({ error: "That group is deactivated. Reactivate it first, or pick another group." }); return;
  }

  // Prevent circular reference: target must not be a descendant of the node being moved
  const { rows: circular } = await pool.query(`
    WITH RECURSIVE descendants AS (
      SELECT id FROM account_ledgers WHERE parent_id = $1
      UNION ALL
      SELECT al.id FROM account_ledgers al JOIN descendants d ON al.parent_id = d.id
    )
    SELECT id FROM descendants WHERE id = $2
  `, [id, parentId]);
  if (circular.length > 0) {
    res.status(400).json({ error: "Cannot move a group into one of its own sub-groups" }); return;
  }

  await pool.query(`UPDATE account_ledgers SET parent_id = $1 WHERE id = $2`, [parentId, id]);
  res.json({ success: true });
});

router.delete("/accounts/chart/:id", requireModuleAction("page:/accounts/chart", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rows: [row] } = await pool.query(`SELECT is_system_group, code, name FROM account_ledgers WHERE id = $1`, [id]);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  // One rule, one place: the page disables the action using exactly the reason
  // computed here, so the button and the route can never disagree.
  //
  // The old guard counted payments and receipts only, which let a ledger used
  // solely on a journal voucher, an expense or a cash deposit be deleted —
  // orphaning its postings. `loadLedgerUsage` covers every table that holds a
  // ledger id, because only one of them has a real foreign key.
  const [{ rows: [kids] }, usage] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM account_ledgers WHERE parent_id = $1`, [id]),
    loadLedgerUsage(pool),
  ]);
  const reason = deleteBlockReason(
    { isSystemGroup: row.is_system_group ?? false, code: row.code ?? null, childCount: Number(kids?.n ?? 0) },
    usage.get(id),
  );
  if (reason) { res.status(400).json({ error: reason }); return; }

  await db.delete(accountLedgersTable).where(eq(accountLedgersTable.id, id));
  await logActivity({
    action: "DELETE", module: "accounts", entityType: "account_ledger", entityId: id,
    description: `Deleted chart account "${row.name}"`,
    user: (req as any).employee?.username ?? "system",
  });
  res.status(204).send();
});

// ── Payments ──────────────────────────────────────────────────────────────
// LBAC: each location keeps its own payment book — a branch sees the vouchers
// that belong to it (stamped location, or a leg on one of its own ledgers) and
// Head Office sees everything. See lib/moneyScope.ts for the ownership rule.
router.get("/accounts/payments", requireModuleView(["page:/accounts/vouchers", "page:/operations/payment-voucher"]), async (req, res): Promise<void> => {
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const params: unknown[] = [];
  let where = scopeMoneyWhere(scope, ledgerIds, params, 'p', ['paid_from_ledger_id', 'paid_to_ledger_id']);
  // Global location context — vouchers are stamped with their owner location
  // (legacy null = Head Office). View narrowing on top of the LBAC scope.
  const payViewLoc = getLocationFilter(req);
  if (payViewLoc) {
    params.push(payViewLoc.locationType);
    where += ` AND COALESCE(p.location_type, 'headoffice') = $${params.length}`;
    if (payViewLoc.locationType !== 'headoffice') {
      params.push(payViewLoc.locationId);
      where += ` AND COALESCE(p.location_id, 0) = $${params.length}`;
    }
  }
  const result = await pool.query(`
    SELECT p.*, 
      pf.name AS paid_from_name,
      pt.name AS paid_to_name,
      (sr.id IS NOT NULL) AS is_refund
    FROM payments p
    LEFT JOIN account_ledgers pf ON p.paid_from_ledger_id = pf.id
    LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
    LEFT JOIN sales_returns sr ON sr.refund_payment_id = p.id
    WHERE ${where}
    ORDER BY p.id DESC
  `, params);
  res.json(result.rows.map(r => {
    // Rows owned by another module are system vouchers: visible here for a
    // complete register, but locked. Verdict = stored source (fail closed on
    // NULL) plus the legacy link checks, matching loadManualPayment exactly.
    const isSystem = Boolean(r.is_location_expense) || Boolean(r.is_refund)
      || !(r.source && PAYMENT_EDITABLE_SOURCES.has(r.source));
    return {
      id: r.id,
      voucherNumber: r.voucher_number,
      paymentDate: r.payment_date,
      paidFromLedgerId: r.paid_from_ledger_id,
      paidFromName: r.paid_from_name,
      paidToLedgerId: r.paid_to_ledger_id,
      paidToName: r.paid_to_name,
      amount: Number(r.amount),
      narration: r.narration,
      paymentMode: r.payment_mode ?? null,
      referenceNumber: r.reference_number ?? null,
      attachmentUrl: r.attachment_url ?? null,
      createdBy: r.created_by ?? null,
      origin: isSystem ? 'system' : 'manual',
      editable: !isSystem,
      locationType: r.location_type ?? 'headoffice',
      locationId: r.location_id ?? 0,
      createdAt: r.created_at,
    };
  }));
});

/**
 * Instrument modes a MANUAL receipt/payment voucher may record. Display and
 * filter metadata only — the accounting posting is driven entirely by which
 * ledgers the voucher names, so a "cheque" mode never changes the books.
 * (Sales settlement modes are a different, credit-controlled list.)
 */
const MANUAL_VOUCHER_MODES = new Set(["cash", "upi", "bank", "card", "cheque", "neft", "rtgs"]);

/** Shared create/edit field validation for manual money vouchers. */
function validateVoucherFields(body: any): { amount?: number; error?: string } {
  if (body.amount !== undefined) {
    const amt = Number(body.amount);
    if (!Number.isFinite(amt) || amt <= 0) return { error: "Amount must be greater than zero." };
    if (Math.abs(amt * 100 - Math.round(amt * 100)) > 1e-6) return { error: "Amount cannot have more than 2 decimal places." };
    return { amount: Math.round(amt * 100) / 100 };
  }
  return {};
}
function validateVoucherMode(mode: unknown): string | null | undefined {
  if (mode === undefined) return undefined;      // not supplied — keep current
  if (mode === null || mode === "") return null; // explicit clear
  return MANUAL_VOUCHER_MODES.has(String(mode)) ? String(mode) : undefined;
}

/**
 * A payments-table row is only a MANUAL voucher when no other module owns it.
 * Ownership is STORED (payments.source / receipts.source, stamped by every
 * producer and backfilled once at migration), never inferred from voucher
 * numbers or narrations — inference misses producers. Vendor payments are the
 * one non-manual source that stays editable: they own no other record (vendor
 * dues are derived from the ledger at read time), so editing them here is the
 * same books correction a manual voucher edit is.
 *
 * Fail closed: a NULL source after the backfill means some producer forgot to
 * stamp its rows — such rows are locked, not editable. The legacy join checks
 * stay as belt-and-braces for rows a bad backfill might ever mislabel.
 * Backend-enforced: the UI hiding a button is not a guard.
 */
const PAYMENT_EDITABLE_SOURCES = new Set(["manual", "vendor"]);
const SYSTEM_SOURCE_LOCK_MESSAGES: Record<string, string> = {
  expense: "This entry is a location expense — manage it from the Expenses page.",
  refund: "This is a system voucher raised by a sales return and is locked.",
  sale: "This is a system voucher raised by a sale and is locked.",
  deposit: "This is a system voucher raised by a cash deposit and is locked.",
  settlement: "This is a system voucher raised by a bank settlement and is locked.",
};
const UNKNOWN_SOURCE_LOCK = "This voucher was created by another module and is locked.";

async function loadManualPayment(client: { query: Function }, id: number, scopeWhere: string, params: unknown[], forUpdate = false) {
  const { rows: [row] } = await client.query(
    `SELECT p.*, (sr.id IS NOT NULL) AS is_refund
     FROM payments p
     LEFT JOIN sales_returns sr ON sr.refund_payment_id = p.id
     WHERE p.id = $1 AND ${scopeWhere}${forUpdate ? " FOR UPDATE OF p" : ""}`, params,
  );
  if (!row) return { error: 404 as const };
  if (row.is_location_expense) return { error: SYSTEM_SOURCE_LOCK_MESSAGES.expense };
  if (row.is_refund) return { error: SYSTEM_SOURCE_LOCK_MESSAGES.refund };
  const src = row.source ?? null;
  if (src === null || !PAYMENT_EDITABLE_SOURCES.has(src)) {
    return { error: SYSTEM_SOURCE_LOCK_MESSAGES[src as string] ?? UNKNOWN_SOURCE_LOCK };
  }
  return { row };
}

/** Same rule for receipts; only 'manual' rows are editable. */
async function loadManualReceipt(client: { query: Function }, id: number, scopeWhere: string, params: unknown[], forUpdate = false) {
  const { rows: [row] } = await client.query(
    `SELECT r.*,
            EXISTS(SELECT 1 FROM sale_payments sp WHERE sp.clearing_receipt_id = r.id) AS is_clearing,
            EXISTS(SELECT 1 FROM sales s WHERE s.invoice_number = r.voucher_number) AS is_sale_receipt
     FROM receipts r
     WHERE r.id = $1 AND ${scopeWhere}${forUpdate ? " FOR UPDATE OF r" : ""}`, params,
  );
  if (!row) return { error: 404 as const };
  if (row.is_clearing || row.is_sale_receipt) return { error: SYSTEM_SOURCE_LOCK_MESSAGES.sale };
  const src = row.source ?? null;
  if (src !== "manual") {
    return { error: SYSTEM_SOURCE_LOCK_MESSAGES[src as string] ?? UNKNOWN_SOURCE_LOCK };
  }
  return { row };
}

router.post("/accounts/payments", requireModuleAction(["page:/accounts/vouchers", "page:/operations/payment-voucher"], "add"), async (req, res): Promise<void> => {
  const { paymentDate, paidFromLedgerId, paidToLedgerId, amount, narration, paymentMode, referenceNumber, attachmentUrl } = req.body as {
    paymentDate: string; paidFromLedgerId: number; paidToLedgerId: number; amount: number; narration?: string;
    paymentMode?: string; referenceNumber?: string; attachmentUrl?: string;
  };
  if (!paymentDate || !paidFromLedgerId || !paidToLedgerId || !amount) {
    res.status(400).json({ error: "paymentDate, paidFromLedgerId, paidToLedgerId and amount are required" }); return;
  }
  if (!isIsoDate(paymentDate)) {
    res.status(400).json({ error: "paymentDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }
  const av = validateVoucherFields({ amount });
  if (av.error) { res.status(400).json({ error: av.error }); return; }
  if (Number(paidFromLedgerId) === Number(paidToLedgerId)) {
    res.status(400).json({ error: "Paid From and Paid To cannot be the same account." }); return;
  }
  const mode = validateVoucherMode(paymentMode);
  if (paymentMode !== undefined && mode === undefined) {
    res.status(400).json({ error: "Payment mode must be one of cash, upi, bank, card, cheque, neft, rtgs." }); return;
  }
  // A branch user may only pay out of its own cash box, and never into another
  // location's or Head Office's cash/bank accounts.
  const scope = ownLocationScope((req as any).employee);
  const legCheck = await checkVoucherLegs(scope, Number(paidFromLedgerId), Number(paidToLedgerId), 'Paid from');
  if (!legCheck.ok) { res.status(403).json({ error: legCheck.error }); return; }

  const { locationType, locationId } = callerLocation((req as any).employee);
  const voucherNumber = await nextVoucherNumber(pool, 'payment', paymentDate);
  const result = await pool.query(
    `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, location_type, location_id,
                           payment_mode, reference_number, attachment_url, created_by, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'manual') RETURNING *`,
    [voucherNumber, paymentDate, paidFromLedgerId, paidToLedgerId, av.amount, narration ?? null, locationType, locationId,
     mode ?? null, referenceNumber?.trim() || null, attachmentUrl?.trim() || null, (req as any).employee?.username ?? null]
  );
  const r = result.rows[0];
  const [pf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(paidFromLedgerId))).limit(1);
  const [pt] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(paidToLedgerId))).limit(1);
  logActivity({ action: "CREATE", module: "accounts", entityType: "payment_voucher", entityId: r.id,
    description: `Payment voucher ${r.voucher_number} — ₹${Number(r.amount).toLocaleString("en-IN")} from ${pf?.name ?? paidFromLedgerId} to ${pt?.name ?? paidToLedgerId}`,
    metadata: { voucherNumber: r.voucher_number, date: r.payment_date, amount: Number(r.amount), paidFrom: pf?.name, paidTo: pt?.name, mode: r.payment_mode, reference: r.reference_number },
  }).catch(() => {});
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, paymentDate: r.payment_date,
    paidFromLedgerId: r.paid_from_ledger_id, paidFromName: pf?.name ?? '',
    paidToLedgerId: r.paid_to_ledger_id, paidToName: pt?.name ?? '',
    amount: Number(r.amount), narration: r.narration,
    paymentMode: r.payment_mode, referenceNumber: r.reference_number, attachmentUrl: r.attachment_url, createdBy: r.created_by,
    locationType: r.location_type ?? 'headoffice', locationId: r.location_id ?? 0,
    createdAt: r.created_at,
  });
});

// Edit a MANUAL payment voucher. System-owned rows (location expenses,
// sales-return refunds) are refused server-side. The legs are re-validated on
// the EFFECTIVE values (body ?? current row) so a partial PATCH cannot route
// around the branch cash-box rules.
router.patch("/accounts/payments/:id", requireModuleAction(["page:/accounts/vouchers", "page:/operations/payment-voucher"], "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid payment id" }); return; }
  const b = req.body as Record<string, unknown>;
  if (b.paymentDate !== undefined && !isIsoDate(String(b.paymentDate))) {
    res.status(400).json({ error: "paymentDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }
  const av = validateVoucherFields(b);
  if (av.error) { res.status(400).json({ error: av.error }); return; }
  const mode = validateVoucherMode(b.paymentMode);
  if (b.paymentMode !== undefined && mode === undefined) {
    res.status(400).json({ error: "Payment mode must be one of cash, upi, bank, card, cheque, neft, rtgs." }); return;
  }
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const params: unknown[] = [id];
    const where = scopeMoneyWhere(scope, ledgerIds, params, 'p', ['paid_from_ledger_id', 'paid_to_ledger_id']);
    const loaded = await loadManualPayment(client, id, where, params, true);
    if ('error' in loaded) {
      await client.query("ROLLBACK");
      if (loaded.error === 404) res.status(404).json({ error: "Payment not found" });
      else res.status(403).json({ error: loaded.error });
      return;
    }
    const row = loaded.row;
    const newFrom = b.paidFromLedgerId !== undefined ? Number(b.paidFromLedgerId) : Number(row.paid_from_ledger_id);
    const newTo = b.paidToLedgerId !== undefined ? Number(b.paidToLedgerId) : Number(row.paid_to_ledger_id);
    if (!Number.isInteger(newFrom) || !Number.isInteger(newTo) || newFrom <= 0 || newTo <= 0) {
      await client.query("ROLLBACK"); res.status(400).json({ error: "Invalid account selection." }); return;
    }
    if (newFrom === newTo) { await client.query("ROLLBACK"); res.status(400).json({ error: "Paid From and Paid To cannot be the same account." }); return; }
    const legCheck = await checkVoucherLegs(scope, newFrom, newTo, 'Paid from');
    if (!legCheck.ok) { await client.query("ROLLBACK"); res.status(403).json({ error: legCheck.error }); return; }

    const upd = await client.query(
      `UPDATE payments SET
         payment_date = $2, paid_from_ledger_id = $3, paid_to_ledger_id = $4, amount = $5,
         narration = $6, payment_mode = $7, reference_number = $8, attachment_url = $9
       WHERE id = $1 RETURNING *`,
      [id,
       b.paymentDate !== undefined ? String(b.paymentDate) : row.payment_date,
       newFrom, newTo,
       av.amount !== undefined ? av.amount : row.amount,
       b.narration !== undefined ? (String(b.narration).trim() || null) : row.narration,
       b.paymentMode !== undefined ? mode : row.payment_mode,
       b.referenceNumber !== undefined ? (String(b.referenceNumber).trim() || null) : row.reference_number,
       b.attachmentUrl !== undefined ? (String(b.attachmentUrl).trim() || null) : row.attachment_url,
      ],
    );
    await client.query("COMMIT");
    const r = upd.rows[0];
    const [pf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, newFrom)).limit(1);
    const [pt] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, newTo)).limit(1);
    logActivity({ action: "UPDATE", module: "accounts", entityType: "payment_voucher", entityId: id,
      description: `Payment voucher ${r.voucher_number} edited`,
      metadata: {
        old: { date: row.payment_date, from: row.paid_from_ledger_id, to: row.paid_to_ledger_id, amount: Number(row.amount), narration: row.narration, mode: row.payment_mode, reference: row.reference_number },
        new: { date: r.payment_date, from: r.paid_from_ledger_id, to: r.paid_to_ledger_id, amount: Number(r.amount), narration: r.narration, mode: r.payment_mode, reference: r.reference_number },
      },
    }).catch(() => {});
    res.json({
      id: r.id, voucherNumber: r.voucher_number, paymentDate: r.payment_date,
      paidFromLedgerId: r.paid_from_ledger_id, paidFromName: pf?.name ?? '',
      paidToLedgerId: r.paid_to_ledger_id, paidToName: pt?.name ?? '',
      amount: Number(r.amount), narration: r.narration,
      paymentMode: r.payment_mode, referenceNumber: r.reference_number, attachmentUrl: r.attachment_url, createdBy: r.created_by,
      locationType: r.location_type ?? 'headoffice', locationId: r.location_id ?? 0,
      createdAt: r.created_at,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

router.delete("/accounts/payments/:id", requireModuleAction(["page:/accounts/vouchers", "page:/operations/payment-voucher"], "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid payment id" }); return; }
  // Scope the DELETE itself: a branch user must not be able to remove another
  // location's (or Head Office's) voucher by guessing its id.
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const params: unknown[] = [id];
  const where = scopeMoneyWhere(scope, ledgerIds, params, 'p', ['paid_from_ledger_id', 'paid_to_ledger_id']);
  const loaded = await loadManualPayment(pool, id, where, params);
  if ('error' in loaded) {
    if (loaded.error === 404) res.status(404).json({ error: "Payment not found" });
    else res.status(403).json({ error: loaded.error });
    return;
  }
  await pool.query(`DELETE FROM payments WHERE id = $1`, [id]);
  logActivity({ action: "DELETE", module: "accounts", entityType: "payment_voucher", entityId: id,
    description: `Payment voucher ${loaded.row.voucher_number} deleted — ₹${Number(loaded.row.amount).toLocaleString("en-IN")}`,
    metadata: { old: { voucherNumber: loaded.row.voucher_number, date: loaded.row.payment_date, from: loaded.row.paid_from_ledger_id, to: loaded.row.paid_to_ledger_id, amount: Number(loaded.row.amount), narration: loaded.row.narration, mode: loaded.row.payment_mode, reference: loaded.row.reference_number } },
  }).catch(() => {});
  res.status(204).send();
});

// ── Receipts ──────────────────────────────────────────────────────────────
// LBAC: same ownership rule as payments — a branch sees its own receipts only.
router.get("/accounts/receipts", requireModuleView(["page:/accounts/vouchers", "page:/operations/receipt-voucher"]), async (req, res): Promise<void> => {
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const params: unknown[] = [];
  let where = scopeMoneyWhere(scope, ledgerIds, params, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
  // Global location context — same ownership stamp rule as payments.
  const rcptViewLoc = getLocationFilter(req);
  if (rcptViewLoc) {
    params.push(rcptViewLoc.locationType);
    where += ` AND COALESCE(r.location_type, 'headoffice') = $${params.length}`;
    if (rcptViewLoc.locationType !== 'headoffice') {
      params.push(rcptViewLoc.locationId);
      where += ` AND COALESCE(r.location_id, 0) = $${params.length}`;
    }
  }
  const result = await pool.query(`
    SELECT r.*,
      rf.name AS received_from_name,
      ri.name AS received_in_name,
      EXISTS(SELECT 1 FROM sale_payments sp WHERE sp.clearing_receipt_id = r.id) AS is_clearing,
      EXISTS(SELECT 1 FROM sales s WHERE s.invoice_number = r.voucher_number) AS is_sale_receipt
    FROM receipts r
    LEFT JOIN account_ledgers rf ON r.received_from_ledger_id = rf.id
    LEFT JOIN account_ledgers ri ON r.received_in_ledger_id = ri.id
    WHERE ${where}
    ORDER BY r.id DESC
  `, params);
  res.json(result.rows.map(r => {
    // Sale-linked rows belong to the sales flow; any non-manual (or unstamped)
    // source is likewise locked — same verdict as loadManualReceipt.
    const isSystem = Boolean(r.is_clearing) || Boolean(r.is_sale_receipt) || r.source !== 'manual';
    return {
      id: r.id,
      voucherNumber: r.voucher_number,
      receiptDate: r.receipt_date,
      receivedFromLedgerId: r.received_from_ledger_id,
      receivedFromName: r.received_from_name,
      receivedInLedgerId: r.received_in_ledger_id,
      receivedInName: r.received_in_name,
      amount: Number(r.amount),
      narration: r.narration,
      paymentMode: r.payment_mode ?? null,
      referenceNumber: r.reference_number ?? null,
      attachmentUrl: r.attachment_url ?? null,
      createdBy: r.created_by ?? null,
      origin: isSystem ? 'system' : 'manual',
      editable: !isSystem,
      locationType: r.location_type ?? 'headoffice',
      locationId: r.location_id ?? 0,
      createdAt: r.created_at,
    };
  }));
});

router.post("/accounts/receipts", requireModuleAction(["page:/accounts/vouchers", "page:/operations/receipt-voucher"], "add"), async (req, res): Promise<void> => {
  const { receiptDate, receivedFromLedgerId, receivedInLedgerId, amount, narration, paymentMode, referenceNumber, attachmentUrl } = req.body as {
    receiptDate: string; receivedFromLedgerId: number; receivedInLedgerId: number; amount: number; narration?: string;
    paymentMode?: string; referenceNumber?: string; attachmentUrl?: string;
  };
  if (!receiptDate || !receivedFromLedgerId || !receivedInLedgerId || !amount) {
    res.status(400).json({ error: "receiptDate, receivedFromLedgerId, receivedInLedgerId and amount are required" }); return;
  }
  if (!isIsoDate(receiptDate)) {
    res.status(400).json({ error: "receiptDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }
  const av = validateVoucherFields({ amount });
  if (av.error) { res.status(400).json({ error: av.error }); return; }
  if (Number(receivedFromLedgerId) === Number(receivedInLedgerId)) {
    res.status(400).json({ error: "Received From and Received In cannot be the same account." }); return;
  }
  const mode = validateVoucherMode(paymentMode);
  if (paymentMode !== undefined && mode === undefined) {
    res.status(400).json({ error: "Payment mode must be one of cash, upi, bank, card, cheque, neft, rtgs." }); return;
  }
  // A branch user may only collect into its own cash box.
  const scope = ownLocationScope((req as any).employee);
  const legCheck = await checkVoucherLegs(scope, Number(receivedInLedgerId), Number(receivedFromLedgerId), 'Received in');
  if (!legCheck.ok) { res.status(403).json({ error: legCheck.error }); return; }

  const { locationType, locationId } = callerLocation((req as any).employee);
  const voucherNumber = await nextVoucherNumber(pool, 'receipt', receiptDate);
  const result = await pool.query(
    `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, location_type, location_id,
                           payment_mode, reference_number, attachment_url, created_by, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'manual') RETURNING *`,
    [voucherNumber, receiptDate, receivedFromLedgerId, receivedInLedgerId, av.amount, narration ?? null, locationType, locationId,
     mode ?? null, referenceNumber?.trim() || null, attachmentUrl?.trim() || null, (req as any).employee?.username ?? null]
  );
  const r = result.rows[0];
  const [rf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(receivedFromLedgerId))).limit(1);
  const [ri] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(receivedInLedgerId))).limit(1);
  logActivity({ action: "CREATE", module: "accounts", entityType: "receipt_voucher", entityId: r.id,
    description: `Receipt voucher ${r.voucher_number} — ₹${Number(r.amount).toLocaleString("en-IN")} from ${rf?.name ?? receivedFromLedgerId} into ${ri?.name ?? receivedInLedgerId}`,
    metadata: { voucherNumber: r.voucher_number, date: r.receipt_date, amount: Number(r.amount), receivedFrom: rf?.name, receivedIn: ri?.name, mode: r.payment_mode, reference: r.reference_number },
  }).catch(() => {});
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, receiptDate: r.receipt_date,
    receivedFromLedgerId: r.received_from_ledger_id, receivedFromName: rf?.name ?? '',
    receivedInLedgerId: r.received_in_ledger_id, receivedInName: ri?.name ?? '',
    amount: Number(r.amount), narration: r.narration,
    paymentMode: r.payment_mode, referenceNumber: r.reference_number, attachmentUrl: r.attachment_url, createdBy: r.created_by,
    locationType: r.location_type ?? 'headoffice', locationId: r.location_id ?? 0,
    createdAt: r.created_at,
  });
});

// Edit a MANUAL receipt voucher — same effective-value re-validation and
// system-row refusal as payments.
router.patch("/accounts/receipts/:id", requireModuleAction(["page:/accounts/vouchers", "page:/operations/receipt-voucher"], "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid receipt id" }); return; }
  const b = req.body as Record<string, unknown>;
  if (b.receiptDate !== undefined && !isIsoDate(String(b.receiptDate))) {
    res.status(400).json({ error: "receiptDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }
  const av = validateVoucherFields(b);
  if (av.error) { res.status(400).json({ error: av.error }); return; }
  const mode = validateVoucherMode(b.paymentMode);
  if (b.paymentMode !== undefined && mode === undefined) {
    res.status(400).json({ error: "Payment mode must be one of cash, upi, bank, card, cheque, neft, rtgs." }); return;
  }
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const params: unknown[] = [id];
    const where = scopeMoneyWhere(scope, ledgerIds, params, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
    const loaded = await loadManualReceipt(client, id, where, params, true);
    if ('error' in loaded) {
      await client.query("ROLLBACK");
      if (loaded.error === 404) res.status(404).json({ error: "Receipt not found" });
      else res.status(403).json({ error: loaded.error });
      return;
    }
    const row = loaded.row;
    const newFrom = b.receivedFromLedgerId !== undefined ? Number(b.receivedFromLedgerId) : Number(row.received_from_ledger_id);
    const newIn = b.receivedInLedgerId !== undefined ? Number(b.receivedInLedgerId) : Number(row.received_in_ledger_id);
    if (!Number.isInteger(newFrom) || !Number.isInteger(newIn) || newFrom <= 0 || newIn <= 0) {
      await client.query("ROLLBACK"); res.status(400).json({ error: "Invalid account selection." }); return;
    }
    if (newFrom === newIn) { await client.query("ROLLBACK"); res.status(400).json({ error: "Received From and Received In cannot be the same account." }); return; }
    const legCheck = await checkVoucherLegs(scope, newIn, newFrom, 'Received in');
    if (!legCheck.ok) { await client.query("ROLLBACK"); res.status(403).json({ error: legCheck.error }); return; }

    const upd = await client.query(
      `UPDATE receipts SET
         receipt_date = $2, received_from_ledger_id = $3, received_in_ledger_id = $4, amount = $5,
         narration = $6, payment_mode = $7, reference_number = $8, attachment_url = $9
       WHERE id = $1 RETURNING *`,
      [id,
       b.receiptDate !== undefined ? String(b.receiptDate) : row.receipt_date,
       newFrom, newIn,
       av.amount !== undefined ? av.amount : row.amount,
       b.narration !== undefined ? (String(b.narration).trim() || null) : row.narration,
       b.paymentMode !== undefined ? mode : row.payment_mode,
       b.referenceNumber !== undefined ? (String(b.referenceNumber).trim() || null) : row.reference_number,
       b.attachmentUrl !== undefined ? (String(b.attachmentUrl).trim() || null) : row.attachment_url,
      ],
    );
    await client.query("COMMIT");
    const r = upd.rows[0];
    const [rf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, newFrom)).limit(1);
    const [ri] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, newIn)).limit(1);
    logActivity({ action: "UPDATE", module: "accounts", entityType: "receipt_voucher", entityId: id,
      description: `Receipt voucher ${r.voucher_number} edited`,
      metadata: {
        old: { date: row.receipt_date, from: row.received_from_ledger_id, into: row.received_in_ledger_id, amount: Number(row.amount), narration: row.narration, mode: row.payment_mode, reference: row.reference_number },
        new: { date: r.receipt_date, from: r.received_from_ledger_id, into: r.received_in_ledger_id, amount: Number(r.amount), narration: r.narration, mode: r.payment_mode, reference: r.reference_number },
      },
    }).catch(() => {});
    res.json({
      id: r.id, voucherNumber: r.voucher_number, receiptDate: r.receipt_date,
      receivedFromLedgerId: r.received_from_ledger_id, receivedFromName: rf?.name ?? '',
      receivedInLedgerId: r.received_in_ledger_id, receivedInName: ri?.name ?? '',
      amount: Number(r.amount), narration: r.narration,
      paymentMode: r.payment_mode, referenceNumber: r.reference_number, attachmentUrl: r.attachment_url, createdBy: r.created_by,
      locationType: r.location_type ?? 'headoffice', locationId: r.location_id ?? 0,
      createdAt: r.created_at,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

router.delete("/accounts/receipts/:id", requireModuleAction(["page:/accounts/vouchers", "page:/operations/receipt-voucher"], "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid receipt id" }); return; }
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const params: unknown[] = [id];
  const where = scopeMoneyWhere(scope, ledgerIds, params, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
  const loaded = await loadManualReceipt(pool, id, where, params);
  if ('error' in loaded) {
    if (loaded.error === 404) res.status(404).json({ error: "Receipt not found" });
    else res.status(403).json({ error: loaded.error });
    return;
  }
  await pool.query(`DELETE FROM receipts WHERE id = $1`, [id]);
  logActivity({ action: "DELETE", module: "accounts", entityType: "receipt_voucher", entityId: id,
    description: `Receipt voucher ${loaded.row.voucher_number} deleted — ₹${Number(loaded.row.amount).toLocaleString("en-IN")}`,
    metadata: { old: { voucherNumber: loaded.row.voucher_number, date: loaded.row.receipt_date, from: loaded.row.received_from_ledger_id, into: loaded.row.received_in_ledger_id, amount: Number(loaded.row.amount), narration: loaded.row.narration, mode: loaded.row.payment_mode, reference: loaded.row.reference_number } },
  }).catch(() => {});
  res.status(204).send();
});

// ── Ledger Statement ──────────────────────────────────────────────────────
// LBAC: a branch may pull a statement, but only its own movements appear —
// vouchers it owns, its own sales and its own purchase bills. Head-Office-only
// sources (the expenses table, journal-family vouchers) are left out for branch
// users because they carry no location dimension.
router.get("/accounts/ledger-statement", requireModuleView("page:/accounts/ledger"), async (req, res): Promise<void> => {
  const qp = GetLedgerStatementQueryParams.safeParse(req.query);
  if (!qp.success) { res.status(400).json({ error: qp.error.message }); return; }

  const accountId = Number(qp.data.accountId);
  const fromDate = qp.data.fromDate as string | undefined;
  const toDate = qp.data.toDate as string | undefined;
  // Presentation narrowing only — LBAC above/below still decides what the
  // caller may see at all. NOTE: read from req.query, not qp.data — the zod
  // schema predates the location params and strips unknown keys.
  const locFilter = getPostingLocationFilter(req);

  const [account] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, accountId)).limit(1);
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  // Two scopes on purpose: money vouchers follow the caller's own till
  // (`moneyScopeCtx`), while sales and purchases keep the wider location scope
  // the Sales and Purchases modules already use.
  const scope = await getUserDataScope((req as any).employee);
  const moneyScopeCtx = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(moneyScopeCtx);
  if (!moneyScopeCtx.isHeadOffice) {
    const foreign = await foreignLocationLedgerIds(moneyScopeCtx);
    if (foreign.includes(accountId)) {
      res.status(403).json({ error: "That account belongs to another location." }); return;
    }
  }

  const entries: any[] = [];

  // Payments where this account is involved
  const pmtParams: unknown[] = [accountId];
  const pmtScope = scopeMoneyWhere(moneyScopeCtx, ledgerIds, pmtParams, 'p', ['paid_from_ledger_id', 'paid_to_ledger_id']);
  const pmtRes = await pool.query(
    `SELECT p.* FROM payments p
     WHERE (p.paid_from_ledger_id = $1 OR p.paid_to_ledger_id = $1) AND ${pmtScope}${documentLocationCond(locFilter, 'p', pmtParams, 'headoffice')}`,
    pmtParams,
  );
  for (const p of pmtRes.rows) {
    entries.push({
      date: p.payment_date,
      description: p.narration || `Payment ${p.voucher_number}`,
      debit: p.paid_to_ledger_id == accountId ? Number(p.amount) : 0,
      credit: p.paid_from_ledger_id == accountId ? Number(p.amount) : 0,
      entryType: 'payment',
    });
  }

  // Receipts where this account is involved
  const recParams: unknown[] = [accountId];
  const recScope = scopeMoneyWhere(moneyScopeCtx, ledgerIds, recParams, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
  const recRes = await pool.query(
    `SELECT r.* FROM receipts r
     WHERE (r.received_from_ledger_id = $1 OR r.received_in_ledger_id = $1) AND ${recScope}${documentLocationCond(locFilter, 'r', recParams, 'headoffice')}`,
    recParams,
  );
  for (const r of recRes.rows) {
    entries.push({
      date: r.receipt_date,
      description: r.narration || `Receipt ${r.voucher_number}`,
      debit: r.received_in_ledger_id == accountId ? Number(r.amount) : 0,
      credit: r.received_from_ledger_id == accountId ? Number(r.amount) : 0,
      entryType: 'receipt',
    });
  }

  // Expenses tagged to this account — the expenses table is Head Office only
  // (branch spending is recorded as location-expense payments, already above).
  // Raw SQL, not drizzle: location_type/location_id are startup-migration
  // columns that db.select() cannot see.
  if (scope.isHeadOffice) {
    const expParams: unknown[] = [accountId];
    const { rows: exps } = await pool.query(
      `SELECT e.expense_date, e.description, e.amount FROM expenses e
       WHERE e.ledger_account_id = $1${documentLocationCond(locFilter, 'e', expParams, 'headoffice')}`,
      expParams,
    );
    entries.push(...exps.map((e: any) => ({
      date: e.expense_date, description: e.description ?? "Expense",
      debit: Number(e.amount), credit: 0, entryType: 'expense',
    })));
  }

  // Sales rows feeding income and GST ledgers, scoped to the caller's locations
  const needsSales = account.type === 'income' || (account as any).code === 'STD-DTX';
  let scopedSales: Array<{ id: number; sale_date: string; invoice_number: string | null; total_amount: string; tax_total: string }> = [];
  if (needsSales) {
    const salesParams: unknown[] = [];
    const salesWhere = scopeSalesWhere(scope, salesParams);
    // fallback null: a sale with no stored location posts as company-level in
    // the derived stream, so it matches only the 'company' slice here too.
    const { rows } = await pool.query(
      `SELECT s.id, s.sale_date, s.invoice_number, s.total_amount, s.tax_total
       FROM sales s WHERE s.branch_transfer_id IS NULL AND s.cancelled_at IS NULL AND ${salesWhere}${documentLocationCond(locFilter, 's', salesParams, null)}`, salesParams,
    );
    scopedSales = rows as typeof scopedSales;
  }

  // Income accounts: include sales
  if (account.type === 'income') {
    entries.push(...scopedSales.map(s => ({
      date: s.sale_date,
      description: `Sales Invoice ${s.invoice_number || '#' + s.id}`,
      debit: 0, credit: Number(s.total_amount), entryType: 'sale',
    })));
  }

  // Duty & Tax ledger (STD-DTX): show GST collected on each sale as a credit
  const accountCode = (account as any).code ?? null;
  if (accountCode === 'STD-DTX') {
    for (const s of scopedSales) {
      const tax = Number(s.tax_total ?? 0);
      if (tax > 0) {
        entries.push({
          date: s.sale_date,
          description: `GST on ${s.invoice_number || 'Sale #' + s.id}`,
          debit: 0, credit: tax, entryType: 'sale_gst',
        });
      }
    }
  }

  // Purchase-type expense accounts: include purchases (branch-scoped — a
  // warehouse buys on its own bills since Phase 7)
  if (account.type === 'expense' && account.name.toLowerCase().includes('purchase')) {
    const purParams: unknown[] = [];
    const purWhere = scopeBranchWhere(scope, purParams, 'p');
    const { rows: purRows } = await pool.query(
      `SELECT p.id, p.purchase_date, p.invoice_number, p.total_amount
       FROM purchases p WHERE p.branch_transfer_id IS NULL AND ${purWhere}${documentLocationCond(locFilter, 'p', purParams, 'headoffice')}`, purParams,
    );
    entries.push(...purRows.map((p: any) => ({
      date: p.purchase_date,
      description: `Purchase Bill ${p.invoice_number || '#' + p.id}`,
      debit: Number(p.total_amount), credit: 0, entryType: 'purchase',
    })));
  }

  // Journal-family voucher lines touching this ledger (journal/contra/CN/DN).
  // Journal vouchers carry no location dimension, so they stay Head Office —
  // and in a location-sliced statement they are company-level: shown for the
  // 'company' slice and the unfiltered view, dropped for every location slice.
  const includeJvs = scope.isHeadOffice && (!locFilter || locFilter.type === "company");
  const { rows: jvLines } = includeJvs ? await pool.query(
    `SELECT v.voucher_date AS date, v.voucher_number, v.voucher_type, v.narration,
            l.debit, l.credit
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     WHERE l.ledger_id = $1`, [accountId]
  ).catch(() => ({ rows: [] as any[] })) : { rows: [] as any[] };
  for (const jl of jvLines) {
    entries.push({
      date: jl.date,
      description: jl.narration || `${jl.voucher_type === 'contra' ? 'Contra' : jl.voucher_type === 'credit_note' ? 'Credit Note' : jl.voucher_type === 'debit_note' ? 'Debit Note' : 'Journal'} ${jl.voucher_number}`,
      debit: Number(jl.debit), credit: Number(jl.credit),
      entryType: jl.voucher_type,
    });
  }

  // Filter by date range
  let filtered = entries;
  if (fromDate) filtered = filtered.filter(e => e.date >= fromDate!);
  if (toDate) filtered = filtered.filter(e => e.date <= toDate!);
  filtered.sort((a, b) => a.date.localeCompare(b.date));

  // Running balance
  let balance = 0;
  const entriesWithBalance = filtered.map(e => {
    balance += (e.debit || 0) - (e.credit || 0);
    return { ...e, balance };
  });

  res.json({
    accountId, accountName: account.name,
    openingBalance: 0, closingBalance: balance,
    entries: entriesWithBalance,
    transactions: entriesWithBalance,
    ...(locFilter ? { location: locFilter } : {}),
  });
});

/**
 * ── Cash & Bank (legacy) ──────────────────────────────────────────────────
 *
 * `cash_bank_accounts` predates the chart of accounts and has no link to it —
 * no ledger id, and no naming convention that resolves to one. Its `balance`
 * column is a stored running total that no accounting entry maintains (one
 * ad-hoc decrement on expense creation aside), so it is not a balance in the
 * accounting sense and nothing in the books agrees with it.
 *
 * It is therefore reported as `storedBalance` and never as the account's
 * current balance. `currentBalance` stays null while a row has no ledger behind
 * it, because the honest answer here is "this figure is not backed by the
 * books", and a null renders as an explicit gap instead of a confident number.
 * The real cash and bank positions live on the Cash & Bank Book, the Trial
 * Balance and the Balance Sheet, which all read the posting stream.
 *
 * The rows themselves are left untouched: `expenses.payment_account_id` still
 * points at them.
 */
router.get("/accounts/cash-bank", requireModuleView("page:/accounts/cash-bank"), async (_req, res): Promise<void> => {
  const rows = await db.select().from(cashBankAccountsTable).orderBy(cashBankAccountsTable.id);
  res.json(rows.map(r => ({
    ...r,
    balance: Number(r.balance),
    storedBalance: Number(r.balance),
    currentBalance: null,
    balanceSource: "unlinked" as const,
    ledgerId: null,
  })));
});

/** Form wording for validation messages, so a 400 names the field the user
 *  filled in rather than the JSON key behind it. */
const CASH_BANK_LABELS: Record<string, string> = {
  name: "Account Name",
  accountType: "Type",
  bankName: "Bank Name",
  accountNumber: "Account Number",
  ifscCode: "IFSC Code",
  openingBalance: "Opening Balance",
};

router.post("/accounts/cash-bank", requireModuleAction("page:/accounts/cash-bank", "add"), async (req, res): Promise<void> => {
  // `<input type="number">` submits its value as a string, so the money field
  // is normalised before the generated schema — which rightly demands a
  // number — ever sees it. Invalid text is refused here, never coerced to 0.
  const money = optionalMoney(req.body?.openingBalance);
  if (!money.ok) { res.status(400).json({ error: `Opening Balance ${money.reason}.` }); return; }
  if (money.value < 0) { res.status(400).json({ error: "Opening Balance cannot be negative." }); return; }

  // Identifiers stay strings throughout: an account number's leading zeros are
  // significant and its length outruns Number.MAX_SAFE_INTEGER.
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const ifsc = text(req.body?.ifscCode)?.toUpperCase();

  const parsed = CreateCashBankAccountBody.safeParse({
    ...req.body,
    openingBalance: money.value,
    ...(ifsc !== undefined ? { ifscCode: ifsc } : {}),
  });
  if (!parsed.success) {
    res.status(400).json({ error: validationMessage(parsed.error, CASH_BANK_LABELS) });
    return;
  }

  // The opening balance seeds the stored figure and nothing else. This table
  // has no link to the chart of accounts (see the block comment above), so
  // creating a posting from it here would invent an entry no other module
  // knows about and unbalance the trial balance.
  // `money.text` rather than the parsed number: it is the caller's exact digits
  // in canonical form, so the value reaches NUMERIC(12,2) without a float in
  // the path to round a half-cent off it.
  const { openingBalance: _seed, ...rest } = parsed.data as typeof parsed.data & { openingBalance?: number };
  const [row] = await db.insert(cashBankAccountsTable).values({ ...rest, balance: money.text }).returning();
  res.status(201).json({
    ...row,
    balance: Number(row.balance),
    storedBalance: Number(row.balance),
    currentBalance: null,
    balanceSource: "unlinked" as const,
    ledgerId: null,
  });
});

// ── Expenses (merged: expenses table + location expense payments) ──────────
// No mapped consumer; serves the Expenses pages (accounts + sales).
router.get("/expenses", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (req, res): Promise<void> => {
  const expEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const isHO = !expEmp || expEmp.branchType === 'headoffice';
  const dr = parseDateRange(req.query as Record<string, unknown>);
  if (!dr.ok) { res.status(400).json({ error: dr.error }); return; }
  const locFilterReq = getLocationFilter(req);

  type ExpenseRow = {
    id: number; source: 'direct' | 'location'; expenseDate: any;
    description: string | null; ledgerAccountId: number; ledgerAccountName: string;
    paymentAccountId: number; paymentAccountName: string; amount: number;
    voucherNumber: string | null; createdAt: any;
    expenseNumber: string | null; category: string | null; attachmentUrl: string | null;
    locationType: string | null; locationId: number | null; locationName: string;
  };
  let directExpenses: ExpenseRow[] = [];

  // 1. Expenses recorded at Head Office, paid from a company cash/bank account.
  //    A branch user sees the ones attributed to their own location — Head
  //    Office often pays a warehouse's bill centrally, and that spend belongs on
  //    the warehouse's expense list even though the warehouse never touched it.
  //    Raw SQL because the audit columns come from a startup migration and are
  //    invisible to Drizzle's select().
  {
    const params: any[] = [];
    const conds: string[] = [];
    if (!isHO && expEmp) {
      params.push(expEmp.branchType, Number(expEmp.branchId));
      conds.push(`e.location_type = $1 AND e.location_id = $2`);
    }
    // Optional client filters — ANDed onto the LBAC condition, narrowing only.
    pushDateRange(conds, params, 'e.expense_date', dr.from, dr.to);
    pushLocationFilter(
      conds, params, locFilterReq,
      // Unstamped expenses are Head Office spend with no location attribution.
      "COALESCE(e.location_type, 'headoffice')", "COALESCE(e.location_id, 0)",
    );
    const { rows } = await pool.query(`
      SELECT e.id, e.expense_date, e.description, e.ledger_account_id, e.payment_account_id,
             e.amount, e.created_at, e.expense_number, e.category, e.attachment_url,
             e.location_type, e.location_id,
             al.name AS ledger_name, cb.name AS cash_bank_name,
             COALESCE(w.name, o.name) AS location_name
      FROM expenses e
      LEFT JOIN account_ledgers    al ON al.id = e.ledger_account_id
      LEFT JOIN cash_bank_accounts cb ON cb.id = e.payment_account_id
      LEFT JOIN warehouses w ON e.location_type = 'warehouse' AND w.id = e.location_id
      LEFT JOIN outlets    o ON e.location_type = 'outlet'    AND o.id = e.location_id
      ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      ORDER BY e.id DESC
    `, params);
    directExpenses = rows.map((r: any) => ({
      id: r.id,
      source: 'direct' as const,
      expenseDate: r.expense_date,
      description: r.description ?? null,
      ledgerAccountId: r.ledger_account_id,
      ledgerAccountName: r.ledger_name ?? "",
      paymentAccountId: r.payment_account_id,
      paymentAccountName: r.cash_bank_name ?? "",
      amount: Number(r.amount),
      voucherNumber: r.expense_number ?? null,
      createdAt: r.created_at,
      expenseNumber: r.expense_number ?? null,
      category: r.category ?? null,
      attachmentUrl: r.attachment_url ?? null,
      locationType: r.location_type ?? 'headoffice',
      locationId: r.location_id ?? 0,
      locationName: r.location_name ?? 'Head Office',
    }));
  }

  // 2. Location expenses: payments where paid_to is in Direct/Indirect Expense subtree
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  let locationExpenses: ExpenseRow[] = [];
  if (expenseLedgerIds.length > 0) {
    // LBAC: non-HO users see only their location's expenses (from their cash ledger)
    let cashLedgerFilter = '';
    const pmtParams: any[] = [expenseLedgerIds];
    if (!isHO && expEmp) {
      const locTable = expEmp.branchType === 'warehouse' ? 'warehouses' : 'outlets';
      const { rows: [locRow] } = await pool.query(
        `SELECT cash_ledger_id FROM ${locTable} WHERE id = $1`, [expEmp.branchId]
      );
      if (locRow?.cash_ledger_id) {
        pmtParams.push(locRow.cash_ledger_id);
        cashLedgerFilter = ` AND p.paid_from_ledger_id = $${pmtParams.length}`;
      } else {
        // Location has no cash ledger configured — return empty
        res.json([]); return;
      }
    }

    // Optional client filters (narrowing only — the LBAC cash-ledger filter
    // above still applies).
    let extraFilter = '';
    if (dr.from) { pmtParams.push(dr.from); extraFilter += ` AND p.payment_date >= $${pmtParams.length}::date`; }
    if (dr.to)   { pmtParams.push(dr.to);   extraFilter += ` AND p.payment_date <= $${pmtParams.length}::date`; }
    if (locFilterReq && (locFilterReq.locationType === 'warehouse' || locFilterReq.locationType === 'outlet')) {
      // Stamped rows match on their stored identity; legacy unstamped rows
      // resolve through the cash ledger they were paid from. Mirror locations
      // (one place existing as both warehouse and outlet on a shared cash
      // ledger) make the stamped check necessary — the join alone would match
      // both identities.
      const joinAlias = locFilterReq.locationType === 'warehouse' ? 'w' : 'o';
      pmtParams.push(locFilterReq.locationType);
      const pType = pmtParams.length;
      pmtParams.push(locFilterReq.locationId);
      const pId = pmtParams.length;
      extraFilter += ` AND ((p.location_type = $${pType} AND p.location_id = $${pId})
        OR (p.location_type IS NULL AND ${joinAlias}.id = $${pId}))`;
    } else if (locFilterReq) {
      // Head Office is never a location expense (see the w/o guard below).
      res.json(directExpenses.sort((a, b) => String(b.expenseDate).localeCompare(String(a.expenseDate))));
      return;
    }

    const { rows: pmtRows } = await pool.query(`
      SELECT p.id, p.voucher_number, p.payment_date, p.paid_from_ledger_id,
             p.paid_to_ledger_id, p.amount, p.narration, p.created_at,
             p.expense_category, p.attachment_url, p.location_type, p.location_id,
             pf.name AS paid_from_name, pt.name AS paid_to_name,
             COALESCE(w.name, o.name) AS location_name
      FROM payments p
      LEFT JOIN account_ledgers pf ON p.paid_from_ledger_id = pf.id
      LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
      LEFT JOIN warehouses w ON w.cash_ledger_id = p.paid_from_ledger_id
      LEFT JOIN outlets    o ON o.cash_ledger_id = p.paid_from_ledger_id
      WHERE p.paid_to_ledger_id = ANY($1)${cashLedgerFilter}${extraFilter}
        -- Must be spent out of a location's own cash box. Without this, an
        -- ordinary Head Office payment to an expense head is dressed up as a
        -- location expense with a blank location, and its voucher prints as
        -- one. A payment is a location expense only if a location paid it.
        AND (w.id IS NOT NULL OR o.id IS NOT NULL)
      ORDER BY p.id DESC
    `, pmtParams);

    locationExpenses = pmtRows.map((r: any) => ({
      id: r.id,
      source: 'location' as const,
      expenseDate: r.payment_date,
      description: r.narration ?? null,
      ledgerAccountId: r.paid_to_ledger_id,
      ledgerAccountName: r.paid_to_name ?? "",
      paymentAccountId: r.paid_from_ledger_id,
      paymentAccountName: r.paid_from_name ?? "",
      amount: Number(r.amount),
      voucherNumber: r.voucher_number ?? null,
      createdAt: r.created_at,
      expenseNumber: r.voucher_number ?? null,
      category: r.expense_category ?? null,
      attachmentUrl: r.attachment_url ?? null,
      locationType: r.location_type ?? null,
      locationId: r.location_id ?? null,
      locationName: r.location_name ?? '',
    }));
  }

  // Merge and sort by expenseDate descending (most recent first)
  const all = [...directExpenses, ...locationExpenses].sort(
    (a, b) => String(b.expenseDate).localeCompare(String(a.expenseDate))
  );
  const paging = parsePaging(req.query as Record<string, unknown>);
  setPagingHeaders(res, all.length, paging);
  res.json(applyPaging(all, paging));
});

/** Expense categories. Free text would fragment the audit trail across
 *  "Fuel", "fuel" and "Diesel/Fuel", so the set is fixed and validated here. */
export const EXPENSE_CATEGORIES = [
  'Uncategorised', 'Salaries & Wages', 'Rent & Utilities', 'Freight & Transport',
  'Fuel', 'Repairs & Maintenance', 'Packing & Consumables', 'Office & Admin',
  'Professional Fees', 'Marketing', 'Bank & Finance Charges', 'Taxes & Statutory',
  'Cold Storage', 'Travel', 'Other',
] as const;

/**
 * Read the expense extras from the RAW body — zod strips unknown keys.
 *
 * Category is optional: an absent or blank value defaults to 'Uncategorised'.
 * A supplied value must still match the fixed list so historical reporting
 * stays consistent, but the form no longer collects it.
 *
 * Attachments have been retired from the expense forms, so `attachmentUrl` is
 * no longer accepted from the client — new rows are always written with a null
 * attachment. Historical rows keep whatever path they already hold and still
 * render everywhere they are shown.
 */
function readExpenseExtras(body: any): { category: string; attachmentUrl: string | null } | { error: string } {
  const rawCat = body?.category;
  let category = 'Uncategorised';
  if (rawCat !== undefined && rawCat !== null && String(rawCat).trim() !== '') {
    const match = EXPENSE_CATEGORIES.find(c => c.toLowerCase() === String(rawCat).trim().toLowerCase());
    if (!match) return { error: `category must be one of: ${EXPENSE_CATEGORIES.join(', ')}` };
    category = match;
  }
  return { category, attachmentUrl: null };
}

router.post("/expenses", requireModuleAction("page:/accounts/expenses", "add"), async (req, res): Promise<void> => {
  const parsed = CreateExpenseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // expense_date is a NOT NULL DATE column and the zod schema only checks for a
  // string, so a blank or impossible date would otherwise reach the driver.
  if (!isIsoDate(parsed.data.expenseDate)) {
    res.status(400).json({ error: "expenseDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }

  // Head Office only. This row is paid from a company cash/bank account, which
  // a branch does not operate — a branch records spending through
  // /accounts/location-expenses, where its own cash balance is checked.
  const emp = (req as any).employee as { branchType: string; branchId: number; id?: number } | undefined;
  if (emp && emp.branchType !== 'headoffice') {
    res.status(403).json({
      error: "Only Head Office can record an expense against a company cash or bank account. Record this under Sales → Expenses to pay it from your location's cash.",
    });
    return;
  }

  const extras = readExpenseExtras(req.body);
  if ('error' in extras) { res.status(400).json({ error: extras.error }); return; }

  // The expense account must be a postable Indirect Expense ledger. Enforced
  // server-side so hiding non-expense accounts in the UI is never the only
  // guard. Historical rows posted to Direct Expense read fine — only new
  // writes are constrained.
  if (!(await isPostableIndirectExpenseLedger(Number(parsed.data.ledgerAccountId)))) {
    res.status(400).json({ error: "ledgerAccountId must be an active Indirect Expense ledger account." }); return;
  }

  // Attribution: which location the spend belongs to. Defaults to Head Office.
  let locationType = 'headoffice';
  let locationId: number | null = null;
  const rawLocType = (req.body as any)?.locationType;
  if (rawLocType !== undefined && rawLocType !== null && String(rawLocType).trim() !== '') {
    locationType = String(rawLocType).trim();
    if (!['headoffice', 'warehouse', 'outlet'].includes(locationType)) {
      res.status(400).json({ error: "locationType must be headoffice, warehouse or outlet" }); return;
    }
    if (locationType !== 'headoffice') {
      locationId = Number((req.body as any)?.locationId);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        res.status(400).json({ error: "locationId is required when locationType is not headoffice" }); return;
      }
      const table = locationType === 'warehouse' ? 'warehouses' : 'outlets';
      const { rows: [loc] } = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [locationId]);
      if (!loc) { res.status(400).json({ error: `No such ${locationType}` }); return; }
      // Attributing fresh spend to a retired outlet is new outlet activity;
      // expenses already booked against one stay in the books untouched.
      if (locationType === 'outlet' && await outletWritesBlocked(pool)) {
        res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
      }
    }
  }

  const expenseNumber = await nextVoucherNumber(pool, 'expense', String(parsed.data.expenseDate));

  const [row] = await db.insert(expensesTable).values({ ...parsed.data, amount: String(parsed.data.amount) }).returning();
  // Audit columns come from a startup migration, so Drizzle cannot write them.
  await pool.query(
    `UPDATE expenses SET expense_number = $1, category = $2, attachment_url = $3,
            location_type = $4, location_id = $5, created_by = $6
     WHERE id = $7`,
    [expenseNumber, extras.category, extras.attachmentUrl, locationType, locationId, emp?.id ?? null, row.id]
  );
  await db.execute(sql`UPDATE cash_bank_accounts SET balance = balance::numeric - ${parsed.data.amount} WHERE id = ${parsed.data.paymentAccountId}`);
  const [ledger] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, row.ledgerAccountId)).limit(1);
  const [cashBank] = await db.select().from(cashBankAccountsTable).where(eq(cashBankAccountsTable.id, row.paymentAccountId)).limit(1);
  res.status(201).json({
    ...row, ledgerAccountName: ledger?.name ?? "", paymentAccountName: cashBank?.name ?? "",
    amount: Number(row.amount),
    expenseNumber, voucherNumber: expenseNumber,
    category: extras.category, attachmentUrl: extras.attachmentUrl,
    locationType, locationId,
  });
});

// Category list for the pickers — one source of truth, shared by both pages.
router.get("/expenses/categories", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (_req, res): Promise<void> => {
  res.json(EXPENSE_CATEGORIES.map((name) => ({ name })));
});

// ── Location-scoped Expenses (Sales segment) ───────────────────────────────

/** Walk CoA tree to collect all descendant IDs of the given root node codes. */
async function getDescendantLedgerIds(rootCodes: string[]): Promise<number[]> {
  const { rows } = await pool.query(`SELECT id, parent_id, code, is_system_group FROM account_ledgers ORDER BY id`);
  const rootIds = new Set<number>(
    rows.filter((r: any) => rootCodes.includes(r.code)).map((r: any) => r.id)
  );
  for (let i = 0; i < 8; i++) {
    for (const r of rows) {
      if (r.parent_id && rootIds.has(r.parent_id)) rootIds.add(r.id);
    }
  }
  return rows
    .filter((r: any) => rootIds.has(r.id) && !r.is_system_group)
    .map((r: any) => r.id);
}

/**
 * True only when `id` is an active, postable (non-group) ledger under the
 * Indirect Expense subtree. This is the single source of truth for validating
 * the Expense Account chosen on either expense form — a group heading, an
 * inactive ledger, or anything outside Indirect Expense (Direct Expense,
 * Assets, Liabilities, Income, Clearing, Payables) is rejected.
 */
async function isPostableIndirectExpenseLedger(id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false;
  const allowed = await getDescendantLedgerIds(['SYS-INDEXP']);
  if (!allowed.includes(id)) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM account_ledgers
      WHERE id = $1 AND COALESCE(is_active, true) AND NOT COALESCE(is_group, false)`,
    [id],
  );
  return rows.length > 0;
}

/** Resolve the cash_ledger_id for a given warehouse or outlet. */
async function resolveLocationCashLedger(locationType: string, locationId: number): Promise<number | null> {
  if (locationType === 'warehouse') {
    const { rows } = await pool.query(`SELECT cash_ledger_id FROM warehouses WHERE id = $1`, [locationId]);
    return rows[0]?.cash_ledger_id ?? null;
  } else if (locationType === 'outlet') {
    const { rows } = await pool.query(`SELECT cash_ledger_id FROM outlets WHERE id = $1`, [locationId]);
    return rows[0]?.cash_ledger_id ?? null;
  }
  return null;
}

// Postable expense ledgers for the "Expense Account" dropdown.
//
// Defaults to Indirect Expense only — day-to-day expenses (rent, utilities,
// freight, admin, etc.) belong under Indirect Expense, never Direct Expense,
// Assets, Liabilities, Income, Clearing or Payables. Groups and inactive
// ledgers are never postable, so they are excluded too.
//
// A caller that legitimately needs Direct Expense as well (there is none today,
// but historical entries exist) can pass ?include=all to widen the set; the
// read/report endpoints below always keep both subtrees so posted history is
// never hidden.
router.get("/accounts/expense-ledgers", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (req, res): Promise<void> => {
  const include = String((req.query as any)?.include ?? '').trim().toLowerCase();
  const rootCodes = include === 'all' || include === 'direct'
    ? ['SYS-DIREXP', 'SYS-INDEXP']
    : ['SYS-INDEXP'];
  const ids = await getDescendantLedgerIds(rootCodes);
  if (ids.length === 0) { res.json([]); return; }
  // Groups and deactivated ledgers are not postable, so they are not offered.
  const { rows } = await pool.query(
    `SELECT id, name, type, code, parent_id FROM account_ledgers
      WHERE id = ANY($1) AND COALESCE(is_active, true) AND NOT COALESCE(is_group, false)
      ORDER BY name`,
    [ids]
  );
  res.json(rows.map((r: any) => ({ id: r.id, name: r.name, type: r.type, code: r.code ?? null, parentId: r.parent_id ?? null })));
});

// Summary: all locations with expense count + total, for the "By Location" overview tab
router.get("/accounts/location-expenses/summary", requireModuleView("page:/accounts/expenses"), async (req, res): Promise<void> => {
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);

  // LBAC: non-HO users see only their own location
  const sumEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const sumIsHO = !sumEmp || sumEmp.branchType === 'headoffice';

  // Fetch warehouses and outlets (scoped to user's location if non-HO)
  let warehouses: any[] = [];
  let outlets: any[] = [];
  if (sumIsHO) {
    const wRes = await pool.query(`SELECT id, name, cash_ledger_id FROM warehouses WHERE cash_ledger_id IS NOT NULL ORDER BY name`);
    const oRes = await pool.query(`SELECT id, name, cash_ledger_id FROM outlets WHERE cash_ledger_id IS NOT NULL ORDER BY name`);
    warehouses = wRes.rows;
    outlets = oRes.rows;
  } else if (sumEmp.branchType === 'warehouse') {
    const { rows } = await pool.query(`SELECT id, name, cash_ledger_id FROM warehouses WHERE id = $1 AND cash_ledger_id IS NOT NULL`, [sumEmp.branchId]);
    warehouses = rows;
  } else {
    const { rows } = await pool.query(`SELECT id, name, cash_ledger_id FROM outlets WHERE id = $1 AND cash_ledger_id IS NOT NULL`, [sumEmp.branchId]);
    outlets = rows;
  }

  const locations: Array<{
    locationType: string; locationId: number; locationName: string;
    cashLedgerId: number; count: number; total: number;
  }> = [];

  if (expenseLedgerIds.length === 0) {
    // No expense ledgers configured yet — return all locations with zero totals
    for (const w of warehouses) {
      locations.push({ locationType: 'warehouse', locationId: w.id, locationName: w.name, cashLedgerId: w.cash_ledger_id, count: 0, total: 0 });
    }
    for (const o of outlets) {
      locations.push({ locationType: 'outlet', locationId: o.id, locationName: o.name, cashLedgerId: o.cash_ledger_id, count: 0, total: 0 });
    }
    res.json(locations); return;
  }

  // Collect all cash_ledger_ids → location mapping
  const allLocations = [
    ...warehouses.map((w: any) => ({ locationType: 'warehouse', locationId: w.id, locationName: w.name, cashLedgerId: w.cash_ledger_id })),
    ...outlets.map((o: any) => ({ locationType: 'outlet', locationId: o.id, locationName: o.name, cashLedgerId: o.cash_ledger_id })),
  ];

  if (allLocations.length === 0) { res.json([]); return; }

  // One query: count + sum grouped by the location stamp. Grouping by the
  // funding ledger would drop every Bank and Credit expense from its location's
  // total, because neither is funded by that location's till.
  const { rows: stats } = await pool.query(`
    SELECT location_type, location_id, COUNT(*) AS cnt, SUM(amount) AS total
    FROM payments
    WHERE is_location_expense = true
      AND paid_to_ledger_id = ANY($1)
    GROUP BY location_type, location_id
  `, [expenseLedgerIds]);

  const statsMap = new Map<string, { count: number; total: number }>(
    stats.map((r: any) => [`${r.location_type}:${Number(r.location_id)}`, { count: Number(r.cnt), total: Number(r.total) }])
  );

  // A place mirrored as both an outlet and a warehouse row must report the same
  // figure on both of its entries, so totals are summed over every identity
  // sharing the cash ledger rather than over the single stamp on the row.
  const { rows: identityRows } = await pool.query(`
    SELECT 'warehouse' AS t, id, cash_ledger_id FROM warehouses WHERE cash_ledger_id IS NOT NULL
    UNION ALL
    SELECT 'outlet' AS t, id, cash_ledger_id FROM outlets WHERE cash_ledger_id IS NOT NULL
  `);
  const byCashLedger = new Map<number, Array<{ t: string; id: number }>>();
  for (const r of identityRows) {
    const k = Number(r.cash_ledger_id);
    if (!byCashLedger.has(k)) byCashLedger.set(k, []);
    byCashLedger.get(k)!.push({ t: r.t, id: Number(r.id) });
  }

  for (const loc of allLocations) {
    const ids = byCashLedger.get(Number(loc.cashLedgerId)) ?? [{ t: loc.locationType, id: loc.locationId }];
    let count = 0, total = 0;
    for (const i of ids) {
      const s = statsMap.get(`${i.t}:${i.id}`);
      if (s) { count += s.count; total += s.total; }
    }
    locations.push({ ...loc, count, total });
  }

  res.json(locations);
});

// List expenses for a specific location (payments where paid_from = location's cash ledger
// AND paid_to belongs to Direct/Indirect Expense ledger subtree)
// ── GET /accounts/location-expenses/all — all locations combined ──────────────
// No mapped consumer; serves the Expenses page.
router.get("/accounts/location-expenses/all", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (req, res): Promise<void> => {
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  if (expenseLedgerIds.length === 0) { res.json([]); return; }

  // LBAC: non-HO users see only their own location's expenses
  const allEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  const allIsHO = !allEmp || allEmp.branchType === 'headoffice';

  // LBAC scopes on the location stamp rather than the funding ledger: a
  // bank-paid or unpaid expense belongs to its location without ever touching
  // that location's till.
  let locationFilterAll = '';
  const allParams: any[] = [expenseLedgerIds];
  if (!allIsHO && allEmp) {
    const identities = await resolveLocationIdentities(allEmp.branchType, Number(allEmp.branchId));
    locationFilterAll = ` AND ${locationIdentitySql(identities, allParams)}`;
  }

  // Location comes off the row's own stamp; names are looked up from it. The
  // funding ledger is reported separately because it is now Cash, Bank or
  // Expense Payable depending on the payment method.
  const { rows } = await pool.query(`
    SELECT p.id, p.voucher_number, p.payment_date, p.paid_from_ledger_id, p.paid_to_ledger_id,
           p.amount, p.narration, p.created_at, p.expense_category, p.attachment_url,
           p.payment_mode, p.notes, p.location_type, p.location_id,
           pt.name AS expense_ledger_name,
           pf.name AS paid_from_name,
           COALESCE(w.name, o.name)         AS location_name
    FROM payments p
    LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
    LEFT JOIN account_ledgers pf ON p.paid_from_ledger_id = pf.id
    LEFT JOIN warehouses w ON p.location_type = 'warehouse' AND w.id = p.location_id
    LEFT JOIN outlets    o ON p.location_type = 'outlet'    AND o.id = p.location_id
    WHERE p.is_location_expense = true
      AND p.paid_to_ledger_id = ANY($1)${locationFilterAll}
    ORDER BY p.payment_date DESC, p.id DESC
  `, allParams);

  res.json(rows.map((r: any) => ({
    id: r.id,
    voucherNumber: r.voucher_number,
    expenseDate: r.payment_date,
    expenseLedgerId: r.paid_to_ledger_id,
    expenseLedgerName: r.expense_ledger_name ?? '',
    amount: Number(r.amount),
    description: r.narration,
    locationName: r.location_name ?? `${r.location_type} #${r.location_id}`,
    locationType: r.location_type,
    locationId: Number(r.location_id),
    createdAt: r.created_at,
    category: r.expense_category ?? null,
    attachmentUrl: r.attachment_url ?? null,
    paymentMode: r.payment_mode ?? 'cash',
    paidFromName: r.paid_from_name ?? '',
    notes: r.notes ?? null,
  })));
});

router.get("/accounts/location-expenses", requireModuleView(["page:/accounts/expenses", "page:/sales/expenses"]), async (req, res): Promise<void> => {
  const { locationType, locationId } = req.query as { locationType?: string; locationId?: string };
  if (!locationType || !locationId) {
    res.status(400).json({ error: "locationType and locationId are required" }); return;
  }
  // LBAC: non-HO users may only view their own location's expenses
  const locExpEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (locExpEmp && locExpEmp.branchType !== 'headoffice') {
    const reqLocType = String(locationType);
    const reqLocId   = Number(locationId);
    const empLocType = locExpEmp.branchType; // 'warehouse' or 'outlet'
    if (reqLocType !== empLocType || reqLocId !== locExpEmp.branchId) {
      res.status(403).json({ error: "Access denied: you may only view your own location's expenses" }); return;
    }
  }
  const cashLedgerId = await resolveLocationCashLedger(locationType, Number(locationId));
  if (!cashLedgerId) {
    res.status(404).json({ error: "Location has no Cash ledger assigned. Provision it under Accounts → Warehouses/Outlets." }); return;
  }
  // Fetch cash ledger name regardless of whether any expenses or expense ledgers exist.
  // Always return the wrapper shape so the frontend can gate UI on cashLedgerName.
  const { rows: clRows } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [cashLedgerId]);
  const cashLedgerName = clRows[0]?.name ?? '';

  // Only include payments to expense-category ledgers (Direct + Indirect Expense subtree)
  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  if (expenseLedgerIds.length === 0) {
    // No expense categories configured yet — return wrapper with correct metadata and empty list
    res.json({ cashLedgerId, cashLedgerName, expenses: [] }); return;
  }

  // Keyed on the location stamp, not the till: Bank and Credit expenses belong
  // to this location's list even though its cash ledger never funded them.
  const identities = await resolveLocationIdentities(String(locationType), Number(locationId));
  const singleParams: any[] = [expenseLedgerIds];
  const identityFilter = locationIdentitySql(identities, singleParams);
  const { rows } = await pool.query(`
    SELECT p.id, p.voucher_number, p.payment_date, p.paid_from_ledger_id, p.paid_to_ledger_id, p.amount, p.narration, p.created_at,
           p.expense_category, p.attachment_url, p.payment_mode, p.notes,
           pf.name AS paid_from_name, pt.name AS paid_to_name
    FROM payments p
    LEFT JOIN account_ledgers pf ON p.paid_from_ledger_id = pf.id
    LEFT JOIN account_ledgers pt ON p.paid_to_ledger_id = pt.id
    WHERE p.is_location_expense = true
      AND p.paid_to_ledger_id = ANY($1)
      AND ${identityFilter}
    ORDER BY p.id DESC
  `, singleParams);
  // Return wrapper object so cashLedgerName is always available even when no expenses exist
  res.json({
    cashLedgerId,
    cashLedgerName,
    expenses: rows.map((r: any) => ({
      id: r.id,
      voucherNumber: r.voucher_number,
      expenseDate: r.payment_date,
      expenseLedgerId: r.paid_to_ledger_id,
      expenseLedgerName: r.paid_to_name ?? '',
      cashLedgerId: r.paid_from_ledger_id,
      cashLedgerName: r.paid_from_name ?? '',
      amount: Number(r.amount),
      description: r.narration,
      createdAt: r.created_at,
      category: r.expense_category ?? null,
      attachmentUrl: r.attachment_url ?? null,
      paymentMode: r.payment_mode ?? 'cash',
      paidFromName: r.paid_from_name ?? '',
      notes: r.notes ?? null,
    })),
  });
});

/**
 * A location's cash-in-hand, from the accounting postings.
 *
 * This gates the "a till can only spend what it holds" check on cash expenses,
 * so it has to be the same number the Cash Book shows. The previous version
 * added up `receipts` and `payments` only — a second, narrower definition of
 * cash that could not see a till sale, a contra or a journal. It was also a
 * verbatim copy of the helper in the cash-in-outlet route, so the two could
 * drift apart independently. Both now go through the shared balance service.
 */
async function getLocationCashBalance(ledgerId: number): Promise<number> {
  const { currentBalanceIndex } = await import("../lib/ledgerBalances");
  return (await currentBalanceIndex()).net(ledgerId);
}

/**
 * Every (locationType, locationId) pair that denotes the same physical place.
 *
 * Outlets are mirrored as rows in `warehouses` sharing the same cash and sales
 * ledgers, so "Indiranagar Outlet" exists as both outlet 1 and warehouse 3.
 * Reads keyed on one stamp would show an expense on one of those pages and hide
 * it on the other, so a location resolves to every identity that shares its
 * cash ledger. Rows with no cash ledger resolve to themselves.
 */
async function resolveLocationIdentities(
  locationType: string, locationId: number,
): Promise<Array<{ type: string; id: number }>> {
  const out = [{ type: String(locationType), id: Number(locationId) }];
  const cashLedgerId = await resolveLocationCashLedger(locationType, Number(locationId));
  if (!cashLedgerId) return out;
  const { rows } = await pool.query(
    `SELECT 'warehouse' AS t, id FROM warehouses WHERE cash_ledger_id = $1
     UNION ALL
     SELECT 'outlet' AS t, id FROM outlets WHERE cash_ledger_id = $1`,
    [cashLedgerId],
  );
  for (const r of rows) {
    if (!out.some(o => o.type === r.t && o.id === Number(r.id))) out.push({ type: r.t, id: Number(r.id) });
  }
  return out;
}

/** `(location_type = $n AND location_id = $n+1) OR (…)` for an identity set. */
function locationIdentitySql(
  identities: Array<{ type: string; id: number }>, params: any[], alias = 'p',
): string {
  const clauses = identities.map(i => {
    params.push(i.type, i.id);
    return `(${alias}.location_type = $${params.length - 1} AND ${alias}.location_id = $${params.length})`;
  });
  return `(${clauses.join(' OR ')})`;
}

// Create a location-scoped expense. The debit is always the chosen expense
// ledger. What gets credited depends on how it was paid:
//
//   cash   → that location's own till   (balance-checked, cannot go negative)
//   bank   → a company bank ledger      (Head Office only — a branch may move
//                                        only its own cash, per LBAC)
//   credit → Expense Payable            (no money moves; cleared when settled)
//
// The location is stamped on the row in every mode: a bank-paid or unpaid
// expense still belongs to the location that incurred it.
router.post("/accounts/location-expenses", requireModuleAction("page:/sales/expenses", "add"), async (req, res): Promise<void> => {
  const { locationType, locationId, expenseLedgerId, amount, expenseDate, description, reference } = req.body as {
    locationType: string; locationId: number; expenseLedgerId: number;
    amount: number; expenseDate: string; description: string; reference?: string;
  };
  if (!locationType || !locationId || !expenseLedgerId || !amount || !expenseDate || !description) {
    res.status(400).json({ error: "locationType, locationId, expenseLedgerId, amount, expenseDate and description are required" }); return;
  }
  if (!isIsoDate(expenseDate)) {
    res.status(400).json({ error: "expenseDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }
  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) {
    res.status(400).json({ error: "Amount must be positive." }); return;
  }
  // Payment method. Defaults to 'cash' so existing callers (and the mobile app)
  // that never send one keep their previous behaviour exactly.
  const rawMode = req.body?.paymentMode;
  const paymentMode = rawMode === undefined || rawMode === null || String(rawMode).trim() === ''
    ? 'cash'
    : String(rawMode).trim().toLowerCase();
  if (!['cash', 'bank', 'credit'].includes(paymentMode)) {
    res.status(400).json({ error: "paymentMode must be one of: cash, bank, credit" }); return;
  }
  const rawNotes = req.body?.notes;
  const notes = rawNotes === undefined || rawNotes === null || String(rawNotes).trim() === ''
    ? null : String(rawNotes).trim();
  // A retired outlet cannot take on new spending — that would be fresh outlet
  // activity in the books. Past outlet expenses stay readable.
  if (locationType === 'outlet' && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }
  // The stamp has to name a real location in EVERY mode. Only the cash path
  // failed closed on its own (no location, no till, nothing to debit); bank and
  // credit would otherwise stamp an expense onto an id that does not exist,
  // stranding a live voucher where no location page can ever list it.
  if (!['warehouse', 'outlet'].includes(String(locationType))) {
    res.status(400).json({ error: "locationType must be 'warehouse' or 'outlet'" }); return;
  }
  const { rows: [locRow] } = await pool.query(
    String(locationType) === 'warehouse'
      ? `SELECT id FROM warehouses WHERE id = $1`
      : `SELECT id FROM outlets WHERE id = $1`,
    [Number(locationId)],
  );
  if (!locRow) {
    res.status(400).json({ error: `No such ${locationType}: ${locationId}` }); return;
  }
  // Server-side validation: the expense account must be a postable Indirect
  // Expense ledger. Direct Expense, Assets, Liabilities, Income, Clearing and
  // Payable accounts are rejected — frontend filtering alone is not trusted.
  // (Historical vouchers already posted to Direct Expense are untouched: the
  // read/report endpoints still resolve both subtrees.)
  if (!(await isPostableIndirectExpenseLedger(Number(expenseLedgerId)))) {
    res.status(400).json({ error: "expenseLedgerId must be an active Indirect Expense ledger account." }); return;
  }
  // LBAC: a branch user may only spend its own location's cash.
  const expEmployee = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (expEmployee && expEmployee.branchType !== 'headoffice') {
    if (String(locationType) !== expEmployee.branchType || Number(locationId) !== Number(expEmployee.branchId)) {
      res.status(403).json({ error: "Access denied: you may only record expenses for your own location" }); return;
    }
  }
  // ── Funding side: what gets credited ───────────────────────────────────────
  // The location's own cash ledger is resolved in every mode, because the page
  // reports it back as the location's till even when this particular expense
  // was not paid from it.
  const cashLedgerId = await resolveLocationCashLedger(locationType, Number(locationId));
  let fundingLedgerId: number;

  if (paymentMode === 'cash') {
    if (!cashLedgerId) {
      res.status(400).json({ error: "This location has no Cash ledger. Provision ledgers under Accounts → Warehouses/Outlets first." }); return;
    }
    fundingLedgerId = cashLedgerId;
    // Cash cannot go negative: a till can only spend what it holds.
    const cashBalance = await getLocationCashBalance(cashLedgerId);
    if (parsedAmount > cashBalance + 0.001) {
      res.status(400).json({
        error: `Insufficient cash. Available balance is ₹${cashBalance.toFixed(2)} but expense is ₹${parsedAmount.toFixed(2)}.`,
      }); return;
    }
  } else if (paymentMode === 'bank') {
    // A branch may move only its own cash — company bank accounts are Head
    // Office. Without this the bank mode would be a way around that rule.
    if (expEmployee && expEmployee.branchType !== 'headoffice') {
      res.status(403).json({ error: "Access denied: only Head Office can pay an expense from a bank account. Record it as Cash or Credit." }); return;
    }
    const bankLedgerId = Number(req.body?.paymentAccountId);
    if (!Number.isFinite(bankLedgerId) || bankLedgerId <= 0) {
      res.status(400).json({ error: "paymentAccountId is required when paymentMode is 'bank'" }); return;
    }
    const bankIds = await getDescendantLedgerIds(['STD-BANK']);
    if (!bankIds.includes(bankLedgerId)) {
      res.status(400).json({ error: "paymentAccountId must be a Bank ledger account" }); return;
    }
    fundingLedgerId = bankLedgerId;
  } else {
    // Credit: nothing moves now, the liability is recognised instead.
    const { rows: [payable] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'STD-EXP-PAY'`);
    if (!payable) {
      res.status(500).json({ error: "Expense Payable ledger is missing. Restart the server to provision standard ledgers." }); return;
    }
    fundingLedgerId = Number(payable.id);
  }

  const extras = readExpenseExtras(req.body);
  if ('error' in extras) { res.status(400).json({ error: extras.error }); return; }

  const narration = reference ? `${description} [Ref: ${reference}]` : description;
  const voucherNumber = await nextVoucherNumber(pool, 'payment', expenseDate);
  const { rows: [r] } = await pool.query(
    `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, location_type, location_id, expense_category, attachment_url, is_location_expense, payment_mode, notes, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $12, 'expense') RETURNING *`,
    [voucherNumber, expenseDate, fundingLedgerId, Number(expenseLedgerId), parsedAmount, narration,
     String(locationType), Number(locationId), extras.category, extras.attachmentUrl, paymentMode, notes]
  );
  const { rows: [pf] } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [fundingLedgerId]);
  const { rows: [pt] } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [expenseLedgerId]);
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, expenseDate: r.payment_date,
    expenseLedgerId: r.paid_to_ledger_id, expenseLedgerName: pt?.name ?? '',
    cashLedgerId: r.paid_from_ledger_id, cashLedgerName: pf?.name ?? '',
    amount: Number(r.amount), description: r.narration, createdAt: r.created_at,
    category: extras.category, attachmentUrl: extras.attachmentUrl,
    paymentMode, notes,
  });
});

// Delete a location expense recorded in error (Phase 7, task #40).
// Guards: the payment row must actually BE a location expense — paid_from must
// be a location's cash ledger and paid_to must sit in the Direct/Indirect
// Expense subtree. Anything else must be deleted from its own page.
router.delete("/accounts/location-expenses/:id", requireModuleAction("page:/sales/expenses", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid expense id" }); return; }

  const expenseLedgerIds = await getDescendantLedgerIds(['SYS-DIREXP', 'SYS-INDEXP']);
  const { rows: [row] } = await pool.query(`
    SELECT p.id, p.voucher_number, p.amount, p.paid_to_ledger_id, p.is_location_expense,
           p.location_type, p.location_id,
           pt.name AS expense_name,
           COALESCE(w.name, o.name) AS location_name,
           CASE WHEN p.location_type = 'outlet' THEN p.location_id END AS outlet_id
    FROM payments p
    LEFT JOIN account_ledgers pt ON pt.id = p.paid_to_ledger_id
    LEFT JOIN warehouses w ON p.location_type = 'warehouse' AND w.id = p.location_id
    LEFT JOIN outlets    o ON p.location_type = 'outlet'    AND o.id = p.location_id
    WHERE p.id = $1
  `, [id]);
  if (!row) { res.status(404).json({ error: "Expense not found" }); return; }
  // The flag is the discriminator, not the funding ledger: a Bank or Credit
  // expense is still a location expense and must stay deletable here.
  if (!row.is_location_expense || !expenseLedgerIds.includes(Number(row.paid_to_ledger_id))) {
    res.status(400).json({ error: "This voucher is not a location expense. Delete it from Accounts → Vouchers instead." });
    return;
  }
  // Outlet history is never destroyed while the module is retired — deleting an
  // outlet's expense voucher would silently rewrite an audited past period.
  if (row.outlet_id != null && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }

  await pool.query(`DELETE FROM payments WHERE id = $1`, [id]);
  logActivity({
    action: 'DELETE', module: 'accounts', entityType: 'location-expense', entityId: id,
    description: `Deleted location expense ${row.voucher_number} — ${row.expense_name ?? 'expense'} ₹${Number(row.amount)} at ${row.location_name}`,
    user: (req as any).employee?.username ?? 'system',
  }).catch(() => {});
  res.json({ ok: true, id });
});

// ── Financial Statements (Balance Sheet + P&L) ────────────────────────────
//
// Both statements are assembled by `buildBooks()` from the derived posting
// stream, so they agree with the Trial Balance, Cash Book and Bank Book by
// construction. See lib/books.ts for why that removes the plug figure.
router.get("/accounts/financial-statements", requireModuleView(["page:/accounts/chart", "page:/reports/sales"]), async (req, res): Promise<void> => {
  // LBAC: P&L and Balance Sheet are Head Office accounting
  if ((req as any).employee?.branchType !== 'headoffice') { res.json({ pl: null, bs: null }); return; }
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };
  const location = getPostingLocationFilter(req);

  const books = await buildBooks(buildDerivedPostings, { fromDate, toDate, location });

  const [{ rows: warehouses }, { rows: outlets }] = await Promise.all([
    pool.query(`SELECT id, name FROM warehouses ORDER BY id`),
    pool.query(`SELECT id, name FROM outlets ORDER BY id`),
  ]);

  // A filtered view must say what it could NOT attribute: journal-family
  // vouchers and legacy unstamped rows are company-level, and dropping them
  // silently would make per-location statements look like they sum to less
  // than the consolidated books.
  let companyLevel: { entries: number; debit: number; credit: number } | null = null;
  if (location && location.type !== "company") {
    let postings = await buildDerivedPostings(isIsoDate(toDate) ? { toDate } : {});
    if (isIsoDate(fromDate)) postings = postings.filter((p) => p.date >= fromDate);
    companyLevel = companyLevelSummary(postings);
  }

  res.json({
    // Every posting now carries its source document's location (both legs the
    // same stamp), so a location slice is a balanced set of whole entries, not
    // an unbalanced fragment. Unfiltered output is unchanged.
    locationScoped: location != null,
    ...(location ? { location: { type: location.type, id: location.id }, companyLevel } : {}),
    filters: { warehouses, outlets },
    ...books,
  });
});

// ── Ledger Statement ──────────────────────────────────────────────────────
// LBAC: branch users get their own movements on the requested ledger; the
// expenses table and journal-family vouchers stay Head Office (no location).
router.get("/accounts/ledger/:id/statement", requireModuleView("page:/accounts/ledger"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid ledger id" }); return; }
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };
  // Presentation narrowing only; LBAC below still applies first.
  const locFilter = getPostingLocationFilter(req);

  const { rows: [ledger] } = await pool.query(
    `SELECT id, name, type, code FROM account_ledgers WHERE id = $1`, [id]
  );
  if (!ledger) { res.status(404).json({ error: "Ledger not found" }); return; }

  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  if (!scope.isHeadOffice) {
    const foreign = await foreignLocationLedgerIds(scope);
    if (foreign.includes(id)) {
      res.status(403).json({ error: "That account belongs to another location." }); return;
    }
  }
  /** Money-voucher scope fragment for this caller, appended to `params`. */
  const moneyScope = (params: any[], alias: 'p' | 'r'): string => {
    const legs: [string, string] = alias === 'p'
      ? ['paid_from_ledger_id', 'paid_to_ledger_id']
      : ['received_in_ledger_id', 'received_from_ledger_id'];
    return ` AND ${scopeMoneyWhere(scope, ledgerIds, params, alias, legs)}`;
  };

  // Build date-range helpers
  const dateClause = (col: string, params: any[]) => {
    const conds: string[] = [];
    if (fromDate) { params.push(fromDate); conds.push(`${col} >= $${params.length}`); }
    if (toDate)   { params.push(toDate);   conds.push(`${col} <= $${params.length}`); }
    return conds.length ? ` AND ${conds.join(' AND ')}` : '';
  };

  // Payments where this ledger is the source (credit — money leaves)
  const pFromParams: any[] = [id];
  const { rows: payFromRows } = await pool.query(
    `SELECT p.id, p.payment_date AS date, p.amount, p.voucher_number, p.narration,
            pt.name AS other_name
     FROM payments p
     LEFT JOIN account_ledgers pt ON pt.id = p.paid_to_ledger_id
     WHERE p.paid_from_ledger_id = $1${dateClause('p.payment_date', pFromParams)}${moneyScope(pFromParams, 'p')}${documentLocationCond(locFilter, 'p', pFromParams, 'headoffice')}
     ORDER BY p.payment_date, p.id`, pFromParams
  );

  // Payments where this ledger is the destination (debit — money arrives)
  const pToParams: any[] = [id];
  const { rows: payToRows } = await pool.query(
    `SELECT p.id, p.payment_date AS date, p.amount, p.voucher_number, p.narration,
            pf.name AS other_name
     FROM payments p
     LEFT JOIN account_ledgers pf ON pf.id = p.paid_from_ledger_id
     WHERE p.paid_to_ledger_id = $1${dateClause('p.payment_date', pToParams)}${moneyScope(pToParams, 'p')}${documentLocationCond(locFilter, 'p', pToParams, 'headoffice')}
     ORDER BY p.payment_date, p.id`, pToParams
  );

  // Receipts where this ledger is the source (credit)
  const rFromParams: any[] = [id];
  const { rows: recFromRows } = await pool.query(
    `SELECT r.id, r.receipt_date AS date, r.amount, r.voucher_number, r.narration,
            ri.name AS other_name
     FROM receipts r
     LEFT JOIN account_ledgers ri ON ri.id = r.received_in_ledger_id
     WHERE r.received_from_ledger_id = $1${dateClause('r.receipt_date', rFromParams)}${moneyScope(rFromParams, 'r')}${documentLocationCond(locFilter, 'r', rFromParams, 'headoffice')}
     ORDER BY r.receipt_date, r.id`, rFromParams
  ).catch(() => ({ rows: [] }));

  // Receipts where this ledger is the destination (debit)
  const rToParams: any[] = [id];
  const { rows: recToRows } = await pool.query(
    `SELECT r.id, r.receipt_date AS date, r.amount, r.voucher_number, r.narration,
            rf.name AS other_name
     FROM receipts r
     LEFT JOIN account_ledgers rf ON rf.id = r.received_from_ledger_id
     WHERE r.received_in_ledger_id = $1${dateClause('r.receipt_date', rToParams)}${moneyScope(rToParams, 'r')}${documentLocationCond(locFilter, 'r', rToParams, 'headoffice')}
     ORDER BY r.receipt_date, r.id`, rToParams
  ).catch(() => ({ rows: [] }));

  // Expenses charged to this ledger (debit) — Head Office table only
  const expParams: any[] = [id];
  const { rows: expRows } = scope.isHeadOffice ? await pool.query(
    `SELECT e.id, e.expense_date AS date, e.amount, e.description, e.category
     FROM expenses e
     WHERE e.ledger_account_id = $1${dateClause('e.expense_date', expParams)}${documentLocationCond(locFilter, 'e', expParams, 'headoffice')}
     ORDER BY e.expense_date, e.id`, expParams
  ).catch(() => ({ rows: [] })) : { rows: [] as any[] };

  // Journal-family voucher lines touching this ledger — no location dimension,
  // so branch users don't see them (they never create them either). In a
  // location-sliced statement they are company-level: 'company' slice and the
  // unfiltered view only.
  const includeJvRows = scope.isHeadOffice && (!locFilter || locFilter.type === "company");
  const jvParams: any[] = [id];
  const { rows: jvRows } = includeJvRows ? await pool.query(
    `SELECT l.id, v.voucher_date AS date, v.voucher_number, v.voucher_type, v.narration,
            l.debit, l.credit
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     WHERE l.ledger_id = $1${dateClause('v.voucher_date', jvParams)}
     ORDER BY v.voucher_date, l.id`, jvParams
  ).catch(() => ({ rows: [] })) : { rows: [] as any[] };

  // Merge all entries
  const combined: { sortKey: string; date: string; description: string; reference: string; entryType: string; debit: number; credit: number }[] = [];

  for (const r of payFromRows) combined.push({
    sortKey: `${r.date}P-${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || `Payment to ${r.other_name}`,
    entryType: 'payment', debit: 0, credit: Number(r.amount),
  });
  for (const r of payToRows) combined.push({
    sortKey: `${r.date}P+${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || `Payment from ${r.other_name}`,
    entryType: 'payment', debit: Number(r.amount), credit: 0,
  });
  for (const r of recFromRows) combined.push({
    sortKey: `${r.date}R-${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || `Receipt to ${r.other_name}`,
    entryType: 'receipt', debit: 0, credit: Number(r.amount),
  });
  for (const r of recToRows) combined.push({
    sortKey: `${r.date}R+${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || `Receipt from ${r.other_name}`,
    entryType: 'receipt', debit: Number(r.amount), credit: 0,
  });
  for (const r of expRows) combined.push({
    sortKey: `${r.date}E+${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: `EXP-${r.id}`,
    description: r.description || r.category || 'Expense',
    entryType: 'expense', debit: Number(r.amount), credit: 0,
  });
  for (const r of jvRows) combined.push({
    sortKey: `${r.date}J+${String(r.id).padStart(8,'0')}`,
    date: r.date, reference: r.voucher_number,
    description: r.narration || (r.voucher_type === 'contra' ? 'Contra entry'
      : r.voucher_type === 'credit_note' ? 'Credit note'
      : r.voucher_type === 'debit_note' ? 'Debit note' : 'Journal entry'),
    entryType: r.voucher_type, debit: Number(r.debit), credit: Number(r.credit),
  });

  combined.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  let balance = 0;
  const entries = combined.map(({ sortKey: _sk, ...e }) => {
    balance += e.debit - e.credit;
    return { ...e, balance };
  });

  const totalDebit  = entries.reduce((s, e) => s + e.debit,  0);
  const totalCredit = entries.reduce((s, e) => s + e.credit, 0);

  res.json({
    ledger: { id: ledger.id, name: ledger.name, type: ledger.type, code: ledger.code },
    entries, totalDebit, totalCredit, closingBalance: balance,
    ...(locFilter ? { location: locFilter } : {}),
  });
});

// ── GST Summary ───────────────────────────────────────────────────────────
router.get("/gst/summary", requireModuleView(["page:/accounts/gst", "page:/accounts/gst-returns"]), async (req, res): Promise<void> => {
  // LBAC: GST summary is Head Office accounting
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({ salesByRate: [], purchasesByRate: [], totals: {} }); return;
  }
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };

  // Optional GSTIN / warehouse scoping. Resolved to document-id sets via raw
  // SQL because the legacy location columns (outlet_id / branch_*) fall back
  // differently per table; when no filter is active nothing here runs and the
  // output stays byte-identical.
  const gstinQ = typeof req.query.gstin === "string" && req.query.gstin.trim() ? req.query.gstin.trim() : undefined;
  const whQ = Number(req.query.warehouseId);
  const gstScope = (gstinQ || (Number.isInteger(whQ) && whQ > 0))
    ? await resolveGstScope({ gstin: gstinQ, warehouseId: Number.isInteger(whQ) && whQ > 0 ? whQ : undefined })
    : null;
  let saleIdOk: Set<number> | null = null;
  let purchaseIdOk: Set<number> | null = null;
  if (gstScope) {
    const scp: any[] = [];
    const { rows: sIds } = await pool.query(`SELECT id FROM sales s WHERE TRUE${salesScopeCond("s", gstScope, scp)}`, scp);
    saleIdOk = new Set(sIds.map((r: any) => Number(r.id)));
    const pcp: any[] = [];
    const { rows: pIds } = await pool.query(`SELECT id FROM purchases p WHERE TRUE${purchaseScopeCond("p", gstScope, pcp)}`, pcp);
    purchaseIdOk = new Set(pIds.map((r: any) => Number(r.id)));
  }

  // Cancelled documents are not tax documents. The dedicated GSTR-1 / GSTR-3B
  // endpoints have always excluded them; this summary did not, so the two
  // disagreed about the same period's liability.
  //
  // Branch-transfer invoices deliberately STAY: a cross-GSTIN stock transfer
  // carries real output GST that has to be paid, so excluding it here would
  // understate the liability. It is outward supply, not customer revenue —
  // which is why the revenue tiles and the sales reports filter it out and
  // this one does not.
  let allSales = await db.select().from(salesTable)
    .where(sql`cancelled_at IS NULL`).orderBy(salesTable.saleDate);
  if (fromDate) allSales = allSales.filter(s => s.saleDate >= fromDate);
  if (toDate) allSales = allSales.filter(s => s.saleDate <= toDate);
  if (saleIdOk) allSales = allSales.filter(s => saleIdOk.has(Number(s.id)));

  let allPurchases = await db.select().from(purchasesTable)
    .where(sql`cancelled_at IS NULL`).orderBy(purchasesTable.purchaseDate);
  if (fromDate) allPurchases = allPurchases.filter(p => p.purchaseDate >= fromDate);
  if (toDate) allPurchases = allPurchases.filter(p => p.purchaseDate <= toDate);
  if (purchaseIdOk) allPurchases = allPurchases.filter(p => purchaseIdOk.has(Number(p.id)));

  // Document-level tax: prefer the stored total when present, else the
  // per-line head sum via lineTaxHeads (legacy purchases have tax_total = 0).
  const docTax = (lines: any[], stored: number): number => {
    if (stored > 0.004) return stored;
    const headSum = lines.reduce((a, li) => { const h = lineTaxHeads(li); return a + h.cgst + h.sgst + h.igst; }, 0);
    return Math.round(headSum * 100) / 100;
  };

  const salesByRate = new Map<number, { taxableValue: number; cgst: number; sgst: number; igst: number; taxAmount: number }>();
  for (const sale of allSales) {
    const lineItems = (sale.lineItems ?? []) as any[];
    for (const li of lineItems) {
      const rate = Number(li.taxRate ?? 0);
      const sub = Number(li.lineSubtotal ?? (li.quantity * li.unitPrice - (li.discount ?? 0)));
      const existing = salesByRate.get(rate) ?? { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
      const h = lineTaxHeads(li);
      existing.taxableValue += sub;
      existing.cgst += h.cgst;
      existing.sgst += h.sgst;
      existing.igst += h.igst;
      existing.taxAmount += Number(li.taxAmount ?? 0);
      salesByRate.set(rate, existing);
    }
  }

  // Aggregate input tax from purchases using actual gstRate per line
  const purchasesByRate = new Map<number, { taxableValue: number; cgst: number; sgst: number; igst: number; taxAmount: number }>();
  for (const p of allPurchases) {
    const lineItems = (p.lineItems ?? []) as any[];
    for (const li of lineItems) {
      const rate = Number(li.gstRate ?? 0);
      const existing = purchasesByRate.get(rate) ?? { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
      const h = lineTaxHeads(li);
      existing.taxableValue += Number(li.taxableValue ?? 0);
      existing.cgst += h.cgst;
      existing.sgst += h.sgst;
      existing.igst += h.igst;
      existing.taxAmount += Number(li.taxAmount ?? 0);
      purchasesByRate.set(rate, existing);
    }
  }

  const totalSales = allSales.reduce((s, r) => s + Number(r.totalAmount), 0);
  const totalTaxCollected = allSales.reduce((s, r) => s + docTax((r.lineItems ?? []) as any[], Number(r.taxTotal ?? 0)), 0);
  const totalPurchases = allPurchases.reduce((s, p) => s + Number(p.totalAmount), 0);
  const totalTaxPaid = allPurchases.reduce((s, p) => s + docTax((p.lineItems ?? []) as any[], Number((p as any).taxTotal ?? 0)), 0);
  const netGstLiability = totalTaxCollected - totalTaxPaid;

  // Month-wise breakdown (output vs input tax per calendar month)
  const monthMap = new Map<string, { outputTaxable: number; outputTax: number; inputTaxable: number; inputTax: number }>();
  for (const s of allSales) {
    const k = String((s as any).saleDate).slice(0, 7);
    const e = monthMap.get(k) ?? { outputTaxable: 0, outputTax: 0, inputTaxable: 0, inputTax: 0 };
    const tax = docTax((s.lineItems ?? []) as any[], Number((s as any).taxTotal ?? 0));
    e.outputTax += tax;
    e.outputTaxable += Number(s.totalAmount) - tax;
    monthMap.set(k, e);
  }
  for (const p of allPurchases) {
    const k = String((p as any).purchaseDate).slice(0, 7);
    const e = monthMap.get(k) ?? { outputTaxable: 0, outputTax: 0, inputTaxable: 0, inputTax: 0 };
    const tax = docTax((p.lineItems ?? []) as any[], Number((p as any).taxTotal ?? 0));
    e.inputTax += tax;
    e.inputTaxable += Number(p.totalAmount) - tax;
    monthMap.set(k, e);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const monthWise = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, d]) => ({
      month,
      outputTaxable: r2(d.outputTaxable), outputTax: r2(d.outputTax),
      inputTaxable: r2(d.inputTaxable), inputTax: r2(d.inputTax),
      netGst: r2(d.outputTax - d.inputTax),
    }));

  const warehouses = await db.select().from(warehousesTable);

  res.json({
    totalSales, totalTaxCollected, totalPurchases, totalTaxPaid, netGstLiability, monthWise,
    salesByRate: Array.from(salesByRate.entries()).sort((a, b) => a[0] - b[0]).map(([taxRate, d]) => ({ taxRate, ...d })),
    purchasesByRate: Array.from(purchasesByRate.entries()).sort((a, b) => a[0] - b[0]).map(([taxRate, d]) => ({ taxRate, ...d, estimated: false })),
    byWarehouse: warehouses.map(w => ({ warehouseId: w.id, warehouseName: w.name, gstNumber: w.gstNumber, salesTax: 0, purchaseTax: 0 })),
  });
});

// ── Opening Balances ───────────────────────────────────────────────────────
// Opening balances allow the COA to reflect historical account positions so
// the Trial Balance, P&L and Balance Sheet are accurate from day one.

router.get("/accounts/opening-balances", requireModuleView("page:/accounts/chart"), async (_req, res): Promise<void> => {
  const { rows } = await pool.query(`
    SELECT ob.id, ob.ledger_id, ob.balance::float AS balance, ob.balance_type,
           ob.as_of_date, ob.financial_year, ob.notes, ob.created_by, ob.created_at, ob.updated_at,
           al.name AS ledger_name, al.code AS ledger_code, al.type AS ledger_type
    FROM opening_balances ob
    JOIN account_ledgers al ON al.id = ob.ledger_id
    ORDER BY ob.as_of_date DESC, al.name
  `);
  res.json(rows.map((r: any) => ({
    id: r.id,
    ledgerId: r.ledger_id,
    ledgerName: r.ledger_name,
    ledgerCode: r.ledger_code,
    ledgerType: r.ledger_type,
    balance: Number(r.balance),
    balanceType: r.balance_type,
    asOfDate: r.as_of_date instanceof Date ? r.as_of_date.toISOString().slice(0, 10) : String(r.as_of_date).slice(0, 10),
    financialYear: r.financial_year,
    notes: r.notes ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
  })));
});

router.post("/accounts/opening-balances", requireModuleAction("page:/accounts/chart", "add"), async (req, res): Promise<void> => {
  const body = req.body as any;
  const ledgerId = Number(body.ledgerId);
  const balance = Number(body.balance);
  const balanceType = String(body.balanceType ?? "debit");
  const asOfDate = String(body.asOfDate ?? "").slice(0, 10);
  const financialYear = String(body.financialYear ?? "").trim();
  const notes = body.notes ? String(body.notes).trim() || null : null;

  if (!Number.isFinite(ledgerId) || ledgerId <= 0) {
    res.status(400).json({ error: "ledgerId is required" }); return;
  }
  if (!Number.isFinite(balance) || balance < 0) {
    res.status(400).json({ error: "balance must be a non-negative number" }); return;
  }
  if (!["debit", "credit"].includes(balanceType)) {
    res.status(400).json({ error: "balanceType must be 'debit' or 'credit'" }); return;
  }
  if (!isIsoDate(asOfDate)) {
    res.status(400).json({ error: "asOfDate (YYYY-MM-DD) is required" }); return;
  }

  // Verify ledger exists and is postable (not a group)
  const { rows: [ledger] } = await pool.query(
    `SELECT id, name, is_group, is_system_group FROM account_ledgers WHERE id = $1`, [ledgerId]
  );
  if (!ledger) { res.status(404).json({ error: "Ledger not found" }); return; }
  if (ledger.is_group || ledger.is_system_group) {
    res.status(400).json({ error: `"${ledger.name}" is a group ledger — post opening balances to specific ledgers under it` }); return;
  }

  // Upsert: one opening balance record per ledger per financial year
  const { rows: [row] } = await pool.query(`
    INSERT INTO opening_balances (ledger_id, balance, balance_type, as_of_date, financial_year, notes, created_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (ledger_id, financial_year)
    DO UPDATE SET balance = EXCLUDED.balance, balance_type = EXCLUDED.balance_type,
                  as_of_date = EXCLUDED.as_of_date, notes = EXCLUDED.notes,
                  updated_at = NOW()
    RETURNING *
  `, [ledgerId, balance.toFixed(2), balanceType, asOfDate, financialYear,
      notes, req.employee?.username ?? "system"]);

  logActivity({
    action: "CREATE", module: "accounts", entityType: "opening_balance", entityId: row.id,
    description: `Opening balance set for ${ledger.name} — ₹${balance.toFixed(2)} ${balanceType}`,
    metadata: { after: { ledgerId, balance, balanceType, asOfDate, financialYear } },
  }).catch(() => {});

  res.status(201).json({ id: row.id, ledgerId, balance, balanceType, asOfDate, financialYear, notes });
});

router.delete("/accounts/opening-balances/:id", requireModuleAction("page:/accounts/chart", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rows: [deleted] } = await pool.query(
    `DELETE FROM opening_balances WHERE id = $1 RETURNING ledger_id`, [id]
  );
  if (!deleted) { res.status(404).json({ error: "Opening balance not found" }); return; }
  logActivity({
    action: "DELETE", module: "accounts", entityType: "opening_balance", entityId: id,
    description: `Opening balance deleted for ledger ${deleted.ledger_id}`,
  }).catch(() => {});
  res.status(204).send();
});

export default router;

