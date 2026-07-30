// ── Returns, Credit Notes/Debit Notes & Outstanding (Phase 4) ────────────────
// Sales returns: restore stock (entries + batch layer) at the sale's location,
// reverse GST proportionally, and post money as either a Credit Note JV on the
// customer ledger (registered customers) or a cash refund payment row (walk-in).
// Purchase returns: decrement stock and post a Debit Note JV on the vendor
// ledger. Both notes flow into the books via buildDerivedPostings (JV lines /
// payments are derived as stored), so no extra derivation is needed here.
// The sales_returns / purchase_returns tables are memo documents only — they
// are intentionally NOT derived into postings (double-count trap).

import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { restoreBatches, consumeBatches, debitBatchByNumber, type BatchBreakdownEntry } from "../lib/batches";
import { logActivity } from "../lib/audit";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE, OUTLETS_DISABLED_CODE } from "../lib/featureFlags";
import { writeStockLedger, batchResolveMeta } from "../lib/stockLedger";
import { outstandingExpr, creditAdjustmentsExpr, computePaymentPosition } from "../lib/salePaymentPosition";
import { deductMaterialAt, isMaterialKind } from "../lib/materialStock";
import { availabilityAt, insufficientStockMessage } from "../lib/reservations";
import { isIsoDate } from "../lib/dateInput";

const router: IRouter = Router();

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
// Shape AND calendar validity (rejects 2026-02-30) — these values reach real
// DATE columns, where an impossible date raises 22007 instead of storing text.
const isDateStr = (s: unknown): s is string => isIsoDate(s);
const DAY_MS = 24 * 60 * 60 * 1000;

type Q = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

/** Normalize a pg `date` value (JS Date or string) to YYYY-MM-DD for safe comparison. */
function dateOnly(d: unknown): string {
  if (d instanceof Date) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
  return String(d ?? "").slice(0, 10);
}

async function ledgerIdByCode(c: Q, code: string): Promise<number | null> {
  const { rows: [r] } = await c.query(`SELECT id FROM account_ledgers WHERE code = $1`, [code]);
  return r?.id ?? null;
}

/** Resolve GST head ledgers; amounts that can't find their ledger are returned
 *  as `unresolved` so the caller can fold them into the sales/purchase line
 *  (books always balance even if a std head ledger was deleted). */
async function resolveGstHeads(c: Q, side: "output" | "input", cgst: number, sgst: number, igst: number): Promise<{
  headLines: Array<{ ledgerId: number; amount: number }>;
  unresolved: number;
}> {
  const prefix = side === "output" ? "STD-OUT" : "STD-INP";
  const headLines: Array<{ ledgerId: number; amount: number }> = [];
  let unresolved = 0;
  for (const [suffix, amt] of [["CGST", cgst], ["SGST", sgst], ["IGST", igst]] as const) {
    if (!(amt > 0.004)) continue;
    const lid = await ledgerIdByCode(c, `${prefix}-${suffix}`);
    if (lid) headLines.push({ ledgerId: lid, amount: r2(amt) });
    else unresolved = r2(unresolved + amt);
  }
  return { headLines, unresolved };
}

/** Location ledgers (cash + sales) with STD fallbacks, mirroring buildDerivedPostings. */
async function locationLedgers(c: Q, locationType: string, locationId: number): Promise<{
  cashLedgerId: number | null; salesLedgerId: number | null; locationName: string;
}> {
  const table = locationType === "warehouse" ? "warehouses" : "outlets";
  const { rows: [loc] } = await c.query(
    `SELECT name, cash_ledger_id, sales_ledger_id FROM ${table} WHERE id = $1`, [locationId]
  );
  return {
    cashLedgerId: loc?.cash_ledger_id ?? null,
    salesLedgerId: loc?.sales_ledger_id ?? null,
    locationName: loc?.name ?? "",
  };
}

async function insertVoucher(c: Q, args: {
  voucherType: string; voucherNumber: string; voucherDate: string; narration: string;
  partyLedgerId: number | null; reason: string | null; totalAmount: number; createdBy: string | null;
  lines: Array<{ ledgerId: number; debit: number; credit: number }>;
}): Promise<number> {
  const { rows: [v] } = await c.query(
    `INSERT INTO journal_vouchers (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, reason, total_amount, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [args.voucherType, args.voucherNumber, args.voucherDate, args.narration,
     args.partyLedgerId, args.reason, args.totalAmount, args.createdBy]
  );
  for (const l of args.lines) {
    if (!(l.debit > 0.004) && !(l.credit > 0.004)) continue;
    await c.query(
      `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1, $2, $3, $4)`,
      [v.id, l.ledgerId, r2(l.debit), r2(l.credit)]
    );
  }
  return v.id;
}

const userOf = (req: Request): string | null =>
  (req as any).employee?.username ?? null;

// ═════════════════════════════════════════════════════════════════════════════
// Sales returns
// ═════════════════════════════════════════════════════════════════════════════

// POST /sales-returns — body: { saleId, returnDate, reason?, lines: [{ lineIndex, quantity }] }
router.post("/sales-returns", requireModuleAction(["page:/returns", "page:/sales/pos"], "add"), async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const saleId = Number(body.saleId);
  const returnDate = body.returnDate;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  const reqLines = Array.isArray(body.lines) ? body.lines : [];

  if (!Number.isInteger(saleId) || saleId <= 0) { res.status(400).json({ error: "saleId is required" }); return; }
  if (!isDateStr(returnDate)) { res.status(400).json({ error: "returnDate must be YYYY-MM-DD" }); return; }
  if (reqLines.length === 0) { res.status(400).json({ error: "At least one return line is required" }); return; }
  for (const l of reqLines) {
    if (!Number.isInteger(Number(l?.lineIndex)) || Number(l?.lineIndex) < 0 || !(Number(l?.quantity) > 0)) {
      res.status(400).json({ error: "Each line needs a valid lineIndex and a quantity > 0" }); return;
    }
  }
  // Reject duplicate line indexes (they'd bypass the per-line cap check)
  const idxSeen = new Set<number>();
  for (const l of reqLines) {
    const ix = Number(l.lineIndex);
    if (idxSeen.has(ix)) { res.status(400).json({ error: `Duplicate return line for lineIndex ${ix}` }); return; }
    idxSeen.add(ix);
  }

  const client = await (pool as any).connect();
  try {
    await client.query("BEGIN");

    const { rows: [sale] } = await client.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [saleId]);
    if (!sale) { await client.query("ROLLBACK"); res.status(404).json({ error: "Sale not found" }); return; }
    // Cancelling already put the whole quantity back. Returning against a
    // cancelled bill would restore the same stock twice and raise a credit note
    // for revenue that has already been reversed.
    if (sale.cancelled_at) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This invoice has been cancelled — its stock was already restored, so it cannot be returned against.", code: "SALE_CANCELLED" });
      return;
    }
    if (returnDate < dateOnly(sale.sale_date)) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Return date cannot be before the sale date (${dateOnly(sale.sale_date)})` });
      return;
    }

    const saleLines: any[] = Array.isArray(sale.line_items) ? sale.line_items : [];
    const locationType: string = sale.location_type === "warehouse" ? "warehouse" : "outlet";
    const locationId: number = Number(sale.location_id ?? sale.outlet_id ?? 0);

    // A return against an outlet bill would push stock and a credit note back
    // into a retired outlet. Blocked while the module is off; the original bill
    // and any past returns stay readable.
    if (locationType === "outlet" && await outletWritesBlocked(client)) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: OUTLETS_DISABLED_MESSAGE, code: OUTLETS_DISABLED_CODE });
      return;
    }

    // Aggregate prior returns for this sale: qty per lineIndex + restored per batch
    const { rows: priorRows } = await client.query(
      `SELECT line_items FROM sales_returns WHERE sale_id = $1`, [saleId]
    );
    const priorQty = new Map<number, number>();
    const priorBatch = new Map<string, number>();
    for (const pr of priorRows) {
      for (const pl of (Array.isArray(pr.line_items) ? pr.line_items : [])) {
        const ix = Number(pl.lineIndex);
        priorQty.set(ix, r3((priorQty.get(ix) ?? 0) + Number(pl.quantity || 0)));
        for (const br of (Array.isArray(pl.batchRestore) ? pl.batchRestore : [])) {
          const k = `${ix}:${br.batchNumber}`;
          priorBatch.set(k, r3((priorBatch.get(k) ?? 0) + Number(br.quantity || 0)));
        }
      }
    }

    // Build validated return lines with prorated money + batch restore plans
    const retLines: any[] = [];
    let subtotal = 0, taxTotal = 0, totalAmount = 0;
    let totCgst = 0, totSgst = 0, totIgst = 0;

    for (const rl of reqLines) {
      const ix = Number(rl.lineIndex);
      const rq = r3(Number(rl.quantity));
      const li = saleLines[ix];
      if (!li) { await client.query("ROLLBACK"); res.status(400).json({ error: `Sale has no line at index ${ix}` }); return; }

      const soldQty = Number(li.quantity) || 0;
      const already = priorQty.get(ix) ?? 0;
      const returnable = r3(soldQty - already);
      if (rq > returnable + 0.001) {
        await client.query("ROLLBACK");
        res.status(400).json({
          error: `Cannot return ${rq} of "${li.itemName || `item ${li.itemId}`}" — sold ${soldQty}, already returned ${already}, returnable ${Math.max(0, returnable)}`,
        });
        return;
      }

      // Prorate stored line money by quantity (keeps CN consistent with the
      // original invoice's inclusive-GST math, incl. line discounts).
      const frac = soldQty > 0 ? rq / soldQty : 0;
      const taxable = r2(Number(li.taxableAmount ?? li.lineSubtotal ?? 0) * frac);
      const cgst = r2(Number(li.cgst ?? 0) * frac);
      const sgst = r2(Number(li.sgst ?? 0) * frac);
      const igst = r2(Number(li.igst ?? 0) * frac);
      const tax = r2(cgst + sgst + igst);
      const gross = r2(taxable + tax);

      // Batch restore plan: walk the consumed breakdown in reverse (LIFO undo),
      // capped by what previous returns already put back per batch.
      const breakdown: any[] = Array.isArray(li.batchBreakdown) ? li.batchBreakdown : [];
      const alloc: BatchBreakdownEntry[] = [];
      let remaining = rq;
      for (let i = breakdown.length - 1; i >= 0 && remaining > 0.0005; i--) {
        const b = breakdown[i];
        if (!b?.batchNumber) continue;
        const k = `${ix}:${b.batchNumber}`;
        const avail = r3(Number(b.quantity || 0) - (priorBatch.get(k) ?? 0));
        if (avail <= 0.0005) continue;
        const take = r3(Math.min(avail, remaining));
        alloc.push({
          batchNumber: String(b.batchNumber),
          mfgDate: b.mfgDate ?? null,
          expiryDate: b.expiryDate ?? null,
          quantity: take,
          unitCost: Number(b.unitCost || 0),
        });
        priorBatch.set(k, r3((priorBatch.get(k) ?? 0) + take));
        remaining = r3(remaining - take);
      }
      // `remaining` beyond the breakdown = untracked residual (legacy lines) —
      // stock_entries still gets the full qty back below.

      retLines.push({
        lineIndex: ix,
        itemId: Number(li.itemId),
        itemName: li.itemName ?? "",
        unit: li.unit ?? "",
        quantity: rq,
        unitPrice: Number(li.unitPrice ?? 0),
        grossAmount: gross,
        taxableAmount: taxable,
        taxAmount: tax,
        cgst, sgst, igst,
        taxType: li.taxType ?? "cgst_sgst",
        batchRestore: alloc.map(a => ({ batchNumber: a.batchNumber, quantity: a.quantity, unitCost: a.unitCost })),
        _alloc: alloc,
      });

      subtotal = r2(subtotal + taxable);
      taxTotal = r2(taxTotal + tax);
      totalAmount = r2(totalAmount + gross);
      totCgst = r2(totCgst + cgst); totSgst = r2(totSgst + sgst); totIgst = r2(totIgst + igst);
    }

    if (!(totalAmount > 0)) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Return total must be greater than zero" });
      return;
    }

    // ── Restore stock_entries at the sale's location ──────────────────────
    for (const rl of retLines) {
      const { rows: [se] } = await client.query(
        `SELECT id FROM stock_entries
          WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3 FOR UPDATE`,
        [rl.itemId, locationType, locationId]
      );
      if (se) {
        await client.query(
          `UPDATE stock_entries SET quantity = quantity::numeric + $1, updated_at = now() WHERE id = $2`,
          [rl.quantity, se.id]
        );
      } else {
        // Cost for a brand-new entry: weighted batch cost, falling back to item avg cost
        const allocQty = rl._alloc.reduce((s: number, a: BatchBreakdownEntry) => s + a.quantity, 0);
        const allocCost = rl._alloc.reduce((s: number, a: BatchBreakdownEntry) => s + a.quantity * a.unitCost, 0);
        let cost = allocQty > 0 ? r2(allocCost / allocQty) : 0;
        if (!(cost > 0)) {
          const { rows: [it] } = await client.query(
            `SELECT COALESCE(avg_cost, 0) AS avg_cost, COALESCE(cost, 0) AS cost FROM items WHERE id = $1`, [rl.itemId]
          );
          cost = Number(it?.avg_cost) > 0 ? Number(it.avg_cost) : Number(it?.cost ?? 0);
        }
        await client.query(
          `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'item', $2, $3, $4, $5)`,
          [rl.itemId, locationType, locationId, rl.quantity, cost]
        );
      }
    }

    // ── Money: CN for registered customers, cash refund for walk-ins ──────
    const returnNumber = await nextVoucherNumber(client, "sales_return", returnDate);
    const { cashLedgerId, salesLedgerId, locationName } = await locationLedgers(client, locationType, locationId);
    const salesLedger = salesLedgerId ?? await ledgerIdByCode(client, "STD-SALES");
    if (!salesLedger) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Sales ledger not found (STD-SALES missing). Open Chart of Accounts to restore standard ledgers." });
      return;
    }

    const invoiceRef = sale.invoice_number || `Sale #${sale.id}`;
    let creditNoteId: number | null = null;
    let creditNoteNumber: string | null = null;
    let refundPaymentId: number | null = null;
    let refundMode: "credit_note" | "cash" = "credit_note";

    if (sale.customer_id) {
      const custLedger = await ledgerIdByCode(client, `CUST-${sale.customer_id}`);
      if (!custLedger) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Customer ledger not found. Open the customer record and save it once to create the ledger, then retry." });
        return;
      }
      const { headLines, unresolved } = await resolveGstHeads(client, "output", totCgst, totSgst, totIgst);
      const lines = [
        { ledgerId: salesLedger, debit: r2(subtotal + unresolved), credit: 0 },
        ...headLines.map(h => ({ ledgerId: h.ledgerId, debit: h.amount, credit: 0 })),
        { ledgerId: custLedger, debit: 0, credit: totalAmount },
      ];
      creditNoteNumber = await nextVoucherNumber(client, "credit_note", returnDate);
      creditNoteId = await insertVoucher(client, {
        voucherType: "credit_note",
        voucherNumber: creditNoteNumber,
        voucherDate: returnDate,
        narration: `Sales return ${returnNumber} against ${invoiceRef}`,
        partyLedgerId: custLedger,
        reason: reason ?? `Sales return against ${invoiceRef}`,
        totalAmount,
        createdBy: userOf(req),
        lines,
      });
      // Keep the customer's lifetime purchases consistent with sale creation
      await client.query(
        `UPDATE customers SET total_purchases = GREATEST(0, COALESCE(total_purchases, 0)::numeric - $1), updated_at = now() WHERE id = $2`,
        [totalAmount, sale.customer_id]
      );
      refundMode = "credit_note";
    } else {
      // Walk-in: refund cash at the location. Mirrors the sale receipt (full
      // inclusive amount against the location sales ledger) so books reverse
      // exactly what the sale posted.
      if (!cashLedgerId) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Cash ledger not configured for this location — open the outlet/warehouse record and save it once, then retry." });
        return;
      }
      const payNumber = await nextVoucherNumber(client, "payment", returnDate);
      const { rows: [pay] } = await client.query(
        `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount, narration)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [payNumber, returnDate, cashLedgerId, salesLedger, totalAmount,
         `Cash refund ${returnNumber} against ${invoiceRef}${locationName ? ` at ${locationName}` : ""}`]
      );
      refundPaymentId = pay.id;
      refundMode = "cash";
    }

    // ── Persist the return document, then credit the batch layer ──────────
    const lineItemsJson = retLines.map(({ _alloc, ...keep }) => keep);
    const { rows: [ret] } = await client.query(
      `INSERT INTO sales_returns (return_number, sale_id, customer_id, location_type, location_id, return_date,
                                  line_items, subtotal, tax_total, total_amount, refund_mode, credit_note_id, refund_payment_id, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [returnNumber, saleId, sale.customer_id ?? null, locationType, locationId, returnDate,
       JSON.stringify(lineItemsJson), subtotal, taxTotal, totalAmount, refundMode, creditNoteId, refundPaymentId, reason, userOf(req)]
    );

    for (const rl of retLines) {
      if (rl._alloc.length > 0) {
        await restoreBatches(client, rl.itemId, locationType, locationId, rl._alloc, "sales_return", ret.id);
      }
    }

    // Keep the stored status in step with the derived one. Once a credit note is
    // allocated to this invoice the customer may owe nothing further, and a
    // stale 'partially_paid' would leave a settled bill on collection lists.
    if (refundMode === "credit_note") {
      const { rows: [posRow] } = await client.query(
        `SELECT s.total_amount::numeric AS total, COALESCE(s.amount_paid, 0)::numeric AS paid,
                ${creditAdjustmentsExpr("s")} AS credit_notes
           FROM sales s WHERE s.id = $1`,
        [saleId]
      );
      if (posRow) {
        await client.query(`UPDATE sales SET payment_status = $1 WHERE id = $2`, [
          computePaymentPosition({
            totalAmount: posRow.total, amountReceived: posRow.paid,
            creditAdjustments: posRow.credit_notes, cancelledAt: null,
          }).status,
          saleId,
        ]);
      }
    }

    // ── Stock ledger (sales return — fire-and-forget) ─────────────────────────
    ;(async () => {
      const meta = await batchResolveMeta(pool, retLines.map(rl => ({ materialType: 'item', refId: rl.itemId })));
      await writeStockLedger(pool, retLines.map(rl => {
        const info = meta.get(`item:${rl.itemId}`) ?? { name: (rl as any).itemName ?? '', unit: '' };
        return { txnType: 'sales_return', materialType: 'item', refId: rl.itemId, itemName: info.name, unit: info.unit, branchType: locationType, branchId: locationId, branchName: '', qtyChange: Number(rl.quantity), unitCost: 0, docType: 'sales_return', docId: ret.id };
      }));
    })().catch((e: any) => console.error('[stock-ledger] sales return write failed', e));

    await client.query("COMMIT");

    logActivity({
      action: "CREATE", module: "sales", entityType: "sales_return", entityId: ret.id,
      description: `Sales return ${returnNumber} against ${invoiceRef} — ₹${totalAmount.toFixed(2)} (${refundMode === "cash" ? "cash refund" : `credit note ${creditNoteNumber}`})`,
      user: userOf(req) ?? undefined,
      metadata: { after: { saleId, totalAmount, refundMode, creditNoteNumber, lines: lineItemsJson.length } },
    }).catch(() => {});

    res.status(201).json({
      id: ret.id,
      returnNumber,
      saleId,
      invoiceNumber: sale.invoice_number ?? null,
      customerId: sale.customer_id ?? null,
      locationType, locationId,
      returnDate,
      lineItems: lineItemsJson,
      subtotal, taxTotal, totalAmount,
      refundMode,
      creditNoteId, creditNoteNumber,
      refundPaymentId,
      reason,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /sales-returns failed:", err);
    res.status(500).json({ error: "Failed to record sales return" });
  } finally {
    client.release();
  }
});

// GET /sales-returns — list (optionally ?saleId= for per-invoice history)
router.get("/sales-returns", requireModuleView("page:/returns"), async (req: Request, res: Response) => {
  try {
    const emp = (req as any).employee as { branchType: string; branchId: number } | undefined;
    const { getUserDataScope, scopeLocationTypeWhere } = await import("../lib/dataScope");
    const scope = emp ? await getUserDataScope(emp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
    const params: any[] = [];
    const scopeCond = scopeLocationTypeWhere(scope, params, "sr");
    let whereParts = [`${scopeCond}`];
    if (req.query.saleId) { params.push(Number(req.query.saleId)); whereParts.push(`sr.sale_id = $${params.length}`); }
    const where = `WHERE ${whereParts.join(" AND ")}`;
    const { rows } = await pool.query(
      `SELECT sr.*, s.invoice_number, c.name AS customer_name,
              jv.voucher_number AS credit_note_number
       FROM sales_returns sr
       JOIN sales s ON s.id = sr.sale_id
       LEFT JOIN customers c ON c.id = sr.customer_id
       LEFT JOIN journal_vouchers jv ON jv.id = sr.credit_note_id
       ${where}
       ORDER BY sr.id DESC`, params
    );
    res.json(rows.map((r: any) => ({
      id: r.id,
      returnNumber: r.return_number,
      saleId: r.sale_id,
      invoiceNumber: r.invoice_number,
      customerId: r.customer_id,
      customerName: r.customer_name ?? null,
      locationType: r.location_type,
      locationId: r.location_id,
      returnDate: r.return_date,
      lineItems: r.line_items ?? [],
      subtotal: Number(r.subtotal),
      taxTotal: Number(r.tax_total),
      totalAmount: Number(r.total_amount),
      refundMode: r.refund_mode,
      creditNoteId: r.credit_note_id,
      creditNoteNumber: r.credit_note_number ?? null,
      refundPaymentId: r.refund_payment_id,
      reason: r.reason,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error("GET /sales-returns failed:", err);
    res.status(500).json({ error: "Failed to list sales returns" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Purchase returns
// ═════════════════════════════════════════════════════════════════════════════

// POST /purchase-returns — body: { purchaseId, returnDate, reason?, lines: [{ lineIndex, quantity }] }
router.post("/purchase-returns", requireModuleAction(["page:/returns", "page:/production/purchase"], "add"), async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const purchaseId = Number(body.purchaseId);
  const returnDate = body.returnDate;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  const reqLines = Array.isArray(body.lines) ? body.lines : [];

  if (!Number.isInteger(purchaseId) || purchaseId <= 0) { res.status(400).json({ error: "purchaseId is required" }); return; }
  if (!isDateStr(returnDate)) { res.status(400).json({ error: "returnDate must be YYYY-MM-DD" }); return; }
  if (reqLines.length === 0) { res.status(400).json({ error: "At least one return line is required" }); return; }
  for (const l of reqLines) {
    if (!Number.isInteger(Number(l?.lineIndex)) || Number(l?.lineIndex) < 0 || !(Number(l?.quantity) > 0)) {
      res.status(400).json({ error: "Each line needs a valid lineIndex and a quantity > 0" }); return;
    }
  }
  const idxSeen = new Set<number>();
  for (const l of reqLines) {
    const ix = Number(l.lineIndex);
    if (idxSeen.has(ix)) { res.status(400).json({ error: `Duplicate return line for lineIndex ${ix}` }); return; }
    idxSeen.add(ix);
  }

  const client = await (pool as any).connect();
  try {
    await client.query("BEGIN");

    const { rows: [purchase] } = await client.query(`SELECT * FROM purchases WHERE id = $1 FOR UPDATE`, [purchaseId]);
    if (!purchase) { await client.query("ROLLBACK"); res.status(404).json({ error: "Purchase not found" }); return; }
    if (returnDate < dateOnly(purchase.purchase_date)) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Return date cannot be before the purchase date (${dateOnly(purchase.purchase_date)})` });
      return;
    }

    const pLines: any[] = Array.isArray(purchase.line_items) ? purchase.line_items : [];

    const { rows: priorRows } = await client.query(
      `SELECT line_items FROM purchase_returns WHERE purchase_id = $1`, [purchaseId]
    );
    const priorQty = new Map<number, number>();
    for (const pr of priorRows) {
      for (const pl of (Array.isArray(pr.line_items) ? pr.line_items : [])) {
        const ix = Number(pl.lineIndex);
        priorQty.set(ix, r3((priorQty.get(ix) ?? 0) + Number(pl.quantity || 0)));
      }
    }

    const retLines: any[] = [];
    let subtotal = 0, taxTotal = 0, totalAmount = 0;
    let totCgst = 0, totSgst = 0, totIgst = 0;

    for (const rl of reqLines) {
      const ix = Number(rl.lineIndex);
      const rq = r3(Number(rl.quantity));
      const li = pLines[ix];
      if (!li) { await client.query("ROLLBACK"); res.status(400).json({ error: `Purchase has no line at index ${ix}` }); return; }

      const boughtQty = Number(li.quantity) || 0;
      const already = priorQty.get(ix) ?? 0;
      const returnable = r3(boughtQty - already);
      const materialType = li.materialType === "raw_material" ? "raw_material" : li.materialType === "item" ? "item" : "material";
      const materialId = Number(li.materialId);

      // Resolve the material name for messages + the memo document
      const nameTable = materialType === "raw_material" ? "raw_materials" : materialType === "item" ? "items" : "materials";
      const { rows: [mat] } = await client.query(`SELECT name FROM ${nameTable} WHERE id = $1`, [materialId]);
      const materialName = li.materialName || mat?.name || `${materialType} #${materialId}`;

      if (rq > returnable + 0.001) {
        await client.query("ROLLBACK");
        res.status(400).json({
          error: `Cannot return ${rq} of "${materialName}" — purchased ${boughtQty}, already returned ${already}, returnable ${Math.max(0, returnable)}`,
        });
        return;
      }

      // ── Stock decrement (validate availability first) ────────────────────
      if (isMaterialKind(materialType)) {
        const tbl = materialType === "material" ? "materials" : "raw_materials";
        const { rows: [row] } = await client.query(`SELECT id FROM ${tbl} WHERE id = $1 FOR UPDATE`, [materialId]);
        if (!row) { await client.query("ROLLBACK"); res.status(400).json({ error: `${materialName} no longer exists` }); return; }
        // Availability is checked against the location that holds the goods
        // (Head Office), not the company-wide mirror — the mirror cannot tell
        // you whether the stock is actually here to send back.
        const held = await availabilityAt(client, {
          refId: materialId, materialType, branchType: "headoffice", branchId: 1, lock: true,
        });
        if (held.available + 0.001 < rq) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: insufficientStockMessage({
              productName: materialName, locationName: "Head Office",
              quantity: held.quantity, reserved: held.reserved, requested: rq,
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        const sent = await deductMaterialAt(client, materialType, materialId, "headoffice", 1, rq);
        if (!sent.ok) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: insufficientStockMessage({
              productName: materialName, locationName: "Head Office",
              quantity: sent.available, reserved: held.reserved, requested: rq,
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        await client.query(`UPDATE ${tbl} SET current_stock = current_stock::numeric - $1, updated_at = now() WHERE id = $2`, [rq, materialId]);
        // Send the material back out of its own lots (FEFO), so the lot layer
        // keeps matching the located quantity after a purchase return.
        await consumeBatches(client, {
          itemId: materialId, materialType,
          branchType: "headoffice", branchId: 1, quantity: rq,
        });
      } else {
        // Finished item bought into production stock
        const held = await availabilityAt(client, {
          refId: materialId, materialType: 'item', branchType: "headoffice", branchId: 1, lock: true,
        });
        if (held.available + 0.001 < rq) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: insufficientStockMessage({
              productName: materialName, locationName: "Head Office",
              quantity: held.quantity, reserved: held.reserved, requested: rq,
            }),
            code: 'INSUFFICIENT_STOCK',
          });
          return;
        }
        await client.query(`UPDATE stock_entries SET quantity = quantity::numeric - $1, updated_at = now() WHERE id = $2`, [rq, held.entryId]);
        await client.query(`UPDATE items SET production_stock = GREATEST(0, COALESCE(production_stock, 0)::numeric - $1), updated_at = now() WHERE id = $2`, [rq, materialId]);
        const batchNumber = li.batchNumber || `PUR-${purchaseId}`;
        await debitBatchByNumber(client, {
          itemId: materialId, materialType: "item",
          branchType: "headoffice", branchId: 1,
          batchNumber, quantity: rq,
        });
      }

      // ── Money (exclusive GST): prorate stored line values by quantity ────
      const frac = boughtQty > 0 ? rq / boughtQty : 0;
      const taxable = r2(Number(li.taxableValue ?? 0) * frac);
      const cgst = r2(Number(li.cgst ?? 0) * frac);
      const sgst = r2(Number(li.sgst ?? 0) * frac);
      const igst = r2(Number(li.igst ?? 0) * frac);
      const tax = r2(cgst + sgst + igst);
      const gross = r2(taxable + tax);

      retLines.push({
        lineIndex: ix,
        materialType, materialId, materialName,
        quantity: rq,
        unitCost: Number(li.unitCost ?? 0),
        grossAmount: gross,
        taxableAmount: taxable,
        taxAmount: tax,
        cgst, sgst, igst,
        gstRate: Number(li.gstRate ?? 0),
        taxType: li.taxType ?? "intra",
      });

      subtotal = r2(subtotal + taxable);
      taxTotal = r2(taxTotal + tax);
      totalAmount = r2(totalAmount + gross);
      totCgst = r2(totCgst + cgst); totSgst = r2(totSgst + sgst); totIgst = r2(totIgst + igst);
    }

    if (!(totalAmount > 0)) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Return total must be greater than zero" });
      return;
    }

    // ── Debit note on the vendor ledger ───────────────────────────────────
    const vendLedger = await ledgerIdByCode(client, `VEND-${purchase.vendor_id}`);
    if (!vendLedger) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Vendor ledger not found. Open the vendor record and save it once to create the ledger, then retry." });
      return;
    }
    const purLedger = await ledgerIdByCode(client, "STD-PUR");
    if (!purLedger) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Purchases ledger not found (STD-PUR missing). Open Chart of Accounts to restore standard ledgers." });
      return;
    }

    const returnNumber = await nextVoucherNumber(client, "purchase_return", returnDate);
    const billRef = purchase.invoice_number || `Purchase #${purchase.id}`;
    const { headLines, unresolved } = await resolveGstHeads(client, "input", totCgst, totSgst, totIgst);
    const dnNumber = await nextVoucherNumber(client, "debit_note", returnDate);
    const dnId = await insertVoucher(client, {
      voucherType: "debit_note",
      voucherNumber: dnNumber,
      voucherDate: returnDate,
      narration: `Purchase return ${returnNumber} against ${billRef}`,
      partyLedgerId: vendLedger,
      reason: reason ?? `Purchase return against ${billRef}`,
      totalAmount,
      createdBy: userOf(req),
      lines: [
        { ledgerId: vendLedger, debit: totalAmount, credit: 0 },
        { ledgerId: purLedger, debit: 0, credit: r2(subtotal + unresolved) },
        ...headLines.map(h => ({ ledgerId: h.ledgerId, debit: 0, credit: h.amount })),
      ],
    });

    const { rows: [ret] } = await client.query(
      `INSERT INTO purchase_returns (return_number, purchase_id, vendor_id, return_date, line_items,
                                     subtotal, tax_total, total_amount, debit_note_id, reason, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [returnNumber, purchaseId, purchase.vendor_id, returnDate, JSON.stringify(retLines),
       subtotal, taxTotal, totalAmount, dnId, reason, userOf(req)]
    );

    // ── Stock ledger (purchase return — fire-and-forget) ──────────────────────
    ;(async () => {
      await writeStockLedger(pool, retLines.map((rl: any) => ({
        txnType: 'purchase_return', materialType: rl.materialType ?? 'material',
        refId: rl.materialId, itemName: rl.materialName ?? '', unit: '',
        branchType: 'headoffice', branchId: rl.materialType === 'item' ? 1 : 0, branchName: 'Head Office',
        qtyChange: -Number(rl.quantity), unitCost: Number(rl.unitCost ?? 0),
        docType: 'purchase_return', docId: ret.id,
      })));
    })().catch((e: any) => console.error('[stock-ledger] purchase return write failed', e));

    await client.query("COMMIT");

    logActivity({
      action: "CREATE", module: "purchases", entityType: "purchase_return", entityId: ret.id,
      description: `Purchase return ${returnNumber} against ${billRef} — ₹${totalAmount.toFixed(2)} (debit note ${dnNumber})`,
      user: userOf(req) ?? undefined,
      metadata: { after: { purchaseId, totalAmount, debitNoteNumber: dnNumber, lines: retLines.length } },
    }).catch(() => {});

    res.status(201).json({
      id: ret.id,
      returnNumber,
      purchaseId,
      invoiceNumber: purchase.invoice_number ?? null,
      vendorId: purchase.vendor_id,
      returnDate,
      lineItems: retLines,
      subtotal, taxTotal, totalAmount,
      debitNoteId: dnId,
      debitNoteNumber: dnNumber,
      reason,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /purchase-returns failed:", err);
    res.status(500).json({ error: "Failed to record purchase return" });
  } finally {
    client.release();
  }
});

// GET /purchase-returns — list (optionally ?purchaseId=)
// LBAC: purchases are headoffice-only; non-HO users get an empty list
router.get("/purchase-returns", requireModuleView("page:/returns"), async (req: Request, res: Response) => {
  try {
    const purchRetEmp = (req as any).employee as { branchType: string } | undefined;
    if (purchRetEmp && purchRetEmp.branchType !== 'headoffice') {
      res.json([]); return;
    }
    const params: any[] = [];
    let where = "";
    if (req.query.purchaseId) { params.push(Number(req.query.purchaseId)); where = ` WHERE pr.purchase_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT pr.*, p.invoice_number, v.name AS vendor_name,
              jv.voucher_number AS debit_note_number
       FROM purchase_returns pr
       JOIN purchases p ON p.id = pr.purchase_id
       LEFT JOIN vendors v ON v.id = pr.vendor_id
       LEFT JOIN journal_vouchers jv ON jv.id = pr.debit_note_id
       ${where}
       ORDER BY pr.id DESC`, params
    );
    res.json(rows.map((r: any) => ({
      id: r.id,
      returnNumber: r.return_number,
      purchaseId: r.purchase_id,
      invoiceNumber: r.invoice_number,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name ?? null,
      returnDate: r.return_date,
      lineItems: r.line_items ?? [],
      subtotal: Number(r.subtotal),
      taxTotal: Number(r.tax_total),
      totalAmount: Number(r.total_amount),
      debitNoteId: r.debit_note_id,
      debitNoteNumber: r.debit_note_number ?? null,
      reason: r.reason,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error("GET /purchase-returns failed:", err);
    res.status(500).json({ error: "Failed to list purchase returns" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Outstanding: receivables & payables aging, collections worklist
// ═════════════════════════════════════════════════════════════════════════════

const BUCKETS = ["b0_30", "b31_60", "b61_90", "b90p"] as const;
type BucketKey = typeof BUCKETS[number];

function bucketOf(days: number): BucketKey {
  if (days <= 30) return "b0_30";
  if (days <= 60) return "b31_60";
  if (days <= 90) return "b61_90";
  return "b90p";
}

const daysBetween = (fromISO: string, toISO: string): number =>
  Math.floor((Date.parse(toISO) - Date.parse(fromISO)) / DAY_MS);

const todayISO = (): string => new Date().toISOString().slice(0, 10);

const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);

// GET /outstanding/receivables — per-customer aging on unpaid invoice balances,
// aged by days PAST DUE (due = sale date + customer credit days), with issued
// credit notes shown as unallocated credits.
router.get("/outstanding/receivables", requireModuleView(["page:/outstanding", "page:/customers"]), async (req: Request, res: Response) => {
  try {
    const asOf = todayISO();
    const { getUserDataScope, scopeSalesWhere } = await import("../lib/dataScope");
    const rcvEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
    const rcvScope = rcvEmp ? await getUserDataScope(rcvEmp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
    const rcvParams: any[] = [];
    const rcvScopeCond = scopeSalesWhere(rcvScope, rcvParams);
    const { rows: invoices } = await pool.query(
      `SELECT s.id, s.invoice_number, s.sale_date, s.customer_id,
              s.total_amount::numeric AS total, COALESCE(s.amount_paid, 0)::numeric AS paid,
              ${creditAdjustmentsExpr("s")} AS credit_notes,
              ${outstandingExpr("s")} AS outstanding,
              c.name, c.phone, COALESCE(c.credit_days, 0) AS credit_days, COALESCE(c.credit_limit, 0)::numeric AS credit_limit
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE ${outstandingExpr("s")} > 0.009
         AND s.branch_transfer_id IS NULL
         AND ${rcvScopeCond}
       ORDER BY s.sale_date ASC, s.id ASC`,
      rcvParams
    );
    const { rows: cnRows } = await pool.query(
      // UNALLOCATED credits only. A credit note raised by a sales return is
      // already netted off that invoice's own balance above; counting it here as
      // well would relieve the customer of the same money twice.
      `SELECT l.code, COALESCE(SUM(v.total_amount::numeric), 0) AS amt
       FROM journal_vouchers v
       JOIN account_ledgers l ON l.id = v.party_ledger_id
       WHERE v.voucher_type = 'credit_note' AND l.code LIKE 'CUST-%'
         AND NOT EXISTS (SELECT 1 FROM sales_returns sr WHERE sr.credit_note_id = v.id)
       GROUP BY l.code`
    );
    const cnByCustomer = new Map<number, number>();
    for (const r of cnRows) {
      const id = Number(String(r.code).slice(5));
      if (Number.isFinite(id)) cnByCustomer.set(id, r2(Number(r.amt)));
    }

    // The authoritative receivable per customer, from the party ledgers — the
    // same number Sundry Debtors shows on the Balance Sheet, so a receipt, a
    // journal, a contra or a credit note all move it.
    //
    // Ledger postings carry no location, so there is no honest way to scope this
    // to a branch. A location-scoped caller therefore keeps the document view
    // and is told so via `basis`, rather than being shown a company-wide figure
    // under a branch heading.
    const rcvLedgerAnchored = rcvScope.isHeadOffice;
    const ledgerByCustomer = rcvLedgerAnchored
      ? (await (await import("../lib/ledgerBalances")).currentBalanceIndex()).partyBalances("customer")
      : new Map<number, { balance: number }>();

    const byCustomer = new Map<number, any>();
    const totals: Record<BucketKey, number> = { b0_30: 0, b31_60: 0, b61_90: 0, b90p: 0 };
    let totalDueAll = 0;

    for (const inv of invoices) {
      // Net of the credit notes raised against this very invoice — the same
      // figure the invoice, its QR and the PDF quote.
      const balance = r2(Number(inv.outstanding));
      const creditDays = Number(inv.credit_days) || 0;
      const dueDate = addDays(String(inv.sale_date), creditDays);
      const overdue = Math.max(0, daysBetween(dueDate, asOf));
      const bucket = bucketOf(overdue);

      let cust = byCustomer.get(inv.customer_id);
      if (!cust) {
        cust = {
          customerId: inv.customer_id,
          name: inv.name,
          phone: inv.phone ?? null,
          creditLimit: Number(inv.credit_limit),
          creditDays,
          totalDue: 0,
          creditNotes: cnByCustomer.get(inv.customer_id) ?? 0,
          ledgerBalance: ledgerByCustomer.get(inv.customer_id)?.balance ?? 0,
          uninvoicedBalance: 0,
          unallocatedCredit: 0,
          netDue: 0,
          b0_30: 0, b31_60: 0, b61_90: 0, b90p: 0,
          invoices: [],
        };
        byCustomer.set(inv.customer_id, cust);
      }
      cust.totalDue = r2(cust.totalDue + balance);
      cust[bucket] = r2(cust[bucket] + balance);
      cust.invoices.push({
        saleId: inv.id,
        invoiceNumber: inv.invoice_number,
        saleDate: inv.sale_date,
        dueDate,
        daysOverdue: overdue,
        bucket,
        total: r2(Number(inv.total)),
        paid: r2(Number(inv.paid)),
        creditNotes: r2(Number(inv.credit_notes)),
        balance,
      });
      totals[bucket] = r2(totals[bucket] + balance);
      totalDueAll = r2(totalDueAll + balance);
    }

    // A customer can carry a ledger balance with no open invoice behind it — an
    // opening balance, or a journal raising the debt directly. Seeding from the
    // ledger too is what stops them being invisible on a report that claims to
    // show everything owed.
    if (rcvLedgerAnchored) {
      // One query for all of them, not one per customer: this list is unbounded
      // in principle, and a per-row lookup makes the report's cost scale with it.
      const seedIds = [...ledgerByCustomer]
        .filter(([id, bal]) => !byCustomer.has(id) && Math.abs(bal.balance) >= 0.005)
        .map(([id]) => id);
      if (seedIds.length) {
        const { rows: seedRows } = await pool.query<any>(
          `SELECT id, name, phone, COALESCE(credit_limit, 0)::numeric AS credit_limit,
                  COALESCE(credit_days, 0) AS credit_days
             FROM customers WHERE id = ANY($1::int[])`, [seedIds],
        );
        for (const cr of seedRows) {
          const customerId = Number(cr.id);
          byCustomer.set(customerId, {
            customerId, name: cr.name, phone: cr.phone ?? null,
            creditLimit: Number(cr.credit_limit), creditDays: Number(cr.credit_days),
            totalDue: 0, creditNotes: cnByCustomer.get(customerId) ?? 0,
            ledgerBalance: r2(ledgerByCustomer.get(customerId)!.balance),
            uninvoicedBalance: 0, unallocatedCredit: 0, netDue: 0,
            b0_30: 0, b31_60: 0, b61_90: 0, b90p: 0, invoices: [],
          });
        }
      }
    }

    let totalUninvoiced = 0;
    const customers = [...byCustomer.values()].map(c => {
      if (!rcvLedgerAnchored) {
        // Document view: no ledger to anchor to, so the old net-of-credit-notes
        // figure stands and is labelled as an invoice-basis number.
        return { ...c, netDue: r2(Math.max(0, c.totalDue - c.creditNotes)) };
      }
      // Sales carry a real per-invoice allocation (`amount_paid` plus credit
      // notes raised against that invoice), so unlike payables the buckets keep
      // showing genuine settlement history rather than a synthesised FIFO.
      // What changes is the control figure: netDue is the ledger balance, and
      // the gap between it and the aged bills is reported explicitly instead of
      // being absorbed silently.
      //   uninvoicedBalance — owed per the ledger, no dated invoice behind it.
      //   unallocatedCredit — money received or credited but not applied to any
      //                       specific invoice (also covers a net advance).
      const gap = r2(c.ledgerBalance - c.totalDue);
      const row = {
        ...c,
        netDue: r2(c.ledgerBalance),
        uninvoicedBalance: gap > 0 ? gap : 0,
        unallocatedCredit: gap < 0 ? r2(-gap) : 0,
      };
      totalUninvoiced = r2(totalUninvoiced + row.uninvoicedBalance);
      return row;
    }).filter(c => Math.abs(c.netDue) > 0.004 || c.totalDue > 0.004 || c.unallocatedCredit > 0.004)
      .sort((a, b) => b.netDue - a.netDue);

    const totalCreditNotes = r2(customers.reduce((s, c) => s + c.creditNotes, 0));
    res.json({
      asOf,
      basis: rcvLedgerAnchored ? "ledger" : "invoices",
      totals: {
        ...totals,
        // Aged invoice balances only — this is what the buckets add up to.
        totalDue: totalDueAll,
        creditNotes: totalCreditNotes,
        uninvoiced: totalUninvoiced,
        // The control figure: agrees with Sundry Debtors on the Balance Sheet.
        netDue: rcvLedgerAnchored
          ? r2(customers.reduce((s, c) => s + c.netDue, 0))
          : r2(Math.max(0, totalDueAll - totalCreditNotes)),
      },
      customers,
    });
  } catch (err) {
    console.error("GET /outstanding/receivables failed:", err);
    res.status(500).json({ error: "Failed to compute receivables aging" });
  }
});

// GET /outstanding/payables — per-vendor aging. Purchases have no amount_paid,
// so vendor payments + debit notes are FIFO-allocated against bills oldest-first;
// unallocated remainder ages by days since the bill date.
router.get("/outstanding/payables", requireModuleView(["page:/outstanding", "page:/vendors"]), async (req: Request, res: Response) => {
  try {
    // LBAC: purchases/payables are Head Office only
    const payEmp = (req as any).employee as { branchType: string } | undefined;
    if (payEmp && payEmp.branchType !== 'headoffice') {
      res.json({ asOf: todayISO(), totals: { b0_30: 0, b31_60: 0, b61_90: 0, b90p: 0, totalDue: 0, debitNotes: 0, netDue: 0 }, vendors: [] });
      return;
    }
    const asOf = todayISO();
    // An asset bought on credit credits the vendor's payable ledger exactly as a
    // stock purchase does, but it lives in asset_purchases, not purchases. Left
    // out, this report would understate what is owed and disagree with the
    // vendor's ledger balance in the books. Acquisitions with no vendor are
    // funded from Cash and never create a payable, so they stay out.
    // to_regclass guards the case where the fixed-assets migration has not run.
    const { rows: [assetTbl] } = await pool.query<{ ok: boolean }>(
      `SELECT to_regclass('public.asset_purchases') IS NOT NULL AS ok`
    );
    const assetBillsSql = assetTbl?.ok
      ? `UNION ALL
         SELECT 'asset_purchase'::text AS source, ap.id,
                COALESCE(jv.voucher_number, 'Asset — ' || a.name) AS invoice_number,
                ap.purchase_date, ap.vendor_id,
                (ap.quantity * ap.acquisition_cost)::numeric AS total, v.name, v.phone
           FROM asset_purchases ap
           JOIN vendors v ON v.id = ap.vendor_id
           JOIN assets a ON a.id = ap.asset_id
           LEFT JOIN journal_vouchers jv ON jv.id = ap.journal_voucher_id
          WHERE ap.vendor_id IS NOT NULL
            AND (ap.quantity * ap.acquisition_cost) > 0.004`
      : "";
    const { rows: bills } = await pool.query(
      `SELECT * FROM (
         SELECT 'purchase'::text AS source, p.id, p.invoice_number, p.purchase_date, p.vendor_id,
                p.total_amount::numeric AS total, v.name, v.phone
           FROM purchases p
           JOIN vendors v ON v.id = p.vendor_id
         ${assetBillsSql}
       ) bills
       ORDER BY purchase_date ASC, source ASC, id ASC`
    );
    // Payments and debit notes, kept for display only. They are NOT what the
    // ageing settles bills with any more: that pool is derived from the vendor's
    // ledger below, because these two queries between them cannot see a plain
    // journal voucher against a vendor — the exact gap that let a payable
    // settled by journal keep ageing here at its full original value.
    const { rows: payRows } = await pool.query(
      `SELECT l.code, COALESCE(SUM(p.amount::numeric), 0) AS amt
       FROM payments p
       JOIN account_ledgers l ON l.id = p.paid_to_ledger_id
       WHERE l.code LIKE 'VEND-%'
       GROUP BY l.code`
    );
    const { rows: dnRows } = await pool.query(
      `SELECT l.code, COALESCE(SUM(v.total_amount::numeric), 0) AS amt
       FROM journal_vouchers v
       JOIN account_ledgers l ON l.id = v.party_ledger_id
       WHERE v.voucher_type = 'debit_note' AND l.code LIKE 'VEND-%'
       GROUP BY l.code`
    );
    const paidByVendor = new Map<number, number>();
    for (const r of payRows) {
      const id = Number(String(r.code).slice(5));
      if (Number.isFinite(id)) paidByVendor.set(id, r2((paidByVendor.get(id) ?? 0) + Number(r.amt)));
    }
    const dnByVendor = new Map<number, number>();
    for (const r of dnRows) {
      const id = Number(String(r.code).slice(5));
      if (Number.isFinite(id)) dnByVendor.set(id, r2((dnByVendor.get(id) ?? 0) + Number(r.amt)));
    }

    // The authoritative payable per vendor.
    const { currentBalanceIndex } = await import("../lib/ledgerBalances");
    const balIdx = await currentBalanceIndex();
    const ledgerByVendor = balIdx.partyBalances("vendor");

    const newVendorRow = (vendorId: number, name: string, phone: string | null) => ({
      vendorId,
      name,
      phone: phone ?? null,
      totalBilled: 0,
      totalPaid: paidByVendor.get(vendorId) ?? 0,
      debitNotes: dnByVendor.get(vendorId) ?? 0,
      ledgerBalance: ledgerByVendor.get(vendorId)?.balance ?? 0,
      netDue: 0,
      unallocatedCredit: 0,
      unbilledBalance: 0,
      b0_30: 0, b31_60: 0, b61_90: 0, b90p: 0,
      bills: [] as any[],
    });

    const byVendor = new Map<number, any>();
    for (const b of bills) {
      let v = byVendor.get(b.vendor_id);
      if (!v) {
        v = newVendorRow(b.vendor_id, b.name, b.phone ?? null);
        byVendor.set(b.vendor_id, v);
      }
      v.totalBilled = r2(v.totalBilled + Number(b.total));
      const isAsset = b.source === "asset_purchase";
      v.bills.push({
        // Ids are only unique within their own table, so callers key off billKey.
        billKey: `${isAsset ? "A" : "P"}-${b.id}`,
        source: b.source,
        purchaseId: isAsset ? null : b.id,
        assetPurchaseId: isAsset ? b.id : null,
        invoiceNumber: b.invoice_number ?? null,
        purchaseDate: b.purchase_date,
        total: r2(Number(b.total)),
        allocated: 0,
        balance: 0,
        daysOld: Math.max(0, daysBetween(String(b.purchase_date), asOf)),
        bucket: "b0_30" as BucketKey,
      });
    }

    // A vendor can carry a ledger balance with no open bill behind it — an
    // opening balance, or a journal that raised a liability directly. Seeding
    // from the ledger as well as from the bills is what stops those vendors
    // from being invisible on a report that claims to show everything owed.
    // One query for all of them, not one per vendor — see the receivables report.
    {
      const seedIds = [...ledgerByVendor]
        .filter(([id, bal]) => !byVendor.has(id) && Math.abs(bal.balance) >= 0.005)
        .map(([id]) => id);
      if (seedIds.length) {
        const { rows: seedRows } = await pool.query<any>(
          `SELECT id, name, phone FROM vendors WHERE id = ANY($1::int[])`, [seedIds],
        );
        for (const vr of seedRows) {
          byVendor.set(Number(vr.id), newVendorRow(Number(vr.id), vr.name, vr.phone ?? null));
        }
      }
    }

    const totals: Record<BucketKey, number> = { b0_30: 0, b31_60: 0, b61_90: 0, b90p: 0 };
    let totalDueAll = 0;
    let totalUnbilled = 0;

    const vendors = [...byVendor.values()].map(v => {
      // The FIFO pool is everything the vendor's LEDGER says has relieved these
      // bills — payments, debit notes, journals, contras, the lot — not just the
      // two document types this report happens to query. Deriving it as
      // "billed minus what is still owed" means the residual bill balances add
      // up to the ledger balance by construction, so this report can never
      // disagree with the vendor's account or with the Balance Sheet.
      let credit = r2(v.totalBilled - v.ledgerBalance);
      // A ledger balance larger than the bills on file is a real payable with no
      // document behind it. It cannot be aged (there is no invoice date), so it
      // is reported on its own line rather than quietly dropped or back-dated.
      if (credit < 0) {
        v.unbilledBalance = r2(-credit);
        totalUnbilled = r2(totalUnbilled + v.unbilledBalance);
        credit = 0;
      }
      for (const bill of v.bills) {
        const alloc = r2(Math.min(credit, bill.total));
        bill.allocated = alloc;
        bill.balance = r2(bill.total - alloc);
        credit = r2(credit - alloc);
        const bk: BucketKey = bucketOf(bill.daysOld);
        bill.bucket = bk;
        if (bill.balance > 0.004) {
          v[bk] = r2(v[bk] + bill.balance);
          totals[bk] = r2(totals[bk] + bill.balance);
          totalDueAll = r2(totalDueAll + bill.balance);
        }
      }
      // netDue is the vendor's ledger balance, full stop. The buckets above show
      // how much of it can be attributed to dated bills; unbilledBalance carries
      // the rest, and unallocatedCredit is a net advance (an abnormal debit
      // balance), which is shown rather than clamped away.
      v.netDue = v.ledgerBalance;
      v.unallocatedCredit = credit;
      return v;
    }).filter(v => Math.abs(v.netDue) > 0.004 || v.unallocatedCredit > 0.004)
      .sort((a, b) => b.netDue - a.netDue);

    res.json({
      asOf,
      totals: {
        ...totals,
        // Aged bill balances only — this is what the buckets add up to.
        totalDue: totalDueAll,
        unbilled: totalUnbilled,
        // The control figure: agrees with Sundry Creditors on the Balance Sheet.
        netDue: r2(vendors.reduce((s, v) => s + v.netDue, 0)),
      },
      vendors,
    });
  } catch (err) {
    console.error("GET /outstanding/payables failed:", err);
    res.status(500).json({ error: "Failed to compute payables aging" });
  }
});

// GET /outstanding/collections — flat worklist of unpaid/partial invoices,
// most-overdue first, ready for inline payment collection.
router.get("/outstanding/collections", requireModuleView("page:/outstanding"), async (req: Request, res: Response) => {
  try {
    const asOf = todayISO();
    const { getUserDataScope, scopeSalesWhere } = await import("../lib/dataScope");
    const colEmp = (req as any).employee as { branchType: string; branchId: number } | undefined;
    const colScope = colEmp ? await getUserDataScope(colEmp) : { isHeadOffice: true, warehouseIds: [], outletIds: [] };
    const colParams: any[] = [];
    const colScopeCond = scopeSalesWhere(colScope, colParams);
    const { rows } = await pool.query(
      `SELECT s.id, s.invoice_number, s.sale_date, s.payment_status, s.payment_mode, s.customer_id,
              s.location_type, s.location_id,
              s.total_amount::numeric AS total, COALESCE(s.amount_paid, 0)::numeric AS paid,
              ${creditAdjustmentsExpr("s")} AS credit_notes,
              ${outstandingExpr("s")} AS outstanding,
              c.name AS customer_name, c.phone AS customer_phone, COALESCE(c.credit_days, 0) AS credit_days
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE ${outstandingExpr("s")} > 0.009
         AND s.branch_transfer_id IS NULL
         AND ${colScopeCond}
       ORDER BY s.sale_date ASC, s.id ASC`,
      colParams
    );
    const items = rows.map((r: any) => {
      // Chase the effective debt, not the gross one: a credit note settles a
      // bill just as surely as a receipt does.
      const position = computePaymentPosition({
        totalAmount: r.total, amountReceived: r.paid,
        creditAdjustments: r.credit_notes, cancelledAt: null,
      });
      const balance = position.outstanding;
      const dueDate = addDays(String(r.sale_date), Number(r.credit_days) || 0);
      const daysOverdue = Math.max(0, daysBetween(dueDate, asOf));
      return {
        saleId: r.id,
        invoiceNumber: r.invoice_number,
        saleDate: r.sale_date,
        dueDate,
        daysOverdue,
        customerId: r.customer_id,
        customerName: r.customer_name ?? null,
        customerPhone: r.customer_phone ?? null,
        locationType: r.location_type,
        locationId: r.location_id,
        totalAmount: r2(Number(r.total)),
        amountPaid: r2(Number(r.paid)),
        balanceDue: balance,
        paymentStatus: position.status,
      };
    }).sort((a, b) => b.daysOverdue - a.daysOverdue || b.balanceDue - a.balanceDue);

    res.json({ asOf, count: items.length, totalDue: r2(items.reduce((s, i) => s + i.balanceDue, 0)), items });
  } catch (err) {
    console.error("GET /outstanding/collections failed:", err);
    res.status(500).json({ error: "Failed to build collections worklist" });
  }
});

export default router;
