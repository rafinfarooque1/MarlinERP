import { Router } from "express";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";

const router = Router();

// ── Helper: compute running balance for a ledger from receipts/payments ───────
async function getLedgerBalance(client: any, ledgerId: number): Promise<number> {
  const { rows: recRows } = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN received_in_ledger_id = $1 THEN amount::numeric ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN received_from_ledger_id = $1 THEN amount::numeric ELSE 0 END), 0) AS balance
     FROM receipts WHERE received_in_ledger_id = $1 OR received_from_ledger_id = $1`,
    [ledgerId]
  );
  const { rows: payRows } = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN paid_to_ledger_id = $1 THEN amount::numeric ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN paid_from_ledger_id = $1 THEN amount::numeric ELSE 0 END), 0) AS balance
     FROM payments WHERE paid_to_ledger_id = $1 OR paid_from_ledger_id = $1`,
    [ledgerId]
  );
  return Number(recRows[0]?.balance ?? 0) + Number(payRows[0]?.balance ?? 0);
}

// ── GET /cash-in-outlet ───────────────────────────────────────────────────────
// Returns cash balances for ALL locations (outlets + warehouses).
// Each entry includes locationType/locationId/locationName for display,
// plus legacy outletId/outletName (null for warehouses) for deposit compat.
router.get("/cash-in-outlet", async (_req, res): Promise<void> => {
  const result: any[] = [];

  // ── Outlets ────────────────────────────────────────────────────────────────
  const { rows: outlets } = await pool.query(
    `SELECT id, name FROM outlets ORDER BY name`
  );
  for (const outlet of outlets) {
    const cashCode = `OUTLET-CASH-${outlet.id}`;
    const { rows: [ledger] } = await pool.query(
      `SELECT id FROM account_ledgers WHERE code = $1`, [cashCode]
    );
    if (!ledger) {
      result.push({ locationType: 'outlet', locationId: outlet.id, locationName: outlet.name, outletId: outlet.id, outletName: outlet.name, cashLedgerId: null, cashBalance: 0, pendingDeposits: 0, availableBalance: 0 });
      continue;
    }
    const balance = await getLedgerBalance(pool, ledger.id);
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
      cashLedgerId: ledger.id,
      cashBalance: Math.round(balance * 100) / 100,
      pendingDeposits: Math.round(pendingDeposits * 100) / 100,
      availableBalance: Math.round(Math.max(0, balance) * 100) / 100,
    });
  }

  // ── Warehouses ─────────────────────────────────────────────────────────────
  const { rows: warehouses } = await pool.query(
    `SELECT id, name FROM warehouses ORDER BY name`
  );
  for (const wh of warehouses) {
    const cashCode = `WH-CASH-${wh.id}`;
    const { rows: [ledger] } = await pool.query(
      `SELECT id FROM account_ledgers WHERE code = $1`, [cashCode]
    );
    if (!ledger) {
      result.push({ locationType: 'warehouse', locationId: wh.id, locationName: wh.name, outletId: null, outletName: null, cashLedgerId: null, cashBalance: 0, pendingDeposits: 0, availableBalance: 0 });
      continue;
    }
    const balance = await getLedgerBalance(pool, ledger.id);
    result.push({
      locationType: 'warehouse',
      locationId: wh.id,
      locationName: wh.name,
      outletId: null,
      outletName: null,
      cashLedgerId: ledger.id,
      cashBalance: Math.round(balance * 100) / 100,
      pendingDeposits: 0,
      availableBalance: Math.round(Math.max(0, balance) * 100) / 100,
    });
  }

  res.json(result);
});

// ── GET /cash-in-outlet/deposits ──────────────────────────────────────────────
router.get("/cash-in-outlet/deposits", async (req, res): Promise<void> => {
  const { status, outletId } = req.query as Record<string, string | undefined>;

  const params: any[] = [];
  const conds: string[] = [];

  if (status) { params.push(status); conds.push(`cd.status = $${params.length}`); }
  if (outletId) { params.push(Number(outletId)); conds.push(`cd.outlet_id = $${params.length}`); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT cd.*,
            cd.amount::numeric AS amount,
            o.name AS outlet_name,
            al.name AS bank_ledger_name
     FROM cash_deposits cd
     JOIN outlets o ON o.id = cd.outlet_id
     LEFT JOIN account_ledgers al ON al.id = cd.destination_bank_ledger_id
     ${where}
     ORDER BY cd.created_at DESC`,
    params
  );

  res.json(rows.map((r: any) => ({
    id: r.id,
    outletId: r.outlet_id,
    outletName: r.outlet_name,
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
router.post("/cash-in-outlet/deposits", async (req, res): Promise<void> => {
  const { outletId, amount, depositDate, depositReference, destinationBankLedgerId, notes } = req.body as {
    outletId: number;
    amount: number;
    depositDate: string;
    depositReference?: string;
    destinationBankLedgerId?: number;
    notes?: string;
  };

  if (!outletId) { res.status(400).json({ error: "outletId is required" }); return; }
  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) { res.status(400).json({ error: "amount must be positive" }); return; }
  if (!depositDate) { res.status(400).json({ error: "depositDate is required" }); return; }

  const createdBy = (req as any).user?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Get outlet cash ledger
    const cashCode = `OUTLET-CASH-${outletId}`;
    const { rows: [cashLedger] } = await client.query(
      `SELECT id FROM account_ledgers WHERE code = $1`,
      [cashCode]
    );
    if (!cashLedger) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Cash ledger not found for this outlet" }); return;
    }

    // 2. Check available balance
    // The ledger balance already reflects prior deposits (each deposit posts a payment
    // from outlet cash to STD-CIT, immediately reducing the outlet ledger balance).
    // Subtracting pendingDeposits again would double-count.
    const balance = await getLedgerBalance(client, cashLedger.id);

    if (parsedAmount > balance + 0.001) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Deposit amount (₹${parsedAmount}) exceeds available cash balance (₹${balance.toFixed(2)})` }); return;
    }

    // 3. Get STD-CIT ledger
    const { rows: [citLedger] } = await client.query(
      `SELECT id FROM account_ledgers WHERE code = 'STD-CIT'`
    );
    if (!citLedger) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Cash in Transit ledger not configured" }); return;
    }

    // 4. Post payment: paid_from=outlet_cash, paid_to=STD-CIT
    const { rows: [cntRow] } = await client.query(`SELECT COUNT(*) FROM payments`);
    const payVoucher = `PAY-${String(Number(cntRow.count) + 1).padStart(4, "0")}`;
    const { rows: [payment] } = await client.query(
      `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [payVoucher, depositDate, cashLedger.id, citLedger.id, parsedAmount,
        `Cash deposit to bank — ${depositReference ?? "no ref"}`]
    );

    // 5. Insert cash_deposit record
    const { rows: [deposit] } = await client.query(
      `INSERT INTO cash_deposits (outlet_id, source_cash_ledger_id, amount, deposit_date, deposit_reference, destination_bank_ledger_id, notes, created_by, transit_payment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [outletId, cashLedger.id, parsedAmount, depositDate, depositReference ?? null,
        destinationBankLedgerId ?? null, notes ?? null, createdBy, payment.id]
    );

    await client.query("COMMIT");

    logActivity({
      action: "CREATE", module: "cash_in_outlet", entityType: "cash_deposit", entityId: deposit.id,
      description: `Cash deposit of ₹${parsedAmount} from outlet ${outletId}`,
      metadata: { after: { outletId, amount: parsedAmount, depositDate } },
    }).catch(() => {});

    res.status(201).json({
      id: deposit.id,
      outletId: deposit.outlet_id,
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
router.post("/cash-in-outlet/deposits/:id/reconcile", async (req, res): Promise<void> => {
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

  const parsedCharges = Number(charges ?? 0);
  if (parsedCharges < 0) { res.status(400).json({ error: "charges cannot be negative" }); return; }

  const createdBy = (req as any).user?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock and fetch deposit
    const { rows: [deposit] } = await client.query(
      `SELECT * FROM cash_deposits WHERE id = $1 FOR UPDATE`,
      [depositId]
    );
    if (!deposit) { await client.query("ROLLBACK"); res.status(404).json({ error: "Deposit not found" }); return; }
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
    const { rows: [cntRecRow] } = await client.query(`SELECT COUNT(*) FROM receipts`);
    const recVoucher = `REC-${String(Number(cntRecRow.count) + 1).padStart(4, "0")}`;
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
      const { rows: [cntPayRow] } = await client.query(`SELECT COUNT(*) FROM payments`);
      const payVoucher = `PAY-${String(Number(cntPayRow.count) + 1).padStart(4, "0")}`;
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
