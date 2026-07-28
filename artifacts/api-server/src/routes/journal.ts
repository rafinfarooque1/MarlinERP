import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { nextVoucherNumber, VOUCHER_TYPE_LABELS } from "../lib/voucherNumber";
import { logActivity } from "../lib/audit";
import { lineTaxHeads } from "../lib/gst";

const router = Router();

const JV_TYPES = new Set(["journal", "contra", "credit_note", "debit_note"]);
const round2 = (n: number) => Math.round(n * 100) / 100;
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ── Helpers ────────────────────────────────────────────────────────────────

/** All ledger ids at-or-under the given root codes (walks the CoA tree). */
async function ledgerIdsUnderCodes(rootCodes: string[]): Promise<Set<number>> {
  const { rows } = await pool.query(`SELECT id, parent_id, code FROM account_ledgers`);
  const ids = new Set<number>();
  for (const r of rows) if (r.code && rootCodes.includes(r.code)) ids.add(r.id);
  for (let i = 0; i < 8; i++) {
    for (const r of rows) if (r.parent_id && ids.has(r.parent_id)) ids.add(r.id);
  }
  return ids;
}

/** The given ledger id plus all of its descendants. */
async function ledgerSubtreeIds(rootId: number): Promise<Set<number>> {
  const { rows } = await pool.query(`SELECT id, parent_id FROM account_ledgers`);
  const ids = new Set<number>([rootId]);
  for (let i = 0; i < 8; i++) {
    for (const r of rows) if (r.parent_id && ids.has(r.parent_id)) ids.add(r.id);
  }
  return ids;
}

async function fetchVoucher(id: number): Promise<any | null> {
  const { rows: [v] } = await pool.query(
    `SELECT v.*, pl.name AS party_name
     FROM journal_vouchers v
     LEFT JOIN account_ledgers pl ON pl.id = v.party_ledger_id
     WHERE v.id = $1`, [id]
  );
  if (!v) return null;
  const { rows: lines } = await pool.query(
    `SELECT l.id, l.ledger_id, l.debit, l.credit, al.name AS ledger_name, al.code AS ledger_code
     FROM journal_voucher_lines l
     LEFT JOIN account_ledgers al ON al.id = l.ledger_id
     WHERE l.voucher_id = $1 ORDER BY l.id`, [id]
  );
  return serializeVoucher(v, lines);
}

function serializeVoucher(v: any, lines: any[]) {
  return {
    id: v.id,
    voucherType: v.voucher_type,
    voucherNumber: v.voucher_number,
    voucherDate: v.voucher_date,
    narration: v.narration,
    reason: v.reason,
    partyLedgerId: v.party_ledger_id,
    partyName: v.party_name ?? null,
    totalAmount: Number(v.total_amount),
    createdBy: v.created_by,
    createdAt: v.created_at,
    lines: lines.map((l: any) => ({
      id: l.id,
      ledgerId: l.ledger_id,
      ledgerName: l.ledger_name ?? "",
      ledgerCode: l.ledger_code ?? null,
      debit: Number(l.debit),
      credit: Number(l.credit),
    })),
  };
}

// ── Journal / Contra / Credit Note / Debit Note vouchers ──────────────────

router.get("/accounts/journal-vouchers", async (req, res): Promise<void> => {
  // LBAC: journal vouchers are Head Office accounting — non-HO users see nothing
  if ((req as any).employee?.branchType !== 'headoffice') { res.json([]); return; }

  const { type, fromDate, toDate } = req.query as { type?: string; fromDate?: string; toDate?: string };
  const conds: string[] = [];
  const params: any[] = [];
  if (type && JV_TYPES.has(type)) { params.push(type); conds.push(`v.voucher_type = $${params.length}`); }
  if (isDate(fromDate)) { params.push(fromDate); conds.push(`v.voucher_date >= $${params.length}`); }
  if (isDate(toDate))   { params.push(toDate);   conds.push(`v.voucher_date <= $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const { rows: vouchers } = await pool.query(
    `SELECT v.*, pl.name AS party_name
     FROM journal_vouchers v
     LEFT JOIN account_ledgers pl ON pl.id = v.party_ledger_id
     ${where}
     ORDER BY v.voucher_date DESC, v.id DESC`, params
  );

  const linesByVoucher = new Map<number, any[]>();
  if (vouchers.length > 0) {
    const { rows: lines } = await pool.query(
      `SELECT l.id, l.voucher_id, l.ledger_id, l.debit, l.credit,
              al.name AS ledger_name, al.code AS ledger_code
       FROM journal_voucher_lines l
       LEFT JOIN account_ledgers al ON al.id = l.ledger_id
       WHERE l.voucher_id = ANY($1) ORDER BY l.id`,
      [vouchers.map((v: any) => v.id)]
    );
    for (const l of lines) {
      const arr = linesByVoucher.get(l.voucher_id) ?? [];
      arr.push(l);
      linesByVoucher.set(l.voucher_id, arr);
    }
  }

  res.json(vouchers.map((v: any) => serializeVoucher(v, linesByVoucher.get(v.id) ?? [])));
});

router.post("/accounts/journal-vouchers", requireModuleAction("Vouchers", "add"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, any>;
  const voucherType = String(body.voucherType ?? "journal");
  if (!JV_TYPES.has(voucherType)) {
    res.status(400).json({ error: "voucherType must be journal, contra, credit_note or debit_note" }); return;
  }
  const voucherDate = String(body.voucherDate ?? "").slice(0, 10);
  if (!isDate(voucherDate)) { res.status(400).json({ error: "voucherDate (YYYY-MM-DD) is required" }); return; }
  const narration = body.narration ? String(body.narration).trim() || null : null;
  const reason = body.reason ? String(body.reason).trim() || null : null;
  const createdBy = (req as any).user?.username ?? "system";

  let lines: { ledgerId: number; debit: number; credit: number }[] = [];
  let partyLedgerId: number | null = null;

  if (voucherType === "journal") {
    const raw = Array.isArray(body.lines) ? body.lines : [];
    lines = raw.map((l: any) => ({
      ledgerId: Number(l?.ledgerId),
      debit: round2(Number(l?.debit ?? 0)),
      credit: round2(Number(l?.credit ?? 0)),
    }));
    if (lines.length < 2) { res.status(400).json({ error: "A journal voucher needs at least two lines" }); return; }
    for (const l of lines) {
      if (!Number.isFinite(l.ledgerId) || l.ledgerId <= 0) { res.status(400).json({ error: "Every line must have a ledger selected" }); return; }
      if (!Number.isFinite(l.debit) || !Number.isFinite(l.credit) || l.debit < 0 || l.credit < 0) {
        res.status(400).json({ error: "Amounts must be valid non-negative numbers" }); return;
      }
      if ((l.debit > 0) === (l.credit > 0)) {
        res.status(400).json({ error: "Each line must have either a debit or a credit amount (not both, not neither)" }); return;
      }
    }
    const totalDr = round2(lines.reduce((s, l) => s + l.debit, 0));
    const totalCr = round2(lines.reduce((s, l) => s + l.credit, 0));
    if (totalDr <= 0) { res.status(400).json({ error: "Voucher amount must be greater than zero" }); return; }
    if (Math.abs(totalDr - totalCr) > 0.005) {
      res.status(400).json({ error: `Voucher does not balance: debits ₹${totalDr.toFixed(2)} vs credits ₹${totalCr.toFixed(2)}` }); return;
    }
  } else if (voucherType === "contra") {
    const fromLedgerId = Number(body.fromLedgerId);
    const toLedgerId = Number(body.toLedgerId);
    const amount = round2(Number(body.amount));
    if (!fromLedgerId || !toLedgerId) { res.status(400).json({ error: "fromLedgerId and toLedgerId are required" }); return; }
    if (fromLedgerId === toLedgerId) { res.status(400).json({ error: "From and To ledgers must be different" }); return; }
    if (!(amount > 0)) { res.status(400).json({ error: "amount must be greater than zero" }); return; }
    const cashBank = await ledgerIdsUnderCodes(["STD-CASH", "STD-BANK"]);
    if (!cashBank.has(fromLedgerId) || !cashBank.has(toLedgerId)) {
      res.status(400).json({ error: "Contra entries move money between Cash and Bank ledgers only" }); return;
    }
    lines = [
      { ledgerId: toLedgerId, debit: amount, credit: 0 },
      { ledgerId: fromLedgerId, debit: 0, credit: amount },
    ];
  } else {
    // credit_note (customer) / debit_note (vendor)
    const isCN = voucherType === "credit_note";
    const partyType = isCN ? "customer" : "vendor";
    const partyId = Number(body.partyId);
    if (!partyId) { res.status(400).json({ error: `partyId (${partyType} id) is required` }); return; }
    const amount = round2(Number(body.amount));
    if (!(amount > 0)) { res.status(400).json({ error: "amount must be greater than zero" }); return; }

    const partyCode = isCN ? `CUST-${partyId}` : `VEND-${partyId}`;
    const { rows: [pl] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [partyCode]);
    if (!pl) {
      res.status(400).json({ error: `No ledger found for this ${partyType}. Re-save the ${partyType} to create its ledger.` }); return;
    }
    partyLedgerId = pl.id;

    let counterLedgerId = Number(body.counterLedgerId) || 0;
    if (!counterLedgerId) {
      const defCode = isCN ? "STD-SALES" : "STD-PUR";
      const { rows: [def] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = $1`, [defCode]);
      if (!def) { res.status(400).json({ error: "counterLedgerId is required" }); return; }
      counterLedgerId = def.id;
    }
    if (counterLedgerId === partyLedgerId) {
      res.status(400).json({ error: "Counter ledger cannot be the party's own ledger" }); return;
    }

    lines = isCN
      ? [ // sales return / rate difference: Dr Sales (reversal), Cr Customer
          { ledgerId: counterLedgerId, debit: amount, credit: 0 },
          { ledgerId: partyLedgerId!, debit: 0, credit: amount },
        ]
      : [ // purchase return: Dr Vendor, Cr Purchases (reversal)
          { ledgerId: partyLedgerId!, debit: amount, credit: 0 },
          { ledgerId: counterLedgerId, debit: 0, credit: amount },
        ];
  }

  // All referenced ledgers must exist and be postable (not groups)
  const ledgerIds = [...new Set(lines.map(l => l.ledgerId))];
  const { rows: ledgerRows } = await pool.query(
    `SELECT id, name, is_group, is_system_group FROM account_ledgers WHERE id = ANY($1)`, [ledgerIds]
  );
  if (ledgerRows.length !== ledgerIds.length) {
    res.status(400).json({ error: "One or more selected ledgers do not exist" }); return;
  }
  const grp = ledgerRows.find((l: any) => l.is_group || l.is_system_group);
  if (grp) { res.status(400).json({ error: `"${grp.name}" is a group — post to a specific ledger under it instead` }); return; }

  const totalAmount = round2(lines.reduce((s, l) => s + l.debit, 0));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const voucherNumber = await nextVoucherNumber(client, voucherType, voucherDate);
    const { rows: [v] } = await client.query(
      `INSERT INTO journal_vouchers
         (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, reason, total_amount, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [voucherType, voucherNumber, voucherDate, narration, partyLedgerId, reason, totalAmount, createdBy]
    );
    for (const l of lines) {
      await client.query(
        `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1, $2, $3, $4)`,
        [v.id, l.ledgerId, l.debit, l.credit]
      );
    }
    await client.query("COMMIT");

    logActivity({
      action: "CREATE", module: "accounts", entityType: "journal_voucher", entityId: v.id,
      description: `${VOUCHER_TYPE_LABELS[voucherType]} ${voucherNumber} — ₹${totalAmount.toFixed(2)}`,
      metadata: { after: { voucherType, voucherNumber, voucherDate, totalAmount } },
    }).catch(() => {});

    res.status(201).json(await fetchVoucher(v.id));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

router.get("/accounts/journal-vouchers/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const voucher = await fetchVoucher(id);
  if (!voucher) { res.status(404).json({ error: "Voucher not found" }); return; }
  res.json(voucher);
});

router.delete("/accounts/journal-vouchers/:id", requireModuleAction("Vouchers", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rows: [v] } = await pool.query(
    `DELETE FROM journal_vouchers WHERE id = $1 RETURNING voucher_number, voucher_type, total_amount`, [id]
  );
  if (!v) { res.status(404).json({ error: "Voucher not found" }); return; }
  logActivity({
    action: "DELETE", module: "accounts", entityType: "journal_voucher", entityId: id,
    description: `Deleted ${VOUCHER_TYPE_LABELS[v.voucher_type] ?? v.voucher_type} ${v.voucher_number} — ₹${Number(v.total_amount).toFixed(2)}`,
  }).catch(() => {});
  res.status(204).send();
});

// ── Derived double-entry postings ──────────────────────────────────────────
// One shared builder so the Trial Balance, Cash Book and Bank Book always
// agree with each other. Sales/purchases have no stored ledger postings, so
// they are derived here the same way the financial statements imply them.

interface Posting {
  date: string;
  ledgerId: number;
  debit: number;
  credit: number;
  source: string;
  voucherNumber: string | null;
  description: string;
}

export async function buildDerivedPostings(opts: { toDate?: string } = {}): Promise<Posting[]> {
  const { toDate } = opts;
  const postings: Posting[] = [];
  const push = (p: Posting) => {
    if (p.ledgerId && (p.debit > 0.004 || p.credit > 0.004)) postings.push(p);
  };
  const upTo = (col: string, params: any[]) => {
    if (!isDate(toDate)) return "";
    params.push(toDate);
    return ` AND ${col} <= $${params.length}`;
  };

  const { rows: ledgerRows } = await pool.query(`SELECT id, code, name FROM account_ledgers`);
  const byCode = new Map<string, any>(ledgerRows.filter((r: any) => r.code).map((r: any) => [r.code, r]));
  const idOf = (code: string): number => byCode.get(code)?.id ?? 0;
  const stdCash = idOf("STD-CASH"), stdBank = idOf("STD-BANK"), stdSales = idOf("STD-SALES"),
        stdDtx = idOf("STD-DTX"), stdPur = idOf("STD-PUR"), elecClr = idOf("STD-ELEC-CLR"),
        debtors = idOf("SYS-DEBTORS"), creditors = idOf("SYS-CREDITORS");

  // Location → cash / sales ledger mapping
  const { rows: locRows } = await pool.query(`
    SELECT 'warehouse' AS lt, id, cash_ledger_id, sales_ledger_id FROM warehouses
    UNION ALL
    SELECT 'outlet' AS lt, id, cash_ledger_id, sales_ledger_id FROM outlets
  `);
  const locMap = new Map<string, any>(locRows.map((r: any) => [`${r.lt}:${r.id}`, r]));

  // 1. Payments: Dr paid_to / Cr paid_from
  const pp: any[] = [];
  const { rows: pays } = await pool.query(
    `SELECT payment_date AS date, paid_from_ledger_id AS f, paid_to_ledger_id AS t,
            amount, voucher_number, narration
     FROM payments WHERE 1=1${upTo("payment_date", pp)}`, pp
  );
  for (const r of pays) {
    const amt = Number(r.amount);
    const desc = r.narration || "Payment";
    push({ date: r.date, ledgerId: r.t, debit: amt, credit: 0, source: "payment", voucherNumber: r.voucher_number, description: desc });
    push({ date: r.date, ledgerId: r.f, debit: 0, credit: amt, source: "payment", voucherNumber: r.voucher_number, description: desc });
  }

  // 2. Receipts: Dr received_in / Cr received_from
  // Sale-linked receipts are EXCLUDED: the sales flow persists receipt rows at
  // sale creation (voucher_number = invoice_number) and at payment collection
  // (linked via sale_payments.clearing_receipt_id), but those rows don't split
  // GST and credit Sales on collection. Section 5 derives the correct postings
  // from sales + sale_payments instead — including both would double-count.
  const rp: any[] = [];
  const { rows: recs } = await pool.query(
    `SELECT receipt_date AS date, received_from_ledger_id AS f, received_in_ledger_id AS t,
            amount, voucher_number, narration
     FROM receipts
     WHERE id NOT IN (SELECT clearing_receipt_id FROM sale_payments WHERE clearing_receipt_id IS NOT NULL)
       AND (voucher_number IS NULL OR voucher_number NOT IN (SELECT invoice_number FROM sales WHERE invoice_number IS NOT NULL))
       ${upTo("receipt_date", rp)}`, rp
  );
  for (const r of recs) {
    const amt = Number(r.amount);
    const desc = r.narration || "Receipt";
    push({ date: r.date, ledgerId: r.t, debit: amt, credit: 0, source: "receipt", voucherNumber: r.voucher_number, description: desc });
    push({ date: r.date, ledgerId: r.f, debit: 0, credit: amt, source: "receipt", voucherNumber: r.voucher_number, description: desc });
  }

  // 3. Journal voucher lines (journal, contra, credit/debit notes) — as stored
  const jp: any[] = [];
  const { rows: jls } = await pool.query(
    `SELECT v.voucher_date AS date, v.voucher_number, v.voucher_type, v.narration,
            l.ledger_id, l.debit, l.credit
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     WHERE 1=1${upTo("v.voucher_date", jp)}`, jp
  );
  for (const r of jls) {
    push({
      date: r.date, ledgerId: r.ledger_id, debit: Number(r.debit), credit: Number(r.credit),
      source: r.voucher_type, voucherNumber: r.voucher_number,
      description: r.narration || VOUCHER_TYPE_LABELS[r.voucher_type] || "Journal",
    });
  }

  // 4. Legacy direct expenses: Dr expense ledger / Cr Cash or Bank root
  const ep: any[] = [];
  const { rows: exps } = await pool.query(
    `SELECT e.expense_date AS date, e.ledger_account_id AS lid, e.amount, e.description,
            cb.account_type AS cb_type
     FROM expenses e
     LEFT JOIN cash_bank_accounts cb ON cb.id = e.payment_account_id
     WHERE 1=1${upTo("e.expense_date", ep)}`, ep
  );
  for (const r of exps) {
    const amt = Number(r.amount);
    const creditLedger = String(r.cb_type ?? "").toLowerCase().includes("bank") ? stdBank : stdCash;
    const desc = r.description || "Expense";
    push({ date: r.date, ledgerId: r.lid, debit: amt, credit: 0, source: "expense", voucherNumber: null, description: desc });
    push({ date: r.date, ledgerId: creditLedger, debit: 0, credit: amt, source: "expense", voucherNumber: null, description: desc });
  }

  // 5. Sales: Cr sales ledger (net) + Cr Output GST (split CGST/SGST/IGST when
  //    line detail exists, else Duty & Tax lump); Dr cash/clearing via
  //    sale_payments; Dr customer ledger for any unpaid remainder.
  const outCgst = byCode.get("STD-OUT-CGST")?.id, outSgst = byCode.get("STD-OUT-SGST")?.id, outIgst = byCode.get("STD-OUT-IGST")?.id;
  const inpCgst = byCode.get("STD-INP-CGST")?.id, inpSgst = byCode.get("STD-INP-SGST")?.id, inpIgst = byCode.get("STD-INP-IGST")?.id;
  const sp: any[] = [];
  const { rows: sales } = await pool.query(
    `SELECT id, invoice_number, sale_date, total_amount, tax_total, amount_paid,
            payment_mode, customer_id, location_type, location_id, line_items
     FROM sales WHERE 1=1${upTo("sale_date", sp)}`, sp
  );
  const spp: any[] = [];
  const { rows: salePays } = await pool.query(
    `SELECT sp.sale_id, sp.payment_date, sp.method, sp.amount
     FROM sale_payments sp WHERE 1=1${upTo("sp.payment_date", spp)}`, spp
  );
  const spBySale = new Map<number, any[]>();
  for (const r of salePays) {
    const arr = spBySale.get(r.sale_id) ?? [];
    arr.push(r);
    spBySale.set(r.sale_id, arr);
  }

  for (const s of sales) {
    const total = Number(s.total_amount);
    const tax = Number(s.tax_total ?? 0);
    const net = round2(total - tax);
    const inv = s.invoice_number || `Sale #${s.id}`;
    const loc = locMap.get(`${s.location_type}:${s.location_id}`);
    const salesLedger = loc?.sales_ledger_id ?? stdSales;
    const cashLedger = loc?.cash_ledger_id ?? stdCash;

    push({ date: s.sale_date, ledgerId: salesLedger, debit: 0, credit: net, source: "sale", voucherNumber: s.invoice_number, description: `Sales ${inv}` });
    if (tax > 0) {
      const sLines = (s.line_items ?? []) as any[];
      let cg = 0, sg = 0, ig = 0;
      for (const li of sLines) { const h = lineTaxHeads(li); cg += h.cgst; sg += h.sgst; ig += h.igst; }
      cg = round2(cg); sg = round2(sg); ig = round2(ig);
      const split = round2(cg + sg + ig);
      if (outCgst && outSgst && outIgst && split > 0.004 && Math.abs(split - tax) <= 0.05) {
        if (cg > 0.004) push({ date: s.sale_date, ledgerId: outCgst, debit: 0, credit: cg, source: "sale", voucherNumber: s.invoice_number, description: `Output CGST — ${inv}` });
        if (sg > 0.004) push({ date: s.sale_date, ledgerId: outSgst, debit: 0, credit: sg, source: "sale", voucherNumber: s.invoice_number, description: `Output SGST — ${inv}` });
        if (ig > 0.004) push({ date: s.sale_date, ledgerId: outIgst, debit: 0, credit: ig, source: "sale", voucherNumber: s.invoice_number, description: `Output IGST — ${inv}` });
        const resid = round2(tax - split);
        if (resid > 0.004) push({ date: s.sale_date, ledgerId: stdDtx, debit: 0, credit: resid, source: "sale", voucherNumber: s.invoice_number, description: `GST rounding — ${inv}` });
        else if (resid < -0.004) push({ date: s.sale_date, ledgerId: stdDtx, debit: -resid, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `GST rounding — ${inv}` });
      } else {
        push({ date: s.sale_date, ledgerId: stdDtx, debit: 0, credit: tax, source: "sale", voucherNumber: s.invoice_number, description: `GST on ${inv}` });
      }
    }

    let paidViaSp = 0;
    for (const p of spBySale.get(s.id) ?? []) {
      const amt = Number(p.amount);
      paidViaSp += amt;
      const drLedger = p.method === "cash" ? cashLedger : elecClr;
      push({ date: p.payment_date, ledgerId: drLedger, debit: amt, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `${p.method === "cash" ? "Cash" : "Electronic"} received — ${inv}` });
    }

    const amountPaid = Number(s.amount_paid ?? 0);
    const extra = round2(amountPaid - paidViaSp);
    if (extra > 0.004) {
      const drLedger = s.payment_mode === "cash" ? cashLedger : elecClr;
      push({ date: s.sale_date, ledgerId: drLedger, debit: extra, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `Received — ${inv}` });
    }

    const due = round2(total - amountPaid);
    if (due > 0.004) {
      const custLedger = s.customer_id ? (byCode.get(`CUST-${s.customer_id}`)?.id ?? debtors) : debtors;
      push({ date: s.sale_date, ledgerId: custLedger, debit: due, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `Outstanding — ${inv}` });
    }
  }

  // 6. Purchases: Dr Purchases (taxable + round-off) + Dr Input GST / Cr vendor.
  //    Legacy rows without line-level GST detail stay as a single lump debit.
  const pup: any[] = [];
  const { rows: purchases } = await pool.query(
    `SELECT id, vendor_id, purchase_date, invoice_number, total_amount, tax_total, line_items
     FROM purchases WHERE 1=1${upTo("purchase_date", pup)}`, pup
  );
  for (const p of purchases) {
    const amt = Number(p.total_amount);
    const bill = p.invoice_number || `Purchase #${p.id}`;
    const vendLedger = byCode.get(`VEND-${p.vendor_id}`)?.id ?? creditors;
    const pLines = (p.line_items ?? []) as any[];
    let cg = 0, sg = 0, ig = 0;
    for (const li of pLines) { const h = lineTaxHeads(li); cg += h.cgst; sg += h.sgst; ig += h.igst; }
    cg = round2(cg); sg = round2(sg); ig = round2(ig);
    const inputTax = round2(cg + sg + ig);
    // Split only when the head split is internally consistent: per-line heads
    // must agree with the per-line taxAmount sum, and with the stored document
    // tax_total when one exists (legacy purchases have tax_total = 0).
    // Anything inconsistent keeps the legacy lump posting.
    const lineTaxSum = round2(pLines.reduce((a, li) => a + Number(li?.taxAmount ?? 0), 0));
    const pTaxTotal = Number(p.tax_total ?? 0);
    const consistent =
      (lineTaxSum <= 0.004 || Math.abs(inputTax - lineTaxSum) <= 0.05) &&
      (pTaxTotal <= 0.004 || Math.abs(inputTax - pTaxTotal) <= 0.05);
    if (inpCgst && inpSgst && inpIgst && inputTax > 0.004 && inputTax < amt && consistent) {
      push({ date: p.purchase_date, ledgerId: stdPur, debit: round2(amt - inputTax), credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Purchase ${bill}` });
      if (cg > 0.004) push({ date: p.purchase_date, ledgerId: inpCgst, debit: cg, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Input CGST — ${bill}` });
      if (sg > 0.004) push({ date: p.purchase_date, ledgerId: inpSgst, debit: sg, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Input SGST — ${bill}` });
      if (ig > 0.004) push({ date: p.purchase_date, ledgerId: inpIgst, debit: ig, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Input IGST — ${bill}` });
    } else {
      push({ date: p.purchase_date, ledgerId: stdPur, debit: amt, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Purchase ${bill}` });
    }
    push({ date: p.purchase_date, ledgerId: vendLedger, debit: 0, credit: amt, source: "purchase", voucherNumber: p.invoice_number, description: `Purchase ${bill}` });
  }

  return postings;
}

// ── Day Book ───────────────────────────────────────────────────────────────

router.get("/accounts/day-book", requireModuleView("Books"), async (req, res): Promise<void> => {
  // LBAC: the day book is a Head Office accounting view
  if ((req as any).employee?.branchType !== 'headoffice') { res.json({ date: "", entries: [] }); return; }
  const q = String((req.query as any).date ?? "");
  const date = isDate(q) ? q : new Date().toISOString().slice(0, 10);

  const entries: any[] = [];

  // Journal-family vouchers
  const { rows: jvs } = await pool.query(
    `SELECT v.id, v.voucher_type, v.voucher_number, v.narration, v.total_amount
     FROM journal_vouchers v WHERE v.voucher_date = $1 ORDER BY v.id`, [date]
  );
  if (jvs.length > 0) {
    const { rows: jlines } = await pool.query(
      `SELECT l.voucher_id, l.debit, l.credit, al.name AS ledger_name
       FROM journal_voucher_lines l
       LEFT JOIN account_ledgers al ON al.id = l.ledger_id
       WHERE l.voucher_id = ANY($1) ORDER BY l.id`, [jvs.map((v: any) => v.id)]
    );
    for (const v of jvs) {
      const lines = jlines.filter((l: any) => l.voucher_id === v.id);
      const drNames = lines.filter((l: any) => Number(l.debit) > 0).map((l: any) => l.ledger_name).join(", ");
      const crNames = lines.filter((l: any) => Number(l.credit) > 0).map((l: any) => l.ledger_name).join(", ");
      entries.push({
        id: `jv-${v.id}`, refId: v.id, source: v.voucher_type,
        voucherNumber: v.voucher_number,
        particulars: `Dr ${drNames} / Cr ${crNames}`,
        narration: v.narration, amount: Number(v.total_amount),
      });
    }
  }

  // Payments
  const { rows: pays } = await pool.query(
    `SELECT p.id, p.voucher_number, p.amount, p.narration, pf.name AS from_name, pt.name AS to_name
     FROM payments p
     LEFT JOIN account_ledgers pf ON pf.id = p.paid_from_ledger_id
     LEFT JOIN account_ledgers pt ON pt.id = p.paid_to_ledger_id
     WHERE p.payment_date = $1 ORDER BY p.id`, [date]
  );
  for (const p of pays) entries.push({
    id: `pay-${p.id}`, refId: p.id, source: "payment", voucherNumber: p.voucher_number,
    particulars: `${p.from_name ?? "?"} → ${p.to_name ?? "?"}`, narration: p.narration, amount: Number(p.amount),
  });

  // Receipts — sale-linked receipt rows are excluded (the sale itself is
  // already listed below; showing its auto-receipt too would double-list it)
  const { rows: recs } = await pool.query(
    `SELECT r.id, r.voucher_number, r.amount, r.narration, rf.name AS from_name, ri.name AS in_name
     FROM receipts r
     LEFT JOIN account_ledgers rf ON rf.id = r.received_from_ledger_id
     LEFT JOIN account_ledgers ri ON ri.id = r.received_in_ledger_id
     WHERE r.receipt_date = $1
       AND r.id NOT IN (SELECT clearing_receipt_id FROM sale_payments WHERE clearing_receipt_id IS NOT NULL)
       AND (r.voucher_number IS NULL OR r.voucher_number NOT IN (SELECT invoice_number FROM sales WHERE invoice_number IS NOT NULL))
     ORDER BY r.id`, [date]
  );
  for (const r of recs) entries.push({
    id: `rec-${r.id}`, refId: r.id, source: "receipt", voucherNumber: r.voucher_number,
    particulars: `${r.from_name ?? "?"} → ${r.in_name ?? "?"}`, narration: r.narration, amount: Number(r.amount),
  });

  // Sales
  const { rows: sales } = await pool.query(
    `SELECT s.id, s.invoice_number, s.total_amount, c.name AS customer_name,
            COALESCE(w.name, o.name) AS location_name
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN warehouses w ON s.location_type = 'warehouse' AND w.id = s.location_id
     LEFT JOIN outlets o    ON s.location_type = 'outlet'    AND o.id = s.location_id
     WHERE s.sale_date = $1 ORDER BY s.id`, [date]
  );
  for (const s of sales) entries.push({
    id: `sale-${s.id}`, refId: s.id, source: "sale", voucherNumber: s.invoice_number,
    particulars: [s.customer_name, s.location_name].filter(Boolean).join(" — ") || "Walk-in",
    narration: null, amount: Number(s.total_amount),
  });

  // Purchases
  const { rows: purchases } = await pool.query(
    `SELECT p.id, p.invoice_number, p.total_amount, v.name AS vendor_name
     FROM purchases p
     LEFT JOIN vendors v ON v.id = p.vendor_id
     WHERE p.purchase_date = $1 ORDER BY p.id`, [date]
  );
  for (const p of purchases) entries.push({
    id: `pur-${p.id}`, refId: p.id, source: "purchase",
    voucherNumber: p.invoice_number ?? `#${p.id}`,
    particulars: p.vendor_name ?? "Vendor", narration: null, amount: Number(p.total_amount),
  });

  // Legacy direct expenses
  const { rows: exps } = await pool.query(
    `SELECT e.id, e.amount, e.description, al.name AS ledger_name
     FROM expenses e
     LEFT JOIN account_ledgers al ON al.id = e.ledger_account_id
     WHERE e.expense_date = $1 ORDER BY e.id`, [date]
  );
  for (const e of exps) entries.push({
    id: `exp-${e.id}`, refId: e.id, source: "expense", voucherNumber: null,
    particulars: e.ledger_name ?? "Expense", narration: e.description, amount: Number(e.amount),
  });

  const byType: Record<string, { count: number; amount: number }> = {};
  for (const e of entries) {
    const t = byType[e.source] ?? { count: 0, amount: 0 };
    t.count += 1;
    t.amount = round2(t.amount + e.amount);
    byType[e.source] = t;
  }

  res.json({
    date,
    entries,
    totals: {
      count: entries.length,
      amount: round2(entries.reduce((s, e) => s + e.amount, 0)),
      byType,
    },
  });
});

// ── Cash Book / Bank Book ──────────────────────────────────────────────────

// Ledger options for the book selector (cash or bank subtree)
router.get("/accounts/cash-bank-book/ledgers", requireModuleView("Cash & Bank"), async (req, res): Promise<void> => {
  // LBAC: full cash-bank ledger list is Head Office only
  if ((req as any).employee?.branchType !== 'headoffice') { res.json([]); return; }
  const kind = (req.query as any).kind === "bank" ? "bank" : "cash";
  const ids = await ledgerIdsUnderCodes([kind === "bank" ? "STD-BANK" : "STD-CASH"]);
  if (ids.size === 0) { res.json([]); return; }
  const { rows } = await pool.query(
    `SELECT id, name, code, is_group FROM account_ledgers WHERE id = ANY($1) ORDER BY name`,
    [[...ids]]
  );
  res.json(rows.map((r: any) => ({
    id: r.id, name: r.name, code: r.code ?? null, isGroup: !!r.is_group,
  })));
});

router.get("/accounts/cash-bank-book", requireModuleView("Cash & Bank"), async (req, res): Promise<void> => {
  // LBAC: full cash-bank book is Head Office only
  if ((req as any).employee?.branchType !== 'headoffice') { res.json({ ledger: null, entries: [], openingBalance: 0, closingBalance: 0 }); return; }
  const ledgerId = Number((req.query as any).ledgerId);
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };
  if (!ledgerId) { res.status(400).json({ error: "ledgerId is required" }); return; }

  const { rows: [ledger] } = await pool.query(
    `SELECT id, name, code, is_group FROM account_ledgers WHERE id = $1`, [ledgerId]
  );
  if (!ledger) { res.status(404).json({ error: "Ledger not found" }); return; }

  // Selecting a group (e.g. the Cash root) consolidates its whole subtree
  const subtree = await ledgerSubtreeIds(ledgerId);

  const postings = (await buildDerivedPostings({ toDate: isDate(toDate) ? toDate : undefined }))
    .filter(p => subtree.has(p.ledgerId));
  postings.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));

  const from = isDate(fromDate) ? fromDate : null;
  let opening = 0;
  const inRange: Posting[] = [];
  for (const p of postings) {
    if (from && p.date < from) opening = round2(opening + p.debit - p.credit);
    else inRange.push(p);
  }

  let balance = opening;
  const entries = inRange.map(p => {
    balance = round2(balance + p.debit - p.credit);
    return {
      date: p.date, source: p.source, voucherNumber: p.voucherNumber,
      description: p.description, debit: p.debit, credit: p.credit, balance,
    };
  });

  res.json({
    ledger: { id: ledger.id, name: ledger.name, code: ledger.code ?? null },
    openingBalance: opening,
    entries,
    totalDebit: round2(entries.reduce((s, e) => s + e.debit, 0)),
    totalCredit: round2(entries.reduce((s, e) => s + e.credit, 0)),
    closingBalance: balance,
  });
});

// ── Trial Balance ──────────────────────────────────────────────────────────

router.get("/accounts/trial-balance", requireModuleView("Books"), async (req, res): Promise<void> => {
  // LBAC: the trial balance is a Head Office accounting view
  if ((req as any).employee?.branchType !== 'headoffice') { res.json([]); return; }
  const { fromDate, toDate } = req.query as { fromDate?: string; toDate?: string };

  let postings = await buildDerivedPostings({ toDate: isDate(toDate) ? toDate : undefined });
  if (isDate(fromDate)) postings = postings.filter(p => p.date >= fromDate);

  const agg = new Map<number, { dr: number; cr: number }>();
  for (const p of postings) {
    const a = agg.get(p.ledgerId) ?? { dr: 0, cr: 0 };
    a.dr = round2(a.dr + p.debit);
    a.cr = round2(a.cr + p.credit);
    agg.set(p.ledgerId, a);
  }

  const { rows: ledgers } = await pool.query(
    `SELECT l.id, l.name, l.type, l.code, l.parent_id, p.name AS parent_name
     FROM account_ledgers l
     LEFT JOIN account_ledgers p ON p.id = l.parent_id`
  );
  const ledgerById = new Map<number, any>(ledgers.map((l: any) => [l.id, l]));

  const rows: any[] = [];
  for (const [ledgerId, a] of agg) {
    const net = round2(a.dr - a.cr);
    if (Math.abs(net) < 0.005) continue;
    const l = ledgerById.get(ledgerId);
    rows.push({
      ledgerId,
      name: l?.name ?? `Ledger #${ledgerId}`,
      code: l?.code ?? null,
      type: l?.type ?? null,
      groupName: l?.parent_name ?? null,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    });
  }
  rows.sort((a, b) => String(a.groupName ?? "").localeCompare(String(b.groupName ?? "")) || a.name.localeCompare(b.name));

  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  const difference = round2(totalDebit - totalCredit);

  res.json({
    fromDate: isDate(fromDate) ? fromDate : null,
    toDate: isDate(toDate) ? toDate : null,
    rows,
    totalDebit,
    totalCredit,
    difference,
    balanced: Math.abs(difference) < 0.01,
  });
});

export default router;
