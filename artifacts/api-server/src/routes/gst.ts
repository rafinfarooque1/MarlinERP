import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { buildDerivedPostings } from "./journal";
import { lineTaxHeads } from "../lib/gst";
import { requireModuleView } from "../middleware/permissions";
import { isIsoDate } from "../lib/dateInput";
import {
  listGstinGroups, resolveGstScope, salesScopeCond, purchaseScopeCond,
  locationNameIndex, type GstScope,
} from "../lib/gstinScope";
import { purchaseSettlementIndex, settlementModeSummary } from "../lib/vendorBillSettlement";
import { loadPaymentPositions } from "../lib/salePaymentPosition";
import { paymentModeLabel } from "../lib/paymentModes";

const router: IRouter = Router();

const round2 = (n: number) => Math.round(n * 100) / 100;
// Shape AND calendar validity (rejects 2026-02-30) — these values reach real
// DATE columns, where an impossible date raises 22007 instead of storing text.
const isDate = (s: unknown): s is string => isIsoDate(s);
// Month 13 has to fail here: the value is expanded into `${month}-01` and
// compared against real DATE columns, which reject an impossible date.
const isMonth = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}$/.test(s) && isIsoDate(`${s}-01`);
const iso = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Append `AND col >= / <= $n` clauses for an optional date range. */
function rangeFilter(col: string, fromDate: string | undefined, toDate: string | undefined, params: any[]): string {
  let sqlText = "";
  if (fromDate) { params.push(fromDate); sqlText += ` AND ${col} >= $${params.length}`; }
  if (toDate) { params.push(toDate); sqlText += ` AND ${col} <= $${params.length}`; }
  return sqlText;
}

function parseRange(req: any): { fromDate?: string; toDate?: string } {
  const fromDate = isDate(req.query.fromDate) ? req.query.fromDate : undefined;
  const toDate = isDate(req.query.toDate) ? req.query.toDate : undefined;
  return { fromDate, toDate };
}

/** Optional GSTIN / warehouse filter → location scope (null = unfiltered). */
async function parseGstScope(req: any): Promise<GstScope | null> {
  const gstin = typeof req.query.gstin === "string" && req.query.gstin.trim() ? req.query.gstin.trim() : undefined;
  const whRaw = Number(req.query.warehouseId);
  const warehouseId = Number.isInteger(whRaw) && whRaw > 0 ? whRaw : undefined;
  if (!gstin && !warehouseId) return null;
  return resolveGstScope({ gstin, warehouseId });
}

/**
 * Payment status + mode summary per sale, from the actual settlement records.
 * Modes come from sale_payments in first-receipt order; a counter-settled
 * legacy sale (amount_paid with no payment rows) reports the sale's own mode.
 * The convention: unpaid ⇒ "Credit", partial ⇒ "<modes> + Credit".
 */
async function salePaymentSummaries(
  sales: Array<{ id: number; payment_mode?: string | null; branch_transfer_id?: number | null }>,
): Promise<Map<number, { paymentStatus: string; paymentModes: string }>> {
  const out = new Map<number, { paymentStatus: string; paymentModes: string }>();
  const ids = sales.map(s => Number(s.id));
  if (!ids.length) return out;
  const positions = await loadPaymentPositions(pool, ids);
  const { rows: pays } = await pool.query(
    `SELECT sale_id, method, MIN(payment_date) AS first_at, SUM(amount::numeric) AS amt
       FROM sale_payments WHERE sale_id = ANY($1::int[])
      GROUP BY sale_id, method
      ORDER BY MIN(payment_date) ASC, method ASC`,
    [ids],
  );
  const modesBySale = new Map<number, string[]>();
  for (const p of pays) {
    const sid = Number(p.sale_id);
    const label = paymentModeLabel(p.method);
    if (!label || label === "Credit") continue;
    const list = modesBySale.get(sid) ?? [];
    if (!list.includes(label)) list.push(label);
    modesBySale.set(sid, list);
  }
  for (const s of sales) {
    const id = Number(s.id);
    // A branch-transfer invoice settles through inter-branch ledgers, not a
    // customer receipt — a payment status would be a fiction.
    if (s.branch_transfer_id != null) {
      out.set(id, { paymentStatus: "na", paymentModes: "Branch Transfer" });
      continue;
    }
    const pos = positions.get(id);
    let modes = modesBySale.get(id) ?? [];
    if (!modes.length && pos && pos.amountReceived > 0.004) {
      const counter = paymentModeLabel(s.payment_mode);
      if (counter && counter !== "Credit") modes = [counter];
    }
    const status = pos?.status ?? "unpaid";
    let summary: string;
    if (status === "paid") summary = modes.length ? modes.join(" + ") : "Paid";
    else if (status === "partially_paid") summary = [...modes, "Credit"].join(" + ");
    else summary = "Credit";
    out.set(id, { paymentStatus: status, paymentModes: summary });
  }
  return out;
}

/** Map of "material:12" / "raw_material:3" / "item:7" → { hsn, unit, name } for
 *  purchase lines saved before HSN codes were captured per line. */
async function materialHsnMap(): Promise<Map<string, { hsn: string; unit: string; name: string }>> {
  const { rows } = await pool.query(
    `SELECT 'material' AS t, id, hsn_code, unit, name FROM materials
     UNION ALL SELECT 'raw_material', id, hsn_code, unit, name FROM raw_materials
     UNION ALL SELECT 'item', id, hsn_code, unit, name FROM items`
  );
  return new Map(rows.map((r: any) => [`${r.t}:${r.id}`, { hsn: r.hsn_code || "", unit: r.unit || "", name: r.name || "" }]));
}

// ── HSN Summary (outward from sales, inward from purchases) ─────────────────

router.get("/gst/hsn-summary", requireModuleView("page:/accounts/gst-returns"), async (req, res): Promise<void> => {
  // LBAC: GST filing is a Head Office activity
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({ outward: [], inward: [] }); return;
  }
  const { fromDate, toDate } = parseRange(req);
  const scope = await parseGstScope(req);

  const sp: any[] = [];
  const { rows: sales } = await pool.query(
    `SELECT line_items FROM sales s WHERE cancelled_at IS NULL${rangeFilter("sale_date", fromDate, toDate, sp)}${scope ? salesScopeCond("s", scope, sp) : ""}`, sp
  );
  type HsnAgg = { hsnCode: string; taxRate: number; unit: string; quantity: number; taxableValue: number; cgst: number; sgst: number; igst: number; taxAmount: number };
  const outward = new Map<string, HsnAgg>();
  for (const s of sales) {
    for (const li of (s.line_items ?? []) as any[]) {
      const hsn = String(li.hsnCode || "").trim() || "N/A";
      const rate = Number(li.taxRate ?? 0);
      const key = `${hsn}|${rate}`;
      const e = outward.get(key) ?? { hsnCode: hsn, taxRate: rate, unit: "", quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
      if (!e.unit && li.unit) e.unit = String(li.unit);
      const h = lineTaxHeads(li);
      e.quantity += Number(li.quantity ?? 0);
      e.taxableValue += Number(li.lineSubtotal ?? 0);
      e.cgst += h.cgst;
      e.sgst += h.sgst;
      e.igst += h.igst;
      e.taxAmount += Number(li.taxAmount ?? 0);
      outward.set(key, e);
    }
  }

  const pp: any[] = [];
  const { rows: purchases } = await pool.query(
    `SELECT line_items FROM purchases p WHERE cancelled_at IS NULL${rangeFilter("purchase_date", fromDate, toDate, pp)}${scope ? purchaseScopeCond("p", scope, pp) : ""}`, pp
  );
  const matMap = await materialHsnMap();
  const inward = new Map<string, HsnAgg>();
  for (const p of purchases) {
    for (const li of (p.line_items ?? []) as any[]) {
      const mat = matMap.get(`${li.materialType}:${li.materialId}`);
      const hsn = (String(li.hsnCode || "").trim() || mat?.hsn || "N/A") || "N/A";
      const rate = Number(li.gstRate ?? 0);
      const key = `${hsn}|${rate}`;
      const e = inward.get(key) ?? { hsnCode: hsn, taxRate: rate, unit: "", quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
      const h = lineTaxHeads(li);
      if (!e.unit && mat?.unit) e.unit = mat.unit;
      e.quantity += Number(li.quantity ?? 0);
      e.taxableValue += Number(li.taxableValue ?? 0);
      e.cgst += h.cgst;
      e.sgst += h.sgst;
      e.igst += h.igst;
      e.taxAmount += Number(li.taxAmount ?? 0);
      inward.set(key, e);
    }
  }

  const finalize = (m: Map<string, HsnAgg>) =>
    [...m.values()]
      .map(e => ({ ...e, quantity: round2(e.quantity), taxableValue: round2(e.taxableValue), cgst: round2(e.cgst), sgst: round2(e.sgst), igst: round2(e.igst), taxAmount: round2(e.taxAmount) }))
      .sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.taxRate - b.taxRate);

  const out = finalize(outward);
  const inn = finalize(inward);
  const sum = (rows: HsnAgg[], k: keyof HsnAgg) => round2(rows.reduce((s, r) => s + Number(r[k] ?? 0), 0));
  res.json({
    outward: out,
    inward: inn,
    totals: {
      outward: { taxableValue: sum(out, "taxableValue"), taxAmount: sum(out, "taxAmount") },
      inward: { taxableValue: sum(inn, "taxableValue"), taxAmount: sum(inn, "taxAmount") },
    },
  });
});

// ── GSTR-1 (outward supplies register: B2B invoice-wise, B2C rate-wise) ─────

router.get("/gst/gstr1", requireModuleView("page:/accounts/gst-returns"), async (req, res): Promise<void> => {
  // LBAC: GST filing is a Head Office activity
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({ b2b: [], b2cs: [], totals: {} }); return;
  }
  const { fromDate, toDate } = parseRange(req);
  const scope = await parseGstScope(req);

  const sp: any[] = [];
  const { rows: sales } = await pool.query(
    `SELECT id, invoice_number, sale_date, total_amount, tax_total, customer_id, line_items,
            branch_transfer_id, party_name, party_gstin, party_state, payment_mode,
            COALESCE(location_type, 'outlet') AS loc_type,
            COALESCE(location_id, outlet_id, 0) AS loc_id
     FROM sales s WHERE cancelled_at IS NULL${rangeFilter("sale_date", fromDate, toDate, sp)}${scope ? salesScopeCond("s", scope, sp) : ""}
     ORDER BY sale_date, id`, sp
  );
  const locNames = await locationNameIndex();
  const paySummaries = await salePaymentSummaries(sales as any[]);
  const { rows: customers } = await pool.query(`SELECT id, name, gst_number, state FROM customers`);
  const custMap = new Map(customers.map((c: any) => [c.id, c]));
  const { rows: [company] } = await pool.query(`SELECT state, gst_number FROM company_settings LIMIT 1`);
  const homeState = company?.state || "";

  type RateAgg = { taxRate: number; taxableValue: number; cgst: number; sgst: number; igst: number; taxAmount: number };
  const rateGroups = (lines: any[]): RateAgg[] => {
    const m = new Map<number, RateAgg>();
    for (const li of lines) {
      const rate = Number(li.taxRate ?? 0);
      const e = m.get(rate) ?? { taxRate: rate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
      const h = lineTaxHeads(li);
      e.taxableValue += Number(li.lineSubtotal ?? 0);
      e.cgst += h.cgst;
      e.sgst += h.sgst;
      e.igst += h.igst;
      e.taxAmount += Number(li.taxAmount ?? 0);
      m.set(rate, e);
    }
    return [...m.values()].map(e => ({ taxRate: e.taxRate, taxableValue: round2(e.taxableValue), cgst: round2(e.cgst), sgst: round2(e.sgst), igst: round2(e.igst), taxAmount: round2(e.taxAmount) })).sort((a, b) => a.taxRate - b.taxRate);
  };

  const b2b: any[] = [];
  const b2csMap = new Map<string, any>();
  let b2bCount = 0, b2cCount = 0;
  for (const s of sales) {
    const cust: any = s.customer_id ? custMap.get(s.customer_id) : undefined;
    // A branch-transfer invoice has no customer record — the receiving branch's
    // details are stamped on the invoice itself. Reading only customers here
    // would leave the GSTIN blank and dump a registered B2B supply into B2CS.
    const gstin = String(s.party_gstin || cust?.gst_number || "").trim();
    const pos = String(s.party_state || cust?.state || "").trim() || homeState;
    const partyName = String(s.party_name || cust?.name || "");
    const groups = rateGroups((s.line_items ?? []) as any[]);
    if (gstin) {
      b2bCount++;
      const pay = paySummaries.get(Number(s.id));
      for (const g of groups) {
        b2b.push({
          invoiceNumber: s.invoice_number, saleDate: iso(s.sale_date),
          customerName: partyName, gstin, placeOfSupply: pos,
          invoiceValue: round2(Number(s.total_amount)), ...g,
          isBranchTransfer: s.branch_transfer_id != null,
          warehouseName: locNames.name(s.loc_type, s.loc_id),
          paymentStatus: pay?.paymentStatus ?? "unpaid",
          paymentModes: pay?.paymentModes ?? "Credit",
        });
      }
    } else {
      b2cCount++;
      for (const g of groups) {
        const key = `${pos}|${g.taxRate}`;
        const e = b2csMap.get(key) ?? { placeOfSupply: pos, taxRate: g.taxRate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
        e.taxableValue = round2(e.taxableValue + g.taxableValue);
        e.cgst = round2(e.cgst + g.cgst);
        e.sgst = round2(e.sgst + g.sgst);
        e.igst = round2(e.igst + g.igst);
        e.taxAmount = round2(e.taxAmount + g.taxAmount);
        b2csMap.set(key, e);
      }
    }
  }
  const b2cs = [...b2csMap.values()].sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.taxRate - b.taxRate);

  const sumRows = (rows: any[], k: string) => round2(rows.reduce((s, r) => s + Number(r[k] ?? 0), 0));
  res.json({
    b2b, b2cs,
    totals: {
      invoiceCount: sales.length, b2bInvoices: b2bCount, b2cInvoices: b2cCount,
      taxableValue: round2(sumRows(b2b, "taxableValue") + sumRows(b2cs, "taxableValue")),
      cgst: round2(sumRows(b2b, "cgst") + sumRows(b2cs, "cgst")),
      sgst: round2(sumRows(b2b, "sgst") + sumRows(b2cs, "sgst")),
      igst: round2(sumRows(b2b, "igst") + sumRows(b2cs, "igst")),
      taxAmount: round2(sumRows(b2b, "taxAmount") + sumRows(b2cs, "taxAmount")),
      invoiceValue: round2(sales.reduce((s: number, r: any) => s + Number(r.total_amount), 0)),
    },
  });
});

// ── GSTR-3B (monthly summary: outward, ITC, net payable) ────────────────────

router.get("/gst/gstr3b", requireModuleView("page:/accounts/gst-returns"), async (req, res): Promise<void> => {
  // LBAC: GST filing is a Head Office activity
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({}); return;
  }
  const month = String(req.query.month ?? "");
  if (!isMonth(month)) {
    res.status(400).json({ error: "month is required in YYYY-MM format" });
    return;
  }
  const [y, m] = month.split("-").map(Number);
  const fromDate = `${month}-01`;
  const toDate = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  const scope = await parseGstScope(req);

  const sp: any[] = [];
  const { rows: sales } = await pool.query(
    `SELECT line_items FROM sales s WHERE cancelled_at IS NULL${rangeFilter("sale_date", fromDate, toDate, sp)}${scope ? salesScopeCond("s", scope, sp) : ""}`, sp
  );
  let outTaxable = 0, outCgst = 0, outSgst = 0, outIgst = 0, nilTaxable = 0;
  for (const s of sales) {
    for (const li of (s.line_items ?? []) as any[]) {
      const rate = Number(li.taxRate ?? 0);
      const taxable = Number(li.lineSubtotal ?? 0);
      if (rate > 0) {
        const h = lineTaxHeads(li);
        outTaxable += taxable;
        outCgst += h.cgst;
        outSgst += h.sgst;
        outIgst += h.igst;
      } else {
        nilTaxable += taxable;
      }
    }
  }

  const pp: any[] = [];
  const { rows: purchases } = await pool.query(
    `SELECT line_items FROM purchases p WHERE cancelled_at IS NULL${rangeFilter("purchase_date", fromDate, toDate, pp)}${scope ? purchaseScopeCond("p", scope, pp) : ""}`, pp
  );
  let itcCgst = 0, itcSgst = 0, itcIgst = 0;
  for (const p of purchases) {
    for (const li of (p.line_items ?? []) as any[]) {
      const h = lineTaxHeads(li);
      itcCgst += h.cgst;
      itcSgst += h.sgst;
      itcIgst += h.igst;
    }
  }

  outTaxable = round2(outTaxable); outCgst = round2(outCgst); outSgst = round2(outSgst); outIgst = round2(outIgst);
  nilTaxable = round2(nilTaxable); itcCgst = round2(itcCgst); itcSgst = round2(itcSgst); itcIgst = round2(itcIgst);

  // ITC set-off (standard order): IGST credit → IGST, CGST, SGST;
  // CGST credit → CGST, IGST; SGST credit → SGST, IGST.
  let liabC = outCgst, liabS = outSgst, liabI = outIgst;
  let credC = itcCgst, credS = itcSgst, credI = itcIgst;
  const take = (cred: number, liab: number) => Math.min(cred, liab);
  let u = take(credI, liabI); credI = round2(credI - u); liabI = round2(liabI - u);
  u = take(credI, liabC); credI = round2(credI - u); liabC = round2(liabC - u);
  u = take(credI, liabS); credI = round2(credI - u); liabS = round2(liabS - u);
  u = take(credC, liabC); credC = round2(credC - u); liabC = round2(liabC - u);
  u = take(credC, liabI); credC = round2(credC - u); liabI = round2(liabI - u);
  u = take(credS, liabS); credS = round2(credS - u); liabS = round2(liabS - u);
  u = take(credS, liabI); credS = round2(credS - u); liabI = round2(liabI - u);

  res.json({
    month, fromDate, toDate,
    outwardSupplies: { taxableValue: outTaxable, cgst: outCgst, sgst: outSgst, igst: outIgst, totalTax: round2(outCgst + outSgst + outIgst) },
    nilRatedSupplies: { taxableValue: nilTaxable },
    itc: { cgst: itcCgst, sgst: itcSgst, igst: itcIgst, totalItc: round2(itcCgst + itcSgst + itcIgst) },
    netPayable: { cgst: liabC, sgst: liabS, igst: liabI, total: round2(liabC + liabS + liabI) },
    itcCarriedForward: { cgst: credC, sgst: credS, igst: credI, total: round2(credC + credS + credI) },
    counts: { sales: sales.length, purchases: purchases.length },
  });
});

// ── Reconciliation (GST ledger balances vs sales/purchase registers) ────────

router.get("/gst/reconciliation", requireModuleView("page:/accounts/gst-returns"), async (req, res): Promise<void> => {
  // LBAC: GST reconciliation is a Head Office activity
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({}); return;
  }
  const { fromDate, toDate } = parseRange(req);

  // Register side: line-item sums from sales & purchases
  const sp: any[] = [];
  const { rows: sales } = await pool.query(
    `SELECT tax_total, line_items FROM sales WHERE cancelled_at IS NULL${rangeFilter("sale_date", fromDate, toDate, sp)}`, sp
  );
  let regOutC = 0, regOutS = 0, regOutI = 0, salesTaxTotal = 0;
  for (const s of sales) {
    salesTaxTotal += Number(s.tax_total ?? 0);
    for (const li of (s.line_items ?? []) as any[]) {
      const h = lineTaxHeads(li);
      regOutC += h.cgst; regOutS += h.sgst; regOutI += h.igst;
    }
  }
  const pp: any[] = [];
  const { rows: purchases } = await pool.query(
    `SELECT line_items FROM purchases WHERE cancelled_at IS NULL${rangeFilter("purchase_date", fromDate, toDate, pp)}`, pp
  );
  let regInpC = 0, regInpS = 0, regInpI = 0;
  for (const p of purchases) {
    for (const li of (p.line_items ?? []) as any[]) {
      const h = lineTaxHeads(li);
      regInpC += h.cgst; regInpS += h.sgst; regInpI += h.igst;
    }
  }
  regOutC = round2(regOutC); regOutS = round2(regOutS); regOutI = round2(regOutI);
  regInpC = round2(regInpC); regInpS = round2(regInpS); regInpI = round2(regInpI);
  salesTaxTotal = round2(salesTaxTotal);

  // Ledger side: derived postings on the GST ledgers within the same range
  const codes = ["STD-OUT-CGST", "STD-OUT-SGST", "STD-OUT-IGST", "STD-INP-CGST", "STD-INP-SGST", "STD-INP-IGST", "STD-DTX"];
  const { rows: ledgers } = await pool.query(
    `SELECT id, code, name FROM account_ledgers WHERE code = ANY($1)`, [codes]
  );
  const idByCode = new Map(ledgers.map((l: any) => [l.code, l.id]));
  let postings = await buildDerivedPostings({ toDate });
  if (fromDate) postings = postings.filter(p => iso(p.date) >= fromDate);
  const net = new Map<number, { debit: number; credit: number }>();
  for (const p of postings) {
    const e = net.get(p.ledgerId) ?? { debit: 0, credit: 0 };
    e.debit += p.debit; e.credit += p.credit;
    net.set(p.ledgerId, e);
  }
  const creditOf = (code: string) => { const e = net.get(idByCode.get(code) ?? -1); return round2((e?.credit ?? 0) - (e?.debit ?? 0)); };
  const debitOf = (code: string) => { const e = net.get(idByCode.get(code) ?? -1); return round2((e?.debit ?? 0) - (e?.credit ?? 0)); };

  const rows = [
    { head: "Output CGST", ledgerCode: "STD-OUT-CGST", ledgerAmount: creditOf("STD-OUT-CGST"), registerAmount: regOutC },
    { head: "Output SGST", ledgerCode: "STD-OUT-SGST", ledgerAmount: creditOf("STD-OUT-SGST"), registerAmount: regOutS },
    { head: "Output IGST", ledgerCode: "STD-OUT-IGST", ledgerAmount: creditOf("STD-OUT-IGST"), registerAmount: regOutI },
    { head: "Input CGST", ledgerCode: "STD-INP-CGST", ledgerAmount: debitOf("STD-INP-CGST"), registerAmount: regInpC },
    { head: "Input SGST", ledgerCode: "STD-INP-SGST", ledgerAmount: debitOf("STD-INP-SGST"), registerAmount: regInpS },
    { head: "Input IGST", ledgerCode: "STD-INP-IGST", ledgerAmount: debitOf("STD-INP-IGST"), registerAmount: regInpI },
  ].map(r => ({ ...r, difference: round2(r.ledgerAmount - r.registerAmount) }));

  const dtxDirect = creditOf("STD-DTX");
  const splitTotal = round2(regOutC + regOutS + regOutI);
  res.json({
    rows,
    dtxDirect,
    salesTaxTotal,
    salesLumpResidual: round2(salesTaxTotal - splitTotal),
    matched: rows.every(r => Math.abs(r.difference) < 0.05),
    note: "Duty & Tax (direct) holds legacy GST lumps and rounding residuals from sales recorded without line-level tax detail.",
  });
});

// ── Filter options (GSTIN groups → warehouses under each) ───────────────────

router.get("/gst/filters", requireModuleView(["page:/accounts/gst", "page:/accounts/gst-returns"]), async (req, res): Promise<void> => {
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({ gstins: [] }); return;
  }
  res.json({ gstins: await listGstinGroups() });
});

// ── Document register (invoice-wise, with payment settlement columns) ───────

router.get("/gst/documents", requireModuleView(["page:/accounts/gst", "page:/accounts/gst-returns"]), async (req, res): Promise<void> => {
  // LBAC: GST registers are Head Office accounting
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({ outward: [], inward: [], totals: {} }); return;
  }
  const { fromDate, toDate } = parseRange(req);
  const scope = await parseGstScope(req);
  const locNames = await locationNameIndex();

  const docHeads = (lines: any[], taxableKey: "lineSubtotal" | "taxableValue") => {
    let taxable = 0, cgst = 0, sgst = 0, igst = 0, taxAmount = 0;
    for (const li of lines) {
      const h = lineTaxHeads(li);
      taxable += Number(li[taxableKey] ?? 0);
      cgst += h.cgst; sgst += h.sgst; igst += h.igst;
      taxAmount += Number(li.taxAmount ?? 0);
    }
    return { taxableValue: round2(taxable), cgst: round2(cgst), sgst: round2(sgst), igst: round2(igst), taxAmount: round2(taxAmount) };
  };

  // Outward: sales (branch-transfer tax invoices stay — they carry real output GST)
  const sp: any[] = [];
  const { rows: sales } = await pool.query(
    `SELECT id, invoice_number, sale_date, total_amount, customer_id, line_items,
            branch_transfer_id, party_name, party_gstin, payment_mode,
            COALESCE(location_type, 'outlet') AS loc_type,
            COALESCE(location_id, outlet_id, 0) AS loc_id
     FROM sales s WHERE cancelled_at IS NULL${rangeFilter("sale_date", fromDate, toDate, sp)}${scope ? salesScopeCond("s", scope, sp) : ""}
     ORDER BY sale_date, id`, sp
  );
  const { rows: customers } = await pool.query(`SELECT id, name, gst_number FROM customers`);
  const custMap = new Map(customers.map((c: any) => [c.id, c]));
  const paySummaries = await salePaymentSummaries(sales as any[]);

  const outward = sales.map((s: any) => {
    const cust: any = s.customer_id ? custMap.get(s.customer_id) : undefined;
    const pay = paySummaries.get(Number(s.id));
    return {
      docType: "sale",
      documentNumber: s.invoice_number,
      date: iso(s.sale_date),
      partyName: String(s.party_name || cust?.name || "Walk-in"),
      partyGstin: String(s.party_gstin || cust?.gst_number || "").trim(),
      warehouseName: locNames.name(s.loc_type, s.loc_id),
      isBranchTransfer: s.branch_transfer_id != null,
      ...docHeads((s.line_items ?? []) as any[], "lineSubtotal"),
      invoiceValue: round2(Number(s.total_amount)),
      paymentStatus: pay?.paymentStatus ?? "unpaid",
      paymentModes: pay?.paymentModes ?? "Credit",
    };
  });

  // Inward: purchases, settlement derived from the vendor's ledger (FIFO)
  const pp: any[] = [];
  const { rows: purchases } = await pool.query(
    `SELECT p.id, p.invoice_number, p.purchase_date, p.total_amount, p.vendor_id, p.line_items,
            p.branch_transfer_id, p.party_name, p.party_gstin,
            COALESCE(p.location_type, p.branch_type, 'headoffice') AS loc_type,
            COALESCE(p.location_id, p.branch_id, 0) AS loc_id,
            v.name AS vendor_name, v.gst_number AS vendor_gstin
     FROM purchases p LEFT JOIN vendors v ON v.id = p.vendor_id
     WHERE p.cancelled_at IS NULL${rangeFilter("p.purchase_date", fromDate, toDate, pp)}${scope ? purchaseScopeCond("p", scope, pp) : ""}
     ORDER BY p.purchase_date, p.id`, pp
  );
  // Bounded to the vendors in the result set — the FIFO walk is per-vendor,
  // so this changes nothing about their allocation, only skips everyone else.
  const settlementVendors = [...new Set(
    purchases.filter((p: any) => p.branch_transfer_id == null && p.vendor_id != null)
      .map((p: any) => Number(p.vendor_id)),
  )];
  const settlement = settlementVendors.length
    ? await purchaseSettlementIndex(settlementVendors)
    : new Map();

  const inward = purchases.map((p: any) => {
    const st = settlement.get(Number(p.id));
    const isBt = p.branch_transfer_id != null;
    return {
      docType: "purchase",
      documentNumber: p.invoice_number ?? "",
      date: iso(p.purchase_date),
      partyName: String(p.party_name || p.vendor_name || ""),
      partyGstin: String(p.party_gstin || p.vendor_gstin || "").trim(),
      warehouseName: locNames.name(p.loc_type, p.loc_id),
      isBranchTransfer: isBt,
      ...docHeads((p.line_items ?? []) as any[], "taxableValue"),
      invoiceValue: round2(Number(p.total_amount)),
      paymentStatus: isBt ? "na" : (st?.status ?? "unpaid"),
      paymentModes: isBt ? "Branch Transfer" : (st ? settlementModeSummary(st) : "Credit"),
    };
  });

  const sum = (rows: any[], k: string) => round2(rows.reduce((s, r) => s + Number(r[k] ?? 0), 0));
  res.json({
    outward, inward,
    totals: {
      outward: { count: outward.length, taxableValue: sum(outward, "taxableValue"), taxAmount: sum(outward, "taxAmount"), invoiceValue: sum(outward, "invoiceValue") },
      inward: { count: inward.length, taxableValue: sum(inward, "taxableValue"), taxAmount: sum(inward, "taxAmount"), invoiceValue: sum(inward, "invoiceValue") },
    },
  });
});

export default router;
