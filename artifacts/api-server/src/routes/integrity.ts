import { Router } from "express";
import { pool } from "@workspace/db";
import { requireModuleView } from "../middleware/permissions";
import { buildBooks, previousDay, todayISO, type Books } from "../lib/books";
import { buildDerivedPostings, type Posting } from "./journal";
import { openingBalancePostings } from "../lib/openingBalances";
import { isIsoDate } from "../lib/dateInput";
import { parsePostingLocationFilter, postingMatchesLocation, type PostingLocationFilter } from "../lib/postingLocation";
import { stockValuation } from "../lib/valuation";

const router = Router();
const r2 = (n: number) => Math.round(n * 100) / 100;
const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;

type Status = "PASS" | "WARN" | "FAIL" | "UNVERIFIED";
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
    // Financial statements use the valuation engine's default ownership rule:
    // dispatched-but-unreceived goods remain inventory of the sending branch.
    // Keep the diagnostic on that same canonical figure so it cannot report a
    // false mismatch merely because it omitted in-transit stock.
    const valuation = await stockValuation(pool, {
      ...(toDate === todayISO() ? {} : { asOf: toDate }),
      includeInTransit: true,
      ...stockScope(loc),
    });
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
    const bsBalances = close(books.balanceSheet.assets.total, books.balanceSheet.liabilities.total);
    // `books.integrity.issues` also carries evidence-quality warnings (for
    // example, an opening stock position that cannot be reconstructed). Those
    // must not turn a balanced equation into a FAIL. FI-03 is the direct
    // equation check; FI-02 reports a warning when the equation is sound but
    // the statement has unresolved supporting evidence.
    const bsStatus: Status = bsBalances ? (books.integrity.issues.length ? "WARN" : "PASS") : "FAIL";
    checks.push(check("FI-02", "Balance Sheet", bsStatus, {
      actual: books.balanceSheet.assets.total, expected: books.balanceSheet.liabilities.total,
      difference: bsDifference, date: toDate, location: locJson, source: "buildBooks.integrity",
      explanation: bsBalances
        ? books.integrity.issues.join(" ") || "Assets equal liabilities and equity."
        : books.integrity.issues.join(" ") || "Assets and liabilities differ.",
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
    const fi05Actual = r2(
      pl.summary.grossProfit + pl.summary.otherIncome - pl.summary.operatingExpenses,
    );
    const fi05Expected = r2(pl.summary.netProfit);
    const fi05Pass = close(fi05Actual, fi05Expected);
    checks.push(check("FI-05", "Gross Profit + other income - operating expenses = Net Profit", fi05Pass ? "PASS" : "FAIL", {
      actual: fi05Actual, expected: fi05Expected, date: toDate, location: locJson,
      source: "buildBooks.profitAndLoss.summary",
      explanation: fi05Pass
        ? "Gross profit plus other income less the complete indirect-expense total equals net profit; depreciation remains included in that total and is not subtracted twice."
        : "The canonical P&L totals do not reconcile: gross profit plus other income less operating expenses differs from net profit.",
    }));
    const stockValue = valuation.grandTotal;
    const stockDiff = r2(pl.incomes.closingStock - stockValue);
    const stockPnlStatus: Status = !valuation.reliable
      ? "UNVERIFIED"
      : close(pl.incomes.closingStock, stockValue) ? "PASS" : "FAIL";
    checks.push(check("FI-06", "P&L closing stock = inventory valuation", stockPnlStatus, {
      actual: pl.incomes.closingStock, expected: stockValue, difference: stockDiff, date: toDate, location: locJson,
      source: "buildBooks + stockValuation(asOf, includeInTransit)",
      explanation: valuation.reliable ? "P&L closing stock is compared with the dated valuation service." : valuation.note ?? "Historical valuation evidence is incomplete.",
    }));
    const bsStockDiff = r2(books.balanceSheet.assets.closingStock - stockValue);
    const stockBsStatus: Status = !valuation.reliable
      ? "UNVERIFIED"
      : close(books.balanceSheet.assets.closingStock, stockValue) ? "PASS" : "FAIL";
    checks.push(check("FI-07", "Inventory valuation = Balance Sheet inventory", stockBsStatus, {
      actual: books.balanceSheet.assets.closingStock, expected: stockValue, difference: bsStockDiff, date: toDate, location: locJson,
      source: "buildBooks.balanceSheet + stockValuation(asOf, includeInTransit)",
      explanation: valuation.reliable ? "Balance-sheet inventory is compared with the same dated valuation service." : valuation.note ?? "Historical valuation evidence is incomplete.",
    }));

    const { rows: [closeState] } = await pool.query(
      `SELECT b.baseline_date::text AS baseline_date,
              b.time_zone AS baseline_time_zone,
              COALESCE(NULLIF(c.general_settings->>'timeZone', ''), 'Asia/Kolkata') AS current_time_zone,
              (SELECT MAX(r.close_date)::text
                 FROM stock_daily_close_runs r
                WHERE r.completed_at IS NOT NULL) AS closed_through
         FROM stock_daily_close_baseline b
         LEFT JOIN LATERAL (
           SELECT general_settings FROM company_settings LIMIT 1
         ) c ON TRUE
        WHERE b.id = 1`,
    );
    let dailyStockStatus: Status = "UNVERIFIED";
    let dailyStockActual: number | null = null;
    let dailyStockExpected: number | null = null;
    let dailyStockSource = "future-only stock baseline and persisted daily close snapshots";
    let dailyStockExplanation = "No authoritative daily stock baseline is available.";
    if (closeState?.baseline_date) {
      const baselineDate = String(closeState.baseline_date);
      const baselineTimeZone = String(closeState.baseline_time_zone);
      const currentTimeZone = String(closeState.current_time_zone);
      const closedThrough = closeState.closed_through == null ? null : String(closeState.closed_through);
      if (baselineTimeZone !== currentTimeZone) {
        dailyStockExplanation =
          `The company timezone changed from ${baselineTimeZone} to ${currentTimeZone} after the stock baseline; daily continuity is unverified until the date basis is reviewed.`;
      } else if (fromDate < baselineDate) {
        dailyStockExplanation =
          `The selected range starts before the future-only stock baseline (${baselineDate}); earlier history remains unverified.`;
      } else if (!closedThrough || toDate > closedThrough) {
        dailyStockExplanation = closedThrough
          ? `Daily stock snapshots are complete only through ${closedThrough}; the selected range extends beyond the latest closed date.`
          : `The future-only baseline was captured on ${baselineDate}; no company-local daily close has completed yet.`;
      } else {
        const { rows: [coverage] } = await pool.query(
          `WITH requested_days AS (
             SELECT days.close_date::date AS close_date
               FROM generate_series($1::date, $2::date, interval '1 day') AS days(close_date)
           ),
           day_evidence AS (
             SELECT d.close_date, r.completed_at, r.snapshot_rows,
                    r.time_zone, r.baseline_date,
                    COALESCE(entries.row_count, 0)::int AS actual_rows
               FROM requested_days d
               LEFT JOIN stock_daily_close_runs r ON r.close_date = d.close_date
               LEFT JOIN LATERAL (
                 SELECT COUNT(*)::int AS row_count
                   FROM stock_daily_close_entries e
                  WHERE e.close_date = d.close_date
               ) entries ON TRUE
           )
           SELECT COUNT(*)::int AS expected_days,
                  COUNT(*) FILTER (
                    WHERE completed_at IS NOT NULL
                      AND snapshot_rows = actual_rows
                      AND time_zone = $3
                      AND baseline_date = $4::date
                  )::int AS complete_days,
                  COUNT(*) FILTER (
                    WHERE completed_at IS NOT NULL
                      AND (
                        snapshot_rows <> actual_rows
                        OR time_zone IS DISTINCT FROM $3
                        OR baseline_date IS DISTINCT FROM $4::date
                      )
                  )::int AS corrupt_days
             FROM day_evidence`,
          [fromDate, toDate, baselineTimeZone, baselineDate],
        );
        dailyStockExpected = Number(coverage?.expected_days ?? 0);
        dailyStockActual = Number(coverage?.complete_days ?? 0);
        const corruptDays = Number(coverage?.corrupt_days ?? 0);
        if (corruptDays > 0) {
          dailyStockStatus = "FAIL";
          dailyStockExplanation =
            `${corruptDays} persisted daily close(s) do not match their recorded row count or pinned baseline identity.`;
        } else if (dailyStockActual === dailyStockExpected) {
          dailyStockStatus = "PASS";
          dailyStockExplanation =
            `Every date in the selected range has a committed company-local quantity snapshot, and each snapshot matches its recorded row count. Dates before ${baselineDate} are not certified by this check.`;
        } else {
          dailyStockExplanation =
            `Only ${dailyStockActual} of ${dailyStockExpected} dates in the selected range have complete persisted quantity snapshots.`;
        }
      }
    }
    checks.push(check("FI-08", "Daily stock continuity", dailyStockStatus, {
      actual: dailyStockActual, expected: dailyStockExpected, unit: "days",
      date: toDate, location: locJson, source: dailyStockSource,
      explanation: dailyStockExplanation,
    }));
    const unavailable = (id: string, title: string, explanation: string) =>
      checks.push(check(id, title, "UNVERIFIED", { date: toDate, location: locJson, source: "diagnostic evidence not yet materialized", explanation }));
    unavailable("FI-09", "Opening/closing continuity", "Universal Closing(D)=Opening(D+1) still needs a separately validated opening-position comparison; pre-baseline dates remain unverified.");
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
    checks.push(check("FI-22", "Negative stock", negativeStock == null ? "UNVERIFIED" : negativeStock === 0 ? "PASS" : "FAIL", {
      actual: negativeStock, expected: 0, unit: "rows", date: toDate, location: locJson, source: "stock_entries",
      explanation: negativeStock == null ? "The stock quantity query could not be established." : negativeStock === 0 ? "No negative stock-entry quantities exist." : `${negativeStock} negative stock-entry quantities exist.`,
    }));
    unavailable("FI-23", "Negative batches", "Batch-level negative quantity reconciliation is not yet included in the diagnostic query set.");
    unavailable("FI-24", "Over-allocation", "Allocation capacity must be checked per bill and is not inferred from report totals.");
    unavailable("FI-25", "Duplicate settlement", "One-receipt settlement uniqueness needs a dedicated source/allocation query.");
    unavailable("FI-26", "Location isolation", "Location isolation requires the authenticated matrix tests; a read-only aggregate cannot prove ID-tampering resistance.");
    unavailable("FI-27", "Audit durability", "Audit durability requires fault-injection rollback tests; presence of audit rows alone cannot prove atomicity.");

    const summary = checks.reduce((s, c) => ({ ...s, [c.status]: s[c.status] + 1 }), { PASS: 0, WARN: 0, FAIL: 0, UNVERIFIED: 0 });
    res.json({
      fromDate, toDate, location: locJson, readOnly: true,
      summary,
      checks,
      valuation: { reliable: valuation.reliable, note: valuation.note },
    });
  },
);

export default router;