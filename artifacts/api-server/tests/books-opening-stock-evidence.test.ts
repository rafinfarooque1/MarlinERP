/**
 * Read-only regression for the historical stock evidence path.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx tests/books-opening-stock-evidence.test.ts
 *
 * Uses the live development database without creating or changing business rows.
 */
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { buildBooks } from "../src/lib/books";
import { stockValuation } from "../src/lib/valuation";
import { buildDerivedPostings } from "../src/routes/journal";

const fromDate = "2026-09-01";
const toDate = "2026-09-30";

try {
  const [books, closingValuation, movementReconciliation] = await Promise.all([
    buildBooks(buildDerivedPostings, { fromDate, toDate }),
    stockValuation(pool, { asOf: toDate, includeInTransit: true }),
    pool.query(`
      WITH ledger AS (
        SELECT material_type, ref_id, branch_type, branch_id,
               SUM(qty_change::numeric) AS qty
          FROM stock_ledger GROUP BY 1, 2, 3, 4
      ),
      keys AS (
        SELECT material_type, item_id::int AS ref_id, branch_type, branch_id FROM stock_entries
        UNION
        SELECT material_type, ref_id, branch_type, branch_id FROM ledger
      )
      SELECT COUNT(*) FILTER (
               WHERE ABS(COALESCE(se.quantity, 0)::numeric - COALESCE(l.qty, 0)::numeric) > 0.001
             )::int AS mismatched_keys
        FROM keys k
        LEFT JOIN stock_entries se
          ON se.material_type = k.material_type AND se.item_id = k.ref_id
         AND se.branch_type = k.branch_type AND se.branch_id = k.branch_id
        LEFT JOIN ledger l
          ON l.material_type = k.material_type AND l.ref_id = k.ref_id
         AND l.branch_type = k.branch_type AND l.branch_id = k.branch_id
    `),
  ]);
  const pl = books.profitAndLoss;
  const expenses = pl.expenses;
  const incomes = pl.incomes;
  const summary = pl.summary;

  if (String(expenses.openingStockNote ?? "").includes("no persisted cost checkpoint")) {
    assert.equal(
      expenses.openingStockReliable,
      false,
      "Opening value must remain unverified when historical cost checkpoints are missing.",
    );
  }
  assert.ok(
    expenses.openingStockReliable || expenses.openingStockNote,
    "An unverified opening position must include a reason.",
  );
  if (!expenses.openingStockReliable) {
    assert.ok(expenses.openingStockNote, "Unverified opening stock must explain its evidence gap.");
    assert.ok(
      books.integrity.issues.some((issue) =>
        issue.includes(expenses.openingStockNote!) && issue.includes("Opening stock as at 2026-08-31 is unverified"),
      ),
      "The Balance Sheet/Books warning must preserve the opening-stock evidence detail.",
    );
  }

  assert.ok(
    movementReconciliation.rows[0].mismatched_keys === 0 || !expenses.openingStockReliable,
    "A stock movement mismatch must never be reported as a reliable opening position.",
  );
  assert.ok(
    Math.abs(incomes.closingStock - closingValuation.grandTotal) < 0.02,
    "P&L closing inventory must match the dated inventory valuation.",
  );

  const expectedCogs =
    expenses.openingStock + expenses.purchases + expenses.directExpenses.total - incomes.closingStock;
  assert.ok(
    Math.abs(expectedCogs - summary.costOfGoodsSold) < 0.02,
    "Consolidated COGS must reconcile to opening stock + purchases + direct costs - closing stock.",
  );
  assert.ok(
    Math.abs(summary.revenue - summary.costOfGoodsSold - summary.grossProfit) < 0.02,
    "Net sales less COGS must equal gross profit.",
  );
  assert.ok(
    Math.abs(summary.grossProfit + summary.otherIncome - summary.operatingExpenses - summary.netProfit) < 0.02,
    "Gross profit plus other income less operating expenses must equal net profit.",
  );
  assert.ok(
    Math.abs(books.balanceSheet.assets.total - books.balanceSheet.liabilities.total) < 0.02,
    "The Balance Sheet equation must reconcile independently of evidence status.",
  );

  console.log(JSON.stringify({
    period: books.period,
    openingStock: expenses.openingStock,
    openingStockReliable: expenses.openingStockReliable,
    openingStockNote: expenses.openingStockNote,
    movementMismatches: movementReconciliation.rows[0].mismatched_keys,
    closingStock: incomes.closingStock,
    closingValuation: closingValuation.grandTotal,
    cogs: summary.costOfGoodsSold,
    netProfit: summary.netProfit,
    booksStatus: books.integrity.status,
  }, null, 2));
} finally {
  await pool.end();
}
