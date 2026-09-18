import { Router } from "express";
import { pool } from "@workspace/db";
import { requireModuleView } from "../middleware/permissions";
import { buildBooks, previousDay, type Books } from "../lib/books";
import { buildDerivedPostings, type Posting } from "./journal";
import { openingBalancePostings } from "../lib/openingBalances";
import { isIsoDate } from "../lib/dateInput";
import { parsePostingLocationFilter, postingMatchesLocation, type PostingLocationFilter } from "../lib/postingLocation";
import { stockValuation } from "../lib/valuation";

const router = Router();
const r2 = (n: number) => Math.round(n * 100) / 100;
const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;

type Status = "PASS" | "WARN" | "FAIL";
type Evidence = {
  source: string;
  date: string | null;
  location: { type: string; id: number | null } | null;
  actual: number | string | null;
  expected: number | string | null;
  difference: number | null;
  unit: string;
  explanation: string;
};
type Check = {
  id: string;
  title: string;
  status: Status;
  difference: number | null;
  unit: string;
  location: { type: string; id: number | null } | null;
  date: string | null;
  source: string;
  explanation: string;
  evidence: Evidence[];
};

function check(
  id: string,
  title: string,
  status: Status,
  values: {
    actual?: number | string | null;
    expected?: number | string | null;
    difference?: number | null;
    unit?: string;
    source?: string;
    explanation: string;
    date: string | null;
    location: { type: string; id: number | null } | null;
  },
): Check {
  const difference = values.difference === undefined
    ? typeof values.actual === "number" && typeof values.expected === "number"
      ? r2(values.actual - values.expected)
      : null
    : values.difference;
  return {
    id,
    title,
    status,
    difference,
    unit: values.unit ?? "INR",
    location: values.location,
    date: values.date,
    source: values.source ?? "canonical accounting diagnostic",
    explanation: values.explanation,
    evidence: [{
      source: values.source ?? "canonical accounting diagnostic",
      date: values.date,
      location: values.location,
      actual: values.actual ?? null,
      expected: values.expected ?? null,
      difference,
      unit: values.unit ?? "INR",
      explanation: values.explanation,
    }],
  };
}

function locationFromRequest(req: any): PostingLocationFilter | null | "invalid" {
  const hasType = Object.prototype.hasOwnProperty.call(req.query, "locationType");
  if (!hasType) return null;
  const type = String(req.query.locationType ?? "");
  if (type === "all") return null;
  if (type === "headoffice") return { type, id: null };
  if (type === "warehouse" || type === "outlet") {
    const id = Number(req.query.locationId);
    if (Number.isSafeInteger(id) && id > 0) return { type, id };
  }
  return "invalid";
}

function stockScope(location: PostingLocationFilter | null): {
  branchType?: string; branchId?: number;
} {
  if (!location || location.type === "company") return {};
  if (location.type === "headoffice") return { branchType: "headoffice" };
  return { branchType: location.type, branchId: Number(location.id) };
}

function locationEcho(location: PostingLocationFilter | null) {
  return location ? { type: location.type, id: location.id } : { type: "all", id: null };
}

async function countQuery(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Read-only accounting diagnostics. This intentionally reports WARN when a
 * check cannot be established from the current evidence; it never substitutes
 * zero or a current master value merely to make the centre appear healthy.
 */
router.get(
  "/accounts/integrity",
  requireModuleView("page:/accounts/chart"),
  async (req, res): Promise<void> => {
    const fromDate = String(req.query.fromDate ?? "");
    const toDate = String(req.query.toDate ?? "");
    if (!isIsoDate(fromDate) || !isIsoDate(toDate)) {
      res.status(400).json({ error: "fromDate and toDate must be valid YYYY-MM-DD dates" });
      return;
    }
    if (fromDate > toDate) {
      res.status(400).json({ error: "fromDate must not be later than toDate" });
      return;
    }
    const location = locationFromRequest(req);
    if (location === "invalid") {
      res.status(400).json({ error: "locationType must be all, headoffice, warehouse or outlet; warehouse/outlet require locationId" });
      return;
    }
    // This is a sensitive cross-module diagnostic. Branch sessions can use
    // ordinary scoped reports, but cannot ask this endpoint to enumerate
    // integrity failures across accounting, stock and audit data.
    if (req.employee?.branchType !== "headoffice") {
      res.status(403).json({ error: "Financial Integrity is available to Head Office users only" });
      return;
    }

    const loc = location as PostingLocationFilter | null;
    const locJson = locationEcho(loc);
    const books = await buildBooks(
      (opts) => buildDerivedPostings(opts),
      { fromDate, toDate, location: loc },
    );
    const valuation = await stockValuation(pool, { asOf: toDate, ...stockScope(loc) });
    const [derived, openings] = await Promise.all([
      buildDerivedPostings({ toDate }),
      openingBalancePostings({ toDate }),
    ]);
    const postings = [...derived, ...openings as Posting[]]
      .filter((p) => !loc || postingMatchesLocation(p, loc));

    const checks: Check[] = [];
    const debit = r2(postings.reduce((n, p) => n + Number(p.debit || 0), 0));
    const credit = r2(postings.reduce((n, p) => n + Number(p.credit || 0), 0));
    checks.push(check("FI-01", "Trial Balance", close(debit, credit) ? "PASS" : "FAIL", {
      actual: debit, expected: credit, date: toDate, location: locJson,
      source: "buildDerivedPostings + openingBalancePostings",
      explanation: close(debit, credit) ? "Total debits equal total credits." : "The selected posting stream is not balanced.",
    }));
    const bsDifference = Number(books.integrity.difference);
    checks.push(check("FI-02", "Balance Sheet", books.integrity.balanced ? "PASS" : "FAIL", {
      actual: books.balanceSheet.assets.total, expected: books.balanceSheet.liabilities.total,
      difference: bsDifference, date: toDate, location: locJson, source: "buildBooks.integrity",
      explanation: books.integrity.balanced ? "Assets equal liabilities and equity." : books.integrity.issues.join(" "),
    }));
    checks.push(check("FI-03", "Assets = Liabilities + Equity", close(books.balanceSheet.assets.total, books.balanceSheet.liabilities.total) ? "PASS" : "FAIL", {
      actual: books.balanceSheet.assets.total, expected: books.balanceSheet.liabilities.total,
      date: toDate, location: locJson, source: "buildBooks.balanceSheet",
      explanation: "Balance-sheet equation evaluated from the canonical statement totals.",
    }));
    const pl = books.profitAndLoss;
    checks.push(check("FI-04", "Net Sales - COGS = Gross Profit", close(pl.summary.revenue - pl.summary.costOfGoodsSold, pl.summary.grossProfit) ? "PASS" : "FAIL", {
      actual: r2(pl.summary.revenue - pl.summary.costOfGoodsSold), expected: pl.summary.grossProfit,
      date: toDate, location: locJson, source: "buildBooks.profitAndLoss.summary",
      explanation: "Gross profit uses the P&L's own net-sales and COGS values.",
    }));
    checks.push(check("FI-05", "Gross Profit + other income - expenses - depreciation = Net Profit", "WARN", {
      date: toDate, location: locJson, source: "buildBooks.profitAndLoss.summary",
      explanation: "The current canonical statement exposes operating expenses as a combined group; it does not expose depreciation as a separately proven component for this diagnostic. No green result is claimed.",
    }));
    const stockValue = valuation.grandTotal;
    const stockDiff = r2(pl.incomes.closingStock - stockValue);
    checks.push(check("FI-06", "P&L closing stock = inventory valuation", valuation.reliable && close(pl.incomes.closingStock, stockValue) ? "PASS" : "WARN", {
      actual: pl.incomes.closingStock, expected: stockValue, difference: stockDiff, date: toDate, location: locJson,
      source: "buildBooks + stockValuation(asOf)",
      explanation: valuation.reliable ? "P&L closing stock is compared with the dated valuation service." : valuation.note ?? "Historical valuation evidence is incomplete.",
    }));
    const bsStockDiff = r2(books.balanceSheet.assets.closingStock - stockValue);
    checks.push(check("FI-07", "Inventory valuation = Balance Sheet inventory", valuation.reliable && close(books.balanceSheet.assets.closingStock, stockValue) ? "PASS" : "WARN", {
      actual: books.balanceSheet.assets.closingStock, expected: stockValue, difference: bsStockDiff, date: toDate, location: locJson,
      source: "buildBooks.balanceSheet + stockValuation(asOf)",
      explanation: valuation.reliable ? "Balance-sheet inventory is compared with the same dated valuation service." : valuation.note ?? "Historical valuation evidence is incomplete.",
    }));

    const unavailable = (id: string, title: string, explanation: string) =>
      checks.push(check(id, title, "WARN", { date: toDate, location: locJson, source: "diagnostic evidence not yet materialized", explanation }));
    unavailable("FI-08", "Daily stock continuity", "No persisted daily quantity closing table is currently authoritative for every product/location.");
    unavailable("FI-09", "Opening/closing continuity", "Universal Closing(D)=Opening(D+1) cannot be proven without a persisted daily closing ledger.");
    unavailable("FI-10", "Customer balances", "Customer control balances require a dedicated reconciliation query for all customer ledgers and settlement metadata.");
    unavailable("FI-11", "Vendor balances", "Vendor control balances require a dedicated reconciliation query for all vendor ledgers, returns and advances.");
    unavailable("FI-12", "Cash", "Cash ledger control parity is not independently recomputed by this endpoint.");
    unavailable("FI-13", "Bank", "Bank ledger control parity is not independently recomputed by this endpoint.");
    unavailable("FI-14", "GST", "GST register-to-posting reconciliation is not independently recomputed by this endpoint.");
    unavailable("FI-15", "Fixed assets", "Asset register-to-ledger reconciliation is not independently recomputed by this endpoint.");
    unavailable("FI-16", "Depreciation", "Depreciation run idempotency and accumulated-depreciation parity need an asset-specific evidence query.");
    unavailable("FI-17", "Payroll", "Payroll accrual and payable parity needs a payroll-specific evidence query.");
    unavailable("FI-18", "Transfer neutrality", "Transfer neutrality needs source/destination/in-transit document attribution for the selected range.");
    unavailable("FI-19", "Batch quantity reconciliation", valuation.issues.length ? valuation.note ?? "Batch evidence is incomplete." : "Batch quantity reconciliation is not independently compared with the authoritative stock-entry quantity.");
    unavailable("FI-20", "Orphan journal lines", "Orphan journal-line detection is not yet included in the diagnostic query set.");
    unavailable("FI-21", "Orphan stock references", "Orphan stock-reference detection is not yet included in the diagnostic query set.");
    const negativeStock = await countQuery(
      `SELECT COUNT(*) FROM stock_entries WHERE quantity::numeric < 0`,
    ).catch(() => null);
    checks.push(check("FI-22", "Negative stock", negativeStock == null ? "WARN" : negativeStock === 0 ? "PASS" : "FAIL", {
      actual: negativeStock, expected: 0, unit: "rows", date: toDate, location: locJson, source: "stock_entries",
      explanation: negativeStock == null ? "The stock quantity query could not be established." : negativeStock === 0 ? "No negative stock-entry quantities exist." : `${negativeStock} negative stock-entry quantities exist.`,
    }));
    unavailable("FI-23", "Negative batches", "Batch-level negative quantity reconciliation is not yet included in the diagnostic query set.");
    unavailable("FI-24", "Over-allocation", "Allocation capacity must be checked per bill and is not inferred from report totals.");
    unavailable("FI-25", "Duplicate settlement", "One-receipt settlement uniqueness needs a dedicated source/allocation query.");
    unavailable("FI-26", "Location isolation", "Location isolation requires the authenticated matrix tests; a read-only aggregate cannot prove ID-tampering resistance.");
    unavailable("FI-27", "Audit durability", "Audit durability requires fault-injection rollback tests; presence of audit rows alone cannot prove atomicity.");

    const summary = checks.reduce((s, c) => ({ ...s, [c.status]: s[c.status] + 1 }), { PASS: 0, WARN: 0, FAIL: 0 });
    res.json({
      fromDate, toDate, location: locJson, readOnly: true,
      summary,
      checks,
      valuation: { reliable: valuation.reliable, note: valuation.note },
    });
  },
);

export default router;