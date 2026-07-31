import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { db, warehousesTable, outletsTable, pool } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import {
  CreateWarehouseBody, UpdateWarehouseBody,
  CreateOutletBody, UpdateOutletBody,
} from "@workspace/api-zod";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { normalizeUpiId } from "../lib/upi";
import { normalizeWarehouseBilling, validateGstin, stateCodeFromGstin, loadWarehouseIssuer, loadWarehouseIssuers } from "../lib/billingProfile";
import { parsePaging, setPagingHeaders, applyPaging } from "../lib/paging";
import { provisionRentLedgers, syncRentLedgerNames, rentLedgerIdsFor } from "../lib/rentLedgers";
import { resolveChartParentId } from "../lib/chartGroups";

const router = Router();

// ── Ledger helpers ─────────────────────────────────────────────────────────

/** Ensure the three warehouse ledgers exist and are linked back to the row. */
async function provisionWarehouseLedgers(warehouseId: number, warehouseName: string): Promise<void> {
  // Per-location sales and purchase ledgers file inside their own sub-groups so
  // the Sales and Purchase groups stay readable as locations are added.
  const [cashParentId, salParentId, purParentId] = await Promise.all([
    resolveChartParentId(pool, 'STD-CASH'),
    resolveChartParentId(pool, 'STD-GRP-LOC-SAL'),
    resolveChartParentId(pool, 'STD-GRP-LOC-PUR'),
  ]);
  const cashParent = cashParentId ? { id: cashParentId } : undefined;
  const salParent  = salParentId  ? { id: salParentId }  : undefined;
  const purParent  = purParentId  ? { id: purParentId }  : undefined;

  const specs = [
    { col: 'cash_ledger_id',     code: `WH-CASH-${warehouseId}`, name: `${warehouseName} Cash`,     type: 'asset',   section: 'balance_sheet', parent: cashParent, desc: `Cash held at ${warehouseName}` },
    { col: 'sales_ledger_id',    code: `WH-SAL-${warehouseId}`,  name: `${warehouseName} Sales`,    type: 'income',  section: 'profit_loss',   parent: salParent,  desc: `Sales revenue from ${warehouseName}` },
    { col: 'purchase_ledger_id', code: `WH-PUR-${warehouseId}`,  name: `${warehouseName} Purchase`, type: 'expense', section: 'profit_loss',   parent: purParent,  desc: `Purchases at ${warehouseName}` },
  ];

  const ids: Record<string, number | null> = {};
  for (const { col, code, name, type, section, parent, desc } of specs) {
    if (!parent) { ids[col] = null; continue; }
    const { rows: [existing] } = await pool.query<{ id: number }>(`SELECT id FROM account_ledgers WHERE code = $1`, [code]);
    if (existing) {
      ids[col] = existing.id;
    } else {
      const { rows: [ins] } = await pool.query<{ id: number }>(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING id`,
        [name, type, code, section, parent.id, desc],
      );
      ids[col] = ins?.id ?? null;
    }
  }
  await pool.query(
    `UPDATE warehouses SET cash_ledger_id = $1, sales_ledger_id = $2, purchase_ledger_id = $3 WHERE id = $4`,
    [ids['cash_ledger_id'], ids['sales_ledger_id'], ids['purchase_ledger_id'], warehouseId],
  );
}

/** Ensure the two outlet ledgers exist and are linked back to the row. */
async function provisionOutletLedgers(outletId: number, outletName: string): Promise<void> {
  const [cashParentId, salParentId] = await Promise.all([
    resolveChartParentId(pool, 'STD-CASH'),
    resolveChartParentId(pool, 'STD-GRP-LOC-SAL'),
  ]);
  const cashParent = cashParentId ? { id: cashParentId } : undefined;
  const salParent  = salParentId  ? { id: salParentId }  : undefined;

  const specs = [
    { col: 'cash_ledger_id',  code: `OUTLET-CASH-${outletId}`, name: `${outletName} Cash`,  type: 'asset',  section: 'balance_sheet', parent: cashParent, desc: `Cash held at ${outletName}` },
    { col: 'sales_ledger_id', code: `OUTLET-SAL-${outletId}`,  name: `${outletName} Sales`, type: 'income', section: 'profit_loss',   parent: salParent,  desc: `Sales revenue from ${outletName}` },
  ];

  const ids: Record<string, number | null> = {};
  for (const { col, code, name, type, section, parent, desc } of specs) {
    if (!parent) { ids[col] = null; continue; }
    const { rows: [existing] } = await pool.query<{ id: number }>(`SELECT id FROM account_ledgers WHERE code = $1`, [code]);
    if (existing) {
      ids[col] = existing.id;
    } else {
      const { rows: [ins] } = await pool.query<{ id: number }>(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         VALUES ($1, $2, $3, $4, $5, false, $6) RETURNING id`,
        [name, type, code, section, parent.id, desc],
      );
      ids[col] = ins?.id ?? null;
    }
  }
  await pool.query(
    `UPDATE outlets SET cash_ledger_id = $1, sales_ledger_id = $2 WHERE id = $3`,
    [ids['cash_ledger_id'], ids['sales_ledger_id'], outletId],
  );
}

/** Update display names of all linked ledgers when an entity is renamed. */
async function syncWarehouseLedgerNames(warehouseId: number, newName: string): Promise<void> {
  // Resolve by the linked ledger ID, not by the `WH-*` code convention:
  // warehouses converted from outlets deliberately keep their original
  // `OUTLET-*` ledgers so cash and revenue history stays attached, so a
  // code-based lookup would silently match nothing and let names drift.
  const { rows: [wh] } = await pool.query<{
    cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null;
  }>(`SELECT cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses WHERE id = $1`, [warehouseId]);
  if (!wh) return;

  const renames: [number | null, string][] = [
    [wh.cash_ledger_id,     `${newName} Cash`],
    [wh.sales_ledger_id,    `${newName} Sales`],
    [wh.purchase_ledger_id, `${newName} Purchase`],
  ];
  for (const [ledgerId, name] of renames) {
    if (ledgerId != null) {
      await pool.query(`UPDATE account_ledgers SET name = $1 WHERE id = $2`, [name, ledgerId]);
    }
  }
}

async function syncOutletLedgerNames(outletId: number, newName: string): Promise<void> {
  await pool.query(
    `UPDATE account_ledgers SET name = $1 WHERE code = $2`,
    [`${newName} Cash`, `OUTLET-CASH-${outletId}`],
  );
  await pool.query(
    `UPDATE account_ledgers SET name = $1 WHERE code = $2`,
    [`${newName} Sales`, `OUTLET-SAL-${outletId}`],
  );
}

/** Return true if ANY of the given ledger IDs have accounting entries. */
async function hasLedgerEntries(ledgerIds: (number | null)[]): Promise<boolean> {
  const ids = ledgerIds.filter((id): id is number => id !== null);
  if (ids.length === 0) return false;
  const { rows: [row] } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM (
       SELECT id FROM payments WHERE paid_from_ledger_id = ANY($1::int[]) OR paid_to_ledger_id = ANY($1::int[])
       UNION ALL
       SELECT id FROM receipts WHERE received_from_ledger_id = ANY($1::int[]) OR received_in_ledger_id = ANY($1::int[])
       UNION ALL
       SELECT id FROM expenses WHERE ledger_account_id = ANY($1::int[])
     ) t`,
    [ids],
  );
  return Number(row.count) > 0;
}

// ── Warehouses ─────────────────────────────────────────────────────────────
// Cross-cutting location dropdown consumed by most pages (Dashboard, Inventory,
// HR, Expenses, Reports, Transfers …). Kept deliberately wide to avoid blanking
// out pages for users with any of these permissions.
router.get("/warehouses", requireModuleView(["page:/", "page:/production/item-master", "page:/headoffice/stock-verification", "page:/headoffice/warehouses", "page:/headoffice/outlets", "page:/headoffice/item-price", "page:/headoffice/inventory-reports", "page:/headoffice/stock", "page:/hr/attendance", "page:/hr/payroll", "page:/hr/employees", "page:/accounts/expenses", "page:/reports/sales", "page:/transfers"]), async (_req, res): Promise<void> => {
  const rows = await db.select().from(warehousesTable).orderBy(warehousesTable.id);
  const outletCounts = await db
    .select({ warehouseId: outletsTable.warehouseId, cnt: count() })
    .from(outletsTable)
    .groupBy(outletsTable.warehouseId);
  const countMap = new Map(outletCounts.map((o) => [o.warehouseId, o.cnt]));
  // Fetch ledger IDs via raw query (columns not in Drizzle schema)
  const { rows: raw } = await pool.query<{ id: number; cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null }>(
    `SELECT id, cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses ORDER BY id`
  );
  const ledgerMap = new Map(raw.map(r => [r.id, { cashLedgerId: r.cash_ledger_id, salesLedgerId: r.sales_ledger_id, purchaseLedgerId: r.purchase_ledger_id }]));
  // What the invoice will actually print, not what this row happens to hold —
  // the bank and UPI fall back to the company, so a warehouse without its own
  // is not necessarily incomplete.
  const issuers = await loadWarehouseIssuers(pool);
  const paging = parsePaging(_req.query as Record<string, unknown>);
  setPagingHeaders(res, rows.length, paging);
  res.json(applyPaging(rows, paging).map((r) => ({
    ...r, outletCount: countMap.get(r.id) ?? 0, ...ledgerMap.get(r.id),
    billingIncomplete: issuers.get(r.id)?.incomplete ?? [],
  })));
});

router.post("/warehouses", requireModuleAction("page:/headoffice/warehouses", "add"), async (req, res): Promise<void> => {
  const parsed = CreateWarehouseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // Normalise before the insert, not after: an empty string must reach the
  // column as NULL, or every UPI QR builder downstream has to special-case ''.
  const upi = normalizeUpiId(parsed.data.upiId);
  if (!upi.ok) { res.status(400).json({ error: upi.error }); return; }
  // This warehouse will be named as the seller on every invoice raised at it,
  // so its billing details are checked here rather than left to the renderer.
  const gstErr = validateGstin(parsed.data.gstNumber);
  if (gstErr) { res.status(400).json({ error: gstErr, field: "gstNumber" }); return; }
  const billing = normalizeWarehouseBilling(parsed.data as Record<string, unknown>);
  if (!billing.ok) { res.status(400).json({ error: billing.error, field: billing.field }); return; }
  const values = { ...parsed.data, ...billing.value, upiId: upi.value };
  // The GST state code is the first two digits of the GSTIN, so it is derived
  // rather than accepted: a client that submits both could otherwise store a
  // code that contradicts the registration and silently flip the intra/inter
  // -state split on every invoice raised here.
  values.stateCode = stateCodeFromGstin(values.gstNumber) || null;
  const [row] = await db.insert(warehousesTable).values(values).returning();
  // Auto-provision ledgers (non-fatal if CoA groups not ready)
  try { await provisionWarehouseLedgers(row.id, row.name); } catch (e) { console.warn('[branches] warehouse ledger provision failed:', e); }
  // Register the warehouse for rent straight away — inactive and at zero — so it
  // shows up in Rent Management without anyone having to link it by hand.
  try {
    await pool.query(
      `INSERT INTO warehouse_rent_agreements (warehouse_id) VALUES ($1) ON CONFLICT (warehouse_id) DO NOTHING`,
      [row.id],
    );
    await provisionRentLedgers(pool, row.id, row.name);
  } catch (e) { console.warn('[branches] rent registration failed:', e); }
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses WHERE id = $1`, [row.id]
  );
  res.status(201).json({ ...row, outletCount: 0, cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, purchaseLedgerId: ledgers?.purchase_ledger_id ?? null });
});

router.get("/warehouses/:id", requireModuleView("page:/headoffice/warehouses"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [cnt] = await db.select({ cnt: count() }).from(outletsTable).where(eq(outletsTable.warehouseId, id));
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses WHERE id = $1`, [id]
  );
  res.json({ ...row, outletCount: cnt?.cnt ?? 0, cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, purchaseLedgerId: ledgers?.purchase_ledger_id ?? null, billingIncomplete: (await loadWarehouseIssuer(pool, id))?.incomplete ?? [] });
});

router.patch("/warehouses/:id", requireModuleAction("page:/headoffice/warehouses", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const parsed = UpdateWarehouseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // A PATCH is a partial update: only the keys actually present are written, so
  // changing the UPI ID alone must not blank out the name, GSTIN or address.
  const patch: Record<string, unknown> = { ...parsed.data };
  if ('upiId' in patch) {
    const upi = normalizeUpiId(patch['upiId']);
    if (!upi.ok) { res.status(400).json({ error: upi.error }); return; }
    patch['upiId'] = upi.value;
  }
  if ('gstNumber' in patch) {
    const gstErr = validateGstin(patch['gstNumber']);
    if (gstErr) { res.status(400).json({ error: gstErr, field: "gstNumber" }); return; }
  }
  const billing = normalizeWarehouseBilling(patch);
  if (!billing.ok) { res.status(400).json({ error: billing.error, field: billing.field }); return; }
  Object.assign(patch, billing.value);

  // Fetch old name and GSTIN — the name drives ledger renames, and the state
  // code is derived from whichever GSTIN this row ends up with.
  const { rows: [before] } = await pool.query<{ name: string; gst_number: string | null }>(
    `SELECT name, gst_number FROM warehouses WHERE id = $1`, [id],
  );
  // Derive from the effective value, never the submitted one. A submitted state
  // code is ignored outright — accepting it would let `{gstNumber:'33…',
  // stateCode:'29'}` persist a contradiction — and a PATCH that touches neither
  // still backfills legacy rows that predate the column.
  if (before) {
    const effectiveGstin = 'gstNumber' in patch ? patch['gstNumber'] : before.gst_number;
    patch['stateCode'] = stateCodeFromGstin(effectiveGstin) || null;
  }

  // Drizzle throws on an empty SET, which a body with no writable keys would
  // otherwise produce. Fall back to reading the row so the request still
  // answers 404 for a warehouse that is gone.
  let row: typeof warehousesTable.$inferSelect | undefined;
  if (Object.keys(patch).length > 0) {
    [row] = await db.update(warehousesTable).set(patch).where(eq(warehousesTable.id, id)).returning();
  } else {
    [row] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, id)).limit(1);
  }
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  // Sync ledger display names if name changed
  if (before && parsed.data.name && parsed.data.name !== before.name) {
    try { await syncWarehouseLedgerNames(id, row.name); } catch (e) { console.warn('[branches] ledger name sync failed:', e); }
    // Rent ledgers carry the warehouse name too, and are renamed with it rather
    // than edited by hand.
    try { await syncRentLedgerNames(pool, id, row.name); } catch (e) { console.warn('[branches] rent ledger name sync failed:', e); }
  }
  const [cnt] = await db.select({ cnt: count() }).from(outletsTable).where(eq(outletsTable.warehouseId, id));
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses WHERE id = $1`, [id]
  );
  res.json({ ...row, outletCount: cnt?.cnt ?? 0, cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, purchaseLedgerId: ledgers?.purchase_ledger_id ?? null });
});

router.delete("/warehouses/:id", requireModuleAction("page:/headoffice/warehouses", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  // Fetch linked ledger IDs
  const { rows: [wh] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses WHERE id = $1`, [id]
  );
  const rentLedgers = await rentLedgerIdsFor(pool, id);
  if (wh && await hasLedgerEntries([wh.cash_ledger_id, wh.sales_ledger_id, wh.purchase_ledger_id, ...rentLedgers])) {
    res.status(400).json({ error: "This warehouse cannot be deleted because accounting entries already exist. Deleting it would affect financial history." });
    return;
  }
  // Rent accruals are derived postings, not ledger rows, so they are invisible
  // to the ledger check above — but deleting the warehouse would still orphan
  // real rent history and silently drop it out of the P&L.
  const { rows: [rentHistory] } = await pool.query<{ count: string }>(
    `SELECT (SELECT COUNT(*) FROM rent_accruals WHERE warehouse_id = $1)
          + (SELECT COUNT(*) FROM rent_payments WHERE warehouse_id = $1) AS count`, [id],
  );
  if (Number(rentHistory?.count ?? 0) > 0) {
    res.status(400).json({ error: "This warehouse cannot be deleted because rent has already been accrued or paid against it. Deleting it would affect financial history." });
    return;
  }
  // Sales are the reason this row must outlive its usefulness: the warehouse is
  // named as the seller on every invoice raised at it, and that identity is read
  // live at render time. Delete it and every historical invoice reprints with an
  // empty seller block. Outlet sales count too — an outlet inherits its parent's
  // legal identity, so the parent going away breaks the child's invoices as well.
  const { rows: [saleHistory] } = await pool.query<{ count: string }>(
    `SELECT (SELECT COUNT(*) FROM sales WHERE location_type = 'warehouse' AND location_id = $1)
          + (SELECT COUNT(*) FROM sales s JOIN outlets o
               ON o.id = CASE WHEN s.location_type = 'outlet' THEN s.location_id ELSE s.outlet_id END
             WHERE o.warehouse_id = $1) AS count`, [id],
  );
  if (Number(saleHistory?.count ?? 0) > 0) {
    res.status(400).json({ error: "This warehouse cannot be deleted because sales have been invoiced from it. Its name and GSTIN appear on those invoices, which would no longer reprint correctly." });
    return;
  }
  await pool.query(`DELETE FROM warehouse_rent_agreements WHERE warehouse_id = $1`, [id]);
  // Take the auto-provisioned rent ledgers with it. They are safe to drop here
  // precisely because the check above already refused the delete if anything had
  // ever posted to them — leaving them would strand "Rent Expense - <deleted
  // warehouse>" in the Chart of Accounts forever, with no way to reach it.
  if (rentLedgers.length > 0) {
    await pool.query(`DELETE FROM account_ledgers WHERE id = ANY($1::int[])`, [rentLedgers]);
  }
  await db.delete(warehousesTable).where(eq(warehousesTable.id, id));
  res.status(204).send();
});

// ── Outlets ────────────────────────────────────────────────────────────────
// Cross-cutting location dropdown consumed by most pages (as /warehouses, plus
// POS and Sales Expenses). Kept deliberately wide to avoid blanking out pages.
router.get("/outlets", requireModuleView(["page:/", "page:/production/item-master", "page:/headoffice/stock-verification", "page:/headoffice/warehouses", "page:/headoffice/outlets", "page:/headoffice/item-price", "page:/headoffice/inventory-reports", "page:/headoffice/stock", "page:/hr/attendance", "page:/hr/payroll", "page:/hr/employees", "page:/accounts/expenses", "page:/reports/sales", "page:/transfers", "page:/sales/pos", "page:/sales/expenses"]), async (_req, res): Promise<void> => {
  const rows = await db.select().from(outletsTable).orderBy(outletsTable.id);
  const warehouses = await db.select().from(warehousesTable);
  const wMap = new Map(warehouses.map((w) => [w.id, w.name]));
  const { rows: raw } = await pool.query<{ id: number; cash_ledger_id: number | null; sales_ledger_id: number | null; gstin: string | null; state: string | null; state_code: string | null }>(
    `SELECT id, cash_ledger_id, sales_ledger_id, COALESCE(gstin,'') AS gstin, COALESCE(state,'') AS state, COALESCE(state_code,'') AS state_code FROM outlets ORDER BY id`
  );
  const ledgerMap = new Map(raw.map(r => [r.id, { cashLedgerId: r.cash_ledger_id, salesLedgerId: r.sales_ledger_id, gstin: r.gstin ?? '', state: r.state ?? '', stateCode: r.state_code ?? '' }]));
  const paging = parsePaging(_req.query as Record<string, unknown>);
  setPagingHeaders(res, rows.length, paging);
  res.json(applyPaging(rows, paging).map((r) => ({ ...r, warehouseName: wMap.get(r.warehouseId) ?? "", ...ledgerMap.get(r.id) })));
});

router.post("/outlets", requireModuleAction("page:/headoffice/outlets", "add"), async (req, res): Promise<void> => {
  if (await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }
  const parsed = CreateOutletBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(outletsTable).values(parsed.data).returning();
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, row.warehouseId)).limit(1);
  // Auto-provision ledgers
  try { await provisionOutletLedgers(row.id, row.name); } catch (e) { console.warn('[branches] outlet ledger provision failed:', e); }
  // Save GST fields (raw columns not in Drizzle schema)
  const { gstin: gNew = null, state: stNew = null, stateCode: scO = null } = req.body as any;
  await pool.query(`UPDATE outlets SET gstin = $1, state = $2, state_code = $3 WHERE id = $4`, [gNew || null, stNew || null, scO || null, row.id]);
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; gstin: string | null; state: string | null; state_code: string | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, COALESCE(gstin,'') AS gstin, COALESCE(state,'') AS state, COALESCE(state_code,'') AS state_code FROM outlets WHERE id = $1`, [row.id]
  );
  res.status(201).json({ ...row, warehouseName: wh?.name ?? "", cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, gstin: ledgers?.gstin ?? '', state: ledgers?.state ?? '', stateCode: ledgers?.state_code ?? '' });
});

router.get("/outlets/:id", requireModuleView("page:/headoffice/outlets"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(outletsTable).where(eq(outletsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, row.warehouseId)).limit(1);
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; gstin: string | null; state: string | null; state_code: string | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, COALESCE(gstin,'') AS gstin, COALESCE(state,'') AS state, COALESCE(state_code,'') AS state_code FROM outlets WHERE id = $1`, [id]
  );
  res.json({ ...row, warehouseName: wh?.name ?? "", cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, gstin: ledgers?.gstin ?? '', state: ledgers?.state ?? '', stateCode: ledgers?.state_code ?? '' });
});

router.patch("/outlets/:id", requireModuleAction("page:/headoffice/outlets", "edit"), async (req, res): Promise<void> => {
  if (await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }
  const id = parseInt(req.params.id, 10);
  const parsed = UpdateOutletBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { rows: [before] } = await pool.query<{ name: string }>(`SELECT name FROM outlets WHERE id = $1`, [id]);
  const [row] = await db.update(outletsTable).set(parsed.data).where(eq(outletsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (before && parsed.data.name && parsed.data.name !== before.name) {
    try { await syncOutletLedgerNames(id, row.name); } catch (e) { console.warn('[branches] outlet ledger name sync failed:', e); }
  }
  // Update GST fields (raw columns not in Drizzle schema)
  const { gstin: gUpd, state: stUpd, stateCode: scUpd } = req.body as any;
  if (gUpd !== undefined || stUpd !== undefined || scUpd !== undefined) {
    await pool.query(`UPDATE outlets SET gstin = COALESCE($1, gstin), state = COALESCE($2, state), state_code = COALESCE($3, state_code) WHERE id = $4`,
      [gUpd ?? null, stUpd ?? null, scUpd ?? null, id]);
  }
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, row.warehouseId)).limit(1);
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; gstin: string | null; state: string | null; state_code: string | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, COALESCE(gstin,'') AS gstin, COALESCE(state,'') AS state, COALESCE(state_code,'') AS state_code FROM outlets WHERE id = $1`, [id]
  );
  res.json({ ...row, warehouseName: wh?.name ?? "", cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, gstin: ledgers?.gstin ?? '', state: ledgers?.state ?? '', stateCode: ledgers?.state_code ?? '' });
});

router.delete("/outlets/:id", requireModuleAction("page:/headoffice/outlets", "delete"), async (req, res): Promise<void> => {
  // Historical integrity outranks tidiness: while the module is off, outlet rows
  // are frozen, not removable, so no report or audit can lose its subject.
  if (await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }
  const id = parseInt(req.params.id, 10);
  const { rows: [outlet] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null }>(
    `SELECT cash_ledger_id, sales_ledger_id FROM outlets WHERE id = $1`, [id]
  );
  if (outlet && await hasLedgerEntries([outlet.cash_ledger_id, outlet.sales_ledger_id])) {
    res.status(400).json({ error: "This outlet cannot be deleted because accounting entries already exist. Deleting it would affect financial history." });
    return;
  }
  // Block if outlet has sales — fail closed (no catch).
  // Both columns are checked: customer sales stamp outlet_id, while branch
  // transfer invoices stamp location_type/location_id and leave outlet_id null.
  // Counting only outlet_id would let an outlet with transfer history be deleted.
  const { rows: [salCnt] } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM sales
      WHERE outlet_id = $1
         OR (COALESCE(location_type, '') = 'outlet' AND location_id = $1)`, [id]
  );
  if (Number(salCnt.count) > 0) {
    res.status(400).json({ error: "This outlet cannot be deleted because sales records exist. Deleting it would affect financial history." });
    return;
  }
  await db.delete(outletsTable).where(eq(outletsTable.id, id));
  res.status(204).send();
});

export default router;
