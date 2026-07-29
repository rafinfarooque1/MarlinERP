import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { COLLECTION_METHODS, paymentModeLabel } from "../lib/paymentModes";
import { getUserDataScope, scopeSalesWhere } from "../lib/dataScope";
import { callerLocation } from "../lib/moneyScope";
import { loadPaymentPosition, computePaymentPosition } from "../lib/salePaymentPosition";

const router = Router();

// ── Helper: get-or-assert outlet cash ledger (created at startup) ─────────────
async function getOutletCashLedgerId(outletId: number): Promise<number | null> {
  const code = `OUTLET-CASH-${outletId}`;
  const { rows } = await pool.query(
    `SELECT id FROM account_ledgers WHERE code = $1`,
    [code]
  );
  return rows[0]?.id ?? null;
}

// ── GET /sales/:id/payments ────────────────────────────────────────────────────
// Serves HO Sales and Payments pages (both under POS).
router.get("/sales/:id/payments", requireModuleView("page:/sales/pos"), async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  if (!Number.isFinite(saleId)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  // A sale's collection history is part of the sale, so it follows the Sales
  // module's read rule (a warehouse also sees the outlets it supplies) — not the
  // narrower money scope that governs who may take the money.
  const readScope = await getUserDataScope((req as any).employee);
  const readParams: unknown[] = [saleId];
  const { rows: [visibleSale] } = await pool.query(
    `SELECT s.id FROM sales s WHERE s.id = $1 AND ${scopeSalesWhere(readScope, readParams)}`,
    readParams
  );
  if (!visibleSale) { res.status(404).json({ error: "Sale not found" }); return; }

  const { rows: payments } = await pool.query(
    `SELECT sp.*,
            rb.batch_reference,
            rb.settlement_date AS reconciled_on
     FROM sale_payments sp
     LEFT JOIN reconciliation_batch_items rbi ON rbi.sale_payment_id = sp.id
     LEFT JOIN reconciliation_batches rb ON rb.id = rbi.batch_id
     WHERE sp.sale_id = $1
     ORDER BY sp.created_at ASC`,
    [saleId]
  );

  res.json(payments.map((p: any) => ({
    id: p.id,
    saleId: p.sale_id,
    paymentDate: p.payment_date,
    method: p.method,
    amount: Number(p.amount),
    referenceNumber: p.reference_number,
    notes: p.notes,
    reconciliationStatus: p.reconciliation_status,
    clearingReceiptId: p.clearing_receipt_id,
    outletId: p.outlet_id,
    createdBy: p.created_by,
    createdAt: p.created_at,
    batchReference: p.batch_reference ?? null,
    reconciledOn: p.reconciled_on ?? null,
  })));
});

// ── POST /sales/:id/payments ───────────────────────────────────────────────────
router.post("/sales/:id/payments", requireModuleAction(["page:/sales/pos", "page:/outstanding"], "add"), async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  if (!Number.isFinite(saleId)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  const { method, amount, referenceNumber, notes, paymentDate } = req.body as {
    method: string;
    amount: number;
    referenceNumber?: string;
    notes?: string;
    paymentDate?: string;
  };

  // Basic validation
  if (!method) { res.status(400).json({ error: "method is required" }); return; }
  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) { res.status(400).json({ error: "amount must be positive" }); return; }

  const validMethods: readonly string[] = COLLECTION_METHODS;
  if (!validMethods.includes(method)) {
    res.status(400).json({ error: `method must be one of: ${validMethods.join(", ")}` }); return;
  }

  const isElectronic = method !== "cash";
  if (isElectronic && !referenceNumber?.trim()) {
    // Allow electronic without reference — it's useful but not mandatory
  }

  const pDate = paymentDate || new Date().toISOString().split("T")[0];
  const createdBy = (req as any).user?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock and fetch sale (include location columns added by Task #33)
    const { rows: [sale] } = await client.query(
      `SELECT id, outlet_id, location_type, location_id, cancelled_at,
              total_amount::numeric AS total_amount,
              amount_paid::numeric AS amount_paid, payment_status
       FROM sales WHERE id = $1 FOR UPDATE`,
      [saleId]
    );
    if (!sale) { await client.query("ROLLBACK"); res.status(404).json({ error: "Sale not found" }); return; }

    // Cancellation already restored the stock, reversed the customer balance and
    // removed the receipt. Collecting against it afterwards would put the cash
    // and the receivable back on a bill that no longer exists.
    if (sale.cancelled_at) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This invoice has been cancelled — no further payment can be recorded against it.", code: "SALE_CANCELLED" });
      return;
    }

    const totalAmount = Number(sale.total_amount);
    const currentPaid = Number(sale.amount_paid);

    // The cap has to be the EFFECTIVE balance. A credit note reduces what the
    // customer owes, so capping at total-minus-paid would accept a collection
    // larger than the debt and leave an advance nobody asked for. Read on the
    // locked row, inside this transaction, so it is the figure being written
    // against — not one another connection is about to move.
    const position = await loadPaymentPosition(client, saleId);
    if (!position) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Sale not found" });
      return;
    }
    const balanceDue = position.outstanding;

    if (parsedAmount > balanceDue + 0.001) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Amount (₹${parsedAmount}) exceeds balance due (₹${balanceDue.toFixed(2)})` });
      return;
    }

    // 2. Duplicate-submission guard: same sale+method+amount within 10 seconds
    const { rows: dupes } = await client.query(
      `SELECT id FROM sale_payments
       WHERE sale_id = $1 AND method = $2 AND amount = $3
         AND created_at > now() - interval '10 seconds'`,
      [saleId, method, parsedAmount]
    );
    if (dupes.length > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Duplicate payment submission detected. Please wait a moment and try again." });
      return;
    }

    let clearingReceiptId: number | null = null;
    let reconciliationStatus: string | null = null;

    // The collection belongs to the location that made the sale — stamped on
    // the receipt so the location's own money book stays complete.
    const locType = sale.location_type ?? 'outlet';
    const locId   = Number(sale.location_id ?? sale.outlet_id);

    // A branch may only take money for its own sales. The posting below moves
    // cash through the *sale's* ledgers, so without this a warehouse user could
    // collect into another location's till just by using its sale id. Head
    // Office stays unrestricted; this is the narrow money scope on purpose —
    // seeing an outlet's invoice does not mean holding its cash box.
    const caller = callerLocation((req as any).employee);
    if (caller.locationType !== 'headoffice' &&
        (locType !== caller.locationType || locId !== caller.locationId)) {
      await client.query("ROLLBACK");
      res.status(403).json({
        error: "This sale was made at another location. Collections are recorded by the location that made the sale.",
      });
      return;
    }

    if (!isElectronic) {
      // ── CASH PAYMENT ────────────────────────────────────────────────────
      // Resolve cash ledger based on location type (warehouse or outlet)
      const cashLedgerCode = locType === 'warehouse'
        ? `WH-CASH-${locId}`
        : `OUTLET-CASH-${locId}`;
      // The location's own cash_ledger_id is authoritative; the code convention
      // is only a fallback. Mirror locations (a warehouse row twinned with an
      // outlet) share one till, and that ledger's code can only name one of the
      // pair — so a code-only lookup made cash collection impossible at the
      // other half. Same resolution order as the cash-in-outlet read path: a
      // till you can see is a till you can collect into.
      const { rows: [locRow] } = await client.query(
        locType === 'warehouse'
          ? `SELECT cash_ledger_id FROM warehouses WHERE id = $1`
          : `SELECT cash_ledger_id FROM outlets WHERE id = $1`,
        [locId],
      );
      let cashLedger: { id: number } | null = null;
      if (locRow?.cash_ledger_id != null) {
        const { rows } = await client.query(
          `SELECT id FROM account_ledgers WHERE id = $1`, [Number(locRow.cash_ledger_id)],
        );
        if (rows[0]) cashLedger = { id: Number(rows[0].id) };
      }
      if (!cashLedger) {
        const { rows } = await client.query(
          `SELECT id FROM account_ledgers WHERE code = $1`, [cashLedgerCode],
        );
        if (rows[0]) cashLedger = { id: Number(rows[0].id) };
      }
      if (!cashLedger) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: `Cash ledger (${cashLedgerCode}) not found for this location. Go to Accounts → Warehouses/Outlets and provision ledgers first.` });
        return;
      }

      // Get STD-SALES ledger for the "received from" counterpart
      const { rows: [salesLedger] } = await client.query(
        `SELECT id FROM account_ledgers WHERE code = 'STD-SALES'`
      );
      if (!salesLedger) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "Sales ledger not configured." });
        return;
      }

      const voucherNum = await nextVoucherNumber(client, "receipt", pDate);
      const { rows: [receipt] } = await client.query(
        `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, location_type, location_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [voucherNum, pDate, salesLedger.id, cashLedger.id, parsedAmount,
          `Cash payment for invoice ${(await client.query(`SELECT invoice_number FROM sales WHERE id=$1`,[saleId])).rows[0]?.invoice_number ?? saleId}`,
          locType, locId]
      );
      clearingReceiptId = receipt.id;
      reconciliationStatus = null; // cash — no reconciliation needed

    } else {
      // ── ELECTRONIC PAYMENT ──────────────────────────────────────────────
      // Get STD-ELEC-CLR ledger
      const { rows: [clearingLedger] } = await client.query(
        `SELECT id FROM account_ledgers WHERE code = 'STD-ELEC-CLR'`
      );
      if (!clearingLedger) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "Electronic payment clearing ledger not configured." });
        return;
      }

      const { rows: [salesLedger] } = await client.query(
        `SELECT id FROM account_ledgers WHERE code = 'STD-SALES'`
      );
      if (!salesLedger) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "Sales ledger not configured." });
        return;
      }

      const voucherNum = await nextVoucherNumber(client, "receipt", pDate);
      const { rows: [invRow] } = await client.query(`SELECT invoice_number FROM sales WHERE id=$1`, [saleId]);
      const { rows: [receipt] } = await client.query(
        `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, location_type, location_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [voucherNum, pDate, salesLedger.id, clearingLedger.id, parsedAmount,
          `${paymentModeLabel(method)} payment for invoice ${invRow?.invoice_number ?? saleId}${referenceNumber ? ` — Ref: ${referenceNumber}` : ""}`,
          locType, locId]
      );
      clearingReceiptId = receipt.id;
      reconciliationStatus = "pending";
    }

    // 4. Insert sale_payment record
    const { rows: [salePayment] } = await client.query(
      `INSERT INTO sale_payments (sale_id, payment_date, method, amount, reference_number, notes, reconciliation_status, clearing_receipt_id, outlet_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [saleId, pDate, method, parsedAmount, referenceNumber ?? null, notes ?? null,
        reconciliationStatus, clearingReceiptId, sale.outlet_id, createdBy]
    );

    // 5. Update sales.amount_paid and sales.payment_status
    const newAmountPaid = currentPaid + parsedAmount;
    // Derived the same way every read surface derives it, credit notes included,
    // so the stored aggregate cannot drift from what the invoice shows.
    const newPosition = computePaymentPosition({
      totalAmount, amountReceived: newAmountPaid,
      creditAdjustments: position.creditAdjustments, cancelledAt: null,
    });
    const newStatus = newPosition.status;
    await client.query(
      `UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3`,
      [newAmountPaid, newStatus, saleId]
    );

    await client.query("COMMIT");

    logActivity({
      action: "CREATE", module: "payments", entityType: "sale_payment", entityId: salePayment.id,
      description: `Payment of ₹${parsedAmount} via ${method} for sale #${saleId}`,
      metadata: { after: { saleId, method, amount: parsedAmount, reconciliationStatus } },
    }).catch(() => {});

    res.status(201).json({
      id: salePayment.id,
      saleId: salePayment.sale_id,
      paymentDate: salePayment.payment_date,
      method: salePayment.method,
      amount: Number(salePayment.amount),
      referenceNumber: salePayment.reference_number,
      notes: salePayment.notes,
      reconciliationStatus: salePayment.reconciliation_status,
      outletId: salePayment.outlet_id,
      createdBy: salePayment.created_by,
      createdAt: salePayment.created_at,
      newPaymentStatus: newStatus,
      newAmountPaid,
      // Hand back the position just computed, so no caller has to recompute a
      // balance of its own (which would silently drop credit notes).
      newBalanceDue: newPosition.outstanding,
      newCreditAdjustments: newPosition.creditAdjustments,
    });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Payment posting error:", err);
    res.status(500).json({ error: err.message ?? "Failed to record payment" });
  } finally {
    client.release();
  }
});

export default router;
