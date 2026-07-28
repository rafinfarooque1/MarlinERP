import { Router } from "express";
import { requireModuleAction } from "../middleware/permissions";
import { db, warehousesTable, outletsTable, pool } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import {
  CreateWarehouseBody, UpdateWarehouseBody,
  CreateOutletBody, UpdateOutletBody,
} from "@workspace/api-zod";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";

const router = Router();

// ── Ledger helpers ─────────────────────────────────────────────────────────

/** Ensure the three warehouse ledgers exist and are linked back to the row. */
async function provisionWarehouseLedgers(warehouseId: number, warehouseName: string): Promise<void> {
  const [{ rows: [cashParent] }, { rows: [salParent] }, { rows: [purParent] }] = await Promise.all([
    pool.query<{ id: number }>(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH' LIMIT 1`),
    pool.query<{ id: number }>(`SELECT id FROM account_ledgers WHERE code = 'SYS-SAL' LIMIT 1`),
    pool.query<{ id: number }>(`SELECT id FROM account_ledgers WHERE code = 'SYS-PUR' LIMIT 1`),
  ]);

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
  const [{ rows: [cashParent] }, { rows: [salParent] }] = await Promise.all([
    pool.query<{ id: number }>(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH' LIMIT 1`),
    pool.query<{ id: number }>(`SELECT id FROM account_ledgers WHERE code = 'SYS-SAL' LIMIT 1`),
  ]);

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
router.get("/warehouses", async (_req, res): Promise<void> => {
  const rows = await db.select().from(warehousesTable).orderBy(warehousesTable.id);
  const outletCounts = await db
    .select({ warehouseId: outletsTable.warehouseId, cnt: count() })
    .from(outletsTable)
    .groupBy(outletsTable.warehouseId);
  const countMap = new Map(outletCounts.map((o) => [o.warehouseId, o.cnt]));
  // Fetch ledger IDs via raw query (columns not in Drizzle schema)
  const { rows: raw } = await pool.query<{ id: number; cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null; state_code: string | null }>(
    `SELECT id, cash_ledger_id, sales_ledger_id, purchase_ledger_id, COALESCE(state_code,'') AS state_code FROM warehouses ORDER BY id`
  );
  const ledgerMap = new Map(raw.map(r => [r.id, { cashLedgerId: r.cash_ledger_id, salesLedgerId: r.sales_ledger_id, purchaseLedgerId: r.purchase_ledger_id, stateCode: r.state_code ?? '' }]));
  res.json(rows.map((r) => ({ ...r, outletCount: countMap.get(r.id) ?? 0, ...ledgerMap.get(r.id) })));
});

router.post("/warehouses", requireModuleAction("Warehouses", "add"), async (req, res): Promise<void> => {
  const parsed = CreateWarehouseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [row] = await db.insert(warehousesTable).values(parsed.data).returning();
  // Save state_code (raw column not in Drizzle schema)
  const scNew = (req.body as any)?.stateCode ?? null;
  if (scNew !== null) await pool.query(`UPDATE warehouses SET state_code = $1 WHERE id = $2`, [scNew || null, row.id]);
  // Auto-provision ledgers (non-fatal if CoA groups not ready)
  try { await provisionWarehouseLedgers(row.id, row.name); } catch (e) { console.warn('[branches] warehouse ledger provision failed:', e); }
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null; state_code: string | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, purchase_ledger_id, COALESCE(state_code,'') AS state_code FROM warehouses WHERE id = $1`, [row.id]
  );
  res.status(201).json({ ...row, outletCount: 0, cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, purchaseLedgerId: ledgers?.purchase_ledger_id ?? null, stateCode: ledgers?.state_code ?? '' });
});

router.get("/warehouses/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [cnt] = await db.select({ cnt: count() }).from(outletsTable).where(eq(outletsTable.warehouseId, id));
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null; state_code: string | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, purchase_ledger_id, COALESCE(state_code,'') AS state_code FROM warehouses WHERE id = $1`, [id]
  );
  res.json({ ...row, outletCount: cnt?.cnt ?? 0, cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, purchaseLedgerId: ledgers?.purchase_ledger_id ?? null, stateCode: ledgers?.state_code ?? '' });
});

router.patch("/warehouses/:id", requireModuleAction("Warehouses", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const parsed = UpdateWarehouseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  // Fetch old name for comparison
  const { rows: [before] } = await pool.query<{ name: string }>(`SELECT name FROM warehouses WHERE id = $1`, [id]);
  const [row] = await db.update(warehousesTable).set(parsed.data).where(eq(warehousesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  // Update state_code (raw column not in Drizzle schema)
  const scUpd = (req.body as any)?.stateCode;
  if (scUpd !== undefined) await pool.query(`UPDATE warehouses SET state_code = $1 WHERE id = $2`, [scUpd || null, id]);
  // Sync ledger display names if name changed
  if (before && parsed.data.name && parsed.data.name !== before.name) {
    try { await syncWarehouseLedgerNames(id, row.name); } catch (e) { console.warn('[branches] ledger name sync failed:', e); }
  }
  const [cnt] = await db.select({ cnt: count() }).from(outletsTable).where(eq(outletsTable.warehouseId, id));
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null; state_code: string | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, purchase_ledger_id, COALESCE(state_code,'') AS state_code FROM warehouses WHERE id = $1`, [id]
  );
  res.json({ ...row, outletCount: cnt?.cnt ?? 0, cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, purchaseLedgerId: ledgers?.purchase_ledger_id ?? null, stateCode: ledgers?.state_code ?? '' });
});

router.delete("/warehouses/:id", requireModuleAction("Warehouses", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  // Fetch linked ledger IDs
  const { rows: [wh] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses WHERE id = $1`, [id]
  );
  if (wh && await hasLedgerEntries([wh.cash_ledger_id, wh.sales_ledger_id, wh.purchase_ledger_id])) {
    res.status(400).json({ error: "This warehouse cannot be deleted because accounting entries already exist. Deleting it would affect financial history." });
    return;
  }
  // Note: a sales-count check will be added here in Task #33 when location_type is added to sales.
  await db.delete(warehousesTable).where(eq(warehousesTable.id, id));
  res.status(204).send();
});

// ── Outlets ────────────────────────────────────────────────────────────────
router.get("/outlets", async (_req, res): Promise<void> => {
  const rows = await db.select().from(outletsTable).orderBy(outletsTable.id);
  const warehouses = await db.select().from(warehousesTable);
  const wMap = new Map(warehouses.map((w) => [w.id, w.name]));
  const { rows: raw } = await pool.query<{ id: number; cash_ledger_id: number | null; sales_ledger_id: number | null; gstin: string | null; state: string | null; state_code: string | null }>(
    `SELECT id, cash_ledger_id, sales_ledger_id, COALESCE(gstin,'') AS gstin, COALESCE(state,'') AS state, COALESCE(state_code,'') AS state_code FROM outlets ORDER BY id`
  );
  const ledgerMap = new Map(raw.map(r => [r.id, { cashLedgerId: r.cash_ledger_id, salesLedgerId: r.sales_ledger_id, gstin: r.gstin ?? '', state: r.state ?? '', stateCode: r.state_code ?? '' }]));
  res.json(rows.map((r) => ({ ...r, warehouseName: wMap.get(r.warehouseId) ?? "", ...ledgerMap.get(r.id) })));
});

router.post("/outlets", requireModuleAction("Outlets", "add"), async (req, res): Promise<void> => {
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

router.get("/outlets/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [row] = await db.select().from(outletsTable).where(eq(outletsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  const [wh] = await db.select().from(warehousesTable).where(eq(warehousesTable.id, row.warehouseId)).limit(1);
  const { rows: [ledgers] } = await pool.query<{ cash_ledger_id: number | null; sales_ledger_id: number | null; gstin: string | null; state: string | null; state_code: string | null }>(
    `SELECT cash_ledger_id, sales_ledger_id, COALESCE(gstin,'') AS gstin, COALESCE(state,'') AS state, COALESCE(state_code,'') AS state_code FROM outlets WHERE id = $1`, [id]
  );
  res.json({ ...row, warehouseName: wh?.name ?? "", cashLedgerId: ledgers?.cash_ledger_id ?? null, salesLedgerId: ledgers?.sales_ledger_id ?? null, gstin: ledgers?.gstin ?? '', state: ledgers?.state ?? '', stateCode: ledgers?.state_code ?? '' });
});

router.patch("/outlets/:id", requireModuleAction("Outlets", "edit"), async (req, res): Promise<void> => {
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

router.delete("/outlets/:id", requireModuleAction("Outlets", "delete"), async (req, res): Promise<void> => {
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
