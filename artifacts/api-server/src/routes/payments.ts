import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";
import { resolveReceiveIntoAccount, postSaleCollectionReceipt, type ReceiveIntoAccount } from "../lib/saleCollection";
import { optionalIsoDate } from "../lib/dateInput";
import { respondIfMonthLocked } from "../lib/periodLock";
import { COLLECTION_METHODS } from "../lib/paymentModes";
import { getUserDataScope, scopeSalesWhere } from "../lib/dataScope";
import { callerLocation } from "../lib/moneyScope";
import { loadPaymentPosition, computePaymentPosition } from "../lib/salePaymentPosition";

const router = Router();

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

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
            rb.settlement_date AS reconciled_on,
            rc.received_in_ledger_id AS received_in_id,
            al.name AS received_in_name
     FROM sale_payments sp
     LEFT JOIN reconciliation_batch_items rbi ON rbi.sale_payment_id = sp.id
     LEFT JOIN reconciliation_batches rb ON rb.id = rbi.batch_id
     LEFT JOIN receipts rc ON rc.id = sp.clearing_receipt_id
     LEFT JOIN account_ledgers al ON al.id = rc.received_in_ledger_id
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
    // Provenance travels with the row: 'counter' legs are till-settled history
    // (no receipt behind them) and clients must not offer receipt-only actions
    // on them.
    source: p.source ?? null,
    clearingReceiptId: p.clearing_receipt_id,
    outletId: p.outlet_id,
    createdBy: p.created_by,
    createdAt: p.created_at,
    batchReference: p.batch_reference ?? null,
    reconciledOn: p.reconciled_on ?? null,
    // The account the money actually landed in (via the receipt). Old rows
    // without a receipt fall back to the method label on the client.
    receivedInLedgerId: p.received_in_id != null ? Number(p.received_in_id) : null,
    receivedInLedgerName: p.received_in_name ?? null,
  })));
});

// ── POST /sales/:id/payments ───────────────────────────────────────────────────
router.post("/sales/:id/payments", requireModuleAction(["page:/sales/pos", "page:/outstanding", "page:/customers"], "add"), async (req, res): Promise<void> => {
  const saleId = parseInt(req.params.id, 10);
  if (!Number.isFinite(saleId)) { res.status(400).json({ error: "Invalid sale id" }); return; }

  const { method: bodyMethod, amount, referenceNumber, notes, paymentDate } = req.body as {
    method?: string;
    amount: number;
    referenceNumber?: string;
    notes?: string;
    paymentDate?: string;
  };
  // Idempotency + overpayment consent (double-click / retry, and paying beyond
  // the balance to land the excess as advance). Read from the raw body.
  const clientRequestId = typeof (req.body as any)?.clientRequestId === "string"
    ? String((req.body as any).clientRequestId).trim() || null
    : null;
  const allowOverpayment = (req.body as any)?.allowOverpayment === true;
  // Modern path: the caller names the ACTUAL Cash & Bank account the money
  // went into, and the method is derived from that account's type. The legacy
  // method-only path stays for older clients and the importer.
  const receivedInLedgerId = Number((req.body as any)?.receivedInLedgerId) || null;

  let method = String(bodyMethod ?? "");
  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) { res.status(400).json({ error: "amount must be positive" }); return; }

  if (!receivedInLedgerId) {
    if (!method) { res.status(400).json({ error: "method is required" }); return; }
    const validMethods: readonly string[] = COLLECTION_METHODS;
    if (!validMethods.includes(method)) {
      res.status(400).json({ error: `method must be one of: ${validMethods.join(", ")}` }); return;
    }
  }

  // payment_date is a real DATE column: blank falls back to today, malformed is
  // a 400 rather than a 22007 from the driver mid-transaction.
  const pDateInput = optionalIsoDate(paymentDate);
  if (!pDateInput.ok) { res.status(400).json({ error: "paymentDate must be a real calendar date in YYYY-MM-DD form" }); return; }
  const pDate = pDateInput.value ?? new Date().toISOString().split("T")[0];
  const createdBy = (req as any).employee?.username ?? "system";

  // Month lock: a collection is a new record dated pDate — it may not be
  // backdated into a locked month. (Collecting TODAY against an old credit
  // sale stays allowed: the sale document itself is not being changed.)
  if (await respondIfMonthLocked(res, pool, [pDate], "sale payment")) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock and fetch sale (include location columns added by Task #33)
    const { rows: [sale] } = await client.query(
      `SELECT id, outlet_id, location_type, location_id, cancelled_at, customer_id,
              total_amount::numeric AS total_amount,
              amount_paid::numeric AS amount_paid, payment_status
       FROM sales WHERE id = $1 FOR UPDATE`,
      [saleId]
    );
    if (!sale) { await client.query("ROLLBACK"); res.status(404).json({ error: "Sale not found" }); return; }

    // The collection belongs to the location that made the sale — stamped on
    // the receipt so the location's own money book stays complete.
    const locType = sale.location_type ?? 'outlet';
    const locId   = Number(sale.location_id ?? sale.outlet_id);

    // A branch may only take money for its own sales. The posting below moves
    // cash through the *sale's* ledgers, so without this a warehouse user could
    // collect into another location's till just by using its sale id. Head
    // Office stays unrestricted; this is the narrow money scope on purpose —
    // seeing an outlet's invoice does not mean holding its cash box.
    // This gate runs FIRST — before the cancellation and overpayment checks —
    // so an out-of-scope caller learns nothing about the sale's state: the
    // overpayment message quotes the balance due, which is exactly the figure
    // a foreign branch must not be able to probe for.
    const caller = callerLocation((req as any).employee);
    if (caller.locationType !== 'headoffice' &&
        (locType !== caller.locationType || locId !== caller.locationId)) {
      await client.query("ROLLBACK");
      res.status(403).json({
        error: "This sale was made at another location. Collections are recorded by the location that made the sale.",
      });
      return;
    }

    // ── Idempotency (double-click / network retry) ────────────────────────
    // A replay of the same clientRequestId must return the ORIGINAL collection
    // (200, idempotentReplay) — never post a second receipt or double the paid
    // figure. Deliberately AFTER the scope gate: the replay echoes the prior
    // payment row (amount, date, reference), which an out-of-scope caller must
    // not be able to fish for — a clientRequestId is client-generated data,
    // not an authorization credential. It sits BEFORE the cancellation check
    // so a legitimate retry keeps its idempotent answer even if the sale's
    // state moved between the original call and the retry.
    if (clientRequestId) {
      const { rows: [prior] } = await client.query(
        `SELECT * FROM sale_payments WHERE sale_id = $1 AND client_request_id = $2 LIMIT 1`,
        [saleId, clientRequestId],
      );
      if (prior) {
        await client.query("ROLLBACK");
        res.status(200).json({
          id: prior.id,
          saleId: prior.sale_id,
          paymentDate: prior.payment_date,
          method: prior.method,
          amount: Number(prior.amount),
          referenceNumber: prior.reference_number,
          notes: prior.notes,
          reconciliationStatus: prior.reconciliation_status,
          outletId: prior.outlet_id,
          createdBy: prior.created_by,
          createdAt: prior.created_at,
          idempotentReplay: true,
        });
        return;
      }
    }

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

    // ── Overpayment gate ──────────────────────────────────────────────────
    // Paying beyond the balance is refused by default with a machine-readable
    // code, so the client can offer the "hold the excess as advance" choice.
    // Consent (`allowOverpayment`) is honoured ONLY for a registered customer:
    // the excess lands as a credit (advance) on their CUST- ledger, which
    // emerges naturally as the credit remainder of this payment leg over the
    // invoice debit in the derived books. A walk-in sale has no ledger to hold
    // the credit, so overpaying it is unrepresentable — refused even WITH
    // consent.
    if (parsedAmount > balanceDue + 0.001) {
      const excess = round2(parsedAmount - balanceDue);
      const overpaymentAllowed = sale.customer_id != null;
      if (!allowOverpayment || !overpaymentAllowed) {
        await client.query("ROLLBACK");
        res.status(400).json({
          error: overpaymentAllowed
            ? `Amount (₹${parsedAmount.toFixed(2)}) exceeds the balance due (₹${balanceDue.toFixed(2)}) by ₹${excess.toFixed(2)}. Confirm to hold the excess as customer advance.`
            : `Amount (₹${parsedAmount.toFixed(2)}) exceeds the balance due (₹${balanceDue.toFixed(2)}). A walk-in sale cannot hold the excess as advance — collect only what is owed.`,
          code: "EXCEEDS_OUTSTANDING",
          excess,
          balanceDue,
          overpaymentAllowed,
        });
        return;
      }
      // Consented + registered: the full amount is recorded; the excess becomes
      // usable advance. Fall through — nothing else is capped.
    }

    let clearingReceiptId: number | null = null;
    let reconciliationStatus: string | null = null;

    // ── Explicit destination account (modern path) ───────────────────────
    // The picked ledger must be a live Cash & Bank account OF THE SALE'S
    // location — money collected for a Ragiguda invoice lands in a Ragiguda
    // account, never another branch's. The method is derived from the
    // account's own type, so the books and reports keep their cash/bank/UPI
    // classification without the client naming it. Shared with creation-time
    // payments on POST /sales — ONE engine (see lib/saleCollection).
    let override: ReceiveIntoAccount | null = null;
    if (receivedInLedgerId) {
      const resolved = await resolveReceiveIntoAccount(client, locType, locId, receivedInLedgerId);
      if ("error" in resolved) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: resolved.error });
        return;
      }
      override = resolved;
      method = resolved.method;
    }

    // 2. Duplicate-submission guard: same sale+method+amount within 10 seconds.
    // When the caller picked an explicit destination, the destination is part
    // of the identity — a split collection legitimately posts ₹500 to Bank A
    // and ₹500 to Bank B seconds apart, and only a repeat into the SAME
    // account is a double-submit. Legacy method-only bodies keep the old,
    // stricter identity (they carry no destination to compare).
    const { rows: dupes } = await client.query(
      `SELECT sp.id FROM sale_payments sp
       LEFT JOIN receipts r ON r.id = sp.clearing_receipt_id
       WHERE sp.sale_id = $1 AND sp.method = $2 AND sp.amount = $3
         AND sp.created_at > now() - interval '10 seconds'
         AND ($4::int IS NULL OR r.received_in_ledger_id = $4)`,
      [saleId, method, parsedAmount, override?.ledgerId ?? null]
    );
    if (dupes.length > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Duplicate payment submission detected. Please wait a moment and try again." });
      return;
    }

    // 3. Post the receipt through the shared collection engine — the same
    // routine POST /sales uses for creation-time payments, so cash-till
    // resolution, direct-post vs clearing, and reconciliation status can
    // never drift between the two entry points.
    const { rows: [invRow] } = await client.query(`SELECT invoice_number FROM sales WHERE id=$1`, [saleId]);
    const posted = await postSaleCollectionReceipt(client, {
      method,
      account: override,
      locType,
      locId,
      amount: parsedAmount,
      pDate,
      invoiceNumber: invRow?.invoice_number ?? String(saleId),
      referenceNumber: referenceNumber ?? null,
    });
    if ("error" in posted) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: posted.error });
      return;
    }
    clearingReceiptId = posted.clearingReceiptId;
    reconciliationStatus = posted.reconciliationStatus;

    // 4. Insert sale_payment record
    const { rows: [salePayment] } = await client.query(
      `INSERT INTO sale_payments (sale_id, payment_date, method, amount, reference_number, notes, reconciliation_status, clearing_receipt_id, outlet_id, created_by, client_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [saleId, pDate, method, parsedAmount, referenceNumber ?? null, notes ?? null,
        reconciliationStatus, clearingReceiptId, sale.outlet_id, createdBy, clientRequestId]
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
