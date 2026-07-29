/**
 * Reports Center — financial report families.
 *
 * These sit alongside routes/reports.ts and follow its conventions
 * (?from=&to=, money at 2dp, YYYY-MM-DD text dates), but they read the SAME
 * derived posting stream the Trial Balance, Cash Book and the financial
 * statements read. That is the whole point: a GST figure, a ledger balance and
 * a P&L line that disagree are three separate support tickets.
 *
 * Every endpoint is guarded on `page:/reports/sales` — Reports is one sidebar
 * link and therefore one permission row. The equivalent pages under /accounts
 * keep their own keys; this file is the Reports Center's own door, not a
 * back door into those pages.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { requireModuleView } from "../middleware/permissions";
import { buildDerivedPostings, type Posting } from "./journal";
import { loadChart, previousDay } from "../lib/books";
import { isIsoDate } from "../lib/dateInput";

const router = Router();
const REPORTS_KEY = "page:/reports/sales";

// Shape AND calendar validity (rejects 2026-02-30) — these values reach real
// DATE columns, where an impossible date raises 22007 instead of storing text.
const isDate = (v: unknown): v is string => isIsoDate(v);
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function range(req: { query: Record<string, unknown> }): { from: string | null; to: string | null } {
  const from = req.query.from ?? req.query.fromDate;
  const to = req.query.to ?? req.query.toDate;
  return { from: isDate(from) ? from : null, to: isDate(to) ? to : null };
}

/** Financial reports are Head Office views — the posting stream has no location. */
function headOfficeOnly(req: any): boolean {
  return (req as any).employee?.branchType === "headoffice";
}

/** Postings split into "before the window" (opening) and "inside it". */
async function splitPostings(from: string | null, to: string | null) {
  const all = await buildDerivedPostings({ toDate: to ?? undefined });
  const before: Posting[] = [];
  const inRange: Posting[] = [];
  for (const p of all) {
    if (from && p.date < from) before.push(p);
    else inRange.push(p);
  }
  return { before, inRange };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEDGER REPORTS — every ledger's opening / movement / closing, and one
// ledger's statement with a running balance.
// ═══════════════════════════════════════════════════════════════════════════

router.get("/reports/fin/ledgers", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  if (!headOfficeOnly(req)) { res.json({ rows: [], totals: null }); return; }
  const { from, to } = range(req);
  const { before, inRange } = await splitPostings(from, to);

  type Agg = { opening: number; debit: number; credit: number };
  const agg = new Map<number, Agg>();
  const get = (id: number): Agg => {
    let a = agg.get(id);
    if (!a) { a = { opening: 0, debit: 0, credit: 0 }; agg.set(id, a); }
    return a;
  };
  for (const p of before) { const a = get(p.ledgerId); a.opening = r2(a.opening + p.debit - p.credit); }
  for (const p of inRange) { const a = get(p.ledgerId); a.debit = r2(a.debit + p.debit); a.credit = r2(a.credit + p.credit); }

  const chart = await loadChart();
  const rows = [...agg.entries()]
    .map(([id, a]) => {
      const node = chart.byId.get(id);
      const closing = r2(a.opening + a.debit - a.credit);
      return {
        ledgerId: id,
        name: node?.name ?? `Ledger #${id}`,
        code: node?.code ?? null,
        type: node?.type ?? null,
        groupName: node?.parentId ? (chart.byId.get(node.parentId)?.name ?? null) : null,
        rootCode: chart.rootCodeOf(id),
        opening: a.opening,
        debit: a.debit,
        credit: a.credit,
        closing,
      };
    })
    // A ledger that never moved and holds nothing is noise, not information.
    .filter((r) => Math.abs(r.opening) > 0.004 || r.debit > 0.004 || r.credit > 0.004 || Math.abs(r.closing) > 0.004)
    .sort((a, b) => String(a.groupName ?? "").localeCompare(String(b.groupName ?? "")) || a.name.localeCompare(b.name));

  res.json({
    fromDate: from, toDate: to,
    rows,
    totals: {
      opening: r2(rows.reduce((s, r) => s + r.opening, 0)),
      debit: r2(rows.reduce((s, r) => s + r.debit, 0)),
      credit: r2(rows.reduce((s, r) => s + r.credit, 0)),
      closing: r2(rows.reduce((s, r) => s + r.closing, 0)),
    },
  });
});

router.get("/reports/fin/ledger-statement", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  if (!headOfficeOnly(req)) { res.json({ ledger: null, entries: [] }); return; }
  const ledgerId = Number((req.query as any).ledgerId);
  if (!Number.isFinite(ledgerId) || ledgerId <= 0) { res.status(400).json({ error: "ledgerId is required" }); return; }
  const { from, to } = range(req);

  const chart = await loadChart();
  const node = chart.byId.get(ledgerId);
  if (!node) { res.status(404).json({ error: "Ledger not found" }); return; }

  // Selecting a group consolidates its whole subtree, the way the Cash Book does.
  const ids = chart.subtree(ledgerId);

  const { before, inRange } = await splitPostings(from, to);
  const opening = r2(before.filter((p) => ids.has(p.ledgerId)).reduce((s, p) => s + p.debit - p.credit, 0));

  const mine = inRange.filter((p) => ids.has(p.ledgerId));
  mine.sort((a, b) => a.date.localeCompare(b.date) || a.entryId.localeCompare(b.entryId));

  let balance = opening;
  const entries = mine.map((p) => {
    balance = r2(balance + p.debit - p.credit);
    return {
      date: p.date, source: p.source, voucherNumber: p.voucherNumber,
      description: p.description, ledgerId: p.ledgerId,
      ledgerName: chart.byId.get(p.ledgerId)?.name ?? `Ledger #${p.ledgerId}`,
      debit: p.debit, credit: p.credit, balance,
    };
  });

  res.json({
    ledger: { id: node.id, name: node.name, code: node.code ?? null, isGroup: node.isGroup, consolidates: ids.size },
    fromDate: from, toDate: to,
    openingBalance: opening,
    entries,
    totalDebit: r2(entries.reduce((s, e) => s + e.debit, 0)),
    totalCredit: r2(entries.reduce((s, e) => s + e.credit, 0)),
    closingBalance: balance,
  });
});

/** Ledger picker options, optionally narrowed to a root group (e.g. STD-CASH). */
router.get("/reports/fin/ledger-options", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  if (!headOfficeOnly(req)) { res.json([]); return; }
  const under = typeof (req.query as any).under === "string" ? String((req.query as any).under) : "";
  const chart = await loadChart();
  const allow = under ? chart.idsUnder([under]) : null;
  const rows = [...chart.byId.values()]
    .filter((n) => !allow || allow.has(n.id))
    .map((n) => ({ id: n.id, name: n.name, code: n.code, isGroup: n.isGroup, type: n.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(rows);
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIAL BALANCE (Reports Center copy — same numbers, its own permission door)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/reports/fin/trial-balance", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  if (!headOfficeOnly(req)) { res.json({ rows: [], totalDebit: 0, totalCredit: 0, balanced: true }); return; }
  const { from, to } = range(req);
  const { inRange } = await splitPostings(from, to);

  const agg = new Map<number, { dr: number; cr: number }>();
  for (const p of inRange) {
    const a = agg.get(p.ledgerId) ?? { dr: 0, cr: 0 };
    a.dr = r2(a.dr + p.debit); a.cr = r2(a.cr + p.credit);
    agg.set(p.ledgerId, a);
  }

  const chart = await loadChart();
  const rows: any[] = [];
  for (const [ledgerId, a] of agg) {
    const net = r2(a.dr - a.cr);
    if (Math.abs(net) < 0.005) continue;
    const n = chart.byId.get(ledgerId);
    rows.push({
      ledgerId,
      name: n?.name ?? `Ledger #${ledgerId}`,
      code: n?.code ?? null,
      type: n?.type ?? null,
      groupName: n?.parentId ? (chart.byId.get(n.parentId)?.name ?? null) : null,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    });
  }
  rows.sort((a, b) => String(a.groupName ?? "").localeCompare(String(b.groupName ?? "")) || a.name.localeCompare(b.name));

  const totalDebit = r2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = r2(rows.reduce((s, r) => s + r.credit, 0));
  const difference = r2(totalDebit - totalCredit);
  res.json({ fromDate: from, toDate: to, rows, totalDebit, totalCredit, difference, balanced: Math.abs(difference) < 0.01 });
});

// ═══════════════════════════════════════════════════════════════════════════
// CASH & BANK REPORTS — one book per ledger, plus a position summary so the
// report opens on something useful instead of an empty ledger picker.
// ═══════════════════════════════════════════════════════════════════════════

async function bookReport(req: any, rootCode: string) {
  const { from, to } = range(req);
  const chart = await loadChart();
  const rootIds = chart.idsUnder([rootCode]);

  const requested = Number(req.query.ledgerId);
  const scopeIds = Number.isFinite(requested) && requested > 0 && rootIds.has(requested)
    ? chart.subtree(requested)
    : rootIds;

  const { before, inRange } = await splitPostings(from, to);
  const opening = r2(before.filter((p) => scopeIds.has(p.ledgerId)).reduce((s, p) => s + p.debit - p.credit, 0));

  const mine = inRange.filter((p) => scopeIds.has(p.ledgerId));
  mine.sort((a, b) => a.date.localeCompare(b.date) || a.entryId.localeCompare(b.entryId));

  let balance = opening;
  const entries = mine.map((p) => {
    balance = r2(balance + p.debit - p.credit);
    return {
      date: p.date, source: p.source, voucherNumber: p.voucherNumber,
      description: p.description,
      account: chart.byId.get(p.ledgerId)?.name ?? `Ledger #${p.ledgerId}`,
      receipt: p.debit, payment: p.credit, balance,
    };
  });

  // Per-account closing position across the whole root, so "where is the money"
  // is answerable without switching ledgers one at a time.
  const perAccount = new Map<number, { opening: number; inflow: number; outflow: number }>();
  for (const p of before) {
    if (!rootIds.has(p.ledgerId)) continue;
    const a = perAccount.get(p.ledgerId) ?? { opening: 0, inflow: 0, outflow: 0 };
    a.opening = r2(a.opening + p.debit - p.credit);
    perAccount.set(p.ledgerId, a);
  }
  for (const p of inRange) {
    if (!rootIds.has(p.ledgerId)) continue;
    const a = perAccount.get(p.ledgerId) ?? { opening: 0, inflow: 0, outflow: 0 };
    a.inflow = r2(a.inflow + p.debit); a.outflow = r2(a.outflow + p.credit);
    perAccount.set(p.ledgerId, a);
  }
  const accounts = [...perAccount.entries()]
    .filter(([id]) => !chart.byId.get(id)?.isGroup)
    .map(([id, a]) => ({
      ledgerId: id,
      name: chart.byId.get(id)?.name ?? `Ledger #${id}`,
      opening: a.opening, inflow: a.inflow, outflow: a.outflow,
      closing: r2(a.opening + a.inflow - a.outflow),
    }))
    .filter((a) => Math.abs(a.opening) > 0.004 || a.inflow > 0.004 || a.outflow > 0.004)
    .sort((a, b) => b.closing - a.closing);

  return {
    fromDate: from, toDate: to,
    scope: Number.isFinite(requested) && requested > 0 && rootIds.has(requested)
      ? { ledgerId: requested, name: chart.byId.get(requested)?.name ?? "" }
      : { ledgerId: null, name: rootCode === "STD-BANK" ? "All bank accounts" : "All cash accounts" },
    openingBalance: opening,
    entries,
    totalReceipts: r2(entries.reduce((s, e) => s + e.receipt, 0)),
    totalPayments: r2(entries.reduce((s, e) => s + e.payment, 0)),
    closingBalance: balance,
    accounts,
  };
}

router.get("/reports/fin/cash", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  if (!headOfficeOnly(req)) { res.json({ entries: [], accounts: [] }); return; }
  res.json(await bookReport(req, "STD-CASH"));
});

router.get("/reports/fin/bank", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  if (!headOfficeOnly(req)) { res.json({ entries: [], accounts: [] }); return; }
  res.json(await bookReport(req, "STD-BANK"));
});

// ═══════════════════════════════════════════════════════════════════════════
// GST SUMMARY — output tax, input credit and net liability, from the postings.
// ═══════════════════════════════════════════════════════════════════════════

const GST_LEDGERS = {
  outputCgst: "STD-OUT-CGST", outputSgst: "STD-OUT-SGST", outputIgst: "STD-OUT-IGST",
  inputCgst: "STD-INP-CGST", inputSgst: "STD-INP-SGST", inputIgst: "STD-INP-IGST",
} as const;

router.get("/reports/fin/gst", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  if (!headOfficeOnly(req)) { res.json({ output: null, input: null }); return; }
  const { from, to } = range(req);
  const { inRange } = await splitPostings(from, to);
  const chart = await loadChart();

  const idOf = (code: string) => chart.byCode.get(code)?.id ?? -1;
  const ids: Record<keyof typeof GST_LEDGERS, number> = {
    outputCgst: idOf(GST_LEDGERS.outputCgst), outputSgst: idOf(GST_LEDGERS.outputSgst), outputIgst: idOf(GST_LEDGERS.outputIgst),
    inputCgst: idOf(GST_LEDGERS.inputCgst), inputSgst: idOf(GST_LEDGERS.inputSgst), inputIgst: idOf(GST_LEDGERS.inputIgst),
  };

  // Output tax is a credit balance, input credit a debit balance. Reporting
  // both as positive magnitudes is what a GST return does.
  const sum = (id: number, dir: "cr" | "dr") =>
    r2(inRange.filter((p) => p.ledgerId === id)
      .reduce((s, p) => s + (dir === "cr" ? p.credit - p.debit : p.debit - p.credit), 0));

  const output = {
    cgst: sum(ids.outputCgst, "cr"), sgst: sum(ids.outputSgst, "cr"), igst: sum(ids.outputIgst, "cr"),
    total: 0,
  };
  output.total = r2(output.cgst + output.sgst + output.igst);
  const input = {
    cgst: sum(ids.inputCgst, "dr"), sgst: sum(ids.inputSgst, "dr"), igst: sum(ids.inputIgst, "dr"),
    total: 0,
  };
  input.total = r2(input.cgst + input.sgst + input.igst);

  // Month-by-month so a quarter can be read without re-running the report.
  const months = new Map<string, { output: number; input: number }>();
  const allGstIds = new Set(Object.values(ids).filter((i) => i > 0));
  for (const p of inRange) {
    if (!allGstIds.has(p.ledgerId)) continue;
    const m = String(p.date).slice(0, 7);
    const row = months.get(m) ?? { output: 0, input: 0 };
    const isOutput = p.ledgerId === ids.outputCgst || p.ledgerId === ids.outputSgst || p.ledgerId === ids.outputIgst;
    if (isOutput) row.output = r2(row.output + p.credit - p.debit);
    else row.input = r2(row.input + p.debit - p.credit);
    months.set(m, row);
  }

  // Taxable turnover, net of tax, straight from the sales subtree.
  const salesIds = chart.idsUnder(["SYS-SAL"]);
  const taxableTurnover = r2(inRange.filter((p) => salesIds.has(p.ledgerId)).reduce((s, p) => s + p.credit - p.debit, 0));
  const purchaseIds = chart.idsUnder(["SYS-PUR"]);
  const taxablePurchases = r2(inRange.filter((p) => purchaseIds.has(p.ledgerId)).reduce((s, p) => s + p.debit - p.credit, 0));

  res.json({
    fromDate: from, toDate: to,
    output, input,
    netPayable: r2(output.total - input.total),
    taxableTurnover, taxablePurchases,
    byMonth: [...months.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({ month, output: v.output, input: v.input, net: r2(v.output - v.input) })),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPENSE REPORT — the register plus a category and a location breakdown.
// Reads `expenses` directly (not the posting stream) because an expense report
// is about the documents, and expenses carry a location that postings do not.
// ═══════════════════════════════════════════════════════════════════════════

router.get("/reports/fin/expenses", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  const { from, to } = range(req);
  const locationType = typeof req.query.locationType === "string" ? req.query.locationType : "";
  const locationId = Number(req.query.locationId) || 0;
  if (locationType && !["outlet", "warehouse", "headoffice"].includes(locationType)) {
    res.status(400).json({ error: "locationType must be outlet, warehouse or headoffice" }); return;
  }

  // A location employee sees only their own location's spend, whatever they ask for.
  const emp = (req as any).employee;
  const forcedType = emp?.branchType !== "headoffice" ? String(emp?.branchType ?? "") : "";
  const forcedId = forcedType ? Number(emp?.branchId ?? 0) : 0;
  const effType = forcedType || locationType;
  const effId = forcedType ? forcedId : locationId;

  const { rows } = await pool.query<any>(
    `SELECT e.id, e.expense_number, e.expense_date, e.amount, e.description,
            COALESCE(NULLIF(e.category,''),'Uncategorised') AS category,
            e.location_type, e.location_id,
            l.name AS ledger_name, l.code AS ledger_code,
            pa.name AS paid_from,
            emp.name AS created_by_name
       FROM expenses e
       LEFT JOIN account_ledgers l  ON l.id  = e.ledger_account_id
       LEFT JOIN account_ledgers pa ON pa.id = e.payment_account_id
       LEFT JOIN employees emp      ON emp.id = e.created_by
      -- Both sides are cast explicitly so this works whether expense_date is
      -- still text or already a real DATE. Pinning the parameters to ::text (as
      -- this once did) leaves "date >= text", for which no operator exists;
      -- pinning them to ::date alone breaks while the column is still text.
      WHERE ($1::date IS NULL OR e.expense_date::date >= $1::date)
        AND ($2::date IS NULL OR e.expense_date::date <= $2::date)
        AND ($3::text = ''   OR e.location_type = $3)
        AND ($4::int  = 0    OR e.location_id   = $4)
      ORDER BY e.expense_date DESC, e.id DESC`,
    [from, to, effType, effId],
  );

  const { rows: whs } = await pool.query<any>(`SELECT id, name FROM warehouses`);
  const { rows: outs } = await pool.query<any>(`SELECT id, name FROM outlets`);
  const wMap = new Map<number, string>(whs.map((w: any) => [Number(w.id), String(w.name)]));
  const oMap = new Map<number, string>(outs.map((o: any) => [Number(o.id), String(o.name)]));
  const locName = (t: string | null, id: number | null) => {
    if (!t || t === "headoffice") return "Head Office";
    if (t === "warehouse") return wMap.get(Number(id)) ?? `Warehouse #${id}`;
    if (t === "outlet") return oMap.get(Number(id)) ?? `Outlet #${id}`;
    return `${t} #${id}`;
  };

  const items = rows.map((r) => ({
    id: Number(r.id),
    expenseNumber: r.expense_number ?? null,
    date: String(r.expense_date),
    category: String(r.category),
    ledgerName: r.ledger_name ?? "—",
    ledgerCode: r.ledger_code ?? null,
    paidFrom: r.paid_from ?? "—",
    description: r.description ?? "",
    locationType: r.location_type ?? "headoffice",
    locationName: locName(r.location_type, r.location_id),
    createdBy: r.created_by_name ?? null,
    amount: r2(Number(r.amount)),
  }));

  const roll = (key: (i: typeof items[number]) => string) => {
    const m = new Map<string, { count: number; amount: number }>();
    for (const i of items) {
      const k = key(i);
      const v = m.get(k) ?? { count: 0, amount: 0 };
      v.count += 1; v.amount = r2(v.amount + i.amount);
      m.set(k, v);
    }
    return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.amount - a.amount);
  };

  res.json({
    fromDate: from, toDate: to,
    rows: items,
    byCategory: roll((i) => i.category),
    byLedger: roll((i) => i.ledgerName),
    byLocation: roll((i) => i.locationName),
    total: r2(items.reduce((s, i) => s + i.amount, 0)),
    count: items.length,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SALARY REPORT — payroll register with the statutory split.
// ═══════════════════════════════════════════════════════════════════════════

interface SalaryRow {
  id: number; employeeId: number; employeeName: string; role: string | null; location: string;
  period: string; month: number; year: number; status: string;
  paidDate: string | null; paymentMode: string | null;
  workingDays: number; presentDays: number; lopDays: number;
  baseSalary: number; allowances: number; bonus: number; extra: number; grossPay: number;
  lopDeduction: number; advanceDeduction: number; pfEmployee: number; esiEmployee: number;
  otherDeductions: number; netPay: number; paidAmount: number;
  pfEmployer: number; esiEmployer: number; costToCompany: number;
}

router.get("/reports/fin/salary", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  if (!headOfficeOnly(req)) { res.json({ rows: [], totals: null }); return; }
  const { from, to } = range(req);

  // payroll is stored as month + year, not a date, so the window is applied to
  // the last day of the payroll month — a June run belongs to June however late
  // it was approved.
  const { rows } = await pool.query<any>(
    `SELECT p.id, p.employee_id, p.month, p.year, p.pay_period_label, p.status, p.is_paid, p.paid_date,
            p.base_salary, p.allowances_total, p.gross_pay, p.lop_days, p.lop_deduction,
            p.advance_deduction, p.pf_employee, p.pf_employer, p.esi_employee, p.esi_employer,
            p.deductions, p.bonus, p.extra_amount, p.net_pay, p.total_amount, p.paid_amount,
            p.payment_mode, p.working_days, p.present_days,
            e.name AS employee_name, e.branch_type, e.branch_id,
            h.name AS role_name
       FROM payroll p
       LEFT JOIN employees e   ON e.id = p.employee_id
       LEFT JOIN hierarchies h ON h.id = e.hierarchy_id
      ORDER BY p.year DESC, p.month DESC, e.name`,
  );

  const endOfMonth = (y: number, m: number) => {
    const d = new Date(Date.UTC(y, m, 0));
    return d.toISOString().slice(0, 10);
  };
  const startOfMonth = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;

  const { rows: whs } = await pool.query<any>(`SELECT id, name FROM warehouses`);
  const { rows: outs } = await pool.query<any>(`SELECT id, name FROM outlets`);
  const wMap = new Map<number, string>(whs.map((w: any) => [Number(w.id), String(w.name)]));
  const oMap = new Map<number, string>(outs.map((o: any) => [Number(o.id), String(o.name)]));

  const items: SalaryRow[] = (rows as any[])
    .filter((r: any) => {
      const y = Number(r.year), m = Number(r.month);
      if (!y || !m) return true;
      if (from && endOfMonth(y, m) < from) return false;
      if (to && startOfMonth(y, m) > to) return false;
      return true;
    })
    .map((r: any): SalaryRow => {
      const bt = r.branch_type ?? "headoffice";
      const location = bt === "warehouse" ? (wMap.get(Number(r.branch_id)) ?? `Warehouse #${r.branch_id}`)
        : bt === "outlet" ? (oMap.get(Number(r.branch_id)) ?? `Outlet #${r.branch_id}`)
        : "Head Office";
      const n = (v: any) => r2(Number(v ?? 0));
      return {
        id: Number(r.id),
        employeeId: Number(r.employee_id),
        employeeName: r.employee_name ?? `Employee #${r.employee_id}`,
        role: r.role_name ?? null,
        location,
        period: r.pay_period_label ?? `${String(r.month).padStart(2, "0")}/${r.year}`,
        month: Number(r.month), year: Number(r.year),
        status: r.status ?? (r.is_paid ? "paid" : "draft"),
        paidDate: r.paid_date ? String(r.paid_date).slice(0, 10) : null,
        paymentMode: r.payment_mode ?? null,
        workingDays: Number(r.working_days ?? 0),
        presentDays: r3(Number(r.present_days ?? 0)),
        lopDays: r3(Number(r.lop_days ?? 0)),
        baseSalary: n(r.base_salary),
        allowances: n(r.allowances_total),
        bonus: n(r.bonus),
        extra: n(r.extra_amount),
        grossPay: n(r.gross_pay),
        lopDeduction: n(r.lop_deduction),
        advanceDeduction: n(r.advance_deduction),
        pfEmployee: n(r.pf_employee),
        esiEmployee: n(r.esi_employee),
        otherDeductions: n(r.deductions),
        netPay: n(r.net_pay ?? r.total_amount),
        paidAmount: n(r.paid_amount),
        // Employer contributions are a cost to the company but not part of net pay.
        pfEmployer: n(r.pf_employer),
        esiEmployer: n(r.esi_employer),
        costToCompany: r2(n(r.gross_pay) + n(r.pf_employer) + n(r.esi_employer)),
      };
    });

  const sum = (f: (i: typeof items[number]) => number) => r2(items.reduce((s, i) => s + f(i), 0));
  res.json({
    fromDate: from, toDate: to,
    rows: items,
    totals: {
      count: items.length,
      grossPay: sum((i) => i.grossPay),
      deductions: sum((i) => i.lopDeduction + i.advanceDeduction + i.pfEmployee + i.esiEmployee + i.otherDeductions),
      netPay: sum((i) => i.netPay),
      paidAmount: sum((i) => i.paidAmount),
      pfEmployer: sum((i) => i.pfEmployer),
      esiEmployer: sum((i) => i.esiEmployer),
      costToCompany: sum((i) => i.costToCompany),
    },
    byStatus: [...items.reduce((m, i) => {
      const v = m.get(i.status) ?? { count: 0, netPay: 0 };
      v.count += 1; v.netPay = r2(v.netPay + i.netPay);
      return m.set(i.status, v);
    }, new Map<string, { count: number; netPay: number }>())]
      .map(([status, v]) => ({ status, ...v })),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DAY BOOK (Reports Center copy) — one day, or a range, of grouped entries.
// ═══════════════════════════════════════════════════════════════════════════

router.get("/reports/fin/day-book", requireModuleView(REPORTS_KEY), async (req, res): Promise<void> => {
  if (!headOfficeOnly(req)) { res.json({ entries: [], totals: null }); return; }
  const { from, to } = range(req);
  const { inRange } = await splitPostings(from, to);
  const chart = await loadChart();

  const byEntry = new Map<string, {
    id: string; date: string; source: string; voucherNumber: string | null;
    narration: string | null; debit: number; credit: number;
    dr: string[]; cr: string[];
  }>();
  for (const p of inRange) {
    let e = byEntry.get(p.entryId);
    if (!e) {
      e = { id: p.entryId, date: p.date, source: p.source, voucherNumber: p.voucherNumber, narration: p.description || null, debit: 0, credit: 0, dr: [], cr: [] };
      byEntry.set(p.entryId, e);
    }
    const nm = chart.byId.get(p.ledgerId)?.name ?? `Ledger #${p.ledgerId}`;
    if (p.debit > 0.004) { e.debit = r2(e.debit + p.debit); if (!e.dr.includes(nm)) e.dr.push(nm); }
    if (p.credit > 0.004) { e.credit = r2(e.credit + p.credit); if (!e.cr.includes(nm)) e.cr.push(nm); }
  }

  const entries = [...byEntry.values()]
    .map((e) => ({
      ...e,
      particulars: `Dr ${e.dr.join(", ") || "—"} / Cr ${e.cr.join(", ") || "—"}`,
      amount: Math.max(e.debit, e.credit),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));

  const debit = r2(entries.reduce((s, e) => s + e.debit, 0));
  const credit = r2(entries.reduce((s, e) => s + e.credit, 0));
  res.json({
    fromDate: from, toDate: to,
    entries,
    totals: {
      count: entries.length,
      amount: r2(entries.reduce((s, e) => s + e.amount, 0)),
      debit, credit, balanced: Math.abs(debit - credit) < 0.01,
    },
  });
});

export default router;
export { previousDay };
