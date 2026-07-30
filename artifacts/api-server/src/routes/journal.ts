import { Router } from "express";
import { requireModuleAction, requireModuleView } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { nextVoucherNumber, VOUCHER_TYPE_LABELS } from "../lib/voucherNumber";
import { logActivity } from "../lib/audit";
import { lineTaxHeads } from "../lib/gst";
import { clearsThroughBank } from "../lib/paymentModes";
import { isIsoDate } from "../lib/dateInput";

const router = Router();

const JV_TYPES = new Set(["journal", "contra", "credit_note", "debit_note"]);
const round2 = (n: number) => Math.round(n * 100) / 100;
// Shape AND calendar validity (rejects 2026-02-30) — these values reach real
// DATE columns, where an impossible date raises 22007 instead of storing text.
const isDate = (s: unknown): s is string => isIsoDate(s);
/**
 * A pg `date` column parses to a Date at LOCAL midnight. `toISOString()` on that
 * would shift the day backwards in any timezone west of UTC, so read the local
 * calendar fields instead — a voucher dated the 1st must not report as the 31st.
 */
const toLocalISODate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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

// Serves Journal, Contra, Notes and Vouchers pages (all under Vouchers).
router.get("/accounts/journal-vouchers", requireModuleView("page:/accounts/vouchers"), async (req, res): Promise<void> => {
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

router.post("/accounts/journal-vouchers", requireModuleAction("page:/accounts/vouchers", "add"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, any>;
  const voucherType = String(body.voucherType ?? "journal");
  if (!JV_TYPES.has(voucherType)) {
    res.status(400).json({ error: "voucherType must be journal, contra, credit_note or debit_note" }); return;
  }
  const voucherDate = String(body.voucherDate ?? "").slice(0, 10);
  if (!isDate(voucherDate)) { res.status(400).json({ error: "voucherDate (YYYY-MM-DD) is required" }); return; }
  const narration = body.narration ? String(body.narration).trim() || null : null;
  const reason = body.reason ? String(body.reason).trim() || null : null;
  const createdBy = (req as any).employee?.username ?? "system";

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

router.get("/accounts/journal-vouchers/:id", requireModuleView("page:/accounts/vouchers"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const voucher = await fetchVoucher(id);
  if (!voucher) { res.status(404).json({ error: "Voucher not found" }); return; }
  res.json(voucher);
});

router.delete("/accounts/journal-vouchers/:id", requireModuleAction("page:/accounts/vouchers", "delete"), async (req, res): Promise<void> => {
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

export interface Posting {
  date: string;
  /** Stable identity of the source document, so consumers can regroup the
   *  legs of one entry without guessing from voucher number + description. */
  entryId: string;
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
  /**
   * `date` is declared as a YYYY-MM-DD string, but pg hands back a JS Date for
   * every `date`/`timestamptz` column, so half the sources below would push a
   * Date object into a field typed `string`. Consumers then either crash
   * (`p.date.localeCompare is not a function`) or silently mis-sort, because
   * a Date stringifies to "Fri Jul 28 2026 …" which does not compare against
   * "2026-07-28". Normalising once here makes the declared type true for every
   * consumer instead of asking each one to remember `String(p.date)`.
   */
  const push = (p: Posting) => {
    if (!p.ledgerId || (p.debit <= 0.004 && p.credit <= 0.004)) return;
    const d = p.date as unknown;
    postings.push(
      typeof d === "string"
        ? (d.length === 10 ? p : { ...p, date: d.slice(0, 10) })
        : { ...p, date: d instanceof Date ? toLocalISODate(d) : String(d ?? "").slice(0, 10) },
    );
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
  // Inter-branch transfer ledgers. A cross-GSTIN transfer raises a real tax
  // invoice, but it is a movement of own stock, not turnover — so its value
  // parks in the balance-sheet clearing ledger instead of Sales/Purchases,
  // which is what keeps transfers out of the P&L entirely.
  const branchTrf = idOf("STD-BRANCH-TRF"),
        branchDebtor = idOf("STD-BRANCH-DEBTOR"),
        branchCreditor = idOf("STD-BRANCH-CREDITOR");

  // Location → cash / sales / purchase ledger mapping. A location's purchases
  // debit its own purchase ledger, so each warehouse's buying shows separately
  // in the books instead of being lumped into one company-wide Purchases total.
  // Outlets have no purchase ledger of their own (they are sales points, stocked
  // by transfer), so theirs is NULL and falls back to the company Purchases ledger.
  const { rows: locRows } = await pool.query(`
    SELECT 'warehouse' AS lt, id, cash_ledger_id, sales_ledger_id, purchase_ledger_id FROM warehouses
    UNION ALL
    SELECT 'outlet' AS lt, id, cash_ledger_id, sales_ledger_id, NULL::integer AS purchase_ledger_id FROM outlets
  `);
  const locMap = new Map<string, any>(locRows.map((r: any) => [`${r.lt}:${r.id}`, r]));

  // 1. Payments: Dr paid_to / Cr paid_from
  const pp: any[] = [];
  const { rows: pays } = await pool.query(
    `SELECT id, payment_date AS date, paid_from_ledger_id AS f, paid_to_ledger_id AS t,
            amount, voucher_number, narration
     FROM payments WHERE 1=1${upTo("payment_date", pp)}`, pp
  );
  for (const r of pays) {
    const amt = Number(r.amount);
    const desc = r.narration || "Payment";
    const eid = `payment:${r.id}`;
    push({ entryId: eid, date: r.date, ledgerId: r.t, debit: amt, credit: 0, source: "payment", voucherNumber: r.voucher_number, description: desc });
    push({ entryId: eid, date: r.date, ledgerId: r.f, debit: 0, credit: amt, source: "payment", voucherNumber: r.voucher_number, description: desc });
  }

  // 2. Receipts: Dr received_in / Cr received_from
  // Sale-linked receipts are EXCLUDED: the sales flow persists receipt rows at
  // sale creation (voucher_number = invoice_number) and at payment collection
  // (linked via sale_payments.clearing_receipt_id), but those rows don't split
  // GST and credit Sales on collection. Section 5 derives the correct postings
  // from sales + sale_payments instead — including both would double-count.
  const rp: any[] = [];
  const { rows: recs } = await pool.query(
    `SELECT id, receipt_date AS date, received_from_ledger_id AS f, received_in_ledger_id AS t,
            amount, voucher_number, narration
     FROM receipts
     WHERE id NOT IN (SELECT clearing_receipt_id FROM sale_payments WHERE clearing_receipt_id IS NOT NULL)
       AND (voucher_number IS NULL OR voucher_number NOT IN (SELECT invoice_number FROM sales WHERE invoice_number IS NOT NULL))
       ${upTo("receipt_date", rp)}`, rp
  );
  for (const r of recs) {
    const amt = Number(r.amount);
    const desc = r.narration || "Receipt";
    const eid = `receipt:${r.id}`;
    push({ entryId: eid, date: r.date, ledgerId: r.t, debit: amt, credit: 0, source: "receipt", voucherNumber: r.voucher_number, description: desc });
    push({ entryId: eid, date: r.date, ledgerId: r.f, debit: 0, credit: amt, source: "receipt", voucherNumber: r.voucher_number, description: desc });
  }

  // 3. Journal voucher lines (journal, contra, credit/debit notes) — as stored
  const jp: any[] = [];
  const { rows: jls } = await pool.query(
    `SELECT v.id AS voucher_id, v.voucher_date AS date, v.voucher_number, v.voucher_type, v.narration,
            l.ledger_id, l.debit, l.credit
     FROM journal_voucher_lines l
     JOIN journal_vouchers v ON v.id = l.voucher_id
     WHERE 1=1${upTo("v.voucher_date", jp)}`, jp
  );
  for (const r of jls) {
    push({
      entryId: `jv:${r.voucher_id}`,
      date: r.date, ledgerId: r.ledger_id, debit: Number(r.debit), credit: Number(r.credit),
      source: r.voucher_type, voucherNumber: r.voucher_number,
      description: r.narration || VOUCHER_TYPE_LABELS[r.voucher_type] || "Journal",
    });
  }

  // 4. Legacy direct expenses: Dr expense ledger / Cr Cash or Bank root
  const ep: any[] = [];
  const { rows: exps } = await pool.query(
    `SELECT e.id, e.expense_number, e.expense_date AS date, e.ledger_account_id AS lid, e.amount, e.description,
            cb.account_type AS cb_type
     FROM expenses e
     LEFT JOIN cash_bank_accounts cb ON cb.id = e.payment_account_id
     WHERE 1=1${upTo("e.expense_date", ep)}`, ep
  );
  for (const r of exps) {
    const amt = Number(r.amount);
    const creditLedger = String(r.cb_type ?? "").toLowerCase().includes("bank") ? stdBank : stdCash;
    const desc = r.description || "Expense";
    const eid = `expense:${r.id}`;
    push({ entryId: eid, date: r.date, ledgerId: r.lid, debit: amt, credit: 0, source: "expense", voucherNumber: r.expense_number ?? null, description: desc });
    push({ entryId: eid, date: r.date, ledgerId: creditLedger, debit: 0, credit: amt, source: "expense", voucherNumber: r.expense_number ?? null, description: desc });
  }

  // 5. Sales: Cr sales ledger (net) + Cr Output GST (split CGST/SGST/IGST when
  //    line detail exists, else Duty & Tax lump); Dr cash/clearing via
  //    sale_payments; Dr customer ledger for any unpaid remainder.
  const outCgst = byCode.get("STD-OUT-CGST")?.id, outSgst = byCode.get("STD-OUT-SGST")?.id, outIgst = byCode.get("STD-OUT-IGST")?.id;
  const inpCgst = byCode.get("STD-INP-CGST")?.id, inpSgst = byCode.get("STD-INP-SGST")?.id, inpIgst = byCode.get("STD-INP-IGST")?.id;
  const sp: any[] = [];
  const { rows: sales } = await pool.query(
    // A cancelled customer invoice carries no revenue, no tax and no debt, so
    // it must not post at all — leaving it in was what let a cancelled bill go
    // on inflating turnover and output GST after the fact.
    //
    // Cancelled BRANCH-TRANSFER invoices are the deliberate exception and stay
    // in: rejection raises a credit note that reverses them, so dropping the
    // invoice as well would subtract the same amount twice.
    `SELECT id, invoice_number, sale_date, total_amount, tax_total, amount_paid,
            payment_mode, customer_id, location_type, location_id, line_items,
            branch_transfer_id
     FROM sales
     WHERE (cancelled_at IS NULL OR branch_transfer_id IS NOT NULL)
       ${upTo("sale_date", sp)}`, sp
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
    // A branch-transfer invoice credits the inter-branch clearing ledger, never
    // a sales ledger. It replaces the dispatch journal voucher that used to be
    // raised for the same transfer — both would double the revenue and the tax.
    const isBranchTransfer = s.branch_transfer_id != null;
    const salesLedger = isBranchTransfer
      ? (branchTrf || stdSales)
      : (loc?.sales_ledger_id ?? stdSales);
    const cashLedger = loc?.cash_ledger_id ?? stdCash;
    const eid = `sale:${s.id}`;

    push({ entryId: eid, date: s.sale_date, ledgerId: salesLedger, debit: 0, credit: net, source: "sale", voucherNumber: s.invoice_number, description: isBranchTransfer ? `Branch transfer out — ${inv}` : `Sales ${inv}` });
    if (tax > 0) {
      const sLines = (s.line_items ?? []) as any[];
      let cg = 0, sg = 0, ig = 0;
      for (const li of sLines) { const h = lineTaxHeads(li); cg += h.cgst; sg += h.sgst; ig += h.igst; }
      cg = round2(cg); sg = round2(sg); ig = round2(ig);
      const split = round2(cg + sg + ig);
      if (outCgst && outSgst && outIgst && split > 0.004 && Math.abs(split - tax) <= 0.05) {
        if (cg > 0.004) push({ entryId: eid, date: s.sale_date, ledgerId: outCgst, debit: 0, credit: cg, source: "sale", voucherNumber: s.invoice_number, description: `Output CGST — ${inv}` });
        if (sg > 0.004) push({ entryId: eid, date: s.sale_date, ledgerId: outSgst, debit: 0, credit: sg, source: "sale", voucherNumber: s.invoice_number, description: `Output SGST — ${inv}` });
        if (ig > 0.004) push({ entryId: eid, date: s.sale_date, ledgerId: outIgst, debit: 0, credit: ig, source: "sale", voucherNumber: s.invoice_number, description: `Output IGST — ${inv}` });
        const resid = round2(tax - split);
        if (resid > 0.004) push({ entryId: eid, date: s.sale_date, ledgerId: stdDtx, debit: 0, credit: resid, source: "sale", voucherNumber: s.invoice_number, description: `GST rounding — ${inv}` });
        else if (resid < -0.004) push({ entryId: eid, date: s.sale_date, ledgerId: stdDtx, debit: -resid, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `GST rounding — ${inv}` });
      } else {
        push({ entryId: eid, date: s.sale_date, ledgerId: stdDtx, debit: 0, credit: tax, source: "sale", voucherNumber: s.invoice_number, description: `GST on ${inv}` });
      }
    }

    // Branch transfers are never settled in cash and never sit against a
    // customer: the whole invoice is owed by the receiving branch. Note that a
    // CANCELLED transfer invoice is still posted here on purpose — the credit
    // note raised at rejection is what reverses it, and skipping the invoice
    // as well would subtract the same amount twice.
    if (isBranchTransfer) {
      push({ entryId: eid, date: s.sale_date, ledgerId: branchDebtor || debtors, debit: total, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `Due from branch — ${inv}` });
      continue;
    }

    let paidViaSp = 0;
    for (const p of spBySale.get(s.id) ?? []) {
      const amt = Number(p.amount);
      paidViaSp += amt;
      const drLedger = p.method === "cash" ? cashLedger : elecClr;
      push({ entryId: eid, date: p.payment_date, ledgerId: drLedger, debit: amt, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `${p.method === "cash" ? "Cash" : "Electronic"} received — ${inv}` });
    }

    const amountPaid = Number(s.amount_paid ?? 0);
    const extra = round2(amountPaid - paidViaSp);
    if (extra > 0.004) {
      // Cash sits in the cash box; bank/UPI/card clear through Electronic Clearing.
      const drLedger = clearsThroughBank(s.payment_mode) ? elecClr : cashLedger;
      push({ entryId: eid, date: s.sale_date, ledgerId: drLedger, debit: extra, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `Received — ${inv}` });
    }

    const due = round2(total - amountPaid);
    if (due > 0.004) {
      const custLedger = s.customer_id ? (byCode.get(`CUST-${s.customer_id}`)?.id ?? debtors) : debtors;
      push({ entryId: eid, date: s.sale_date, ledgerId: custLedger, debit: due, credit: 0, source: "sale", voucherNumber: s.invoice_number, description: `Outstanding — ${inv}` });
    }
  }

  // 6. Purchases: Dr Purchases (taxable + round-off) + Dr Input GST / Cr vendor.
  //    Legacy rows without line-level GST detail stay as a single lump debit.
  const pup: any[] = [];
  const { rows: purchases } = await pool.query(
    `SELECT id, vendor_id, purchase_date, invoice_number, total_amount, tax_total, line_items,
            location_type, location_id, branch_transfer_id
     FROM purchases WHERE 1=1${upTo("purchase_date", pup)}`, pup
  );
  for (const p of purchases) {
    const amt = Number(p.total_amount);
    const bill = p.invoice_number || `Purchase #${p.id}`;
    // The inward leg of a branch transfer: owed to the sending branch, and its
    // value goes to the inter-branch clearing ledger rather than Purchases, so
    // it offsets the outward leg instead of inflating cost of goods. Replaces
    // the receive journal voucher for the same transfer.
    const isBranchTransfer = p.branch_transfer_id != null;
    const vendLedger = isBranchTransfer
      ? (branchCreditor || creditors)
      : (byCode.get(`VEND-${p.vendor_id}`)?.id ?? creditors);
    // A warehouse's bill debits that warehouse's own purchase ledger; Head
    // Office bills (and anything without a location) keep the standard one.
    const pLoc = locMap.get(`${p.location_type}:${p.location_id}`);
    const purLedger = isBranchTransfer
      ? (branchTrf || stdPur)
      : ((p.location_type && p.location_type !== 'headoffice' && pLoc?.purchase_ledger_id)
        ? Number(pLoc.purchase_ledger_id) : stdPur);
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
    const eid = `purchase:${p.id}`;
    if (inpCgst && inpSgst && inpIgst && inputTax > 0.004 && inputTax < amt && consistent) {
      push({ entryId: eid, date: p.purchase_date, ledgerId: purLedger, debit: round2(amt - inputTax), credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Purchase ${bill}` });
      if (cg > 0.004) push({ entryId: eid, date: p.purchase_date, ledgerId: inpCgst, debit: cg, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Input CGST — ${bill}` });
      if (sg > 0.004) push({ entryId: eid, date: p.purchase_date, ledgerId: inpSgst, debit: sg, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Input SGST — ${bill}` });
      if (ig > 0.004) push({ entryId: eid, date: p.purchase_date, ledgerId: inpIgst, debit: ig, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Input IGST — ${bill}` });
    } else {
      push({ entryId: eid, date: p.purchase_date, ledgerId: purLedger, debit: amt, credit: 0, source: "purchase", voucherNumber: p.invoice_number, description: `Purchase ${bill}` });
    }
    push({ entryId: eid, date: p.purchase_date, ledgerId: vendLedger, debit: 0, credit: amt, source: "purchase", voucherNumber: p.invoice_number, description: isBranchTransfer ? `Due to branch — ${bill}` : `Purchase ${bill}` });
  }

  // 7. Warehouse rent: Dr Rent Expense / Cr Rent Payable, per accrued day.
  //
  // Derived rather than posted as vouchers, for the same reason sales and
  // purchases are: one row per warehouse per day would add thousands of journal
  // vouchers a year and bury the voucher register. Deriving them here puts rent
  // into the trial balance, P&L, balance sheet and ledger statement through the
  // same single stream every other source uses.
  //
  // Ungated by design. Rent is recognised on the day it is incurred, so the
  // running month shows the rent that belongs to it rather than nothing until
  // someone signs the month off. Approval no longer changes what the books say:
  // it locks the month against recalculation and releases the payable for
  // payment. This replaced an `AND p.status IN ('approved','paid')` filter on
  // rent_periods, whose consequence was that approving a month silently restated
  // a P&L that had already been read, reported and acted on.
  //
  // Rent *payments* are real vouchers and arrive via section 3, so the payable is
  // credited here and debited there — no double count.
  const rap: any[] = [];
  const { rows: rentRows } = await pool.query(
    `SELECT r.id, r.accrual_date AS date, r.amount, w.name AS warehouse_name,
            a.expense_ledger_id, a.payable_ledger_id
     FROM rent_accruals r
     JOIN warehouse_rent_agreements a ON a.warehouse_id = r.warehouse_id
     JOIN warehouses w ON w.id = r.warehouse_id
     WHERE a.expense_ledger_id IS NOT NULL AND a.payable_ledger_id IS NOT NULL
       ${upTo("r.accrual_date", rap)}`, rap
  );
  for (const r of rentRows) {
    const amt = Number(r.amount);
    if (!(amt > 0.004)) continue;
    const eid = `rent:${r.id}`;
    const desc = `Rent — ${r.warehouse_name}`;
    push({ entryId: eid, date: r.date, ledgerId: r.expense_ledger_id, debit: amt, credit: 0, source: "rent", voucherNumber: null, description: desc });
    push({ entryId: eid, date: r.date, ledgerId: r.payable_ledger_id, debit: 0, credit: amt, source: "rent", voucherNumber: null, description: desc });
  }

  // 8. Salary: Dr Salary Expense / Cr Salary Payable, per accrued day.
  //
  // Same shape as rent above, ungated for the same reason: the cost belongs to
  // the day it was earned, not to the day someone approved the run.
  //
  // Approval does NOT recognise this cost a second time. postSalaryApproval
  // writes a real voucher that trues the month up to the figure payroll actually
  // computed — it debits only the difference between that figure and what has
  // already accrued here — so the month is recognised once. Salary *payments* are
  // vouchers too, debiting the same payable this credits.
  //
  // Months approved before daily accrual existed carry no accrual rows at all,
  // because the sweep refuses to touch an approved month. Their original
  // full-value voucher therefore stands alone and history is unchanged.
  const sap: any[] = [];
  const { rows: salaryRows } = await pool.query(
    `SELECT a.id, a.accrual_date AS date, a.amount, e.name AS employee_name,
            le.id AS expense_ledger_id, lp.id AS payable_ledger_id
     FROM salary_accruals a
     JOIN employees e ON e.id = a.employee_id
     JOIN account_ledgers le ON le.code = 'SAL-EMP-' || a.employee_id
     JOIN account_ledgers lp ON lp.code = 'SAL-PAY-' || a.employee_id
     WHERE TRUE ${upTo("a.accrual_date", sap)}`, sap
  );
  for (const s of salaryRows) {
    const amt = Number(s.amount);
    if (!(amt > 0.004)) continue;
    const eid = `salary:${s.id}`;
    const desc = `Salary — ${s.employee_name}`;
    push({ entryId: eid, date: s.date, ledgerId: s.expense_ledger_id, debit: amt, credit: 0, source: "salary", voucherNumber: null, description: desc });
    push({ entryId: eid, date: s.date, ledgerId: s.payable_ledger_id, debit: 0, credit: amt, source: "salary", voucherNumber: null, description: desc });
  }

  return postings;
}

// ── Day Book ───────────────────────────────────────────────────────────────
//
// One day's entries as double entries, grouped from the same derived posting
// stream the Trial Balance reads. It used to re-query every source table with
// its own posting rules, so a day book total could disagree with the trial
// balance for the same day and journal-only movements were shown as a lump.

router.get("/accounts/day-book", requireModuleView("page:/accounts/day-book"), async (req, res): Promise<void> => {
  // LBAC: the day book is a Head Office accounting view
  if ((req as any).employee?.branchType !== 'headoffice') {
    res.json({ date: "", entries: [], totals: { count: 0, amount: 0, debit: 0, credit: 0, byType: {} } });
    return;
  }
  const q = String((req.query as any).date ?? "");
  const date = isDate(q) ? q : new Date().toISOString().slice(0, 10);

  const postings = (await buildDerivedPostings({ toDate: date }))
    .filter((p) => String(p.date).slice(0, 10) === date);

  const { rows: ledgerRows } = await pool.query(`SELECT id, name FROM account_ledgers`);
  const nameOf = new Map<number, string>(ledgerRows.map((l: any) => [Number(l.id), l.name as string]));

  type Entry = {
    id: string; refId: number; source: string; voucherNumber: string | null;
    particulars: string; narration: string | null; amount: number;
    debit: number; credit: number;
    lines: Array<{ ledgerId: number; ledgerName: string; debit: number; credit: number }>;
  };

  const byEntry = new Map<string, Entry>();
  for (const p of postings) {
    const key = p.entryId;
    let e = byEntry.get(key);
    if (!e) {
      e = {
        id: key,
        refId: Number(key.split(":")[1] ?? 0),
        source: p.source,
        voucherNumber: p.voucherNumber,
        particulars: "",
        narration: p.description || null,
        amount: 0, debit: 0, credit: 0, lines: [],
      };
      byEntry.set(key, e);
    }
    e.debit = round2(e.debit + p.debit);
    e.credit = round2(e.credit + p.credit);
    e.lines.push({
      ledgerId: p.ledgerId, ledgerName: nameOf.get(p.ledgerId) ?? `Ledger #${p.ledgerId}`,
      debit: p.debit, credit: p.credit,
    });
  }

  const entries: Entry[] = [];
  for (const e of byEntry.values()) {
    // Distinct names only: a sale debits Cash twice when it is part-paid twice,
    // and "Dr Cash, Cash" reads like a mistake.
    const dr = [...new Set(e.lines.filter((l) => l.debit > 0.004).map((l) => l.ledgerName))];
    const cr = [...new Set(e.lines.filter((l) => l.credit > 0.004).map((l) => l.ledgerName))];
    e.particulars = `Dr ${dr.join(", ") || "—"} / Cr ${cr.join(", ") || "—"}`;
    // The entry's value is one side of it, not both added together.
    e.amount = Math.max(e.debit, e.credit);
    e.lines.sort((a, b) => (b.debit - a.debit) || (a.credit - b.credit));
    entries.push(e);
  }
  entries.sort((a, b) => a.source.localeCompare(b.source) || a.refId - b.refId);

  const byType: Record<string, { count: number; amount: number }> = {};
  for (const e of entries) {
    const t = byType[e.source] ?? { count: 0, amount: 0 };
    t.count += 1;
    t.amount = round2(t.amount + e.amount);
    byType[e.source] = t;
  }

  const debit = round2(entries.reduce((s, e) => s + e.debit, 0));
  const credit = round2(entries.reduce((s, e) => s + e.credit, 0));

  res.json({
    date,
    entries,
    totals: {
      count: entries.length,
      amount: round2(entries.reduce((s, e) => s + e.amount, 0)),
      debit,
      credit,
      // A day's postings are balanced in their own right, so a mismatch here
      // means an entry was written with only one leg.
      balanced: Math.abs(debit - credit) < 0.01,
      byType,
    },
  });
});

// ── Cash Book / Bank Book ──────────────────────────────────────────────────

// Ledger options for the book selector (cash or bank subtree)
router.get("/accounts/cash-bank-book/ledgers", requireModuleView(["page:/accounts/cash-book", "page:/accounts/bank-book", "page:/accounts/cash-bank"]), async (req, res): Promise<void> => {
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

router.get("/accounts/cash-bank-book", requireModuleView(["page:/accounts/cash-book", "page:/accounts/bank-book"]), async (req, res): Promise<void> => {
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

router.get("/accounts/trial-balance", requireModuleView("page:/accounts/trial-balance"), async (req, res): Promise<void> => {
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
