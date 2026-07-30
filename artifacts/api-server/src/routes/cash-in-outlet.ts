import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { isIsoDate } from "../lib/dateInput";
import { getUserDataScope, isLocationInScope } from "../lib/dataScope";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";

const router = Router();

// ── Helper: compute running balance for a ledger from receipts/payments ───────
/**
 * A till's balance, from the accounting postings.
 *
 * This used to add up `receipts` and `payments` for the ledger and call the
 * result a cash balance. Those two tables hold voucher-entered money only, so
 * the figure missed every sale settled at the till (the books derive those from
 * the sale row), every contra moving cash to the bank, and every journal — while
 * the Cash Book, the Trial Balance and the Balance Sheet all saw them. Same
 * till, two answers.
 *
 * Callers that need more than one till must build the index once and read
 * `idx.net(ledgerId)` per till; deriving the stream inside a loop is what makes
 * a list endpoint quadratic.
 */
async function getLedgerBalance(_client: unknown, ledgerId: number): Promise<number> {
  const { currentBalanceIndex } = await import("../lib/ledgerBalances");
  return (await currentBalanceIndex()).net(ledgerId);
}

/**
 * Resolves a location's cash till: its own `cash_ledger_id` first, then the
 * `WH-CASH-<id>` / `OUTLET-CASH-<id>` naming convention.
 *
 * The stored column wins because two locations may share one till — an outlet
 * that is also kept as a warehouse row points at the same ledger, and that
 * ledger's code can only name one of them. Reading the code alone therefore
 * reports the till under one location and ₹0 under the other.
 */
async function resolveCashLedger(
  storedLedgerId: unknown, fallbackCode: string,
): Promise<{ id: number } | null> {
  if (storedLedgerId != null) {
    const { rows } = await pool.query(`SELECT id FROM account_ledgers WHERE id = $1`, [Number(storedLedgerId)]);
    if (rows[0]) return { id: Number(rows[0].id) };
  }
  const { rows } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [fallbackCode]);
  return rows[0] ? { id: Number(rows[0].id) } : null;
}

// ── GET /cash-in-outlet ───────────────────────────────────────────────────────
// Returns cash balances scoped to the requesting employee's location.
// Head-office sees all; warehouse sees their own + child outlets; outlet sees only itself.
// Serves Cash Balance (accounts + sales) and Sales Expenses pages.
router.get("/cash-in-outlet", requireModuleView(["page:/accounts/cash-in-outlet", "page:/sales/expenses"]), async (req, res): Promise<void> => {
  const scopeEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
  let allowedOutletIds: number[] | null = null;   // null = unrestricted
  let allowedWarehouseIds: number[] | null = null;
  if (scopeEmp && scopeEmp.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeEmp);
    allowedOutletIds = scope.outletIds;
    allowedWarehouseIds = scope.warehouseIds;
  }
  const result: any[] = [];

  // Derived ONCE for the whole page. Every till reads its balance out of this
  // index; deriving the posting stream per location would re-read the entire
  // ledger history for each outlet and warehouse on the list.
  const { currentBalanceIndex } = await import("../lib/ledgerBalances");
  const balIdx = await currentBalanceIndex();

  // ── Outlets ────────────────────────────────────────────────────────────────
  const { rows: outlets } = await pool.query(
    `SELECT id, name, warehouse_id, cash_ledger_id FROM outlets ORDER BY name`
  );
  for (const outlet of outlets) {
    // Skip outlets outside the caller's scope
    if (allowedOutletIds !== null && !allowedOutletIds.includes(Number(outlet.id))) continue;
    // The location's own cash_ledger_id is authoritative; the code convention is
    // only a fallback. Locations that share a till (an outlet also kept as a
    // warehouse row) point at one ledger whose code names just one of them, so
    // deriving the ledger from the code alone reports ₹0 for the other.
    const ledger = await resolveCashLedger(outlet.cash_ledger_id, `OUTLET-CASH-${outlet.id}`);
    if (!ledger) {
      result.push({ locationType: 'outlet', locationId: outlet.id, locationName: outlet.name, outletId: outlet.id, outletName: outlet.name, parentWarehouseId: outlet.warehouse_id ?? null, cashLedgerId: null, cashBalance: 0, pendingDeposits: 0, availableBalance: 0 });
      continue;
    }
    const balance = balIdx.net(ledger.id);
    const { rows: [pendingRow] } = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric), 0) AS total FROM cash_deposits WHERE outlet_id = $1 AND status = 'pending_reconciliation'`,
      [outlet.id]
    );
    const pendingDeposits = Number(pendingRow?.total ?? 0);
    result.push({
      locationType: 'outlet',
      locationId: outlet.id,
      locationName: outlet.name,
      outletId: outlet.id,
      outletName: outlet.name,
      parentWarehouseId: outlet.warehouse_id ?? null,
      cashLedgerId: ledger.id,
      cashBalance: Math.round(balance * 100) / 100,
      pendingDeposits: Math.round(pendingDeposits * 100) / 100,
      availableBalance: Math.round(Math.max(0, balance) * 100) / 100,
    });
  }

  // ── Warehouses ─────────────────────────────────────────────────────────────
  const { rows: warehouses } = await pool.query(
    `SELECT id, name, cash_ledger_id FROM warehouses ORDER BY name`
  );
  for (const wh of warehouses) {
    // Skip warehouses outside the caller's scope
    if (allowedWarehouseIds !== null && !allowedWarehouseIds.includes(Number(wh.id))) continue;
    const ledger = await resolveCashLedger(wh.cash_ledger_id, `WH-CASH-${wh.id}`);
    if (!ledger) {
      result.push({ locationType: 'warehouse', locationId: wh.id, locationName: wh.name, outletId: null, outletName: null, cashLedgerId: null, cashBalance: 0, pendingDeposits: 0, availableBalance: 0 });
      continue;
    }
    const balance = balIdx.net(ledger.id);
    const { rows: [whPendingRow] } = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric), 0) AS total FROM cash_deposits WHERE warehouse_id = $1 AND status = 'pending_reconciliation'`,
      [wh.id]
    );
    const whPending = Number(whPendingRow?.total ?? 0);
    result.push({
      locationType: 'warehouse',
      locationId: wh.id,
      locationName: wh.name,
      outletId: null,
      outletName: null,
      cashLedgerId: ledger.id,
      cashBalance: Math.round(balance * 100) / 100,
      pendingDeposits: Math.round(whPending * 100) / 100,
      availableBalance: Math.round(Math.max(0, balance) * 100) / 100,
    });
  }

  res.json(result);
});

// ── GET /cash-in-outlet/deposits ──────────────────────────────────────────────
router.get("/cash-in-outlet/deposits", requireModuleView("page:/accounts/cash-in-outlet"), async (req, res): Promise<void> => {
  const { status, outletId } = req.query as Record<string, string | undefined>;

  const params: any[] = [];
  const conds: string[] = [];

  if (status)   { params.push(status);         conds.push(`cd.status = $${params.length}`); }
  if (outletId) { params.push(Number(outletId)); conds.push(`cd.outlet_id = $${params.length}`); }

  // Location scoping: non-headoffice employees only see deposits for their own locations
  const scopeDep = (req as any).employee as { branchType: string; branchId: number } | undefined;
  if (scopeDep && scopeDep.branchType !== 'headoffice') {
    const scope = await getUserDataScope(scopeDep);
    if (scope.outletIds.length > 0 && scope.warehouseIds.length === 0) {
      // Outlet employee — only their outlet's deposits
      params.push(scope.outletIds);
      conds.push(`(cd.outlet_id = ANY($${params.length}::int[]) AND cd.warehouse_id IS NULL)`);
    } else if (scope.warehouseIds.length > 0) {
      // Warehouse employee — their warehouse deposits + child outlet deposits
      const subConds: string[] = [];
      params.push(scope.warehouseIds);
      subConds.push(`cd.warehouse_id = ANY($${params.length}::int[])`);
      if (scope.outletIds.length > 0) {
        params.push(scope.outletIds);
        subConds.push(`cd.outlet_id = ANY($${params.length}::int[])`);
      }
      conds.push(`(${subConds.join(' OR ')})`);
    } else {
      // No accessible locations → return empty
      res.json([]);
      return;
    }
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT cd.*,
            cd.amount::numeric AS amount,
            o.name  AS outlet_name,
            w.name  AS warehouse_name,
            al.name AS bank_ledger_name
     FROM cash_deposits cd
     LEFT JOIN outlets    o  ON o.id  = cd.outlet_id
     LEFT JOIN warehouses w  ON w.id  = cd.warehouse_id
     LEFT JOIN account_ledgers al ON al.id = cd.destination_bank_ledger_id
     ${where}
     ORDER BY cd.created_at DESC`,
    params
  );

  res.json(rows.map((r: any) => ({
    id: r.id,
    outletId: r.outlet_id,
    outletName: r.outlet_name,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    locationName: r.outlet_name ?? r.warehouse_name ?? "Unknown",
    locationType: r.outlet_id ? "outlet" : "warehouse",
    sourceCashLedgerId: r.source_cash_ledger_id,
    amount: Number(r.amount),
    depositDate: r.deposit_date,
    depositReference: r.deposit_reference,
    destinationBankLedgerId: r.destination_bank_ledger_id,
    bankLedgerName: r.bank_ledger_name ?? null,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    status: r.status,
    transitPaymentId: r.transit_payment_id,
    bankReceiptId: r.bank_receipt_id,
  })));
});

// ── POST /cash-in-outlet/deposits ─────────────────────────────────────────────
router.post("/cash-in-outlet/deposits", requireModuleAction("page:/accounts/cash-in-outlet", "add"), async (req, res): Promise<void> => {
  const { outletId, warehouseId, amount, depositDate, depositReference, destinationBankLedgerId, notes } = req.body as {
    outletId?: number;
    warehouseId?: number;
    amount: number;
    depositDate: string;
    depositReference?: string;
    destinationBankLedgerId?: number;
    notes?: string;
  };

  if (!outletId && !warehouseId) { res.status(400).json({ error: "outletId or warehouseId is required" }); return; }
  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) { res.status(400).json({ error: "amount must be positive" }); return; }
  if (!depositDate) { res.status(400).json({ error: "depositDate is required" }); return; }
  if (!isIsoDate(depositDate)) { res.status(400).json({ error: "depositDate must be a real calendar date in YYYY-MM-DD form" }); return; }

  const isWarehouse = !!warehouseId;
  // Cash cannot be banked out of a retired outlet — its till is frozen along
  // with the rest of the module. Historical deposits stay readable.
  if (!isWarehouse && await outletWritesBlocked(pool)) {
    res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE }); return;
  }
  const locationId  = isWarehouse ? warehouseId! : outletId!;
  const cashCode    = isWarehouse ? `WH-CASH-${locationId}` : `OUTLET-CASH-${locationId}`;
  const locLabel    = isWarehouse ? `warehouse ${locationId}` : `outlet ${locationId}`;
  const depositScope = await getUserDataScope((req as any).employee);
  if (!isLocationInScope(depositScope, isWarehouse ? "warehouse" : "outlet", locationId)) {
    res.status(403).json({ error: "You cannot create a cash deposit for another location." }); return;
  }

  const createdBy = (req as any).employee?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Resolve cash ledger — from the stored column first, code only as a
    // fallback. Mirror locations (a warehouse row twinned with an outlet) share
    // one till and only one of the pair owns the `WH-CASH-<id>` style code, so
    // the old code-only lookup rejected deposits from the other half. The read
    // path resolves the same way: a till you can see must be one you can bank.
    const { rows: [locRow] } = await client.query(
      isWarehouse
        ? `SELECT cash_ledger_id FROM warehouses WHERE id = $1`
        : `SELECT cash_ledger_id FROM outlets WHERE id = $1`,
      [locationId],
    );
    if (!locRow) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: `No such ${isWarehouse ? "warehouse" : "outlet"}: ${locationId}` }); return;
    }
    let cashLedger: { id: number } | null = null;
    if (locRow.cash_ledger_id != null) {
      const { rows } = await client.query(`SELECT id FROM account_ledgers WHERE id = $1`, [Number(locRow.cash_ledger_id)]);
      if (rows[0]) cashLedger = { id: Number(rows[0].id) };
    }
    if (!cashLedger) {
      const { rows } = await client.query(`SELECT id FROM account_ledgers WHERE code = $1`, [cashCode]);
      if (rows[0]) cashLedger = { id: Number(rows[0].id) };
    }
    if (!cashLedger) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Cash ledger not found for this ${isWarehouse ? "warehouse" : "outlet"}` }); return;
    }

    // 2. Check available balance
    const balance = await getLedgerBalance(client, cashLedger.id);
    if (parsedAmount > balance + 0.001) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Deposit amount (₹${parsedAmount}) exceeds available cash balance (₹${balance.toFixed(2)})` }); return;
    }

    // 3. Get STD-CIT ledger
    const { rows: [citLedger] } = await client.query(`SELECT id FROM account_ledgers WHERE code = 'STD-CIT'`);
    if (!citLedger) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Cash in Transit ledger not configured" }); return;
    }

    // 4. Post payment: paid_from=cash, paid_to=STD-CIT
    const payVoucher = await nextVoucherNumber(client, 'payment', depositDate);
    const { rows: [payment] } = await client.query(
      `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration, location_type, location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [payVoucher, depositDate, cashLedger.id, citLedger.id, parsedAmount,
        `Cash deposit to bank — ${depositReference ?? "no ref"}`,
        isWarehouse ? 'warehouse' : 'outlet', locationId]
    );

    // 5. Insert cash_deposit record (outlet_id or warehouse_id, the other stays NULL)
    const { rows: [deposit] } = await client.query(
      `INSERT INTO cash_deposits
         (outlet_id, warehouse_id, source_cash_ledger_id, amount, deposit_date, deposit_reference,
          destination_bank_ledger_id, notes, created_by, transit_payment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        isWarehouse ? null : locationId,
        isWarehouse ? locationId : null,
        cashLedger.id, parsedAmount, depositDate, depositReference ?? null,
        destinationBankLedgerId ?? null, notes ?? null, createdBy, payment.id,
      ]
    );

    await client.query("COMMIT");

    logActivity({
      action: "CREATE", module: "cash_in_outlet", entityType: "cash_deposit", entityId: deposit.id,
      description: `Cash deposit of ₹${parsedAmount} from ${locLabel}`,
      metadata: { after: { outletId, warehouseId, amount: parsedAmount, depositDate } },
    }).catch(() => {});

    res.status(201).json({
      id: deposit.id,
      outletId: deposit.outlet_id,
      warehouseId: deposit.warehouse_id,
      sourceCashLedgerId: deposit.source_cash_ledger_id,
      amount: Number(deposit.amount),
      depositDate: deposit.deposit_date,
      depositReference: deposit.deposit_reference,
      destinationBankLedgerId: deposit.destination_bank_ledger_id,
      notes: deposit.notes,
      createdBy: deposit.created_by,
      createdAt: deposit.created_at,
      status: deposit.status,
      transitPaymentId: deposit.transit_payment_id,
    });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Cash deposit error:", err);
    res.status(500).json({ error: err.message ?? "Failed to create cash deposit" });
  } finally {
    client.release();
  }
});

// ── POST /cash-in-outlet/deposits/:id/reconcile ───────────────────────────────
router.post("/cash-in-outlet/deposits/:id/reconcile", requireModuleAction(["page:/accounts/cash-in-outlet", "page:/accounts/reconciliation"], "edit"), async (req, res): Promise<void> => {
  const depositId = parseInt(req.params.id, 10);
  if (!Number.isFinite(depositId)) { res.status(400).json({ error: "Invalid deposit id" }); return; }

  const { destinationBankLedgerId, bankReference, charges, settlementDate } = req.body as {
    destinationBankLedgerId: number;
    bankReference?: string;
    charges?: number;
    settlementDate: string;
  };

  if (!destinationBankLedgerId) { res.status(400).json({ error: "destinationBankLedgerId is required" }); return; }
  if (!settlementDate) { res.status(400).json({ error: "settlementDate is required" }); return; }
  if (!isIsoDate(settlementDate)) { res.status(400).json({ error: "settlementDate must be a real calendar date in YYYY-MM-DD form" }); return; }

  const parsedCharges = Number(charges ?? 0);
  if (parsedCharges < 0) { res.status(400).json({ error: "charges cannot be negative" }); return; }

  const createdBy = (req as any).employee?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock and fetch deposit
    const { rows: [deposit] } = await client.query(
      `SELECT * FROM cash_deposits WHERE id = $1 FOR UPDATE`,
      [depositId]
    );
    if (!deposit) { await client.query("ROLLBACK"); res.status(404).json({ error: "Deposit not found" }); return; }
    const reconcileScope = await getUserDataScope((req as any).employee);
    const depositType = deposit.warehouse_id != null ? "warehouse" : "outlet";
    const depositLocation = Number(deposit.warehouse_id ?? deposit.outlet_id);
    if (!isLocationInScope(reconcileScope, depositType, depositLocation)) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Deposit not found" }); return;
    }
    if (deposit.status !== "pending_reconciliation") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Deposit is already ${deposit.status}` }); return;
    }

    const depositAmount = Number(deposit.amount);
    const netAmount = depositAmount - parsedCharges;

    if (netAmount <= 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Net amount (₹${netAmount.toFixed(2)}) must be positive` }); return;
    }

    // 2. Verify bank ledger is under STD-BANK
    const { rows: allLedgers } = await client.query(`SELECT id, parent_id, code FROM account_ledgers`);
    const bankRoot = allLedgers.find((l: any) => l.code === "STD-BANK");
    if (!bankRoot) { await client.query("ROLLBACK"); res.status(500).json({ error: "STD-BANK not configured" }); return; }
    const bankIds = new Set<number>([bankRoot.id]);
    for (let i = 0; i < 5; i++) {
      for (const l of allLedgers) {
        if (l.parent_id && bankIds.has(l.parent_id)) bankIds.add(l.id);
      }
    }
    if (!bankIds.has(Number(destinationBankLedgerId))) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Destination ledger must be a bank account" }); return;
    }

    // 3. Get STD-CIT
    const { rows: [citLedger] } = await client.query(`SELECT id FROM account_ledgers WHERE code = 'STD-CIT'`);
    if (!citLedger) { await client.query("ROLLBACK"); res.status(500).json({ error: "Cash in Transit ledger not configured" }); return; }

    // 4. Post receipt: received_from=CIT, received_in=bank, net
    const recVoucher = await nextVoucherNumber(client, 'receipt', settlementDate);
    const { rows: [receipt] } = await client.query(
      `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [recVoucher, settlementDate, citLedger.id, destinationBankLedgerId, netAmount,
        `Cash deposit confirmed — ${bankReference ?? "no ref"}`]
    );

    // 5. If charges, post payment: paid_from=CIT, paid_to=charges ledger
    if (parsedCharges > 0) {
      const { rows: [chargesLedger] } = await client.query(`SELECT id FROM account_ledgers WHERE code = 'STD-PROC-CHG'`);
      if (!chargesLedger) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "Bank & Processor Charges ledger (STD-PROC-CHG) not configured. Cannot post charges." });
        return;
      }
      const payVoucher = await nextVoucherNumber(client, 'payment', settlementDate);
      await client.query(
        `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [payVoucher, settlementDate, citLedger.id, chargesLedger.id, parsedCharges,
          `Bank charges on cash deposit`]
      );
    }

    // 6. Update deposit: set status=reconciled, bank_receipt_id, destination_bank_ledger_id
    await client.query(
      `UPDATE cash_deposits SET status = 'reconciled', bank_receipt_id = $1, destination_bank_ledger_id = $2,
       deposit_reference = COALESCE(deposit_reference, $3)
       WHERE id = $4`,
      [receipt.id, destinationBankLedgerId, bankReference ?? null, depositId]
    );

    await client.query("COMMIT");

    logActivity({
      action: "UPDATE", module: "cash_in_outlet", entityType: "cash_deposit", entityId: depositId,
      description: `Cash deposit #${depositId} reconciled to bank, net ₹${netAmount}`,
      metadata: { after: { destinationBankLedgerId, netAmount, charges: parsedCharges } },
    }).catch(() => {});

    res.json({ success: true, depositId, netAmount, charges: parsedCharges });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Cash deposit reconcile error:", err);
    res.status(500).json({ error: err.message ?? "Failed to reconcile cash deposit" });
  } finally {
    client.release();
  }
});

export default router;
