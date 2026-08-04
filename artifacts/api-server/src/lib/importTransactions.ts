/**
 * Historical sales & purchase invoices imported from the old ERP.
 *
 * Each document commits through the SAME primitives the manual creation
 * routes use — stock deduction with FEFO lot consumption, weighted-average
 * costs, the stock ledger dated on the BUSINESS date, GST paise split via
 * buildSaleLines/priceBill, and the settlement model (sale_payments /
 * payment allocations) — so every imported invoice lands in the books,
 * inventory, GST reports and dashboards exactly like a hand-entered one.
 *
 * Imported sales draw a fresh SB2B/SB2C number from the same allocator as
 * manual entry (series picked from the customer's GST number); the old-ERP
 * number from the file is preserved in sales.legacy_invoice_number so the
 * source document stays searchable. Committing the source number verbatim
 * into invoice_number would put imported bills outside the two-series
 * numbering and could collide with the allocator. Purchases still keep the
 * supplied number (purchases_vendor_invoice enforces per-vendor uniqueness).
 *
 * Rollback is reversal-equivalent, not a bare row delete: stock and lots are
 * restored, settlements unwound, and — beyond what DELETE /purchases does —
 * average cost is unwound with the quantity (updateAvgCostOnReversal for
 * items, the mirrored guarded SQL for materials), because a rollback must
 * leave the valuation as if the batch had never been imported.
 */
import { pool, type PgPoolClient as PoolClient } from "@workspace/db";
import { buildSaleLines } from "../routes/sales";
import { buildBranchMaps } from "../routes/stock";
import {
  priceBill, buildNameMaps, allocateBatchNumbers, resolveSupplyTaxType,
  ledgerBranchId, type NameMaps,
} from "../routes/purchases";
import {
  consumeBatches, restoreBatches, creditBatch, debitBatchByNumber,
  updateAvgCostOnInbound, updateAvgCostOnReversal,
} from "./batches";
import { writeStockLedger, batchResolveMeta } from "./stockLedger";
import { availabilityAt, insufficientStockMessage } from "./reservations";
import { isSettledAtSale, clearsThroughBank } from "./paymentModes";
import { computePaymentPosition } from "./salePaymentPosition";
import { nextVoucherNumber, nextSalesInvoiceNumber } from "./voucherNumber";
import { creditMaterialAt, deductMaterialAt } from "./materialStock";
import { productBatchIdentity, type ProductKind } from "./productIdentity";
import { isValidGstSlab, gstSlabErrorMessage } from "./gst";
import { locationLabel, type ProdLocation } from "./productionCosting";
import { ensureVendorLedger } from "./partyCreate";

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// ── Shared ledger lookups ────────────────────────────────────────────────────

async function ledgerIdByCode(q: { query: Function }, code: string): Promise<number | null> {
  const { rows: [r] } = await (q as any).query(`SELECT id FROM account_ledgers WHERE code = $1`, [code]);
  return r ? Number(r.id) : null;
}

/** The till money is collected into / paid out of at a location.
 *  HO pays from STD-CASH; branches use their provisioned cash ledger
 *  (id column first — mirror locations share one till — then code). */
async function locationCashLedgerId(q: { query: Function }, loc: ProdLocation): Promise<number | null> {
  if (loc.type === "headoffice") return ledgerIdByCode(q, "STD-CASH");
  const table = loc.type === "warehouse" ? "warehouses" : "outlets";
  const { rows: [locRow] } = await (q as any).query(
    `SELECT cash_ledger_id FROM ${table} WHERE id = $1`, [loc.id],
  );
  if (locRow?.cash_ledger_id != null) {
    const { rows: [l] } = await (q as any).query(
      `SELECT id FROM account_ledgers WHERE id = $1`, [Number(locRow.cash_ledger_id)],
    );
    if (l) return Number(l.id);
  }
  const code = loc.type === "warehouse" ? `WH-CASH-${loc.id}` : `OUTLET-CASH-${loc.id}`;
  return ledgerIdByCode(q, code);
}

// ── Sales ────────────────────────────────────────────────────────────────────

export interface ImportSaleLine {
  itemId: number;
  quantity: number;
  /** GST-EXCLUSIVE unit price (taxable base) — tax is added from the item master rate. */
  unitPrice: number;
  /** Line-TOTAL discount amount (legacy semantics — deducted once, never per-unit). */
  discount: number;
}

export interface ImportSaleDocInput {
  invoiceNumber: string;
  saleDate: string; // ISO YYYY-MM-DD
  customerId: number;
  lines: ImportSaleLine[];
  /** Pre-tax bill discount, allocated paise-exactly across lines. */
  billDiscount: number;
  paymentMode: "cash" | "bank" | "upi" | "credit";
  /** Collection recorded against a CREDIT sale (settled modes are always fully paid). */
  paidAmount: number;
  reference: string | null;
  loc: ProdLocation;
  user: string;
}

export interface ImportedSaleResult {
  saleId: number;
  invoiceNumber: string;
  totalAmount: number;
  salePaymentIds: number[];
  clearingReceiptIds: number[];
}

export async function importSaleDoc(doc: ImportSaleDocInput): Promise<ImportedSaleResult> {
  const loc = doc.loc;
  // Sales/stock convention: HO rows carry location_id 1 (placeholder differs
  // per table — vouchers use 0, sales and stock use 1).
  const locationId = loc.type === "headoffice" ? 1 : loc.id;

  // ── Company + customer state → inter/intra (identical to POST /sales) ──
  const { rows: [comp] } = await pool.query(`SELECT state FROM company_settings LIMIT 1`);
  const companyState = String(comp?.state ?? "").trim().toLowerCase();
  const { rows: [cust] } = await pool.query(`SELECT state, name FROM customers WHERE id = $1`, [doc.customerId]);
  if (!cust) throw new Error(`Customer #${doc.customerId} no longer exists — re-validate the batch.`);
  const customerState = String(cust.state ?? "").trim().toLowerCase();
  const isInterState = !!(companyState && customerState && companyState !== customerState);

  // ── Item master snapshot (tax_rate/mrp are raw-migration columns → raw SQL) ──
  const itemIds = [...new Set(doc.lines.map((l) => l.itemId))];
  const { rows: itemRows } = await pool.query(
    `SELECT id, name, COALESCE(tax_rate, 0)::float8 AS tax_rate,
            COALESCE(hsn_code, '') AS hsn_code, COALESCE(unit, '') AS unit
       FROM items WHERE id = ANY($1::int[])`, [itemIds],
  );
  const itemTaxMap = new Map<number, { taxRate: number; name: string; hsnCode: string | null; unit: string | null }>(
    itemRows.map((i: any) => [Number(i.id), {
      taxRate: Number(i.tax_rate), name: String(i.name), hsnCode: i.hsn_code, unit: i.unit,
    }]),
  );
  for (const iid of itemIds) {
    if (!itemTaxMap.has(iid)) throw new Error(`Item #${iid} no longer exists — re-validate the batch.`);
  }

  // ── One canonical computation: prices are GST-exclusive for imports ──
  const built = buildSaleLines(
    doc.lines.map((l) => ({
      itemId: l.itemId, quantity: l.quantity, unitPrice: l.unitPrice,
      discount: l.discount, priceMode: "exclusive",
    })),
    itemTaxMap, isInterState, doc.billDiscount,
  );
  if (!built.ok) throw new Error(built.error);
  const lineItems = built.lineItems;
  const billDiscount = built.billDiscount;
  const subtotal = lineItems.reduce((s: number, li: any) => s + li.lineSubtotal, 0);
  const taxTotal = lineItems.reduce((s: number, li: any) => s + li.taxAmount, 0);
  const totalAmount = subtotal + taxTotal; // no post-tax coupon on imports

  // ── Location ledgers (HO deliberately has none — derived postings fall back) ──
  let cashLedgerId: number | null = null;
  let salesLedgerId: number | null = null;
  let locationName = "Head Office";
  if (loc.type === "warehouse") {
    const { rows: [wh] } = await pool.query(
      `SELECT name, cash_ledger_id, sales_ledger_id FROM warehouses WHERE id = $1`, [loc.id],
    );
    if (!wh) throw new Error(`Warehouse #${loc.id} no longer exists`);
    cashLedgerId = wh.cash_ledger_id == null ? null : Number(wh.cash_ledger_id);
    salesLedgerId = wh.sales_ledger_id == null ? null : Number(wh.sales_ledger_id);
    locationName = String(wh.name);
  } else if (loc.type === "outlet") {
    const { rows: [ol] } = await pool.query(
      `SELECT name, cash_ledger_id, sales_ledger_id FROM outlets WHERE id = $1`, [loc.id],
    );
    if (!ol) throw new Error(`Outlet #${loc.id} no longer exists`);
    cashLedgerId = ol.cash_ledger_id == null ? null : Number(ol.cash_ledger_id);
    salesLedgerId = ol.sales_ledger_id == null ? null : Number(ol.sales_ledger_id);
    locationName = String(ol.name);
  }
  const elecClrLedgerId = clearsThroughBank(doc.paymentMode)
    ? await ledgerIdByCode(pool, "STD-ELEC-CLR") : null;
  const custLedgerId = doc.paymentMode === "credit"
    ? await ledgerIdByCode(pool, `CUST-${doc.customerId}`) : null;

  const [ledgerMeta, branchNameOf] = await Promise.all([
    batchResolveMeta(pool, lineItems.map((li: any) => ({ materialType: "item" as const, refId: li.itemId }))),
    buildBranchMaps(),
  ]);

  const settledAtSale = isSettledAtSale(doc.paymentMode);
  const salePaymentIds: number[] = [];
  const clearingReceiptIds: number[] = [];

  const client = await pool.connect();
  let saleId = 0;
  let newInvoiceNumber = "";
  try {
    await client.query("BEGIN");

    // ── Stock: check, lock, deduct — ascending item id (same as POST /sales) ──
    const stockOrder = lineItems.map((_: any, i: number) => i)
      .sort((a: number, b: number) => lineItems[a].itemId - lineItems[b].itemId);
    const breakdowns: any[] = new Array(lineItems.length);
    for (const idx of stockOrder) {
      const li = lineItems[idx];
      const avail = await availabilityAt(client, {
        refId: li.itemId, materialType: "item",
        branchType: loc.type, branchId: locationId, lock: true,
      });
      if (avail.available + 0.001 < Number(li.quantity)) {
        throw new Error(insufficientStockMessage({
          productName: li.itemName || `Item #${li.itemId}`,
          locationName, unit: li.unit,
          quantity: avail.quantity, reserved: avail.reserved,
          requested: Number(li.quantity),
        }));
      }
      await client.query(
        `UPDATE stock_entries SET quantity = quantity::numeric - $1, updated_at = now() WHERE id = $2`,
        [li.quantity, avail.entryId],
      );
      breakdowns[idx] = await consumeBatches(client, {
        itemId: li.itemId, branchType: loc.type, branchId: locationId, quantity: li.quantity,
      });
    }
    const lineItemsWithBatches = lineItems.map((li: any, i: number) => ({ ...li, batchBreakdown: breakdowns[i] ?? [] }));

    // ── Allocate an SB2B/SB2C number like any other sale; the OLD ERP's
    // number lands in legacy_invoice_number so the source document stays
    // searchable. Importing the source number verbatim into invoice_number
    // would put imported bills outside the two-series numbering — and an
    // imported number shaped like SB2x/FY/n could collide with (or sit ahead
    // of) the allocator and brick the next POS sale until a restart reconciles.
    const { rows: [custGst] } = await client.query(
      `SELECT NULLIF(TRIM(COALESCE(gst_number, '')), '') AS gstin FROM customers WHERE id = $1`,
      [doc.customerId],
    );
    newInvoiceNumber = await nextSalesInvoiceNumber(
      client, custGst?.gstin != null ? "b2b" : "b2c", doc.saleDate,
    );
    const outletIdForInsert = loc.type === "outlet" ? loc.id : null;
    const { rows: [row] } = await client.query(
      `INSERT INTO sales (invoice_number, legacy_invoice_number, outlet_id, location_type, location_id, customer_id, sale_date,
                          line_items, subtotal, tax_total, discount_total, bill_discount, total_amount,
                          payment_mode, coupon_code, amount_paid, payment_status)
       VALUES ($1, $17, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [newInvoiceNumber, outletIdForInsert, loc.type, locationId, doc.customerId, doc.saleDate,
       JSON.stringify(lineItemsWithBatches), subtotal, taxTotal, 0, billDiscount, totalAmount,
       doc.paymentMode, null,
       settledAtSale ? totalAmount : 0,
       settledAtSale ? "paid" : "unpaid",
       doc.invoiceNumber],
    );
    saleId = Number(row.id);

    // ── Movement trail, dated on the BUSINESS date from the file ──
    await writeStockLedger(client, lineItems.map((li: any) => {
      const m = ledgerMeta.get(`item:${li.itemId}`);
      return {
        txnType: "sale", materialType: "item" as const, refId: li.itemId,
        itemName: m?.name ?? "", unit: m?.unit ?? "",
        branchType: loc.type, branchId: locationId,
        branchName: branchNameOf(loc.type, locationId),
        qtyChange: -Number(li.quantity),
        unitCost: Number(li.unitPrice ?? 0),
        docType: "sale", docId: saleId,
        txnDate: doc.saleDate,
        notes: newInvoiceNumber,
      };
    }));

    await client.query(
      `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric + $1 WHERE id = $2`,
      [totalAmount, doc.customerId],
    );

    // ── Legacy cash-book trail (branch sales only — HO writes no receipts) ──
    if (salesLedgerId) {
      let debitLedgerId = cashLedgerId;
      if (clearsThroughBank(doc.paymentMode) && elecClrLedgerId) debitLedgerId = elecClrLedgerId;
      else if (doc.paymentMode === "credit" && custLedgerId) debitLedgerId = custLedgerId;
      if (debitLedgerId && totalAmount > 0.004) {
        await client.query(
          `INSERT INTO receipts (receipt_date, received_from_ledger_id, received_in_ledger_id, amount,
                                 narration, voucher_number, location_type, location_id, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sale')`,
          [doc.saleDate, salesLedgerId, debitLedgerId, totalAmount,
           `Sale: ${newInvoiceNumber}${locationName ? ` at ${locationName}` : ""}`, newInvoiceNumber,
           loc.type, locationId],
        );
      }
    }

    // ── Collection against a credit sale — the payments.ts recipe, in-txn ──
    if (doc.paymentMode === "credit" && doc.paidAmount > 0.004) {
      const paid = Math.min(r2(doc.paidAmount), r2(totalAmount));
      let clearingReceiptId: number | null = null;
      if (loc.type !== "headoffice") {
        const tillId = await locationCashLedgerId(client, loc);
        const stdSalesId = await ledgerIdByCode(client, "STD-SALES");
        if (!tillId) {
          throw new Error(`Cash ledger not provisioned for ${locationName} — go to Accounts → Warehouses/Outlets and provision ledgers, then commit again.`);
        }
        if (!stdSalesId) throw new Error("Sales ledger (STD-SALES) not configured.");
        const voucherNum = await nextVoucherNumber(client, "receipt", doc.saleDate);
        const { rows: [receipt] } = await client.query(
          `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id,
                                 amount, narration, location_type, location_id, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sale') RETURNING id`,
          [voucherNum, doc.saleDate, stdSalesId, tillId, paid,
           `Cash payment for invoice ${newInvoiceNumber}`, loc.type, locationId],
        );
        clearingReceiptId = Number(receipt.id);
        clearingReceiptIds.push(clearingReceiptId);
      }
      const { rows: [sp] } = await client.query(
        `INSERT INTO sale_payments (sale_id, payment_date, method, amount, reference_number, notes,
                                    reconciliation_status, clearing_receipt_id, outlet_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [saleId, doc.saleDate, "cash", paid, doc.reference ?? null, "Imported from old ERP",
         null, clearingReceiptId, outletIdForInsert, doc.user],
      );
      salePaymentIds.push(Number(sp.id));
      const pos = computePaymentPosition({
        totalAmount, amountReceived: paid, creditAdjustments: 0, cancelledAt: null,
      });
      await client.query(
        `UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE id = $3`,
        [paid, pos.status, saleId],
      );
    }

    await client.query("COMMIT");
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (e?.code === "23505" && String(e?.constraint ?? "").includes("uq_sales_invoice_number")) {
      throw new Error(`Invoice number allocation collided for "${doc.invoiceNumber}" — retry the commit; if it persists, restart the server so the sales counters reconcile.`);
    }
    throw e;
  } finally {
    client.release();
  }

  return { saleId, invoiceNumber: newInvoiceNumber, totalAmount: r2(totalAmount), salePaymentIds, clearingReceiptIds };
}

// ── Purchases ────────────────────────────────────────────────────────────────

export interface ImportPurchaseLine {
  kind: ProductKind;
  id: number;
  quantity: number;
  /** GST-EXCLUSIVE unit rate — tax added from the product master rate. */
  rate: number;
  /** Discount PERCENT (0–100), the purchase module's convention. */
  discountPct: number;
}

export interface ImportPurchaseDocInput {
  invoiceNumber: string | null;
  purchaseDate: string; // ISO
  vendorId: number;
  lines: ImportPurchaseLine[];
  paidAmount: number;
  narration: string | null;
  reference: string | null;
  loc: ProdLocation;
  user: string;
}

export interface ImportedPurchaseResult {
  purchaseId: number;
  totalAmount: number;
  paymentId: number | null;
}

export async function importPurchaseDoc(doc: ImportPurchaseDocInput): Promise<ImportedPurchaseResult> {
  const loc = doc.loc;
  const maps: NameMaps = await buildNameMaps();
  const { rows: [vend] } = await pool.query(`SELECT name FROM vendors WHERE id = $1`, [doc.vendorId]);
  if (!vend) throw new Error(`Vendor #${doc.vendorId} no longer exists — re-validate the batch.`);
  const supply = await resolveSupplyTaxType(doc.vendorId, loc);

  const rawLines = doc.lines.map((l) => ({
    materialType: l.kind, materialId: l.id, quantity: l.quantity,
    unitCost: l.rate, discount: l.discountPct,
  }));
  const priced = priceBill(rawLines, "exclusive", maps, supply.taxType);
  const enriched: any[] = priced.enriched;
  for (const li of enriched) {
    if (!isValidGstSlab(li.gstRate ?? li.taxRate)) {
      const master = maps[li.materialType as keyof NameMaps]?.get(Number(li.materialId));
      throw new Error(`${master?.name ?? `#${li.materialId}`}: ${gstSlabErrorMessage(li.gstRate ?? li.taxRate)}`);
    }
  }
  const locName = await locationLabel(pool, loc);

  // Vendor ledger must exist BEFORE any settlement voucher can aim at it.
  const vendLedgerId = doc.paidAmount > 0.004
    ? await ensureVendorLedger(doc.vendorId, String(vend.name)) : null;

  const notesParts: string[] = [];
  if (doc.narration) notesParts.push(doc.narration);
  if (doc.reference) notesParts.push(`Ref: ${doc.reference}`);

  const lineIdentity = (li: any) =>
    productBatchIdentity(pool, (li.materialType ?? "item") as ProductKind, Number(li.materialId));

  const client = await pool.connect();
  let purchaseId = 0;
  let paymentId: number | null = null;
  try {
    await client.query("BEGIN");

    // Imports never carry hand-typed lot numbers — every line gets a
    // server-issued one from the sequence (collision-free by construction).
    const issued = await allocateBatchNumbers(client, doc.purchaseDate, enriched.length);
    enriched.forEach((l, i) => { l.batchNumber = issued[i]; l.mfgDate = null; l.expiryDate = null; });

    const { rows: [ins] } = await client.query(
      `INSERT INTO purchases (vendor_id, purchase_date, invoice_number, line_items, total_amount,
                              notes, tax_total, discount_total, round_off, location_type, location_id,
                              price_mode)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [doc.vendorId, doc.purchaseDate, doc.invoiceNumber ?? null,
       JSON.stringify(enriched), String(priced.totalAmount),
       notesParts.length ? notesParts.join(" — ") : null,
       priced.taxTotal, priced.discountTotal, priced.roundOff, loc.type, loc.id, "exclusive"],
    );
    purchaseId = Number(ins.id);

    // ── Per-line stock, lots and weighted-average cost — the POST /purchases recipe ──
    for (const li of enriched) {
      if (li.materialType === "material") {
        await client.query(
          `UPDATE materials SET
             avg_cost = ROUND(
               (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
               / NULLIF(current_stock::numeric + $2::numeric, 0),
             4),
             current_stock = current_stock::numeric + $2::numeric
           WHERE id = $1`,
          [li.materialId, li.quantity, li.costPerUnit],
        );
        await creditMaterialAt(client, "material", li.materialId, loc.type, loc.id, Number(li.quantity), Number(li.costPerUnit));
        await creditBatch(client, {
          itemId: li.materialId, materialType: "material",
          branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber!, mfgDate: null, expiryDate: null,
          quantity: li.quantity, unitCost: li.costPerUnit,
          source: "purchase", sourceId: purchaseId,
          ...(await lineIdentity(li)),
        });
      } else if (li.materialType === "raw_material") {
        await client.query(
          `UPDATE raw_materials SET
             avg_cost = ROUND(
               (current_stock::numeric * COALESCE(avg_cost, 0)::numeric + $2::numeric * $3::numeric)
               / NULLIF(current_stock::numeric + $2::numeric, 0),
             4),
             current_stock = current_stock::numeric + $2::numeric
           WHERE id = $1`,
          [li.materialId, li.quantity, li.costPerUnit],
        );
        await creditMaterialAt(client, "raw_material", li.materialId, loc.type, loc.id, Number(li.quantity), Number(li.costPerUnit));
        await creditBatch(client, {
          itemId: li.materialId, materialType: "raw_material",
          branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber!, mfgDate: null, expiryDate: null,
          quantity: li.quantity, unitCost: li.costPerUnit,
          source: "purchase", sourceId: purchaseId,
          ...(await lineIdentity(li)),
        });
      } else if (li.materialType === "item") {
        await client.query(
          `UPDATE items SET production_stock = production_stock::numeric + $2::numeric WHERE id = $1`,
          [li.materialId, li.quantity],
        );
        await client.query(
          `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'item', $4, $5, $2, $3)
           ON CONFLICT (item_id, material_type, branch_type, branch_id) DO UPDATE SET
             quantity = stock_entries.quantity::numeric + EXCLUDED.quantity::numeric,
             cost_price = EXCLUDED.cost_price,
             updated_at = now()`,
          [li.materialId, li.quantity, li.costPerUnit, loc.type, loc.id],
        );
        await updateAvgCostOnInbound(client, li.materialId, li.quantity, li.costPerUnit);
        await creditBatch(client, {
          itemId: li.materialId, branchType: loc.type, branchId: loc.id,
          batchNumber: li.batchNumber!, mfgDate: null, expiryDate: null,
          quantity: li.quantity, unitCost: li.costPerUnit,
          source: "purchase", sourceId: purchaseId,
          ...(await lineIdentity(li)),
        });
      }
    }

    await writeStockLedger(client, enriched.map((li: any) => {
      const master = maps[li.materialType as keyof NameMaps]?.get(Number(li.materialId));
      return {
        txnType: "purchase", materialType: li.materialType ?? "item",
        refId: li.materialId, itemName: master?.name ?? "", unit: master?.unit ?? "",
        branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? "item"), branchName: locName,
        qtyChange: Number(li.quantity), unitCost: Number(li.costPerUnit ?? 0),
        docType: "purchase", docId: purchaseId,
        txnDate: doc.purchaseDate,
      };
    }));

    // ── Settlement: paid/partly-paid bills get an allocation voucher ──
    if (doc.paidAmount > 0.004) {
      if (!vendLedgerId) {
        throw new Error(`Creditor ledger for ${vend.name} could not be provisioned — the paid amount was not recorded.`);
      }
      const tillId = await locationCashLedgerId(client, loc);
      if (!tillId) {
        throw new Error(`Cash ledger not provisioned for ${locName} — go to Accounts → Warehouses/Outlets and provision ledgers, then commit again.`);
      }
      const paid = Math.min(r2(doc.paidAmount), r2(Number(priced.totalAmount)));
      // Money vouchers carry the HO placeholder 0 (unlike sales/stock, which use 1).
      const voucherLocId = loc.type === "headoffice" ? 0 : loc.id;
      const voucherNumber = await nextVoucherNumber(client, "payment", doc.purchaseDate);
      const { rows: [pv] } = await client.query(
        `INSERT INTO payments (voucher_number, payment_date, paid_from_ledger_id, paid_to_ledger_id, amount,
                               narration, location_type, location_id, reference_number, created_by,
                               source, advance_amount, advance_ledger_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'allocation', 0, NULL) RETURNING id`,
        [voucherNumber, doc.purchaseDate, tillId, vendLedgerId, paid,
         `Settlement of ${doc.invoiceNumber ?? `bill #${purchaseId}`} (imported from old ERP)`,
         loc.type, voucherLocId, doc.reference ?? null, doc.user],
      );
      paymentId = Number(pv.id);
      await client.query(
        `INSERT INTO payment_bill_allocations (payment_id, purchase_id, amount) VALUES ($1, $2, $3)`,
        [paymentId, purchaseId, paid],
      );
    }

    await client.query("COMMIT");
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (e?.code === "23505" && String(e?.constraint ?? "").includes("purchases_vendor_invoice")) {
      throw new Error(`Invoice "${doc.invoiceNumber}" is already recorded for this vendor — it was entered since validation.`);
    }
    throw e;
  } finally {
    client.release();
  }

  return { purchaseId, totalAmount: r2(Number(priced.totalAmount)), paymentId };
}

// ── Rollback (reversal-equivalent, inside the CALLER's transaction) ─────────
// Both functions return a human-readable blocking reason, or null when the
// document was fully reversed. The caller runs ALL documents in one
// transaction and ROLLBACKs everything if any reason comes back — batch
// rollback is all-or-nothing, same as the masters rollback.

export async function rollbackImportedSale(
  client: PoolClient,
  saleId: number,
  own: { salePaymentIds?: number[]; clearingReceiptIds?: number[] },
): Promise<string | null> {
  const ownPayIds = (own.salePaymentIds ?? []).map(Number).filter(Number.isInteger);
  const ownReceiptIds = (own.clearingReceiptIds ?? []).map(Number).filter(Number.isInteger);

  const { rows: [sale] } = await client.query(
    `SELECT id, invoice_number, customer_id, total_amount::numeric AS total_amount,
            location_type, location_id, outlet_id, cancelled_at, branch_transfer_id, line_items,
            to_char(sale_date, 'YYYY-MM-DD') AS sale_date
       FROM sales WHERE id = $1 FOR UPDATE`, [saleId],
  );
  if (!sale) return null; // already gone — nothing to reverse
  if (sale.cancelled_at) return `${sale.invoice_number} was cancelled after import — its stock was already restored; roll it back is not possible`;
  if (sale.branch_transfer_id) return `${sale.invoice_number} is tied to a branch transfer`;

  const { rows: [ret] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM sales_returns WHERE sale_id = $1`, [saleId],
  );
  if (Number(ret?.n ?? 0) > 0) return `${sale.invoice_number} has a sales return recorded against it`;

  const { rows: foreign } = await client.query(
    ownPayIds.length > 0
      ? `SELECT COUNT(*)::int AS n FROM sale_payments WHERE sale_id = $1 AND NOT (id = ANY($2::int[]))`
      : `SELECT COUNT(*)::int AS n FROM sale_payments WHERE sale_id = $1`,
    ownPayIds.length > 0 ? [saleId, ownPayIds] : [saleId],
  );
  if (Number(foreign[0]?.n ?? 0) > 0) {
    return `payments were collected against ${sale.invoice_number} after import — refund or remove them first`;
  }

  // Own settlement trail dies with the document.
  if (ownPayIds.length > 0) {
    await client.query(`DELETE FROM sale_payments WHERE sale_id = $1 AND id = ANY($2::int[])`, [saleId, ownPayIds]);
  }
  if (ownReceiptIds.length > 0) {
    await client.query(`DELETE FROM receipts WHERE id = ANY($1::int[])`, [ownReceiptIds]);
  }

  const locType: string = sale.location_type ?? "outlet";
  const locId: number = Number(sale.location_id ?? sale.outlet_id);
  const lines = (sale.line_items ?? []) as Array<{ itemId: number; quantity: number; unitPrice?: number; batchBreakdown?: any[] }>;

  // Put the goods back — ascending item order, same as cancellation.
  for (const li of [...lines].sort((a, b) => Number(a.itemId) - Number(b.itemId))) {
    const { rows: [se] } = await client.query(
      `SELECT id FROM stock_entries
        WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3
        LIMIT 1 FOR UPDATE`,
      [li.itemId, locType, locId],
    );
    if (se) {
      await client.query(
        `UPDATE stock_entries SET quantity = quantity::numeric + $1, updated_at = now() WHERE id = $2`,
        [li.quantity, se.id],
      );
    } else {
      await client.query(
        `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
         VALUES ($1, 'item', $2, $3, $4, '0')`,
        [li.itemId, locType, locId, li.quantity],
      );
    }
    await restoreBatches(client, li.itemId, locType, locId, li.batchBreakdown, "sale", saleId);
  }

  const meta = await batchResolveMeta(client, lines.map((li) => ({ materialType: "item" as const, refId: li.itemId })));
  const branchNameOf = await buildBranchMaps();
  await writeStockLedger(client, lines.map((li) => {
    const m = meta.get(`item:${li.itemId}`);
    return {
      txnType: "sale_cancellation", materialType: "item" as const, refId: li.itemId,
      itemName: m?.name ?? "", unit: m?.unit ?? "",
      branchType: locType, branchId: locId,
      branchName: branchNameOf(locType, locId),
      qtyChange: Number(li.quantity),
      unitCost: Number(li.unitPrice ?? 0),
      docType: "sale", docId: saleId,
      // Dated on the sale's own business date: rollback must read, on any
      // report date, as if the imported invoice never existed.
      txnDate: String(sale.sale_date ?? "") || null,
      notes: `${sale.invoice_number} — import rolled back`,
    };
  }));

  if (sale.customer_id) {
    await client.query(
      `UPDATE customers SET total_purchases = COALESCE(total_purchases, 0)::numeric - $1 WHERE id = $2`,
      [Number(sale.total_amount), sale.customer_id],
    );
  }
  // Cash-book trail rows keyed on the invoice number (sale-source only —
  // never someone's manual receipt that happens to share the text).
  await client.query(`DELETE FROM receipts WHERE voucher_number = $1 AND source = 'sale'`, [sale.invoice_number]);
  await client.query(`DELETE FROM sales WHERE id = $1`, [saleId]);
  return null;
}

export async function rollbackImportedPurchase(
  client: PoolClient,
  purchaseId: number,
  own: { paymentId?: number | null },
): Promise<string | null> {
  // Our own settlement voucher goes first, so its allocation does not read as
  // foreign activity below.
  if (own.paymentId != null && Number.isInteger(Number(own.paymentId))) {
    await client.query(`DELETE FROM payment_bill_allocations WHERE payment_id = $1 AND purchase_id = $2`,
      [Number(own.paymentId), purchaseId]);
    await client.query(`DELETE FROM payments WHERE id = $1 AND source = 'allocation'`, [Number(own.paymentId)]);
  }

  const { rows: [locked] } = await client.query(
    `SELECT line_items, vendor_id, invoice_number, total_amount, location_type, location_id,
            to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date
       FROM purchases WHERE id = $1 FOR UPDATE`, [purchaseId],
  );
  if (!locked) return null; // already gone
  const label = locked.invoice_number ? `bill "${locked.invoice_number}"` : `bill #${purchaseId}`;

  const { rows: [allocRef] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM payment_bill_allocations WHERE purchase_id = $1`, [purchaseId],
  );
  if (Number(allocRef?.n ?? 0) > 0) return `a payment voucher has settled ${label} since import — delete that voucher first`;
  const { rows: [advRef] } = await client.query(
    `SELECT COUNT(*)::int AS n FROM purchase_advance_applications WHERE purchase_id = $1`, [purchaseId],
  );
  if (Number(advRef?.n ?? 0) > 0) return `a vendor advance was applied against ${label} since import`;

  const loc: ProdLocation = { type: locked.location_type ?? "headoffice", id: Number(locked.location_id ?? 1) };
  const locName = await locationLabel(client, loc);
  const lineItems = (locked.line_items ?? []) as Array<{
    materialType: string; materialId: number; quantity: number;
    costPerUnit?: number; batchNumber?: string | null;
  }>;

  // The imported lots must still be intact: a lot that production, a sale or
  // a transfer has drawn from cannot be silently un-purchased.
  for (const li of lineItems) {
    const batchNumber = li.batchNumber || `PUR-${purchaseId}`;
    const { rows: [lot] } = await client.query(
      `SELECT quantity::numeric AS quantity FROM stock_batches
        WHERE item_id = $1 AND material_type = $2 AND branch_type = $3 AND branch_id = $4 AND batch_number = $5
        FOR UPDATE`,
      [li.materialId, li.materialType ?? "item", loc.type, loc.id, batchNumber],
    );
    if (!lot || Number(lot.quantity) + 0.0005 < Number(li.quantity)) {
      return `stock from ${label} has since been used (lot ${batchNumber}) — reverse that activity first`;
    }
  }

  for (const li of lineItems) {
    const qty = Number(li.quantity);
    const cost = Number(li.costPerUnit ?? 0);
    if (li.materialType === "material" || li.materialType === "raw_material") {
      const table = li.materialType === "material" ? "materials" : "raw_materials";
      // Unwind the weighted average WITH the quantity (the manual DELETE
      // deliberately leaves the average; an import rollback must not).
      // Guarded: when nothing would remain, the last known figure stands.
      await client.query(
        `UPDATE ${table} SET
           avg_cost = CASE
             WHEN current_stock::numeric - $2::numeric > 0.0005 THEN ROUND(
               GREATEST(0, current_stock::numeric * COALESCE(avg_cost, 0)::numeric - $2::numeric * $3::numeric)
               / (current_stock::numeric - $2::numeric),
             4)
             ELSE avg_cost END
         WHERE id = $1`,
        [li.materialId, qty, cost],
      );
      await client.query(
        `UPDATE ${table} SET current_stock = GREATEST(0, current_stock::numeric - $2::numeric) WHERE id = $1`,
        [li.materialId, qty],
      );
      await deductMaterialAt(client, li.materialType as "material" | "raw_material", li.materialId, loc.type, loc.id, qty, { floor: true });
      await debitBatchByNumber(client, {
        itemId: li.materialId, materialType: li.materialType as any, branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${purchaseId}`, quantity: qty,
      });
    } else if (li.materialType === "item") {
      // BEFORE quantity removal — the unwind derives the prior average from
      // the totals as they stand right now.
      await updateAvgCostOnReversal(client, li.materialId, qty, cost);
      await client.query(
        `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric - $2::numeric) WHERE id = $1`,
        [li.materialId, qty],
      );
      await client.query(
        `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
         WHERE item_id = $2 AND material_type = 'item' AND branch_type = $3 AND branch_id = $4`,
        [qty, li.materialId, loc.type, loc.id],
      );
      await debitBatchByNumber(client, {
        itemId: li.materialId, materialType: "item", branchType: loc.type, branchId: loc.id,
        batchNumber: li.batchNumber || `PUR-${purchaseId}`, quantity: qty,
      });
    }
  }

  await client.query(
    `DELETE FROM stock_batches
      WHERE source = 'purchase' AND source_id = $1
        AND branch_type = $2 AND branch_id = $3
        AND quantity::numeric <= 0.0005`,
    [purchaseId, loc.type, loc.id],
  );
  await writeStockLedger(client, lineItems.map((li) => ({
    txnType: "purchase_reversal", materialType: (li.materialType ?? "item") as any,
    refId: li.materialId, itemName: "", unit: "",
    branchType: loc.type, branchId: ledgerBranchId(loc, li.materialType ?? "item"), branchName: locName,
    qtyChange: -Number(li.quantity), unitCost: 0,
    docType: "purchase", docId: purchaseId,
    txnDate: String(locked.purchase_date ?? "") || null,
    notes: "Import rolled back — stock reversed",
  })));
  await client.query(`DELETE FROM purchases WHERE id = $1 RETURNING id`, [purchaseId]);
  return null;
}
