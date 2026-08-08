import { disabledWarehouseError, WAREHOUSE_DISABLED_CODE } from "../lib/warehouseLifecycle";
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
  checkVoucherLegs, foreignLocationLedgerIds, foreignPartyLedgerIds, headOfficeCashBankLedgerIds,
  resolveMoneyVoucherLocation,
} from "../lib/moneyScope";
import { loadLedgerUsage, deleteBlockReason } from "../lib/chartGroups";
import { respondIfMonthLocked, isMonthLocked, ymOfDate, monthLockedBody } from "../lib/periodLock";
import { loadPaymentPosition, computePaymentPosition, outstandingExpr } from "../lib/salePaymentPosition";
import { parsePartyLedgerCode, ensureAdvanceLedger, advanceAvailable, takeAdvanceLock, voucherAdvanceConsumed } from "../lib/advanceLedgers";
import { purchaseSettlementIndex } from "../lib/vendorBillSettlement";
import { parsePostingLocationFilter, companyLevelSummary, filterPostingsByLocation, type PostingLocationFilter } from "../lib/postingLocation";
import { resolveGstScope, salesScopeCond, purchaseScopeCond } from "../lib/gstinScope";
import { openingBalancePostings } from "../lib/openingBalances";

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

/**
 * Location condition for journal-family voucher lines. A voucher's effective
 * location mirrors buildDerivedPostings(): a return-linked note inherits its
 * return document's location, otherwise the voucher's own stamp counts.
 * Manual vouchers are stamped 'headoffice' at creation (and backfilled), so
 * they follow the books into the Head Office slice; unstamped SYSTEM vouchers
 * (payroll allocations, transfer clearing) stay company-level — visible
 * unfiltered and in the 'company' slice only.
 * Requires the caller's query to join: sales_returns sr (credit_note_id),
 * purchase_returns pr (debit_note_id) and purchases pu (pr.purchase_id),
 * with the voucher aliased `v`.
 */
function jvLocationCond(f: PostingLocationFilter | null, params: unknown[]): string {
  if (!f) return "";
  const typeExpr = `COALESCE(sr.location_type, pu.location_type, v.location_type)`;
  const idExpr = `COALESCE(sr.location_id, pu.location_id, v.location_id, 0)`;
  if (f.type === "company") return ` AND ${typeExpr} IS NULL`;
  if (f.type === "headoffice") return ` AND ${typeExpr} = 'headoffice'`;
  params.push(f.type);
  const t = `$${params.length}`;
  params.push(f.id);
  const i = `$${params.length}`;
  return ` AND ${typeExpr} = ${t} AND ${idExpr} = ${i}::int`;
}

/**
 * LBAC gate for journal-family voucher lines — who is ALLOWED to see them
 * (jvLocationCond above is the view filter layered on top). Head Office sees
 * everything. A branch caller sees only vouchers whose EFFECTIVE location is
 * their own: their sales-return credit notes and purchase-return debit notes,
 * which the derived posting stream already attributes to them — excluding
 * those here would make a branch's statement disagree with its own books.
 * Manual/HO-stamped vouchers and company-level system vouchers stay Head
 * Office reading. Same join requirements as jvLocationCond.
 */
function jvScopeCond(
  scope: { isHeadOffice: boolean; warehouseIds: number[]; outletIds: number[] },
  params: unknown[],
): string {
  if (scope.isHeadOffice) return "";
  const typeExpr = `COALESCE(sr.location_type, pu.location_type, v.location_type)`;
  const idExpr = `COALESCE(sr.location_id, pu.location_id, v.location_id, 0)`;
  params.push(scope.warehouseIds);
  const w = `$${params.length}`;
  params.push(scope.outletIds);
  const o = `$${params.length}`;
  return ` AND ((${typeExpr} = 'warehouse' AND ${idExpr} = ANY(${w}::int[]))
             OR (${typeExpr} = 'outlet' AND ${idExpr} = ANY(${o}::int[])))`;
}

const router = Router();

// ── Chart of Accounts (tree) ───────────────────────────────────────────────
// Consumers: Chart of Accounts page, and the Expenses page's ledger dropdown.
router.get("/accounts/chart", requireModuleView(["page:/accounts/chart", "page:/accounts/expenses"]), async (_req, res): Promise<void> => {
  const [result, usage, whsRes, outsRes] = await Promise.all([
    pool.query(`SELECT * FROM account_ledgers ORDER BY name`),
    loadLedgerUsage(pool),
    pool.query(`SELECT id, name FROM warehouses`),
    pool.query(`SELECT id, name FROM outlets`),
  ]);
  const rows = result.rows;
  const whName = new Map<number, string>(whsRes.rows.map((r: any) => [Number(r.id), String(r.name)]));
  const outName = new Map<number, string>(outsRes.rows.map((r: any) => [Number(r.id), String(r.name)]));
  // location_type/location_id are raw-migration columns (SELECT * surfaces
  // them via pg). Display-only ownership stamp — report scoping stays
  // document/posting-based.
  const locName = (t: string | null, i: any): string | null => {
    if (!t) return null;
    if (t === "headoffice") return "Head Office";
    if (t === "warehouse") return whName.get(Number(i)) ?? `Warehouse #${i}`;
    if (t === "outlet") return outName.get(Number(i)) ?? `Outlet #${i}`;
    return String(t);
  };

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
    locationType: r.location_type ?? null,
    locationId: r.location_id != null ? Number(r.location_id) : null,
    locationName: locName(r.location_type ?? null, r.location_id),
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

  // The Cash / Bank Accounts heads and everything under them are owned by the
  // Cash & Bank module: the UI shows a SYSTEM badge on the heads, disables
  // add/move inside, and points edits at Accounts → Cash & Bank. (The heads
  // are deliberately NOT `is_system_group` — they are postable parents whose
  // own history the statements must keep counting.)
  {
    const markManaged = (node: any) => {
      node.moduleManaged = true;
      for (const child of node.children) markManaged(child);
    };
    for (const node of map.values()) {
      if (node.code === "STD-CASH" || node.code === "STD-BANK") markManaged(node);
    }
  }
  res.json(roots);
});

// Also expose flat list for dropdowns
// Fills account dropdowns on Journal, Contra/Notes, Vouchers and Ledger — and
// the "Other Charges" expense-ledger picker on the Purchase Bill form, so the
// purchase page right must open it too (shared surface, any-of guard).
router.get("/accounts/chart/flat", requireModuleView(["page:/accounts/vouchers", "page:/accounts/ledger", "page:/operations/receipt-voucher", "page:/operations/payment-voucher", "page:/production/purchase"]), async (req, res): Promise<void> => {
  // Deactivated ledgers are withheld: this list exists to be selected from, and
  // a deactivated ledger must not attract new postings.
  const result = await pool.query(`SELECT * FROM account_ledgers WHERE COALESCE(is_active, true) ORDER BY id`);
  // LBAC: a branch user's pickers offer only what the write path would accept —
  // never another location's ledgers, never another branch's parties, and no
  // Head Office cash/bank. The dropdown matching the guard beats a 403 later.
  const flatScope = ownLocationScope((req as any).employee);
  if (!flatScope.isHeadOffice) {
    const [foreignLoc, foreignParty, hoCashBank, ownCash] = await Promise.all([
      foreignLocationLedgerIds(flatScope),
      foreignPartyLedgerIds(flatScope),
      headOfficeCashBankLedgerIds(),
      scopeCashLedgerIds(flatScope),
    ]);
    const ownCashSet = new Set(ownCash);
    const blocked = new Set<number>([
      ...foreignLoc, ...foreignParty,
      ...hoCashBank.filter((lid) => !ownCashSet.has(lid)),
    ]);
    result.rows = result.rows.filter((r: any) => !blocked.has(Number(r.id)));
  }
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
router.get("/accounts/cash-bank-ledgers", requireModuleView(["page:/accounts/cash-bank", "page:/accounts/expenses", "page:/accounts/vouchers", "page:/vendors", "page:/sales/expenses", "page:/hr/payroll", "page:/hr/advances", "page:/operations/receipt-voucher", "page:/operations/payment-voucher", "page:/sales/pos", "page:/outstanding", "page:/customers"]), async (req, res): Promise<void> => {
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
  // Receipts. A branch may only move its OWN money, so it sees its own till
  // plus the Cash & Bank accounts assigned to its location (both come from
  // scopeCashLedgerIds) — never another branch's accounts or the company-wide
  // tree. Head Office keeps the full cash + bank tree.
  const cbScope = ownLocationScope((req as any).employee);
  if (!cbScope.isHeadOffice) {
    const own = await scopeCashLedgerIds(cbScope);
    for (const id of Array.from(ids)) if (!own.includes(id)) ids.delete(id);
  }
  // Cash & Bank account type (cash / bank / upi) where the ledger is backed by
  // a cash_bank_accounts row — lets pickers tell a UPI account from a bank one.
  const { rows: cbaRows } = await pool.query(
    `SELECT ledger_id, account_type FROM cash_bank_accounts WHERE ledger_id IS NOT NULL`
  );
  const cbaType = new Map<number, string>(cbaRows.map((r: any) => [Number(r.ledger_id), String(r.account_type)]));
  // Deactivated tills and bank accounts stay out of the picker.
  res.json(rows.filter((r: any) => ids.has(r.id) && (r.is_active ?? true)).map((r: any) => ({
    id: r.id, name: r.name, type: r.type,
    parentId: r.parent_id ?? null, code: r.code ?? null,
    bankDetails: r.bank_details ?? null,
    accountType: cbaType.get(Number(r.id)) ?? null,
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

  // The Cash / Bank Accounts heads and everything under them belong to the
  // Cash & Bank module — the ONLY writer of ledgers in those subtrees. A
  // hand-made ledger there would have no account behind it, which is exactly
  // the unlinked drift the module migration cleaned up.
  {
    const { cashBankSubtreeIds } = await import("../lib/cashBankLedgers");
    const cbTree = await cashBankSubtreeIds(pool);
    if (cbTree.has(parentId)) {
      res.status(400).json({ error: "Cash and bank ledgers are managed from Accounts → Cash & Bank. Add the account there and its ledger appears here automatically." });
      return;
    }
  }

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
  // Shared with the Data Import commit (lib/chartGroups.ts) so an imported
  // ledger is created and audited exactly like a manually added one.
  const { insertChartAccount } = await import("../lib/chartGroups");
  const created = await insertChartAccount(pool, {
    name, type: parent.type, parentId, section: parent.section ?? null,
    description, isGroup: wantGroup, user: (req as any).employee?.username ?? "system",
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
    {
      const { rows: [t] } = await pool.query(`SELECT code FROM account_ledgers WHERE id = $1`, [id]);
      if (t?.code === "STD-CASH" || t?.code === "STD-BANK") {
        res.status(400).json({ error: "The Cash and Bank Accounts heads are system accounts — they cannot be deactivated." });
        return;
      }
      if (typeof t?.code === "string" && t.code.startsWith("CBA-")) {
        res.status(400).json({ error: "This ledger mirrors a Cash & Bank account. Manage it from Accounts → Cash & Bank." });
        return;
      }
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

  // The Cash / Bank Accounts subtrees are module territory: their ledgers may
  // not be dragged out (each mirrors a Cash & Bank account under its head),
  // and nothing may be dragged in (only the module creates ledgers there).
  {
    const { cashBankSubtreeIds } = await import("../lib/cashBankLedgers");
    const cbTree = await cashBankSubtreeIds(pool);
    if (cbTree.has(id) || cbTree.has(Number(parentId))) {
      res.status(400).json({ error: "Cash and bank ledgers are managed from Accounts → Cash & Bank and cannot be moved in the chart." });
      return;
    }
  }

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
      legacyVoucherNumber: r.legacy_voucher_number ?? null,
      paymentDate: r.payment_date,
      paidFromLedgerId: r.paid_from_ledger_id,
      paidFromName: r.paid_from_name,
      paidToLedgerId: r.paid_to_ledger_id,
      paidToName: r.paid_to_name,
      amount: Number(r.amount),
      narration: r.narration,
      referenceNumber: r.reference_number ?? null,
      createdBy: r.created_by ?? null,
      origin: isSystem ? 'system' : 'manual',
      editable: !isSystem,
      locationType: r.location_type ?? 'headoffice',
      locationId: r.location_id ?? 0,
      createdAt: r.created_at,
    };
  }));
});

// Manual receipt/payment vouchers no longer record a payment "mode" or an
// attachment: the selected cash/bank account IS the instrument (posting is
// driven entirely by the ledger legs), so a separate mode was redundant and
// could contradict the account. The payment_mode / attachment_url columns
// stay in the DB for legacy rows but are never read or written any more.
// (Sales settlement modes are a different, credit-controlled list.)

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
  allocation: "This voucher settles specific bills. It cannot be edited — delete it and record a fresh one.",
};

/** Round to 2dp — voucher money arithmetic. */
const money2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Is this ledger inside the STD-CASH subtree? Decides the `method` stamped on
 * the sale_payments legs an allocation receipt writes — display metadata only
 * (the POSTING debits the chosen ledger directly), but collection lists key
 * their labels off it.
 */
async function isCashFamilyLedger(q: { query: Function }, ledgerId: number): Promise<boolean> {
  const { rows } = await q.query(
    `WITH RECURSIVE fam AS (
       SELECT id FROM account_ledgers WHERE code = 'STD-CASH'
       UNION ALL
       SELECT l.id FROM account_ledgers l JOIN fam f ON l.parent_id = f.id
     ) SELECT 1 AS hit FROM fam WHERE id = $1 LIMIT 1`,
    [ledgerId],
  );
  return rows.length > 0;
}

/**
 * Validate and normalise a voucher's bill-allocation list.
 * Returns clean rows (2dp, unique ids) plus the derived advance slice
 * (voucher amount − allocated), or an error message.
 */
function parseAllocations(
  raw: unknown,
  idKey: "saleId" | "purchaseId",
  voucherAmount: number,
  advanceAmountIn: unknown,
): { rows: { id: number; amount: number }[]; advance: number } | { error: string } {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<number>();
  const rows: { id: number; amount: number }[] = [];
  for (const a of list) {
    const id = Number((a as any)?.[idKey]);
    const amt = Number((a as any)?.amount);
    if (!Number.isInteger(id) || id <= 0) return { error: `Each allocation needs a valid ${idKey}.` };
    if (!Number.isFinite(amt) || amt <= 0) return { error: "Each allocation amount must be a positive number." };
    if (Math.abs(amt * 100 - Math.round(amt * 100)) > 1e-6) return { error: "Allocation amounts cannot go beyond paise (2 decimal places)." };
    if (seen.has(id)) return { error: "The same bill appears twice in the allocations." };
    seen.add(id);
    rows.push({ id, amount: money2(amt) });
  }
  const allocated = money2(rows.reduce((s, r) => s + r.amount, 0));
  const advance = money2(voucherAmount - allocated);
  if (advance < -0.005) return { error: `Allocations (₹${allocated.toFixed(2)}) exceed the voucher amount (₹${voucherAmount.toFixed(2)}).` };
  if (advanceAmountIn !== undefined && advanceAmountIn !== null) {
    const sent = Number(advanceAmountIn);
    if (!Number.isFinite(sent) || sent < 0) return { error: "advanceAmount must be a non-negative number." };
    if (Math.abs(sent - Math.max(0, advance)) > 0.011) {
      return { error: "The advance amount no longer matches the allocations — refresh and try again." };
    }
  }
  return { rows, advance: Math.max(0, advance) };
}
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

/**
 * Administrator = level-1 hierarchy. System-voucher deletion is gated on this,
 * ON TOP of the page delete right: reversing a system-generated receipt
 * rewrites an invoice's payment story, which is a bigger authority than
 * deleting a voucher a user typed themselves.
 */
async function isLevelOneAdmin(employee: any): Promise<boolean> {
  const hid = Number(employee?.hierarchyId);
  if (!Number.isFinite(hid)) return false;
  const { rows } = await pool.query(`SELECT level FROM hierarchies WHERE id = $1`, [hid]);
  return Number(rows[0]?.level ?? 99) === 1;
}

type SaleReceiptImpactSale = {
  saleId: number; invoiceNumber: string; customerName: string;
  totalAmount: number; currentPaid: number; currentStatus: string;
  reversal: number; newPaid: number; newStatus: string;
};

/**
 * What deleting a system (source='sale') receipt would change.
 *
 * Two shapes exist (see the derivation notes in routes/journal.ts):
 *   · collection — sale_payments rows point at it via clearing_receipt_id;
 *     deleting removes those payment rows and their money from the invoice.
 *   · invoice trail — written at sale creation with voucher_number = the
 *     invoice number, recording counter money that has NO sale_payments row;
 *     deleting removes that slice from sales.amount_paid. The slice is
 *     measured as amount_paid − Σ sale_payments (never the raw receipt
 *     amount) so a receipt left stale by later edits cannot eat into money
 *     that separate collection receipts own.
 *   · orphan — its sale is gone; the receipt posts to the books as an
 *     ordinary receipt (no exclusion marker matches), so deleting it simply
 *     removes that posting. Nothing else to unwind.
 *
 * The DELETE recomputes this INSIDE its transaction with rows locked — the
 * GET preview is display only and must never be trusted as the verdict.
 */
async function computeSaleReceiptImpact(
  q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, receipt: any, forUpdate: boolean,
): Promise<{
  kind: "collection" | "invoice" | "orphan";
  sales: SaleReceiptImpactSale[];
  legs: { id: number; sale_id: number; amount: number }[];
  blockers: string[];
}> {
  const blockers: string[] = [];
  const saleCols = `s.id, s.invoice_number, s.total_amount::numeric AS total_amount,
                    s.amount_paid::numeric AS amount_paid, s.payment_status, s.cancelled_at,
                    COALESCE(c.name, 'Walk-in Customer') AS customer_name`;
  const lock = forUpdate ? " FOR UPDATE OF s" : "";

  const { rows: legs } = await q.query(
    `SELECT sp.id, sp.sale_id, sp.amount::numeric AS amount FROM sale_payments sp
      WHERE sp.clearing_receipt_id = $1 ORDER BY sp.sale_id ASC, sp.id ASC`, [receipt.id],
  );

  const buildSale = async (saleRow: any, reversal: number): Promise<SaleReceiptImpactSale> => {
    const currentPaid = Number(saleRow.amount_paid);
    const newPaid = money2(Math.max(0, currentPaid - reversal));
    const pos = await loadPaymentPosition(q, saleRow.id);
    const newPos = computePaymentPosition({
      totalAmount: Number(saleRow.total_amount), amountReceived: newPaid,
      creditAdjustments: pos?.creditAdjustments ?? 0, cancelledAt: null,
    });
    if (saleRow.cancelled_at) {
      blockers.push(`Invoice ${saleRow.invoice_number} is cancelled — its money records are frozen and cannot be rewritten.`);
    }
    return {
      saleId: saleRow.id, invoiceNumber: saleRow.invoice_number, customerName: saleRow.customer_name,
      totalAmount: Number(saleRow.total_amount), currentPaid, currentStatus: saleRow.payment_status,
      reversal: money2(reversal), newPaid, newStatus: newPos.status,
    };
  };

  if (legs.length > 0) {
    const bySale = new Map<number, number>();
    for (const leg of legs) bySale.set(leg.sale_id, money2((bySale.get(leg.sale_id) ?? 0) + Number(leg.amount)));
    const sales: SaleReceiptImpactSale[] = [];
    for (const [saleId, reversal] of bySale) {
      const { rows: [saleRow] } = await q.query(
        `SELECT ${saleCols} FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
          WHERE s.id = $1${lock}`, [saleId],
      );
      if (!saleRow) continue; // sale gone; its legs delete with the receipt
      sales.push(await buildSale(saleRow, reversal));
    }
    return { kind: "collection", sales, legs, blockers };
  }

  // Invoice-trail shape: match the sale by the shared voucher/invoice number,
  // disambiguating by the receipt's stored location when the number is reused
  // across locations — the same rule the sale-edit path applies when it
  // replaces these rows.
  const { rows: candidates } = await q.query(
    `SELECT ${saleCols}, COALESCE(s.location_type, 'outlet') AS loc_type,
            COALESCE(s.location_id, s.outlet_id, 0) AS loc_id
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.invoice_number = $1${lock}`, [receipt.voucher_number],
  );
  if (candidates.length === 0) return { kind: "orphan", sales: [], legs: [], blockers };
  let saleRow = candidates[0];
  if (candidates.length > 1) {
    const rt = receipt.location_type ?? "headoffice";
    const rid = Number(receipt.location_id ?? 0);
    const matched = candidates.filter((s: any) => s.loc_type === rt && Number(s.loc_id) === rid);
    if (matched.length !== 1) {
      blockers.push(`Invoice number ${receipt.voucher_number} is shared by ${candidates.length} invoices and the receipt's location does not single one out.`);
      return { kind: "invoice", sales: [], legs: [], blockers };
    }
    saleRow = matched[0];
  }
  const { rows: [spSum] } = await q.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM sale_payments WHERE sale_id = $1`, [saleRow.id],
  );
  const counterSlice = Math.max(0, money2(Number(saleRow.amount_paid) - Number(spSum.total)));
  const reversal = Math.min(Number(receipt.amount), counterSlice);
  return { kind: "invoice", sales: [await buildSale(saleRow, reversal)], legs: [], blockers };
}

router.post("/accounts/payments", requireModuleAction(["page:/accounts/vouchers", "page:/operations/payment-voucher"], "add"), async (req, res): Promise<void> => {
  // paymentMode/attachmentUrl are deliberately NOT read: the chosen account is
  // the instrument, and old clients still sending them are silently ignored.
  const { paymentDate, paidFromLedgerId, paidToLedgerId, amount, narration, referenceNumber, allocations, advanceAmount } = req.body as {
    paymentDate: string; paidFromLedgerId: number; paidToLedgerId: number; amount: number; narration?: string;
    referenceNumber?: string;
    allocations?: { purchaseId: number; amount: number }[];
    advanceAmount?: number;
  };
  if (!paymentDate || !paidFromLedgerId || !paidToLedgerId || !amount) {
    res.status(400).json({ error: "paymentDate, paidFromLedgerId, paidToLedgerId and amount are required" }); return;
  }
  if (!isIsoDate(paymentDate)) {
    res.status(400).json({ error: "paymentDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }
  // Month lock: a payment voucher is a new record dated paymentDate — it may
  // not be created in a locked month.
  if (await respondIfMonthLocked(res, pool, [paymentDate], "payment voucher create")) return;
  const av = validateVoucherFields({ amount });
  if (av.error) { res.status(400).json({ error: av.error }); return; }
  if (Number(paidFromLedgerId) === Number(paidToLedgerId)) {
    res.status(400).json({ error: "Paid From and Paid To cannot be the same account." }); return;
  }
  // A branch user may only pay out of its own cash box, and never into another
  // location's or Head Office's cash/bank accounts.
  const scope = ownLocationScope((req as any).employee);
  const legCheck = await checkVoucherLegs(scope, Number(paidFromLedgerId), Number(paidToLedgerId), 'Paid from');
  if (!legCheck.ok) { res.status(403).json({ error: legCheck.error }); return; }

  // The stamped location = the selected transaction location (validated
  // against the paying account's owner), NEVER blindly the caller's own — an
  // Admin recording for a branch produces a branch voucher, not a HO one.
  const payLocRes = await resolveMoneyVoucherLocation((req as any).employee, req.body as any, Number(paidFromLedgerId));
  if (!payLocRes.ok) { res.status(payLocRes.status).json({ error: payLocRes.error }); return; }
  const { locationType, locationId } = payLocRes.loc;
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: locationType, id: locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }

  // ── Bill-wise settlement path (vendor bills) ──────────────────────────────
  // Purchases have no amount_paid column, so vendor allocations live in
  // payment_bill_allocations; the excess parks in the vendor's advance ledger
  // (an asset — money already handed over, adjustable against future bills).
  const wantsSettlement = (Array.isArray(allocations) && allocations.length > 0) || Number(advanceAmount ?? 0) > 0;
  if (wantsSettlement) {
    const parsedAllocs = parseAllocations(allocations, "purchaseId", av.amount!, advanceAmount);
    if ("error" in parsedAllocs) { res.status(400).json({ error: parsedAllocs.error }); return; }
    const { rows: allocRows, advance } = parsedAllocs;

    const { rows: [toLedger] } = await pool.query(
      `SELECT id, code, name FROM account_ledgers WHERE id = $1`, [Number(paidToLedgerId)],
    );
    const party = parsePartyLedgerCode(toLedger?.code);
    if (!party || party.kind !== "vendor") {
      res.status(400).json({ error: "Bill settlement needs a vendor account in Paid To. Pick the vendor's ledger, or remove the allocations." });
      return;
    }

    // Soft cap first, computed the way every report computes vendor dues (the
    // shared settlement index): explicit allocations, advance applications and
    // the FIFO pool all reduce a bill's balance. The hard guard inside the
    // transaction below is what holds under concurrency.
    if (allocRows.length > 0) {
      const idx = await purchaseSettlementIndex([party.partyId]);
      for (const al of allocRows) {
        const bill = idx.get(al.id);
        if (bill && al.amount > bill.due + 0.005) {
          res.status(400).json({ error: `₹${al.amount.toFixed(2)} against ${bill.invoiceNumber ?? `bill #${al.id}`} exceeds its balance due (₹${bill.due.toFixed(2)}).` });
          return;
        }
      }
    }

    const caller = callerLocation((req as any).employee);
    const createdBy = (req as any).employee?.username ?? null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: dupes } = await client.query(
        `SELECT id FROM payments
          WHERE source = 'allocation' AND paid_to_ledger_id = $1 AND amount = $2
            AND created_at > now() - interval '10 seconds'`,
        [Number(paidToLedgerId), av.amount],
      );
      if (dupes.length > 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Duplicate settlement submission detected. Please wait a moment and try again." });
        return;
      }

      const details: { bill: any; alloc: { id: number; amount: number } }[] = [];
      for (const al of [...allocRows].sort((a, b) => a.id - b.id)) {
        const { rows: [bill] } = await client.query(
          `SELECT id, invoice_number, vendor_id, branch_transfer_id, location_type, location_id,
                  total_amount::numeric AS total_amount,
                  COALESCE((SELECT SUM((e->>'amount')::numeric)
                              FROM jsonb_array_elements(COALESCE(other_charges, '[]'::jsonb)) e
                             WHERE (e->>'amount') ~ '^[0-9.]+$'), 0) AS other_charges_total
             FROM purchases WHERE id = $1 FOR UPDATE`,
          [al.id],
        );
        if (!bill) { await client.query("ROLLBACK"); res.status(404).json({ error: `Purchase bill not found (#${al.id}).` }); return; }
        if (Number(bill.vendor_id) !== party.partyId) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Bill ${bill.invoice_number ?? `#${al.id}`} belongs to a different vendor.` });
          return;
        }
        if (bill.branch_transfer_id) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Bill ${bill.invoice_number ?? `#${al.id}`} is a branch transfer document and is settled by the transfer flow.` });
          return;
        }
        const bLocType = bill.location_type ?? "headoffice";
        const bLocId = Number(bill.location_id ?? 0);
        if (caller.locationType !== "headoffice" &&
            (bLocType !== caller.locationType || bLocId !== caller.locationId)) {
          await client.query("ROLLBACK");
          res.status(403).json({ error: `Bill ${bill.invoice_number ?? `#${al.id}`} belongs to another location.` });
          return;
        }
        // Hard cap on the locked row: everything EXPLICITLY allocated against
        // this bill (payments + advance applications) can never exceed its
        // total. The FIFO-settled slice of legacy bills is presentation-level
        // and already enforced by the soft cap above.
        const { rows: [ex] } = await client.query(
          `SELECT COALESCE((SELECT SUM(amount)::numeric FROM payment_bill_allocations WHERE purchase_id = $1), 0)
                + COALESCE((SELECT SUM(amount)::numeric FROM purchase_advance_applications WHERE purchase_id = $1), 0) AS allocated`,
          [al.id],
        );
        const already = Number(ex?.allocated ?? 0);
        // The bill's payable side is goods PLUS other purchase charges — both
        // credit the vendor, so an allocation may cover the whole of it.
        const billPayable = Number(bill.total_amount) + Number(bill.other_charges_total ?? 0);
        if (already + al.amount > billPayable + 0.005) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `₹${al.amount.toFixed(2)} against ${bill.invoice_number ?? `#${al.id}`} exceeds what is left on the bill (₹${money2(billPayable - already).toFixed(2)}).` });
          return;
        }
        details.push({ bill, alloc: al });
      }

      let advanceLedgerId: number | null = null;
      if (advance > 0.004) {
        const { rows: [vend] } = await client.query(`SELECT name FROM vendors WHERE id = $1`, [party.partyId]);
        const vendName = vend?.name ?? toLedger?.name ?? `Vendor ${party.partyId}`;
        advanceLedgerId = await ensureAdvanceLedger(client, "vendor", party.partyId, vendName);
      }

      const voucherNumber = await nextVoucherNumber(client, "payment", paymentDate);
      const { rows: [r] } = await client.query(
        `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, location_type, location_id,
                               reference_number, created_by, source, advance_amount, advance_ledger_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'allocation', $11, $12) RETURNING *`,
        [voucherNumber, paymentDate, Number(paidFromLedgerId), Number(paidToLedgerId), av.amount,
         narration ?? null, locationType, locationId, referenceNumber?.trim() || null, createdBy,
         advance > 0.004 ? advance : 0, advanceLedgerId],
      );
      for (const d of details) {
        await client.query(
          `INSERT INTO payment_bill_allocations (payment_id, purchase_id, amount) VALUES ($1, $2, $3)`,
          [r.id, d.bill.id, d.alloc.amount],
        );
      }
      await client.query("COMMIT");

      logActivity({
        action: "CREATE", module: "accounts", entityType: "payment_voucher", entityId: r.id,
        description: `Payment voucher ${voucherNumber} — ₹${Number(r.amount).toLocaleString("en-IN")} to ${toLedger?.name ?? paidToLedgerId}, settling ${details.length} bill(s)${advance > 0.004 ? ` with ₹${advance.toLocaleString("en-IN")} to advance` : ""}`,
        metadata: {
          voucherNumber, date: paymentDate, amount: Number(r.amount),
          allocations: details.map(d => ({ purchaseId: d.bill.id, invoiceNumber: d.bill.invoice_number, amount: d.alloc.amount })),
          advanceAmount: advance > 0.004 ? advance : 0,
        },
      }).catch(() => {});

      const { rows: [pf] } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [Number(paidFromLedgerId)]);
      res.status(201).json({
        id: r.id, voucherNumber: r.voucher_number, paymentDate: r.payment_date,
        paidFromLedgerId: r.paid_from_ledger_id, paidFromName: pf?.name ?? "",
        paidToLedgerId: r.paid_to_ledger_id, paidToName: toLedger?.name ?? "",
        amount: Number(r.amount), narration: r.narration,
        referenceNumber: r.reference_number, createdBy: r.created_by,
        locationType: r.location_type ?? "headoffice", locationId: r.location_id ?? 0,
        createdAt: r.created_at,
        allocations: details.map(d => ({ purchaseId: d.bill.id, invoiceNumber: d.bill.invoice_number, amount: d.alloc.amount })),
        advanceAmount: advance > 0.004 ? advance : 0,
      });
      return;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  const voucherNumber = await nextVoucherNumber(pool, 'payment', paymentDate);
  const result = await pool.query(
    `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, location_type, location_id,
                           reference_number, created_by, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual') RETURNING *`,
    [voucherNumber, paymentDate, paidFromLedgerId, paidToLedgerId, av.amount, narration ?? null, locationType, locationId,
     referenceNumber?.trim() || null, (req as any).employee?.username ?? null]
  );
  const r = result.rows[0];
  const [pf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(paidFromLedgerId))).limit(1);
  const [pt] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(paidToLedgerId))).limit(1);
  logActivity({ action: "CREATE", module: "accounts", entityType: "payment_voucher", entityId: r.id,
    description: `Payment voucher ${r.voucher_number} — ₹${Number(r.amount).toLocaleString("en-IN")} from ${pf?.name ?? paidFromLedgerId} to ${pt?.name ?? paidToLedgerId}`,
    metadata: { voucherNumber: r.voucher_number, date: r.payment_date, amount: Number(r.amount), paidFrom: pf?.name, paidTo: pt?.name, reference: r.reference_number },
  }).catch(() => {});
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, paymentDate: r.payment_date,
    paidFromLedgerId: r.paid_from_ledger_id, paidFromName: pf?.name ?? '',
    paidToLedgerId: r.paid_to_ledger_id, paidToName: pt?.name ?? '',
    amount: Number(r.amount), narration: r.narration,
    referenceNumber: r.reference_number, createdBy: r.created_by,
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
    // Month lock: an edit may neither touch a voucher inside a locked month
    // nor move it into/out of one — check BOTH the stored date and the new one.
    {
      const newDate = b.paymentDate !== undefined ? String(b.paymentDate) : row.payment_date;
      for (const d of [row.payment_date, newDate]) {
        const ym = ymOfDate(d);
        if (ym && await isMonthLocked(client, ym.year, ym.month)) {
          await client.query("ROLLBACK");
          res.status(423).json(monthLockedBody(ym.year, ym.month));
          return;
        }
      }
    }
    const newFrom = b.paidFromLedgerId !== undefined ? Number(b.paidFromLedgerId) : Number(row.paid_from_ledger_id);
    const newTo = b.paidToLedgerId !== undefined ? Number(b.paidToLedgerId) : Number(row.paid_to_ledger_id);
    if (!Number.isInteger(newFrom) || !Number.isInteger(newTo) || newFrom <= 0 || newTo <= 0) {
      await client.query("ROLLBACK"); res.status(400).json({ error: "Invalid account selection." }); return;
    }
    if (newFrom === newTo) { await client.query("ROLLBACK"); res.status(400).json({ error: "Paid From and Paid To cannot be the same account." }); return; }
    const legCheck = await checkVoucherLegs(scope, newFrom, newTo, 'Paid from');
    if (!legCheck.ok) { await client.query("ROLLBACK"); res.status(403).json({ error: legCheck.error }); return; }

    // Re-resolve the owning location on the EFFECTIVE paying account: an
    // explicit body location is validated, otherwise the till's owner speaks,
    // and only an unrecognised till keeps the row's current stamp.
    const locRes = await resolveMoneyVoucherLocation((req as any).employee, b, newFrom,
      { locationType: (row.location_type ?? 'headoffice') as any, locationId: Number(row.location_id ?? 0) });
    if (!locRes.ok) { await client.query("ROLLBACK"); res.status(locRes.status).json({ error: locRes.error }); return; }

    const upd = await client.query(
      `UPDATE payments SET
         payment_date = $2, paid_from_ledger_id = $3, paid_to_ledger_id = $4, amount = $5,
         narration = $6, reference_number = $7, location_type = $8, location_id = $9
       WHERE id = $1 RETURNING *`,
      [id,
       b.paymentDate !== undefined ? String(b.paymentDate) : row.payment_date,
       newFrom, newTo,
       av.amount !== undefined ? av.amount : row.amount,
       b.narration !== undefined ? (String(b.narration).trim() || null) : row.narration,
       b.referenceNumber !== undefined ? (String(b.referenceNumber).trim() || null) : row.reference_number,
       locRes.loc.locationType, Number(locRes.loc.locationId),
      ],
    );
    await client.query("COMMIT");
    const r = upd.rows[0];
    const [pf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, newFrom)).limit(1);
    const [pt] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, newTo)).limit(1);
    logActivity({ action: "UPDATE", module: "accounts", entityType: "payment_voucher", entityId: id,
      description: `Payment voucher ${r.voucher_number} edited`,
      metadata: {
        old: { date: row.payment_date, from: row.paid_from_ledger_id, to: row.paid_to_ledger_id, amount: Number(row.amount), narration: row.narration, reference: row.reference_number },
        new: { date: r.payment_date, from: r.paid_from_ledger_id, to: r.paid_to_ledger_id, amount: Number(r.amount), narration: r.narration, reference: r.reference_number },
      },
    }).catch(() => {});
    res.json({
      id: r.id, voucherNumber: r.voucher_number, paymentDate: r.payment_date,
      paidFromLedgerId: r.paid_from_ledger_id, paidFromName: pf?.name ?? '',
      paidToLedgerId: r.paid_to_ledger_id, paidToName: pt?.name ?? '',
      amount: Number(r.amount), narration: r.narration,
      referenceNumber: r.reference_number, createdBy: r.created_by,
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

  // Settlement vouchers: locked for edit, deletable with a full unwind of
  // their bill allocations — refused when the advance slice has already been
  // adjusted against a later purchase bill.
  {
    const probeParams: unknown[] = [id];
    const probeWhere = scopeMoneyWhere(scope, ledgerIds, probeParams, 'p', ['paid_from_ledger_id', 'paid_to_ledger_id']);
    const { rows: [probe] } = await pool.query(
      `SELECT p.id, p.source FROM payments p WHERE p.id = $1 AND ${probeWhere}`, probeParams,
    );
    if (probe && probe.source === 'allocation') {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: [row] } = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [id]);
        if (!row) { await client.query("ROLLBACK"); res.status(404).json({ error: "Payment not found" }); return; }
        // Month lock: cannot delete a voucher dated in a locked month.
        {
          const ym = ymOfDate(row.payment_date);
          if (ym && await isMonthLocked(client, ym.year, ym.month)) {
            await client.query("ROLLBACK");
            res.status(423).json(monthLockedBody(ym.year, ym.month));
            return;
          }
        }
        const advAmt = Number(row.advance_amount ?? 0);
        if (advAmt > 0.004) {
          const party = parsePartyLedgerCode(
            (await client.query(`SELECT code FROM account_ledgers WHERE id = $1`, [row.paid_to_ledger_id])).rows[0]?.code,
          );
          if (party) {
            await takeAdvanceLock(client, party.kind, party.partyId);
            // Precise, reference-based guard first: if any purchase consumed
            // THIS voucher's slice, deletion is refused even when another
            // advance voucher happens to cover the balance — fungible-pool
            // arithmetic must not rewrite which money settled which bill.
            const consumed = await voucherAdvanceConsumed(client, "payment", id);
            if (consumed > 0.004) {
              await client.query("ROLLBACK");
              res.status(409).json({ error: `₹${money2(consumed).toFixed(2)} of this voucher's advance has been adjusted against purchase bills. Delete those bills first.` });
              return;
            }
            // Aggregate backstop: money parked here may also have been drained
            // by paths that predate slice tracking (manual journals).
            const pos = await advanceAvailable(party.kind, party.partyId);
            if (pos.available + 0.005 < advAmt) {
              await client.query("ROLLBACK");
              res.status(409).json({ error: `₹${money2(advAmt - pos.available).toFixed(2)} of this voucher's advance has already been adjusted against bills. Remove those adjustments first.` });
              return;
            }
          }
        }
        const { rows: allocs } = await client.query(
          `SELECT purchase_id, amount FROM payment_bill_allocations WHERE payment_id = $1`, [id],
        );
        await client.query(`DELETE FROM payment_bill_allocations WHERE payment_id = $1`, [id]);
        await client.query(`DELETE FROM payments WHERE id = $1`, [id]);
        await client.query("COMMIT");
        logActivity({
          action: "DELETE", module: "accounts", entityType: "payment_voucher", entityId: id,
          description: `Settlement payment ${row.voucher_number} deleted — ₹${Number(row.amount).toLocaleString("en-IN")}, ${allocs.length} bill allocation(s) unwound`,
          metadata: { old: { voucherNumber: row.voucher_number, date: row.payment_date, amount: Number(row.amount), advanceAmount: advAmt, allocations: allocs.map((a: any) => ({ purchaseId: a.purchase_id, amount: Number(a.amount) })) } },
        }).catch(() => {});
        res.status(204).send();
        return;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
  }

  const loaded = await loadManualPayment(pool, id, where, params);
  if ('error' in loaded) {
    if (loaded.error === 404) res.status(404).json({ error: "Payment not found" });
    else res.status(403).json({ error: loaded.error });
    return;
  }
  // Month lock: cannot delete a voucher dated in a locked month.
  if (await respondIfMonthLocked(res, pool, [loaded.row.payment_date], "payment voucher delete")) return;
  await pool.query(`DELETE FROM payments WHERE id = $1`, [id]);
  logActivity({ action: "DELETE", module: "accounts", entityType: "payment_voucher", entityId: id,
    description: `Payment voucher ${loaded.row.voucher_number} deleted — ₹${Number(loaded.row.amount).toLocaleString("en-IN")}`,
    metadata: { old: { voucherNumber: loaded.row.voucher_number, date: loaded.row.payment_date, from: loaded.row.paid_from_ledger_id, to: loaded.row.paid_to_ledger_id, amount: Number(loaded.row.amount), narration: loaded.row.narration, reference: loaded.row.reference_number } },
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
  const admin = await isLevelOneAdmin((req as any).employee);
  res.json(result.rows.map(r => {
    // Sale-linked rows belong to the sales flow; any non-manual (or unstamped)
    // source is likewise locked — same verdict as loadManualReceipt.
    const isSystem = Boolean(r.is_clearing) || Boolean(r.is_sale_receipt) || r.source !== 'manual';
    return {
      id: r.id,
      voucherNumber: r.voucher_number,
      legacyVoucherNumber: r.legacy_voucher_number ?? null,
      receiptDate: r.receipt_date,
      receivedFromLedgerId: r.received_from_ledger_id,
      receivedFromName: r.received_from_name,
      receivedInLedgerId: r.received_in_ledger_id,
      receivedInName: r.received_in_name,
      amount: Number(r.amount),
      narration: r.narration,
      referenceNumber: r.reference_number ?? null,
      createdBy: r.created_by ?? null,
      origin: isSystem ? 'system' : 'manual',
      editable: !isSystem,
      // Server verdict for the admin-only system delete: only sale-sourced
      // receipts qualify, and only a level-1 Administrator sees the button.
      // The endpoints re-check both — this flag is display routing, not a guard.
      systemDeletable: admin && r.source === 'sale',
      locationType: r.location_type ?? 'headoffice',
      locationId: r.location_id ?? 0,
      createdAt: r.created_at,
    };
  }));
});

router.post("/accounts/receipts", requireModuleAction(["page:/accounts/vouchers", "page:/operations/receipt-voucher"], "add"), async (req, res): Promise<void> => {
  // paymentMode/attachmentUrl are deliberately NOT read: the chosen account is
  // the instrument, and old clients still sending them are silently ignored.
  const { receiptDate, receivedFromLedgerId, receivedInLedgerId, amount, narration, referenceNumber, allocations, advanceAmount } = req.body as {
    receiptDate: string; receivedFromLedgerId: number; receivedInLedgerId: number; amount: number; narration?: string;
    referenceNumber?: string;
    allocations?: { saleId: number; amount: number }[];
    advanceAmount?: number;
  };
  if (!receiptDate || !receivedFromLedgerId || !receivedInLedgerId || !amount) {
    res.status(400).json({ error: "receiptDate, receivedFromLedgerId, receivedInLedgerId and amount are required" }); return;
  }
  if (!isIsoDate(receiptDate)) {
    res.status(400).json({ error: "receiptDate must be a real calendar date in YYYY-MM-DD form" }); return;
  }
  // Month lock: a receipt is a new record dated receiptDate — it may not be
  // created in a locked month. (We guard the receipt's OWN date, never the
  // linked sale's month — same principle as counter-collection payments.)
  if (await respondIfMonthLocked(res, pool, [receiptDate], "receipt voucher create")) return;
  const av = validateVoucherFields({ amount });
  if (av.error) { res.status(400).json({ error: av.error }); return; }
  if (Number(receivedFromLedgerId) === Number(receivedInLedgerId)) {
    res.status(400).json({ error: "Received From and Received In cannot be the same account." }); return;
  }
  // A branch user may only collect into its own cash box.
  const scope = ownLocationScope((req as any).employee);
  const legCheck = await checkVoucherLegs(scope, Number(receivedInLedgerId), Number(receivedFromLedgerId), 'Received in');
  if (!legCheck.ok) { res.status(403).json({ error: legCheck.error }); return; }

  // The stamped location = the selected transaction location (validated
  // against the receiving account's owner), NEVER blindly the caller's own —
  // an Admin recording for a branch produces a branch voucher, not a HO one.
  const rcptLocRes = await resolveMoneyVoucherLocation((req as any).employee, req.body as any, Number(receivedInLedgerId));
  if (!rcptLocRes.ok) { res.status(rcptLocRes.status).json({ error: rcptLocRes.error }); return; }
  const { locationType, locationId } = rcptLocRes.loc;
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: locationType, id: locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }

  // ── Bill-wise settlement path ─────────────────────────────────────────────
  // The voucher names the invoices it settles; any excess parks in the
  // customer's advance ledger. The allocated slices are recorded as
  // sale_payments rows linked via clearing_receipt_id — exactly how counter
  // collections work — so every read surface (outstanding, statements, the
  // derived postings) sees them without new plumbing.
  const wantsSettlement = (Array.isArray(allocations) && allocations.length > 0) || Number(advanceAmount ?? 0) > 0;
  if (wantsSettlement) {
    const parsedAllocs = parseAllocations(allocations, "saleId", av.amount!, advanceAmount);
    if ("error" in parsedAllocs) { res.status(400).json({ error: parsedAllocs.error }); return; }
    const { rows: allocRows, advance } = parsedAllocs;

    const { rows: [fromLedger] } = await pool.query(
      `SELECT id, code, name FROM account_ledgers WHERE id = $1`, [Number(receivedFromLedgerId)],
    );
    const party = parsePartyLedgerCode(fromLedger?.code);
    if (!party || party.kind !== "customer") {
      res.status(400).json({ error: "Bill settlement needs a customer account in Received From. Pick the customer's ledger, or remove the allocations." });
      return;
    }
    const caller = callerLocation((req as any).employee);
    const createdBy = (req as any).employee?.username ?? null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Double-submit guard: the same settlement fired twice within seconds
      // would allocate the same bills twice before the outstanding cap can
      // catch up on partially-paid invoices.
      const { rows: dupes } = await client.query(
        `SELECT id FROM receipts
          WHERE source = 'allocation' AND received_from_ledger_id = $1 AND amount = $2
            AND created_at > now() - interval '10 seconds'`,
        [Number(receivedFromLedgerId), av.amount],
      );
      if (dupes.length > 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Duplicate settlement submission detected. Please wait a moment and try again." });
        return;
      }

      // Lock the allocated invoices in id order (stable order = no deadlocks
      // against concurrent collections) and validate each against the EFFECTIVE
      // balance on the locked row.
      const details: { sale: any; alloc: { id: number; amount: number }; position: any }[] = [];
      for (const al of [...allocRows].sort((a, b) => a.id - b.id)) {
        const { rows: [sale] } = await client.query(
          `SELECT id, invoice_number, customer_id, outlet_id, location_type, location_id,
                  cancelled_at, branch_transfer_id,
                  total_amount::numeric AS total_amount, amount_paid::numeric AS amount_paid
             FROM sales WHERE id = $1 FOR UPDATE`,
          [al.id],
        );
        if (!sale) { await client.query("ROLLBACK"); res.status(404).json({ error: `Invoice not found (sale #${al.id}).` }); return; }
        if (Number(sale.customer_id) !== party.partyId) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Invoice ${sale.invoice_number ?? `#${al.id}`} belongs to a different customer.` });
          return;
        }
        if (sale.cancelled_at) {
          await client.query("ROLLBACK");
          res.status(409).json({ error: `Invoice ${sale.invoice_number ?? `#${al.id}`} has been cancelled — nothing can be settled against it.`, code: "SALE_CANCELLED" });
          return;
        }
        if (sale.branch_transfer_id) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `Invoice ${sale.invoice_number ?? `#${al.id}`} is a branch transfer document and is settled by the transfer flow.` });
          return;
        }
        // Narrow money scope, same rule as counter collections: a branch may
        // only settle its own location's invoices. Head Office is unrestricted.
        const sLocType = sale.location_type ?? "outlet";
        const sLocId = Number(sale.location_id ?? sale.outlet_id);
        if (caller.locationType !== "headoffice" &&
            (sLocType !== caller.locationType || sLocId !== caller.locationId)) {
          await client.query("ROLLBACK");
          res.status(403).json({ error: `Invoice ${sale.invoice_number ?? `#${al.id}`} was raised at another location — its collections are recorded there.` });
          return;
        }
        const position = await loadPaymentPosition(client, al.id);
        if (!position) { await client.query("ROLLBACK"); res.status(404).json({ error: `Invoice not found (sale #${al.id}).` }); return; }
        if (al.amount > position.outstanding + 0.005) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: `₹${al.amount.toFixed(2)} against ${sale.invoice_number ?? `#${al.id}`} exceeds its balance due (₹${position.outstanding.toFixed(2)}).` });
          return;
        }
        details.push({ sale, alloc: al, position });
      }

      // Excess simply stays as a CREDIT (negative) balance on the customer's
      // own Sundry Debtor ledger — no separate advance ledger exists. The
      // advance_amount column still records the unallocated slice (it drives
      // FIFO consumption attribution and the voucher delete guard).
      const advanceLedgerId: number | null = null;

      const method = (await isCashFamilyLedger(client, Number(receivedInLedgerId))) ? "cash" : "bank";
      const voucherNumber = await nextVoucherNumber(client, "receipt", receiptDate);
      const { rows: [r] } = await client.query(
        `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, location_type, location_id,
                               reference_number, created_by, source, advance_amount, advance_ledger_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'allocation', $11, $12) RETURNING *`,
        [voucherNumber, receiptDate, Number(receivedFromLedgerId), Number(receivedInLedgerId), av.amount,
         narration ?? null, locationType, locationId, referenceNumber?.trim() || null, createdBy,
         advance > 0.004 ? advance : 0, advanceLedgerId],
      );

      for (const d of details) {
        // reconciliation_status stays NULL: the money landed in the chosen
        // ledger directly, so there is nothing for the electronic
        // reconciliation queue to settle.
        await client.query(
          `INSERT INTO sale_payments (sale_id, payment_date, method, amount, reference_number, notes, reconciliation_status, clearing_receipt_id, outlet_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9)`,
          [d.sale.id, receiptDate, method, d.alloc.amount, referenceNumber?.trim() || null,
           `Receipt voucher ${voucherNumber}`, r.id, d.sale.outlet_id, createdBy],
        );
        const newPaid = money2(Number(d.sale.amount_paid) + d.alloc.amount);
        const newPos = computePaymentPosition({
          totalAmount: Number(d.sale.total_amount), amountReceived: newPaid,
          creditAdjustments: d.position.creditAdjustments, cancelledAt: null,
        });
        await client.query(
          `UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3`,
          [newPaid, newPos.status, d.sale.id],
        );
      }

      await client.query("COMMIT");

      logActivity({
        action: "CREATE", module: "accounts", entityType: "receipt_voucher", entityId: r.id,
        description: `Receipt voucher ${voucherNumber} — ₹${Number(r.amount).toLocaleString("en-IN")} from ${fromLedger?.name ?? receivedFromLedgerId}, settling ${details.length} bill(s)${advance > 0.004 ? ` with ₹${advance.toLocaleString("en-IN")} to advance` : ""}`,
        metadata: {
          voucherNumber, date: receiptDate, amount: Number(r.amount),
          allocations: details.map(d => ({ saleId: d.sale.id, invoiceNumber: d.sale.invoice_number, amount: d.alloc.amount })),
          advanceAmount: advance > 0.004 ? advance : 0,
        },
      }).catch(() => {});

      const { rows: [ri] } = await pool.query(`SELECT name FROM account_ledgers WHERE id = $1`, [Number(receivedInLedgerId)]);
      res.status(201).json({
        id: r.id, voucherNumber: r.voucher_number, receiptDate: r.receipt_date,
        receivedFromLedgerId: r.received_from_ledger_id, receivedFromName: fromLedger?.name ?? "",
        receivedInLedgerId: r.received_in_ledger_id, receivedInName: ri?.name ?? "",
        amount: Number(r.amount), narration: r.narration,
        referenceNumber: r.reference_number, createdBy: r.created_by,
        locationType: r.location_type ?? "headoffice", locationId: r.location_id ?? 0,
        createdAt: r.created_at,
        allocations: details.map(d => ({ saleId: d.sale.id, invoiceNumber: d.sale.invoice_number, amount: d.alloc.amount })),
        advanceAmount: advance > 0.004 ? advance : 0,
      });
      return;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  const voucherNumber = await nextVoucherNumber(pool, 'receipt', receiptDate);
  const result = await pool.query(
    `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, location_type, location_id,
                           reference_number, created_by, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual') RETURNING *`,
    [voucherNumber, receiptDate, receivedFromLedgerId, receivedInLedgerId, av.amount, narration ?? null, locationType, locationId,
     referenceNumber?.trim() || null, (req as any).employee?.username ?? null]
  );
  const r = result.rows[0];
  const [rf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(receivedFromLedgerId))).limit(1);
  const [ri] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, Number(receivedInLedgerId))).limit(1);
  logActivity({ action: "CREATE", module: "accounts", entityType: "receipt_voucher", entityId: r.id,
    description: `Receipt voucher ${r.voucher_number} — ₹${Number(r.amount).toLocaleString("en-IN")} from ${rf?.name ?? receivedFromLedgerId} into ${ri?.name ?? receivedInLedgerId}`,
    metadata: { voucherNumber: r.voucher_number, date: r.receipt_date, amount: Number(r.amount), receivedFrom: rf?.name, receivedIn: ri?.name, reference: r.reference_number },
  }).catch(() => {});
  res.status(201).json({
    id: r.id, voucherNumber: r.voucher_number, receiptDate: r.receipt_date,
    receivedFromLedgerId: r.received_from_ledger_id, receivedFromName: rf?.name ?? '',
    receivedInLedgerId: r.received_in_ledger_id, receivedInName: ri?.name ?? '',
    amount: Number(r.amount), narration: r.narration,
    referenceNumber: r.reference_number, createdBy: r.created_by,
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
    // Month lock: an edit may neither touch a receipt inside a locked month
    // nor move it into/out of one — check BOTH the stored date and the new one.
    {
      const newDate = b.receiptDate !== undefined ? String(b.receiptDate) : row.receipt_date;
      for (const d of [row.receipt_date, newDate]) {
        const ym = ymOfDate(d);
        if (ym && await isMonthLocked(client, ym.year, ym.month)) {
          await client.query("ROLLBACK");
          res.status(423).json(monthLockedBody(ym.year, ym.month));
          return;
        }
      }
    }
    const newFrom = b.receivedFromLedgerId !== undefined ? Number(b.receivedFromLedgerId) : Number(row.received_from_ledger_id);
    const newIn = b.receivedInLedgerId !== undefined ? Number(b.receivedInLedgerId) : Number(row.received_in_ledger_id);
    if (!Number.isInteger(newFrom) || !Number.isInteger(newIn) || newFrom <= 0 || newIn <= 0) {
      await client.query("ROLLBACK"); res.status(400).json({ error: "Invalid account selection." }); return;
    }
    if (newFrom === newIn) { await client.query("ROLLBACK"); res.status(400).json({ error: "Received From and Received In cannot be the same account." }); return; }
    const legCheck = await checkVoucherLegs(scope, newIn, newFrom, 'Received in');
    if (!legCheck.ok) { await client.query("ROLLBACK"); res.status(403).json({ error: legCheck.error }); return; }

    // Re-resolve the owning location on the EFFECTIVE receiving account: an
    // explicit body location is validated, otherwise the till's owner speaks,
    // and only an unrecognised till keeps the row's current stamp.
    const locRes = await resolveMoneyVoucherLocation((req as any).employee, b, newIn,
      { locationType: (row.location_type ?? 'headoffice') as any, locationId: Number(row.location_id ?? 0) });
    if (!locRes.ok) { await client.query("ROLLBACK"); res.status(locRes.status).json({ error: locRes.error }); return; }

    const upd = await client.query(
      `UPDATE receipts SET
         receipt_date = $2, received_from_ledger_id = $3, received_in_ledger_id = $4, amount = $5,
         narration = $6, reference_number = $7, location_type = $8, location_id = $9
       WHERE id = $1 RETURNING *`,
      [id,
       b.receiptDate !== undefined ? String(b.receiptDate) : row.receipt_date,
       newFrom, newIn,
       av.amount !== undefined ? av.amount : row.amount,
       b.narration !== undefined ? (String(b.narration).trim() || null) : row.narration,
       b.referenceNumber !== undefined ? (String(b.referenceNumber).trim() || null) : row.reference_number,
       locRes.loc.locationType, Number(locRes.loc.locationId),
      ],
    );
    await client.query("COMMIT");
    const r = upd.rows[0];
    const [rf] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, newFrom)).limit(1);
    const [ri] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, newIn)).limit(1);
    logActivity({ action: "UPDATE", module: "accounts", entityType: "receipt_voucher", entityId: id,
      description: `Receipt voucher ${r.voucher_number} edited`,
      metadata: {
        old: { date: row.receipt_date, from: row.received_from_ledger_id, into: row.received_in_ledger_id, amount: Number(row.amount), narration: row.narration, reference: row.reference_number },
        new: { date: r.receipt_date, from: r.received_from_ledger_id, into: r.received_in_ledger_id, amount: Number(r.amount), narration: r.narration, reference: r.reference_number },
      },
    }).catch(() => {});
    res.json({
      id: r.id, voucherNumber: r.voucher_number, receiptDate: r.receipt_date,
      receivedFromLedgerId: r.received_from_ledger_id, receivedFromName: rf?.name ?? '',
      receivedInLedgerId: r.received_in_ledger_id, receivedInName: ri?.name ?? '',
      amount: Number(r.amount), narration: r.narration,
      referenceNumber: r.reference_number, createdBy: r.created_by,
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

  // Settlement vouchers are locked for EDIT but deletable: deletion unwinds
  // every bill allocation (sale_payments + amount_paid) in one transaction,
  // and refuses when the advance slice has already been adjusted against a
  // later invoice — deleting it then would drive the advance negative.
  {
    const probeParams: unknown[] = [id];
    const probeWhere = scopeMoneyWhere(scope, ledgerIds, probeParams, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
    const { rows: [probe] } = await pool.query(
      `SELECT r.id, r.source FROM receipts r WHERE r.id = $1 AND ${probeWhere}`, probeParams,
    );
    if (probe && probe.source === 'allocation') {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: [row] } = await client.query(
          `SELECT * FROM receipts WHERE id = $1 FOR UPDATE`, [id],
        );
        if (!row) { await client.query("ROLLBACK"); res.status(404).json({ error: "Receipt not found" }); return; }
        // Month lock: cannot delete a receipt dated in a locked month.
        {
          const ym = ymOfDate(row.receipt_date);
          if (ym && await isMonthLocked(client, ym.year, ym.month)) {
            await client.query("ROLLBACK");
            res.status(423).json(monthLockedBody(ym.year, ym.month));
            return;
          }
        }
        const advAmt = Number(row.advance_amount ?? 0);
        if (advAmt > 0.004) {
          const party = parsePartyLedgerCode(
            (await client.query(`SELECT code FROM account_ledgers WHERE id = $1`, [row.received_from_ledger_id])).rows[0]?.code,
          );
          if (party) {
            // Serialize against concurrent advance consumers, then apply the
            // precise, reference-based guard first: if any sale consumed THIS
            // voucher's slice, deletion is refused even when another advance
            // voucher happens to cover the balance — fungible-pool arithmetic
            // must not rewrite which money settled which invoice.
            await takeAdvanceLock(client, party.kind, party.partyId);
            const consumed = await voucherAdvanceConsumed(client, "receipt", id);
            if (consumed > 0.004) {
              await client.query("ROLLBACK");
              res.status(409).json({ error: `₹${money2(consumed).toFixed(2)} of this voucher's advance has been adjusted against invoices. Cancel those invoices first.` });
              return;
            }
            // Aggregate backstop — vendor-side only. A vendor advance is a
            // segregated VADV pool, so an aggregate drain that predates slice
            // tracking must keep blocking. A CUSTOMER advance is just the
            // credit side of their own Sundry Debtor ledger: open bills
            // legitimately absorb it, so the netted "available" figure says
            // nothing about whether THIS voucher's money was used — the
            // reference-based guard above is the sole authority there.
            if (party.kind === "vendor") {
              const pos = await advanceAvailable(party.kind, party.partyId);
              if (pos.available + 0.005 < advAmt) {
                await client.query("ROLLBACK");
                res.status(409).json({ error: `₹${money2(advAmt - pos.available).toFixed(2)} of this voucher's advance has already been adjusted against invoices. Remove those adjustments first.` });
                return;
              }
            }
          }
        }
        const { rows: legs } = await client.query(
          `SELECT sp.id, sp.sale_id, sp.amount FROM sale_payments sp
            WHERE sp.clearing_receipt_id = $1 ORDER BY sp.sale_id ASC`, [id],
        );
        for (const leg of legs) {
          const { rows: [sale] } = await client.query(
            `SELECT id, total_amount::numeric AS total_amount, amount_paid::numeric AS amount_paid
               FROM sales WHERE id = $1 FOR UPDATE`, [leg.sale_id],
          );
          if (!sale) continue;
          await client.query(`DELETE FROM sale_payments WHERE id = $1`, [leg.id]);
          const newPaid = money2(Math.max(0, Number(sale.amount_paid) - Number(leg.amount)));
          const pos = await loadPaymentPosition(client, leg.sale_id);
          const newPos = computePaymentPosition({
            totalAmount: Number(sale.total_amount), amountReceived: newPaid,
            creditAdjustments: pos?.creditAdjustments ?? 0, cancelledAt: null,
          });
          await client.query(
            `UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3`,
            [newPaid, newPos.status, leg.sale_id],
          );
        }
        await client.query(`DELETE FROM receipts WHERE id = $1`, [id]);
        await client.query("COMMIT");
        logActivity({
          action: "DELETE", module: "accounts", entityType: "receipt_voucher", entityId: id,
          description: `Settlement receipt ${row.voucher_number} deleted — ₹${Number(row.amount).toLocaleString("en-IN")}, ${legs.length} bill allocation(s) unwound`,
          metadata: { old: { voucherNumber: row.voucher_number, date: row.receipt_date, amount: Number(row.amount), advanceAmount: advAmt, allocations: legs.map((l: any) => ({ saleId: l.sale_id, amount: Number(l.amount) })) } },
        }).catch(() => {});
        res.status(204).send();
        return;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
  }

  const loaded = await loadManualReceipt(pool, id, where, params);
  if ('error' in loaded) {
    if (loaded.error === 404) res.status(404).json({ error: "Receipt not found" });
    else res.status(403).json({ error: loaded.error });
    return;
  }
  // Month lock: cannot delete a receipt dated in a locked month.
  if (await respondIfMonthLocked(res, pool, [loaded.row.receipt_date], "receipt voucher delete")) return;
  await pool.query(`DELETE FROM receipts WHERE id = $1`, [id]);
  logActivity({ action: "DELETE", module: "accounts", entityType: "receipt_voucher", entityId: id,
    description: `Receipt voucher ${loaded.row.voucher_number} deleted — ₹${Number(loaded.row.amount).toLocaleString("en-IN")}`,
    metadata: { old: { voucherNumber: loaded.row.voucher_number, date: loaded.row.receipt_date, from: loaded.row.received_from_ledger_id, into: loaded.row.received_in_ledger_id, amount: Number(loaded.row.amount), narration: loaded.row.narration, reference: loaded.row.reference_number } },
  }).catch(() => {});
  res.status(204).send();
});

// ── Admin-only system receipt deletion ────────────────────────────────────
// Sale-generated receipts (source='sale') are locked everywhere else: they
// mirror money the sales flow owns. An Administrator may delete one HERE with
// a full unwind — the linked sale_payments rows / counter-money slice come off
// the invoice in the same transaction, so the books (all derived) behave as if
// the voucher never existed. Every other system source keeps routing to its
// owning module: an expense/refund/deposit/settlement voucher is a shadow of a
// record that would be orphaned by deleting the shadow alone.

/** Human label for a receipt's stored location stamp. */
async function moneyLocationLabel(locType: string | null, locId: number | null): Promise<string> {
  const t = locType ?? "headoffice";
  if (t === "headoffice") return "Head Office";
  const table = t === "warehouse" ? "warehouses" : "outlets";
  const { rows } = await pool.query(`SELECT name FROM ${table} WHERE id = $1`, [Number(locId ?? 0)]);
  return rows[0]?.name ?? `${t === "warehouse" ? "Warehouse" : "Outlet"} #${locId}`;
}

router.get("/accounts/receipts/:id/delete-impact", requireModuleAction(["page:/accounts/vouchers", "page:/operations/receipt-voucher"], "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid receipt id" }); return; }
  if (!(await isLevelOneAdmin((req as any).employee))) {
    res.status(403).json({ error: "Only Administrators can delete system-generated vouchers." });
    return;
  }
  const scope = ownLocationScope((req as any).employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const params: unknown[] = [id];
  const where = scopeMoneyWhere(scope, ledgerIds, params, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
  const { rows: [receipt] } = await pool.query(
    `SELECT r.*, rf.name AS received_from_name, ri.name AS received_in_name
       FROM receipts r
       LEFT JOIN account_ledgers rf ON r.received_from_ledger_id = rf.id
       LEFT JOIN account_ledgers ri ON r.received_in_ledger_id = ri.id
      WHERE r.id = $1 AND ${where}`, params,
  );
  if (!receipt) { res.status(404).json({ error: "Receipt not found" }); return; }
  if (receipt.source !== "sale") {
    res.status(400).json({ error: "This is not a system-generated sale receipt. Use the normal voucher workflow." });
    return;
  }
  const impact = await computeSaleReceiptImpact(pool, receipt, false);
  res.json({
    receiptId: receipt.id,
    voucherNumber: receipt.voucher_number,
    receiptDate: receipt.receipt_date,
    amount: Number(receipt.amount),
    narration: receipt.narration ?? null,
    receivedFromName: receipt.received_from_name ?? null,
    receivedInName: receipt.received_in_name ?? null,
    locationLabel: await moneyLocationLabel(receipt.location_type, receipt.location_id),
    kind: impact.kind,
    sales: impact.sales,
    blockers: impact.blockers,
  });
});

router.post("/accounts/receipts/:id/system-delete", requireModuleAction(["page:/accounts/vouchers", "page:/operations/receipt-voucher"], "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid receipt id" }); return; }
  const employee = (req as any).employee;
  if (!(await isLevelOneAdmin(employee))) {
    res.status(403).json({ error: "Only Administrators can delete system-generated vouchers." });
    return;
  }
  const reason = String((req.body as any)?.reason ?? "").trim();
  if (reason.length < 5) {
    res.status(400).json({ error: "A reason is required for the audit log (at least 5 characters)." });
    return;
  }
  const scope = ownLocationScope(employee);
  const ledgerIds = await scopeLedgerIds(scope);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock order matches the allocation-receipt delete: receipt row first,
    // then each affected sale row inside computeSaleReceiptImpact.
    const lockParams: unknown[] = [id];
    const lockWhere = scopeMoneyWhere(scope, ledgerIds, lockParams, 'r', ['received_in_ledger_id', 'received_from_ledger_id']);
    const { rows: [receipt] } = await client.query(
      `SELECT r.* FROM receipts r WHERE r.id = $1 AND ${lockWhere} FOR UPDATE OF r`, lockParams,
    );
    if (!receipt) { await client.query("ROLLBACK"); res.status(404).json({ error: "Receipt not found — it may already have been deleted." }); return; }
    if (receipt.source !== "sale") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "This is not a system-generated sale receipt. Use the normal voucher workflow." });
      return;
    }
    // Month lock: cannot delete a receipt dated in a locked month. We guard the
    // receipt's OWN receipt_date, never the linked sale's month.
    {
      const ym = ymOfDate(receipt.receipt_date);
      if (ym && await isMonthLocked(client, ym.year, ym.month)) {
        await client.query("ROLLBACK");
        res.status(423).json(monthLockedBody(ym.year, ym.month));
        return;
      }
    }
    // Recompute the impact with the sale rows locked — the preview the client
    // showed is not the verdict; the state under the lock is.
    const impact = await computeSaleReceiptImpact(client, receipt, true);
    if (impact.blockers.length > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: impact.blockers.join(" ") });
      return;
    }
    if (impact.kind === "collection") {
      // Remove the payment rows this receipt cleared, then re-derive each
      // invoice's paid figure and status the same way every other writer does.
      await client.query(`DELETE FROM sale_payments WHERE clearing_receipt_id = $1`, [id]);
      for (const s of impact.sales) {
        await client.query(
          `UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3`,
          [s.newPaid, s.newStatus, s.saleId],
        );
      }
    } else if (impact.kind === "invoice") {
      for (const s of impact.sales) {
        await client.query(
          `UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3`,
          [s.newPaid, s.newStatus, s.saleId],
        );
      }
    }
    // kind === 'orphan': nothing to unwind — the receipt is the only record.
    await client.query(`DELETE FROM receipts WHERE id = $1`, [id]);
    await client.query("COMMIT");
    logActivity({
      action: "DELETE", module: "accounts", entityType: "receipt_voucher", entityId: id,
      user: employee?.username,
      description: `System receipt ${receipt.voucher_number} deleted by Administrator — ₹${Number(receipt.amount).toLocaleString("en-IN")} reversed${impact.sales.length ? ` from ${impact.sales.map((s) => s.invoiceNumber).join(", ")}` : ""}. Reason: ${reason}`,
      metadata: {
        reason,
        systemDelete: true,
        old: {
          voucherNumber: receipt.voucher_number, date: receipt.receipt_date,
          from: receipt.received_from_ledger_id, into: receipt.received_in_ledger_id,
          amount: Number(receipt.amount), narration: receipt.narration,
          locationType: receipt.location_type ?? "headoffice", locationId: receipt.location_id ?? 0,
        },
        kind: impact.kind,
        sales: impact.sales.map((s) => ({
          saleId: s.saleId, invoiceNumber: s.invoiceNumber, customerName: s.customerName,
          reversal: s.reversal, paidBefore: s.currentPaid, paidAfter: s.newPaid,
          statusBefore: s.currentStatus, statusAfter: s.newStatus,
        })),
      },
    }).catch(() => {});
    res.json({ deleted: true, kind: impact.kind, sales: impact.sales });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// ── Ledger Statement ──────────────────────────────────────────────────────
// LBAC: a branch may pull a statement, but only its own movements appear —
// vouchers it owns, its own sales and its own purchase bills. Head-Office-only
// sources (the expenses table, journal-family vouchers) are left out for branch
// users because they carry no location dimension.
/**
 * One ledger's statement, read off the SAME derived posting stream (plus
 * opening-balance postings) that the Trial Balance, the ledger reports and
 * the Cash/Bank Books consume. These two statement routes previously stitched
 * their entries from source documents (payments, receipts, expenses, JV
 * lines) with their own arithmetic — they could not see purchases, sales,
 * payroll, rent or opening balances, so the "Ledger View" disagreed with
 * every other balance surface. One stream, one figure.
 */
async function postingLedgerStatement(opts: {
  ledgerId: number;
  fromDate?: string;
  toDate?: string;
  locFilter: PostingLocationFilter | null;
}): Promise<{
  opening: number; closing: number; totalDebit: number; totalCredit: number;
  entries: Array<{ date: string; reference: string | null; description: string; entryType: string; debit: number; credit: number; balance: number }>;
}> {
  const rnd = (n: number) => Math.round(n * 100) / 100;
  const dateOpts = opts.toDate && isIsoDate(opts.toDate) ? { toDate: opts.toDate } : {};
  const stream: Array<Record<string, any>> = (await buildDerivedPostings(dateOpts) as Array<Record<string, any>>)
    .concat(await openingBalancePostings(dateOpts));
  const sliced = filterPostingsByLocation(stream as any, opts.locFilter) as Array<Record<string, any>>;

  const mine = sliced
    .filter((p) => Number(p.ledgerId) === opts.ledgerId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.entryId ?? "").localeCompare(String(b.entryId ?? "")));

  const from = opts.fromDate && isIsoDate(opts.fromDate) ? opts.fromDate : null;
  let opening = 0;
  let running = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  const entries: Array<{ date: string; reference: string | null; description: string; entryType: string; debit: number; credit: number; balance: number }> = [];
  for (const p of mine) {
    const debit = Number(p.debit) || 0;
    const credit = Number(p.credit) || 0;
    running = rnd(running + debit - credit);
    // Entries before the window roll into the opening figure instead of being
    // dropped — the running balance must stay continuous across the window edge.
    if (from && String(p.date).slice(0, 10) < from) { opening = running; continue; }
    totalDebit = rnd(totalDebit + debit);
    totalCredit = rnd(totalCredit + credit);
    entries.push({
      date: String(p.date).slice(0, 10),
      reference: p.voucherNumber == null ? null : String(p.voucherNumber),
      description: String(p.description ?? ""),
      entryType: String(p.source ?? "journal"),
      debit: rnd(debit),
      credit: rnd(credit),
      balance: running,
    });
  }
  return { opening: rnd(opening), closing: running, totalDebit, totalCredit, entries };
}

/** LBAC first: a branch caller is pinned to their own location's slice of the books; Head Office may narrow freely via the global selector. */
function statementLocationFilter(req: any): PostingLocationFilter | null {
  const emp = req.employee as { branchType?: string; branchId?: number } | undefined;
  if (emp?.branchType && emp.branchType !== "headoffice") {
    return { type: emp.branchType, id: Number(emp.branchId ?? 0) } as PostingLocationFilter;
  }
  return getPostingLocationFilter(req);
}

router.get("/accounts/ledger-statement", requireModuleView("page:/accounts/ledger"), async (req, res): Promise<void> => {
  const qp = GetLedgerStatementQueryParams.safeParse(req.query);
  if (!qp.success) { res.status(400).json({ error: qp.error.message }); return; }

  const accountId = Number(qp.data.accountId);
  const fromDate = qp.data.fromDate as string | undefined;
  const toDate = qp.data.toDate as string | undefined;

  const [account] = await db.select().from(accountLedgersTable).where(eq(accountLedgersTable.id, accountId)).limit(1);
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const scope = ownLocationScope((req as any).employee);
  if (!scope.isHeadOffice) {
    const foreign = await foreignLocationLedgerIds(scope);
    if (foreign.includes(accountId)) {
      res.status(403).json({ error: "That account belongs to another location." }); return;
    }
  }
  const locFilter = statementLocationFilter(req);

  const st = await postingLedgerStatement({ ledgerId: accountId, fromDate, toDate, locFilter });
  res.json({
    accountId,
    accountName: account.name,
    openingBalance: st.opening,
    closingBalance: st.closing,
    totalDebit: st.totalDebit,
    totalCredit: st.totalCredit,
    entries: st.entries,
    transactions: st.entries,
    ...(locFilter ? { location: locFilter } : {}),
  });
});

/**
 * ── Cash & Bank ───────────────────────────────────────────────────────────
 *
 * Every account here is backed by exactly one postable ledger under the system
 * heads Cash (STD-CASH) / Bank Accounts (STD-BANK) — see lib/cashBankLedgers.ts.
 * Balances are NEVER stored: every figure below is derived from the posting
 * stream plus opening balances, so this screen, the Cash/Bank Book, the Trial
 * Balance and the Balance Sheet are the same number by construction.
 *
 * The list is the WHOLE Cash/Bank subtree, not just module rows: branch tills
 * (owned by the Locations module) and the two heads themselves (which carry
 * legacy Head-Office history) appear as read-only rows, so the sum of the
 * screen equals the books' cash+bank position exactly.
 *
 * `cash_bank_accounts.ledger_id/location_type/location_id` are raw-migration
 * columns — invisible to drizzle, so this section uses raw SQL throughout.
 */
router.get("/accounts/cash-bank", requireModuleView("page:/accounts/cash-bank"), async (_req, res): Promise<void> => {
  const { currentBalanceIndex } = await import("../lib/ledgerBalances");
  const idx = await currentBalanceIndex();

  const [{ rows: accounts }, { rows: whs }, { rows: outs }, { rows: tree }] = await Promise.all([
    pool.query(`SELECT * FROM cash_bank_accounts ORDER BY id`),
    pool.query(`SELECT id, name, cash_ledger_id FROM warehouses`),
    pool.query(`SELECT id, name, cash_ledger_id FROM outlets`),
    pool.query(`
      WITH RECURSIVE tree AS (
        SELECT id, name, code, is_active, code AS root_code FROM account_ledgers WHERE code IN ('STD-CASH','STD-BANK')
        UNION ALL
        SELECT al.id, al.name, al.code, al.is_active, t.root_code FROM account_ledgers al JOIN tree t ON al.parent_id = t.id
      ) SELECT * FROM tree ORDER BY id
    `),
  ]);

  const locName = (lt: string | null, lid: number | null): string => {
    if (lt === "warehouse") return whs.find((w: any) => Number(w.id) === lid)?.name ?? "Warehouse";
    if (lt === "outlet") return outs.find((o: any) => Number(o.id) === lid)?.name ?? "Outlet";
    return "Head Office";
  };

  const out: any[] = [];
  const listed = new Set<number>();

  // 1. Module-managed accounts (editable).
  for (const c of accounts) {
    const lid = c.ledger_id != null ? Number(c.ledger_id) : null;
    if (lid) listed.add(lid);
    const bal = lid ? idx.net(lid) : null;
    const lt = c.location_type ?? "headoffice";
    const locId = c.location_id != null ? Number(c.location_id) : null;
    out.push({
      id: Number(c.id), name: c.name, accountType: c.account_type,
      bankName: c.bank_name ?? null, accountNumber: c.account_number ?? null, ifscCode: c.ifsc_code ?? null,
      balance: bal ?? Number(c.balance), storedBalance: Number(c.balance),
      currentBalance: bal, balanceSource: lid ? ("ledger" as const) : ("unlinked" as const),
      ledgerId: lid, locationType: lt, locationId: locId, locationName: locName(lt, locId),
      source: "module", readOnly: false,
      requiresReconciliation: c.account_type !== "cash" && c.requires_reconciliation === true,
    });
  }

  // 2. Branch tills — created by the Locations module, shown read-only. A
  //    mirror location can exist as BOTH warehouse and outlet sharing ONE cash
  //    ledger, so rows are deduped by ledger id (warehouse identity wins).
  const outletsHidden = await outletWritesBlocked(pool);
  const tills = [
    ...whs.filter((w: any) => w.cash_ledger_id).map((w: any) => ({ lt: "warehouse", locId: Number(w.id), locNm: w.name, lid: Number(w.cash_ledger_id) })),
    ...(outletsHidden ? [] : outs.filter((o: any) => o.cash_ledger_id).map((o: any) => ({ lt: "outlet", locId: Number(o.id), locNm: o.name, lid: Number(o.cash_ledger_id) }))),
  ];
  const ledgerMeta = new Map<number, any>(tree.map((t: any) => [Number(t.id), t]));
  for (const t of tills) {
    if (listed.has(t.lid)) continue;
    listed.add(t.lid);
    const meta = ledgerMeta.get(t.lid);
    out.push({
      id: -t.lid, name: meta?.name ?? `${t.locNm} Cash`, accountType: "cash",
      bankName: null, accountNumber: null, ifscCode: null,
      balance: idx.net(t.lid), storedBalance: 0,
      currentBalance: idx.net(t.lid), balanceSource: "ledger" as const,
      ledgerId: t.lid, locationType: t.lt, locationId: t.locId, locationName: t.locNm,
      source: "location", readOnly: true,
    });
  }

  // 3. The heads themselves plus anything else left in the subtree (deep
  //    sub-ledgers etc.), so Σ(rows) = the books' cash + bank position.
  for (const t of tree) {
    const lid = Number(t.id);
    if (listed.has(lid)) continue;
    listed.add(lid);
    const isRoot = t.code === "STD-CASH" || t.code === "STD-BANK";
    out.push({
      id: -lid, name: t.name, accountType: t.root_code === "STD-CASH" ? "cash" : "bank",
      bankName: null, accountNumber: null, ifscCode: null,
      balance: idx.net(lid), storedBalance: 0,
      currentBalance: idx.net(lid), balanceSource: "ledger" as const,
      ledgerId: lid, locationType: "headoffice", locationId: null, locationName: "Head Office",
      source: isRoot ? "system" : "ledger", readOnly: true,
    });
  }

  res.json(out);
});

/** Validate + resolve the location fields on a Cash & Bank write. */
async function resolveCashBankLocation(body: any): Promise<
  { ok: true; locationType: string; locationId: number | null }
  | { ok: false; status: number; error: string; code?: string }
> {
  let locationType = "headoffice";
  let locationId: number | null = null;
  const rawLt = body?.locationType;
  if (rawLt !== undefined && rawLt !== null && String(rawLt).trim() !== "") {
    locationType = String(rawLt).trim();
    if (!["headoffice", "warehouse", "outlet"].includes(locationType)) {
      return { ok: false, status: 400, error: "locationType must be headoffice, warehouse or outlet" };
    }
    if (locationType !== "headoffice") {
      locationId = Number(body?.locationId);
      if (!Number.isInteger(locationId) || locationId <= 0) {
        return { ok: false, status: 400, error: "Pick the location this account belongs to." };
      }
      const table = locationType === "warehouse" ? "warehouses" : "outlets";
      const { rows: [loc] } = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [locationId]);
      if (!loc) return { ok: false, status: 400, error: `No such ${locationType}` };
      if (locationType === "outlet" && await outletWritesBlocked(pool)) {
        return { ok: false, status: 409, error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE };
      }
    }
  }
  return { ok: true, locationType, locationId };
}

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
  // Company money accounts are a Head Office concern: page rights alone must
  // not let a branch user create accounts or assign them to other branches.
  if ((req as any).employee?.branchType !== "headoffice") {
    res.status(403).json({ error: "Only Head Office can manage cash and bank accounts." }); return;
  }
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

  const loc = await resolveCashBankLocation(req.body);
  if (!loc.ok) { res.status(loc.status).json({ error: loc.error, ...(loc.code ? { code: loc.code } : {}) }); return; }

  // One name per account, checked against both the module and the subtree the
  // ledger will join — a duplicate ledger name under the same head would make
  // the Cash Book ambiguous.
  const name = parsed.data.name.trim();
  const { rows: [dupe] } = await pool.query(
    `SELECT id FROM cash_bank_accounts WHERE lower(name) = lower($1) LIMIT 1`, [name],
  );
  if (dupe) { res.status(409).json({ error: `An account named "${name}" already exists.` }); return; }

  // Reconciliation is a bank-side concept: cash never consults the flag. For
  // bank/UPI it defaults ON — collections pass through Electronic Clearing and
  // reach the balance via Reconciliation unless someone deliberately opts out.
  const isCashType = parsed.data.accountType === "cash";
  const requiresRecon = isCashType
    ? false
    : (parsed.data.requiresReconciliation ?? true) === true;

  // Account row + backing ledger are one atomic unit: a row without a ledger
  // would be exactly the unlinked legacy state this module just migrated off.
  const { provisionCashBankLedger } = await import("../lib/cashBankLedgers");
  const client = await pool.connect();
  let accountId: number; let ledgerId: number;
  try {
    await client.query("BEGIN");
    const { rows: [row] } = await client.query(
      `INSERT INTO cash_bank_accounts (name, account_type, bank_name, account_number, ifsc_code, balance, location_type, location_id, requires_reconciliation)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8) RETURNING id`,
      [name, parsed.data.accountType, parsed.data.bankName ?? null, parsed.data.accountNumber ?? null,
       ifsc ?? null, loc.locationType, loc.locationId, requiresRecon],
    );
    accountId = Number(row.id);
    ledgerId = await provisionCashBankLedger(client, { accountId, name, accountType: parsed.data.accountType });
    await client.query(`UPDATE cash_bank_accounts SET ledger_id = $1 WHERE id = $2`, [ledgerId, accountId]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  // The opening figure goes through the ONE opening-balance write path — a
  // ledger-level record the books fold in — never a stored column. The equity
  // counterweight keeps the trial balance balanced against the one-sided seed.
  if (money.value > 0) {
    const { upsertOpeningBalance, currentFinancialYear } = await import("../lib/openingBalances");
    const { rebalanceCashBankOpeningEquity } = await import("../lib/cashBankLedgers");
    const fy = await currentFinancialYear();
    await upsertOpeningBalance({
      ledgerId, balance: money.value, balanceType: "debit",
      asOfDate: new Date().toISOString().slice(0, 10), financialYear: fy.label,
      notes: "Opening balance from Cash & Bank account creation",
      user: (req as any).employee?.username ?? "system", ledgerName: name,
    });
    await rebalanceCashBankOpeningEquity(pool);
  }

  await logActivity({
    action: "CREATE", module: "accounts", entityType: "cash_bank_account", entityId: accountId,
    description: `Created ${parsed.data.accountType} account "${name}" (ledger #${ledgerId})`,
    user: (req as any).employee?.username ?? "system",
  });

  res.status(201).json({
    id: accountId, name, accountType: parsed.data.accountType,
    bankName: parsed.data.bankName ?? null, accountNumber: parsed.data.accountNumber ?? null, ifscCode: ifsc ?? null,
    balance: money.value, storedBalance: 0,
    currentBalance: money.value, balanceSource: "ledger" as const, ledgerId,
    locationType: loc.locationType, locationId: loc.locationId,
    source: "module", readOnly: false,
    requiresReconciliation: requiresRecon,
  });
});

router.patch("/accounts/cash-bank/:id", requireModuleAction("page:/accounts/cash-bank", "edit"), async (req, res): Promise<void> => {
  if ((req as any).employee?.branchType !== "headoffice") {
    res.status(403).json({ error: "Only Head Office can manage cash and bank accounts." }); return;
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { rows: [acc] } = await pool.query(`SELECT * FROM cash_bank_accounts WHERE id = $1`, [id]);
  if (!acc) { res.status(404).json({ error: "Account not found" }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;

  // The account type decides which head the ledger lives under; changing it
  // would mean moving history between Cash and Bank Accounts. Delete-and-
  // recreate (only possible while empty) is the honest path.
  if (body.accountType !== undefined && String(body.accountType) !== String(acc.account_type)) {
    res.status(400).json({ error: "The account type cannot be changed — it decides whether the ledger sits under Cash or Bank Accounts. Create a new account of the right type instead." });
    return;
  }

  const text = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const sets: string[] = [];
  const vals: any[] = [];
  const push = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

  let newName: string | undefined;
  if (body.name !== undefined) {
    newName = String(body.name ?? "").trim();
    if (newName.length < 2) { res.status(400).json({ error: "Give the account a name of at least 2 characters." }); return; }
    const { rows: [dupe] } = await pool.query(
      `SELECT id FROM cash_bank_accounts WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1`, [newName, id],
    );
    if (dupe) { res.status(409).json({ error: `An account named "${newName}" already exists.` }); return; }
    push("name", newName);
  }
  if (body.bankName !== undefined) push("bank_name", text(body.bankName) || null);
  if (body.accountNumber !== undefined) push("account_number", text(body.accountNumber) || null);
  if (body.ifscCode !== undefined) push("ifsc_code", text(body.ifscCode)?.toUpperCase() || null);

  if (body.requiresReconciliation !== undefined) {
    if (String(acc.account_type) === "cash") {
      res.status(400).json({ error: "Cash accounts never go through bank reconciliation — the switch applies to bank and UPI accounts." });
      return;
    }
    push("requires_reconciliation", body.requiresReconciliation === true);
  }

  if (body.locationType !== undefined || body.locationId !== undefined) {
    const loc = await resolveCashBankLocation({
      locationType: body.locationType ?? acc.location_type ?? "headoffice",
      locationId: body.locationId ?? acc.location_id,
    });
    if (!loc.ok) { res.status(loc.status).json({ error: loc.error, ...(loc.code ? { code: loc.code } : {}) }); return; }
    push("location_type", loc.locationType);
    push("location_id", loc.locationId);
  }

  if (sets.length > 0) {
    vals.push(id);
    await pool.query(`UPDATE cash_bank_accounts SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  }
  // The ledger mirrors the account name — the two screens must never disagree.
  if (newName !== undefined && acc.ledger_id != null) {
    await pool.query(`UPDATE account_ledgers SET name = $1 WHERE id = $2`, [newName, Number(acc.ledger_id)]);
  }

  // Opening balance correction goes through the same single write path.
  if (body.openingBalance !== undefined && acc.ledger_id != null) {
    const money = optionalMoney(body.openingBalance);
    if (!money.ok) { res.status(400).json({ error: `Opening Balance ${money.reason}.` }); return; }
    if (money.value < 0) { res.status(400).json({ error: "Opening Balance cannot be negative." }); return; }
    const { upsertOpeningBalance, currentFinancialYear } = await import("../lib/openingBalances");
    const { rebalanceCashBankOpeningEquity } = await import("../lib/cashBankLedgers");
    const fy = await currentFinancialYear();
    await upsertOpeningBalance({
      ledgerId: Number(acc.ledger_id), balance: money.value, balanceType: "debit",
      asOfDate: fy.startDate, financialYear: fy.label,
      notes: "Opening balance edited from Cash & Bank",
      user: (req as any).employee?.username ?? "system", ledgerName: newName ?? acc.name,
    });
    await rebalanceCashBankOpeningEquity(pool);
  }

  await logActivity({
    action: "UPDATE", module: "accounts", entityType: "cash_bank_account", entityId: id,
    description: `Updated cash/bank account "${newName ?? acc.name}"`,
    user: (req as any).employee?.username ?? "system",
  });

  const { rows: [fresh] } = await pool.query(`SELECT * FROM cash_bank_accounts WHERE id = $1`, [id]);
  // The response carries the DERIVED balance (postings + openings), same as the
  // list — a stale zero here would flash a wrong figure onto the screen.
  let derived: number | null = null;
  if (fresh.ledger_id != null) {
    const { currentBalanceIndex } = await import("../lib/ledgerBalances");
    derived = (await currentBalanceIndex()).net(Number(fresh.ledger_id));
  }
  res.json({
    id, name: fresh.name, accountType: fresh.account_type,
    bankName: fresh.bank_name ?? null, accountNumber: fresh.account_number ?? null, ifscCode: fresh.ifsc_code ?? null,
    balance: derived ?? 0, storedBalance: Number(fresh.balance),
    currentBalance: derived, balanceSource: fresh.ledger_id ? ("ledger" as const) : ("unlinked" as const),
    ledgerId: fresh.ledger_id != null ? Number(fresh.ledger_id) : null,
    locationType: fresh.location_type ?? "headoffice",
    locationId: fresh.location_id != null ? Number(fresh.location_id) : null,
    source: "module", readOnly: false,
    requiresReconciliation: fresh.account_type !== "cash" && fresh.requires_reconciliation === true,
  });
});

router.delete("/accounts/cash-bank/:id", requireModuleAction("page:/accounts/cash-bank", "delete"), async (req, res): Promise<void> => {
  if ((req as any).employee?.branchType !== "headoffice") {
    res.status(403).json({ error: "Only Head Office can manage cash and bank accounts." }); return;
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { rows: [acc] } = await pool.query(`SELECT * FROM cash_bank_accounts WHERE id = $1`, [id]);
  if (!acc) { res.status(404).json({ error: "Account not found" }); return; }
  const ledgerId = acc.ledger_id != null ? Number(acc.ledger_id) : null;

  if (ledgerId != null) {
    // Transactions block deletion — removing the ledger would break the audit
    // trail. Opening balances do NOT block: they are part of the account's own
    // identity and are removed with it.
    const usage = await loadLedgerUsage(pool);
    const u = usage.get(ledgerId);
    const { rows: [ob] } = await pool.query(`SELECT COUNT(*)::int AS n FROM opening_balances WHERE ledger_id = $1`, [ledgerId]);
    const { rows: [ex] } = await pool.query(`SELECT COUNT(*)::int AS n FROM expenses WHERE payment_account_id = $1`, [id]);
    const txns = Math.max(0, (u?.transactions ?? 0) - Number(ob?.n ?? 0)) + Number(ex?.n ?? 0);
    if (txns > 0) {
      res.status(409).json({ error: `This account carries ${txns} transaction${txns === 1 ? "" : "s"}. Deleting it would break the books — it must stay.` });
      return;
    }
    if ((u?.references.length ?? 0) > 0) {
      res.status(409).json({ error: `This account's ledger is wired to ${u!.references.join(", ")}. Unlink it there first.` });
      return;
    }
    const { rows: [kid] } = await pool.query(`SELECT COUNT(*)::int AS n FROM account_ledgers WHERE parent_id = $1`, [ledgerId]);
    if (Number(kid?.n ?? 0) > 0) {
      res.status(409).json({ error: "This account's ledger has sub-ledgers under it. Remove those first." });
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (ledgerId != null) {
      await client.query(`DELETE FROM opening_balances WHERE ledger_id = $1`, [ledgerId]);
      await client.query(`DELETE FROM account_ledgers WHERE id = $1`, [ledgerId]);
    }
    await client.query(`DELETE FROM cash_bank_accounts WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  // The account's opening rows are gone; shrink the equity counterweight to match.
  {
    const { rebalanceCashBankOpeningEquity } = await import("../lib/cashBankLedgers");
    await rebalanceCashBankOpeningEquity(pool);
  }

  await logActivity({
    action: "DELETE", module: "accounts", entityType: "cash_bank_account", entityId: id,
    description: `Deleted cash/bank account "${acc.name}"${ledgerId != null ? ` (ledger #${ledgerId})` : ""}`,
    user: (req as any).employee?.username ?? "system",
  });
  res.json({ success: true });
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

  // Month lock: an expense is a new record dated expenseDate — it may not be
  // created in a locked month.
  if (await respondIfMonthLocked(res, pool, [parsed.data.expenseDate], "expense create")) return;

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
  // No stored balance to maintain: the account's balance is derived from the
  // posting stream, and this expense's credit leg lands on the account's own
  // ledger (see buildDerivedPostings), so every screen moves together.
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

  // View narrowing from the global location selector (or explicit query
  // params), ANDed onto the LBAC above so it can only narrow. A mirror place
  // (same site as both warehouse and outlet) matches across both identities,
  // the same way LBAC reads do.
  const allViewLoc = getLocationFilter(req);
  if (allViewLoc) {
    if (allViewLoc.locationType === "headoffice") {
      locationFilterAll += ` AND (p.location_type = 'headoffice' OR p.location_type IS NULL)`;
    } else {
      const viewIdent = await resolveLocationIdentities(allViewLoc.locationType, Number(allViewLoc.locationId));
      locationFilterAll += ` AND ${locationIdentitySql(viewIdent, allParams)}`;
    }
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
  // Month lock: a location expense is a new payment dated expenseDate — it may
  // not be created in a locked month.
  if (await respondIfMonthLocked(res, pool, [expenseDate], "location expense create")) return;
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
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: locationType, id: locationId }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
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
           p.location_type, p.location_id, p.payment_date,
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
  // Month lock: cannot delete a location expense whose underlying payment is
  // dated in a locked month.
  if (await respondIfMonthLocked(res, pool, [row.payment_date], "location expense delete")) return;

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
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };
  // LBAC: branch users always get their own location's slice — the view
  // header/query cannot widen it. Head Office keeps the free selector.
  const fsEmp = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
  const fsBranch = fsEmp?.branchType && fsEmp.branchType !== 'headoffice';
  const location = fsBranch
    ? { type: fsEmp!.branchType as "warehouse" | "outlet", id: Number(fsEmp!.branchId ?? 0) }
    : getPostingLocationFilter(req);

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
  // Branch users get their own slice only — the company-level remainder is
  // Head Office information, so the key is omitted (never zeroed) for them.
  if (!fsBranch && location && location.type !== "company") {
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

  const { rows: [ledger] } = await pool.query(
    `SELECT id, name, type, code FROM account_ledgers WHERE id = $1`, [id]
  );
  if (!ledger) { res.status(404).json({ error: "Ledger not found" }); return; }

  const scope = ownLocationScope((req as any).employee);
  if (!scope.isHeadOffice) {
    const foreign = await foreignLocationLedgerIds(scope);
    if (foreign.includes(id)) {
      res.status(403).json({ error: "That account belongs to another location." }); return;
    }
  }
  const locFilter = statementLocationFilter(req);

  const st = await postingLedgerStatement({ ledgerId: id, fromDate, toDate, locFilter });
  res.json({
    ledger: { id: ledger.id, name: ledger.name, type: ledger.type, code: ledger.code },
    entries: st.entries,
    totalDebit: st.totalDebit,
    totalCredit: st.totalCredit,
    openingBalance: st.opening,
    closingBalance: st.closing,
    ...(locFilter ? { location: locFilter } : {}),
  });
});

// ── GST Summary ───────────────────────────────────────────────────────────
router.get("/gst/summary", requireModuleView(["page:/accounts/gst", "page:/accounts/gst-returns"]), async (req, res): Promise<void> => {
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };

  // LBAC: branch sessions are PINNED to their own registration — a warehouse
  // files under its own GSTIN, an outlet under its parent warehouse's. Query
  // params cannot widen this; an outlet with no parent sees an empty summary.
  const gstSumEmp = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
  let pinnedWh: number | undefined;
  if (gstSumEmp?.branchType === "warehouse") {
    pinnedWh = Number(gstSumEmp.branchId);
  } else if (gstSumEmp?.branchType === "outlet") {
    const { rows: pw } = await pool.query(`SELECT warehouse_id FROM outlets WHERE id = $1`, [Number(gstSumEmp.branchId)]);
    const wid = Number(pw[0]?.warehouse_id);
    if (Number.isFinite(wid) && wid > 0) pinnedWh = wid;
    else { res.json({ salesByRate: [], purchasesByRate: [], totals: {} }); return; }
  }

  // Optional GSTIN / warehouse scoping. Resolved to document-id sets via raw
  // SQL because the legacy location columns (outlet_id / branch_*) fall back
  // differently per table; when no filter is active nothing here runs and the
  // output stays byte-identical.
  const gstinQ = pinnedWh != null ? undefined
    : (typeof req.query.gstin === "string" && req.query.gstin.trim() ? req.query.gstin.trim() : undefined);
  const whQ = Number(req.query.warehouseId);
  let whEff = pinnedWh ?? (Number.isInteger(whQ) && whQ > 0 ? whQ : undefined);
  // No explicit filter → fall back to the global location context the way the
  // GSTR-1/3B endpoints do (parseGstScope in gst.ts): filings are per GSTIN,
  // so a warehouse maps to its own filing scope, an outlet to its parent
  // warehouse's, and Head Office / All to the company-wide view.
  if (!gstinQ && !whEff) {
    const gstViewLoc = getLocationFilter(req);
    if (gstViewLoc?.locationType === "warehouse") {
      whEff = Number(gstViewLoc.locationId);
    } else if (gstViewLoc?.locationType === "outlet") {
      const { rows: owh } = await pool.query(`SELECT warehouse_id FROM outlets WHERE id = $1`, [gstViewLoc.locationId]);
      const wid = Number(owh[0]?.warehouse_id);
      if (Number.isFinite(wid) && wid > 0) whEff = wid;
    }
  }
  const gstScope = (gstinQ || whEff)
    ? await resolveGstScope({ gstin: gstinQ, warehouseId: whEff })
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

  // Month lock: an opening balance belongs to its as-of period — it cannot be
  // written into a locked month.
  if (await respondIfMonthLocked(res, pool, [asOfDate], "opening balance upsert")) return;

  // Verify ledger exists and is postable (not a group)
  const { rows: [ledger] } = await pool.query(
    `SELECT id, name, code, is_group, is_system_group FROM account_ledgers WHERE id = $1`, [ledgerId]
  );
  if (!ledger) { res.status(404).json({ error: "Ledger not found" }); return; }
  if (ledger.is_group || ledger.is_system_group) {
    res.status(400).json({ error: `"${ledger.name}" is a group ledger — post opening balances to specific ledgers under it` }); return;
  }
  // Module-owned openings are off limits here: a manual edit would bypass the
  // equity counterweight and unbalance the books.
  const code = String(ledger.code ?? "");
  if (code.startsWith("CBA-")) {
    res.status(400).json({ error: `"${ledger.name}" is managed from Accounts → Cash & Bank — set its opening balance there.` }); return;
  }
  if (code === "STD-OB-ADJ") {
    res.status(400).json({ error: "Opening Balance Adjustment is maintained automatically — it cannot be edited by hand." }); return;
  }

  // Upsert: one opening balance record per ledger per financial year. Shared
  // with the Data Import commit (lib/openingBalances.ts) so both paths write
  // and audit identically.
  const { upsertOpeningBalance } = await import("../lib/openingBalances");
  const row = await upsertOpeningBalance({
    ledgerId, balance, balanceType: balanceType as "debit" | "credit", asOfDate,
    financialYear, notes, user: req.employee?.username ?? "system", ledgerName: ledger.name,
  });

  res.status(201).json({ id: row.id, ledgerId, balance, balanceType, asOfDate, financialYear, notes });
});

// ── Bill-wise settlement context ──────────────────────────────────────────
// Everything the receipt/payment voucher form needs when a party ledger is
// picked: the party's open bills (oldest first, with balances computed the
// same way the outstanding reports compute them) and their advance position.
router.get("/accounts/settlement-context", requireModuleView(["page:/accounts/vouchers", "page:/operations/receipt-voucher", "page:/operations/payment-voucher"]), async (req, res): Promise<void> => {
  const ledgerId = Number(req.query.ledgerId);
  if (!Number.isInteger(ledgerId) || ledgerId <= 0) {
    res.status(400).json({ error: "ledgerId is required" }); return;
  }
  const { rows: [ledger] } = await pool.query(
    `SELECT id, code, name FROM account_ledgers WHERE id = $1`, [ledgerId],
  );
  if (!ledger) { res.status(404).json({ error: "Account not found" }); return; }
  const party = parsePartyLedgerCode(ledger.code);
  if (!party) {
    // Not a party ledger — nothing to settle bill-wise. An empty context lets
    // the form fall back to a plain voucher without special-casing.
    res.json({ kind: null, partyId: null, bills: [], advance: { available: 0 } });
    return;
  }

  // A branch caller settles only its own location's bills — the same scope
  // rule the write path enforces, applied here so the form never offers a
  // bill the submission would then refuse.
  const caller = callerLocation((req as any).employee);
  const branchScoped = caller.locationType !== "headoffice";

  // Same party-ownership rule as checkVoucherLegs: a branch user may not read
  // another branch's customer/vendor position (name, bills, advance). 404, not
  // 403 — the account's existence is itself information.
  if (branchScoped) {
    const scope = ownLocationScope((req as any).employee);
    const foreignParties = await foreignPartyLedgerIds(scope);
    if (foreignParties.includes(ledgerId)) {
      res.status(404).json({ error: "Account not found" }); return;
    }
  }

  const advance = await advanceAvailable(party.kind, party.partyId);

  if (party.kind === "customer") {
    const params: unknown[] = [party.partyId];
    let locCond = "TRUE";
    if (branchScoped) {
      params.push(caller.locationType, caller.locationId);
      locCond = `(COALESCE(s.location_type, 'outlet') = $2 AND COALESCE(s.location_id, s.outlet_id) = $3)`;
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.invoice_number, s.sale_date, s.total_amount::numeric AS total,
              ${outstandingExpr("s")} AS outstanding
         FROM sales s
        WHERE s.customer_id = $1
          AND s.cancelled_at IS NULL
          AND s.branch_transfer_id IS NULL
          AND ${outstandingExpr("s")} > 0.009
          AND ${locCond}
        ORDER BY s.sale_date ASC, s.id ASC`,
      params,
    );
    res.json({
      kind: "customer", partyId: party.partyId, partyName: ledger.name,
      bills: rows.map(r => ({
        saleId: Number(r.id), invoiceNumber: r.invoice_number ?? null,
        billDate: r.sale_date, total: Number(r.total), due: money2(Number(r.outstanding)),
      })),
      advance: { available: advance.available },
    });
    return;
  }

  // Vendor: dues come from the shared settlement index, so this list can never
  // disagree with the payables ageing or the GST purchase register.
  const idx = await purchaseSettlementIndex([party.partyId]);
  const params: unknown[] = [party.partyId];
  let locCond = "TRUE";
  if (branchScoped) {
    params.push(caller.locationType, caller.locationId);
    locCond = `(COALESCE(p.location_type, 'headoffice') = $2 AND COALESCE(p.location_id, 0) = $3)`;
  }
  const { rows } = await pool.query(
    `SELECT p.id, p.invoice_number, p.purchase_date,
            -- The payable side of the bill: goods plus other purchase charges,
            -- matching the vendor credit in the books and the settlement index.
            (p.total_amount::numeric + COALESCE((
               SELECT SUM((e->>'amount')::numeric)
                 FROM jsonb_array_elements(COALESCE(p.other_charges, '[]'::jsonb)) e
                WHERE (e->>'amount') ~ '^[0-9.]+$'
             ), 0)) AS total
       FROM purchases p
      WHERE p.vendor_id = $1 AND p.branch_transfer_id IS NULL AND ${locCond}
      ORDER BY p.purchase_date ASC, p.id ASC`,
    params,
  );
  res.json({
    kind: "vendor", partyId: party.partyId, partyName: ledger.name,
    bills: rows
      .map(r => {
        const s = idx.get(Number(r.id));
        return {
          purchaseId: Number(r.id), invoiceNumber: r.invoice_number ?? null,
          billDate: r.purchase_date, total: Number(r.total),
          due: money2(s?.due ?? Number(r.total)),
        };
      })
      .filter(b => b.due > 0.009),
    advance: { available: advance.available },
  });
});

// The sale / purchase forms ask one question: "does this party have an advance
// to adjust, and how much?" Guarded by the union of the pages that can ask it.
router.get("/accounts/party-advance", requireModuleView(["page:/sales/pos", "page:/production/purchase", "page:/accounts/vouchers", "page:/operations/receipt-voucher", "page:/operations/payment-voucher"]), async (req, res): Promise<void> => {
  const kind = String(req.query.kind ?? "");
  const partyId = Number(req.query.partyId);
  if ((kind !== "customer" && kind !== "vendor") || !Number.isInteger(partyId) || partyId <= 0) {
    res.status(400).json({ error: "kind (customer|vendor) and partyId are required" }); return;
  }
  // Branch callers may only read their own parties' positions — the ownership
  // rule from moneyScope: warehouse/outlet-stamped masters belong to that
  // location; HO-stamped and unstamped parties are company-wide. 404, not 403.
  const paScope = ownLocationScope((req as any).employee);
  if (!paScope.isHeadOffice) {
    const { rows: [master] } = await pool.query(
      kind === "customer"
        ? `SELECT location_type, location_id FROM customers WHERE id = $1`
        : `SELECT location_type, location_id FROM vendors WHERE id = $1`,
      [partyId],
    );
    if (!master) { res.status(404).json({ error: "Not found" }); return; }
    const lt = String(master.location_type ?? "");
    const lid = Number(master.location_id);
    const foreign =
      (lt === "warehouse" && !paScope.warehouseIds.includes(lid)) ||
      (lt === "outlet" && !paScope.outletIds.includes(lid));
    if (foreign) { res.status(404).json({ error: "Not found" }); return; }
  }
  const pos = await advanceAvailable(kind, partyId);
  res.json({ kind, partyId, available: pos.available });
});

router.delete("/accounts/opening-balances/:id", requireModuleAction("page:/accounts/chart", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  // Module-owned openings are off limits here — deleting one by hand would
  // bypass the equity counterweight and unbalance the books.
  const { rows: [owner] } = await pool.query(
    `SELECT al.name, al.code, ob.as_of_date FROM opening_balances ob JOIN account_ledgers al ON al.id = ob.ledger_id WHERE ob.id = $1`, [id]
  );
  const ownerCode = String(owner?.code ?? "");
  if (ownerCode.startsWith("CBA-")) {
    res.status(400).json({ error: `"${owner.name}" is managed from Accounts → Cash & Bank — delete the account there instead.` }); return;
  }
  if (ownerCode === "STD-OB-ADJ") {
    res.status(400).json({ error: "Opening Balance Adjustment is maintained automatically — it cannot be deleted by hand." }); return;
  }
  // Month lock: an opening balance belongs to its as-of period — it cannot be
  // deleted when that month is locked.
  if (owner && await respondIfMonthLocked(res, pool, [owner.as_of_date], "opening balance delete")) return;
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

