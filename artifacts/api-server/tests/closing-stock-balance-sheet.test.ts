/**
 * Read-only regression against the development database. No test transactions,
 * stock movements, or balancing entries are written.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx tests/closing-stock-balance-sheet.test.ts
 * Optional STOCK_BASELINE_PATH compares the entire P&L with a pre-fix snapshot.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { buildBooks, previousDay, todayISO, type Books } from "../src/lib/books";
import { buildDerivedPostings } from "../src/routes/journal";
import { canonicalDocument } from "../src/services/reportCanonicalDocument";

const r2 = (n: number) => Math.round(n * 100) / 100;
let passed = 0;
function check(name: string, test: () => void) {
  test();
  passed++;
  console.log(`PASS ${name}`);
}

function checkStock(b: Books, label: string) {
  const a = b.balanceSheet.assets;
  const p = b.profitAndLoss.incomes;
  check(`${label}: stock is identical in assets and P&L`, () => {
    assert.equal(a.closingStock, p.closingStock);
    assert.equal(a.closingStockOnHand, p.closingStockOnHand);
    assert.equal(a.closingStockInTransit, p.closingStockInTransit);
  });
  check(`${label}: assets include stock exactly once`, () => {
    assert.equal(a.total, r2(a.fixedAssets.total + a.currentAssets.total + a.closingStock));
    assert.equal(b.integrity.difference, r2(a.total - b.balanceSheet.liabilities.total));
  });
  check(`${label}: canonical export shows the same stock and asset total`, () => {
    const doc = canonicalDocument({ reportId: "balance-sheet", filters: {}, display: {} }, b);
    const assets = doc.sections.find(s => s.heading === "Assets");
    assert.ok(assets);
    assert.deepEqual(assets.rows.filter(row => row[0] === "Closing Stock"), [["Closing Stock", a.closingStock]]);
    assert.equal(assets.totalsRow?.[1], a.total);
  });
}

async function run() {
  const q = await pool.connect();
  try {
    await q.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const postings = await buildDerivedPostings({ q });
    const current = await buildBooks(async () => postings, { q });
    checkStock(current, "Current consolidated");

    if (process.env.STOCK_BASELINE_PATH) {
      const before: Books = JSON.parse(readFileSync(process.env.STOCK_BASELINE_PATH, "utf8"));
      check("P&L, inventory valuation, opening balances, and liabilities are unchanged", () => {
        assert.deepEqual(current.profitAndLoss, before.profitAndLoss);
        assert.deepEqual(current.openingBalances, before.openingBalances);
        assert.deepEqual(current.capitalisationOverlay, before.capitalisationOverlay);
        assert.equal(current.balanceSheet.liabilities.total, before.balanceSheet.liabilities.total);
        assert.deepEqual(current.balanceSheet.assets.fixedAssets, before.balanceSheet.assets.fixedAssets);
        assert.deepEqual(current.balanceSheet.assets.currentAssets, before.balanceSheet.assets.currentAssets);
      });
      check("Only the actual stock value is added to assets", () => {
        assert.equal(current.balanceSheet.assets.total, r2(before.balanceSheet.assets.total + current.balanceSheet.assets.closingStock));
        assert.equal(current.integrity.difference, r2(before.integrity.difference + current.balanceSheet.assets.closingStock));
      });
    }

    const company = await buildBooks(async () => postings, { q, location: { type: "company", id: null } });
    checkStock(company, "Company-only");
    check("Company-only slice does not invent inventory", () => assert.equal(company.balanceSheet.assets.closingStock, 0));

    const { rows: [branch] } = await q.query(
      "SELECT branch_type, branch_id FROM stock_entries WHERE quantity > 0 AND branch_type IN ('warehouse', 'outlet', 'headoffice') ORDER BY id LIMIT 1",
    );
    if (branch) {
      const located = await buildBooks(async () => postings, {
        q, location: { type: branch.branch_type, id: Number(branch.branch_id) },
      });
      checkStock(located, "Location");
    }

    const historical = await buildBooks(buildDerivedPostings, { q, toDate: previousDay(todayISO()) });
    checkStock(historical, "Historical");
    check("Unverified historical evidence is not suppressed", () => {
      if (!historical.profitAndLoss.incomes.closingStockReliable) {
        assert.ok(historical.profitAndLoss.incomes.closingStockNote);
      }
    });

    const { rows: [cash] } = await q.query("SELECT id FROM account_ledgers WHERE code = 'STD-CASH'");
    assert.ok(cash, "Regression requires the system cash ledger");
    // Inject a defect only in memory: the actual database remains read-only.
    const broken = await buildBooks(async () => [...postings, {
      date: todayISO(), ledgerId: Number(cash.id), debit: 123.45, credit: 0,
      entryId: "stock-regression-unbalanced", voucherNumber: "STOCK-REGRESSION",
    }], { q });
    check("Genuine imbalance still fails; stock is not used as a plug", () => {
      assert.equal(broken.integrity.status, "FAIL");
      assert.equal(broken.integrity.balanced, false);
      assert.equal(broken.integrity.difference, r2(current.integrity.difference + 123.45));
      assert.equal(broken.balanceSheet.assets.closingStock, current.balanceSheet.assets.closingStock);
      assert.ok(broken.integrity.issues.some(issue => issue.includes("STOCK-REGRESSION")));
    });
    console.log(JSON.stringify({
      passed,
      current: {
        assets: current.balanceSheet.assets.total,
        liabilities: current.balanceSheet.liabilities.total,
        closingStock: current.balanceSheet.assets.closingStock,
        integrity: current.integrity,
      },
    }, null, 2));
  } finally {
    await q.query("ROLLBACK");
    q.release();
    await pool.end();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
