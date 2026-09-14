/**
 * Focused development-only coverage for the accounting audit acceptance cases.
 *
 * Run directly (the suite creates its own disposable login fixture):
 *   node artifacts/api-server/tests/accounting-audit-acceptance.test.mjs
 *
 * Or use the shared fixture-auth runner:
 *   node artifacts/api-server/tests/run-with-fixture-auth.mjs \
 *     tests/accounting-audit-acceptance.test.mjs
 *
 * The test deliberately uses the company-local current date in an open month.
 * It provisions an otherwise-empty disposable warehouse, proves that
 * location-scoped statements are quiet, then posts one disposable taxable
 * purchase on that date.
 * No lock rows are changed and no seeded/admin password is assumed.
 */

import pg from "pg";
import { createTestAdmin } from "./support/testAuth.mjs";

const BASE = process.env.API_URL || "http://localhost:8080/api";
const TAG = "ZZAUDIT";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params = []) => pool.query(text, params);

let authToken = "";
let fixtureAuth;
let purchaseId = 0;
let vendorId = 0;
let materialId = 0;
let warehouseId = 0;
let warehouseLedgerIds = [];
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function apiReq(method, path, body) {
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(`${BASE}${path}`, options);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

const get = (path) => apiReq("GET", path);
const post = (path, body) => apiReq("POST", path, body);
const del = (path) => apiReq("DELETE", path);

const money = (value) => Math.round(Number(value ?? 0) * 100) / 100;
const closeEnough = (a, b, tolerance = 0.01) => Math.abs(money(a) - money(b)) < tolerance;

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function companyToday(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function statementFigures(statement) {
  const pnl = statement?.profitAndLoss ?? {};
  const expenses = pnl.expenses ?? {};
  const incomes = pnl.incomes ?? {};
  const summary = pnl.summary ?? {};
  return {
    openingStock: money(expenses.openingStock),
    closingStock: money(incomes.closingStock),
    purchases: money(expenses.purchases),
    revenue: money(summary.revenue),
    cogs: money(summary.costOfGoodsSold),
    grossProfit: money(summary.grossProfit),
    directExpenses: money(expenses.directExpenses?.total),
    indirectExpenses: money(expenses.indirectExpenses?.total),
    directIncomes: money(incomes.directIncomes?.total),
    indirectIncomes: money(incomes.indirectIncomes?.total),
  };
}

async function readBooks(date, locationId) {
  const response = await get(
    `/accounts/financial-statements?fromDate=${date}&toDate=${date}` +
    `&locationType=warehouse&locationId=${locationId}`,
  );
  return { response, figures: statementFigures(response.data) };
}

async function readTrialBalance(date, locationId) {
  const response = await get(
    `/accounts/trial-balance?toDate=${date}&locationType=warehouse&locationId=${locationId}`,
  );
  const rows = response.data?.rows ?? [];
  const debit = money(response.data?.totalDebit ?? rows.reduce((sum, row) => sum + Number(row.debit ?? 0), 0));
  const credit = money(response.data?.totalCredit ?? rows.reduce((sum, row) => sum + Number(row.credit ?? 0), 0));
  return { response, debit, credit };
}

function assertIntegrity(label, books, trialBalance) {
  const integrity = books.data?.integrity ?? {};
  assert(`${label}: Balance Sheet is balanced`, integrity.balanced === true,
    JSON.stringify(integrity).slice(0, 220));
  assert(`${label}: Balance Sheet difference is zero`, money(integrity.difference) === 0,
    `difference=${integrity.difference}`);
  assert(`${label}: Balance Sheet reports no integrity issues`,
    Array.isArray(integrity.issues) && integrity.issues.length === 0,
    JSON.stringify(integrity.issues).slice(0, 220));
  assert(`${label}: Trial Balance is balanced`, trialBalance.response.status === 200 &&
    trialBalance.response.data?.balanced === true &&
    closeEnough(trialBalance.debit, trialBalance.credit),
  `debit=${trialBalance.debit} credit=${trialBalance.credit}`);
}

async function cleanupData() {
  // Never remove a location while its purchase still exists. The normal API
  // reversal must succeed first; otherwise a failed cleanup must leave the
  // fixture visible rather than orphaning a dated accounting document.
  if (purchaseId) {
    const response = await del(`/purchases/${purchaseId}`).catch((error) => ({ status: 0, data: { error: String(error) } }));
    assert("Disposable purchase deleted through the API", response.status === 204,
      `status=${response.status} body=${JSON.stringify(response.data).slice(0, 220)}`);
    if (response.status !== 204) return;
    purchaseId = 0;
  }

  // The purchase DELETE route intentionally leaves the dated reversal trail.
  // This suite owns only the uniquely tagged product, so remove that trail and
  // every disposable row after the API has performed its normal reversal.
  if (materialId) {
    await sql(`DELETE FROM stock_reservations WHERE material_type = 'material' AND ref_id = $1`, [materialId]).catch(() => {});
    await sql(`DELETE FROM stock_ledger WHERE material_type = 'material' AND ref_id = $1`, [materialId]).catch(() => {});
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'material'`, [materialId]).catch(() => {});
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'material'`, [materialId]).catch(() => {});
    await sql(`DELETE FROM materials WHERE id = $1`, [materialId]).catch(() => {});
    materialId = 0;
  }
  if (vendorId) {
    await sql(`DELETE FROM account_ledgers WHERE code = $1`, [`VEND-${vendorId}`]).catch(() => {});
    await sql(`DELETE FROM vendors WHERE id = $1`, [vendorId]).catch(() => {});
    vendorId = 0;
  }

  if (warehouseId) {
    const response = await del(`/warehouses/${warehouseId}`).catch((error) => ({
      status: 0, data: { error: String(error) },
    }));
    assert("Disposable warehouse deleted through the API", response.status === 204,
      `status=${response.status} body=${JSON.stringify(response.data).slice(0, 220)}`);
    if (response.status !== 204) return;
    // The ordinary warehouse DELETE removes the warehouse and rent agreement,
    // but deliberately leaves its never-used cash/sales/purchase ledgers. They
    // are disposable fixture rows and are removed only after the API delete,
    // with a guard proving no accounting line references them.
    if (warehouseLedgerIds.length) {
      const { rows: [used] } = await sql(
        `SELECT COUNT(*)::int AS n FROM journal_voucher_lines
          WHERE ledger_id = ANY($1::int[])`,
        [warehouseLedgerIds],
      );
      assert("Disposable warehouse ledgers have no journal history", Number(used?.n ?? 1) === 0,
        `journal lines=${used?.n}`);
      if (Number(used?.n ?? 0) === 0) {
        await sql(`DELETE FROM account_ledgers WHERE id = ANY($1::int[])`, [warehouseLedgerIds]);
      }
    }
    warehouseId = 0;
    warehouseLedgerIds = [];
  }
}

async function main() {
  fixtureAuth = await createTestAdmin(pool, TAG);
  const login = await post("/auth/login", {
    username: fixtureAuth.username,
    password: fixtureAuth.password,
  });
  authToken = login.data?.token ?? "";
  assert("Disposable fixture login returns a token", !!authToken,
    `status=${login.status} body=${JSON.stringify(login.data).slice(0, 180)}`);
  if (!authToken) throw new Error("Cannot obtain disposable fixture auth token");

  const { rows: [settings] } = await sql(
    `SELECT COALESCE(general_settings->>'timeZone', 'Asia/Kolkata') AS time_zone
       FROM company_settings LIMIT 1`,
  );
  const timeZone = String(settings?.time_zone || "Asia/Kolkata");
  const today = companyToday(timeZone);
  const { rows: locks } = await sql(
    `SELECT year, month FROM accounting_period_locks
      WHERE year = $1 AND month = $2`,
    [Number(today.slice(0, 4)), Number(today.slice(5, 7))],
  );
  assert("Company-local current month is open (no lock bypassed)", locks.length === 0,
    `${today.slice(0, 7)} has ${locks.length} lock row(s)`);
  if (locks.length > 0) throw new Error("The company-local current month is locked; refusing to bypass it");

  // Provision an unused warehouse through the API. Its location slice is
  // isolated from the shared company history, so no existing sale, purchase,
  // or stock movement can invalidate the no-activity case.
  const suffix = `${process.pid}-${Date.now()}`;
  const warehouse = await post("/warehouses", {
    name: `${TAG} Warehouse ${suffix}`,
    location: "Bengaluru",
    state: "Karnataka",
    gstNumber: "29ZZAUD9999A1Z5",
  });
  warehouseId = Number(warehouse.data?.id ?? 0);
  warehouseLedgerIds = [
    warehouse.data?.cashLedgerId,
    warehouse.data?.salesLedgerId,
    warehouse.data?.purchaseLedgerId,
  ].filter((id) => Number(id) > 0).map(Number);
  if (warehouseId && warehouseLedgerIds.length === 0) {
    const { rows } = await sql(
      `SELECT id FROM account_ledgers
        WHERE name LIKE $1`,
      [`${TAG} Warehouse ${suffix}%`],
    );
    warehouseLedgerIds = rows.map((row) => Number(row.id));
  }
  assert("Disposable isolated warehouse is created", (warehouse.status === 200 || warehouse.status === 201) && warehouseId > 0,
    `status=${warehouse.status} body=${JSON.stringify(warehouse.data).slice(0, 260)}`);
  if (!warehouseId) throw new Error("Cannot create disposable isolated warehouse");

  // The date is the company-local current date, and the lock check above
  // proves its month is open. The new location has no prior activity by
  // construction, so this is a guaranteed no-activity period.
  const quietDate = today;
  const before = await readBooks(quietDate, warehouseId);
  const beforeBooks = before.response;

  const beforeFigures = before.figures;
  const beforeTrialBalance = await readTrialBalance(quietDate, warehouseId);
  assert("Isolated no-activity statement is location-scoped",
    beforeBooks.data?.locationScoped === true &&
    beforeBooks.data?.location?.type === "warehouse" &&
    Number(beforeBooks.data?.location?.id) === warehouseId,
    JSON.stringify(beforeBooks.data?.location));
  assert("No-activity period opening stock equals closing stock",
    closeEnough(beforeFigures.openingStock, beforeFigures.closingStock),
    `opening=${beforeFigures.openingStock} closing=${beforeFigures.closingStock}`);
  assert("No-activity period COGS contribution is zero", closeEnough(beforeFigures.cogs, 0),
    `cogs=${beforeFigures.cogs}`);
  assert("No-activity period gross-profit contribution is zero", closeEnough(beforeFigures.grossProfit, 0),
    `grossProfit=${beforeFigures.grossProfit}`);
  assertIntegrity("Before disposable purchase", beforeBooks, beforeTrialBalance);

  vendorId = Number((await sql(
    `INSERT INTO vendors (name, state, gst_number)
     VALUES ($1, 'Karnataka', $2) RETURNING id`,
    [`${TAG} Vendor ${suffix}`, `29ZZAUD${String(process.pid).padStart(4, "0")}A1Z5`],
  )).rows[0].id);
  materialId = Number((await sql(
    `INSERT INTO materials
       (name, unit, hsn_code, tax_rate, item_code, status, current_stock)
     VALUES ($1, 'EA', '0901', 12, $2, 'active', 0) RETURNING id`,
    [`${TAG} Material ${suffix}`, `${TAG}-${suffix}`],
  )).rows[0].id);

  const quantity = 4;
  const unitCost = 125;
  const taxableValue = quantity * unitCost;
  const purchase = await post("/purchases", {
    vendorId,
    purchaseDate: quietDate,
    vendorInvoiceDate: quietDate,
    invoiceNumber: `${TAG}-${suffix}`,
    locationType: "warehouse",
    locationId: warehouseId,
    lineItems: [{
      materialType: "material",
      materialId,
      quantity,
      unitCost,
      hsnCode: "0901",
      discount: 0,
      gstRate: 12,
      taxType: "intra",
      mfgDate: quietDate,
      expiryDate: addDays(quietDate, 365),
      batchNumber: `${TAG}-BATCH-${suffix}`,
    }],
  });
  purchaseId = Number(purchase.data?.id ?? 0);
  assert("Disposable purchase is created on the open quiet date",
    (purchase.status === 200 || purchase.status === 201) && purchaseId > 0,
    `status=${purchase.status} body=${JSON.stringify(purchase.data).slice(0, 260)}`);
  assert("Purchase taxable inventory value is ₹500.00",
    closeEnough(Number(purchase.data?.subtotal ?? 0) - Number(purchase.data?.discountTotal ?? 0), taxableValue),
    `subtotal=${purchase.data?.subtotal} discount=${purchase.data?.discountTotal}`);
  assert("Purchase GST is excluded from taxable inventory value",
    closeEnough(Number(purchase.data?.taxTotal ?? 0), 60),
    `taxTotal=${purchase.data?.taxTotal}`);

  const afterBooks = await readBooks(quietDate, warehouseId);
  const afterFigures = afterBooks.figures;
  const afterTrialBalance = await readTrialBalance(quietDate, warehouseId);
  assert("Purchase-only period closing stock rises by taxable inventory value",
    closeEnough(afterFigures.closingStock - afterFigures.openingStock, taxableValue),
    `opening=${afterFigures.openingStock} closing=${afterFigures.closingStock} expectedRise=${taxableValue}`);
  assert("Purchase-only period opening stock is unchanged",
    closeEnough(afterFigures.openingStock, beforeFigures.openingStock),
    `before=${beforeFigures.openingStock} after=${afterFigures.openingStock}`);
  assert("Purchase-only period COGS remains zero", closeEnough(afterFigures.cogs, 0),
    `cogs=${afterFigures.cogs}`);
  assert("Purchase-only period gross profit remains zero", closeEnough(afterFigures.grossProfit, 0),
    `grossProfit=${afterFigures.grossProfit}`);
  assert("Purchase-only period has no revenue", closeEnough(afterFigures.revenue, 0),
    `revenue=${afterFigures.revenue}`);
  assert("Purchase-only period purchases equal taxable inventory value",
    closeEnough(afterFigures.purchases, taxableValue),
    `purchases=${afterFigures.purchases} expected=${taxableValue}`);
  assertIntegrity("After disposable purchase", afterBooks.response, afterTrialBalance);

  const ownedIds = {
    purchaseId, vendorId, materialId, warehouseId,
    warehouseLedgerIds: [...warehouseLedgerIds],
  };
  await cleanupData();
  const afterCleanupBooks = await readBooks(quietDate, ownedIds.warehouseId);
  const afterCleanupTrialBalance = await readTrialBalance(quietDate, ownedIds.warehouseId);
  const afterCleanupFigures = afterCleanupBooks.figures;
  assert("After cleanup, no-activity opening stock is restored",
    closeEnough(afterCleanupFigures.openingStock, beforeFigures.openingStock));
  assert("After cleanup, no-activity closing stock is restored",
    closeEnough(afterCleanupFigures.closingStock, beforeFigures.closingStock));
  assert("After cleanup, no-activity COGS is zero", closeEnough(afterCleanupFigures.cogs, 0));
  assert("After cleanup, no-activity gross profit is zero", closeEnough(afterCleanupFigures.grossProfit, 0));
  assertIntegrity("After fixture cleanup", afterCleanupBooks.response, afterCleanupTrialBalance);
  const { rows: [left] } = await sql(
    `SELECT
       (SELECT COUNT(*) FROM vendors WHERE id = $1)
       + (SELECT COUNT(*) FROM materials WHERE id = $2)
       + (SELECT COUNT(*) FROM purchases WHERE id = $3)
       + (SELECT COUNT(*) FROM warehouses WHERE id = $4) AS remaining`,
    [ownedIds.vendorId, ownedIds.materialId, ownedIds.purchaseId, ownedIds.warehouseId],
  );
  assert("All disposable accounting fixtures are removed", Number(left?.remaining ?? 1) === 0,
    `remaining=${left?.remaining}`);
  if (ownedIds.warehouseLedgerIds.length) {
    const { rows: [ledgersLeft] } = await sql(
      `SELECT COUNT(*)::int AS n FROM account_ledgers WHERE id = ANY($1::int[])`,
      [ownedIds.warehouseLedgerIds],
    );
    assert("All disposable warehouse ledgers are removed", Number(ledgersLeft?.n ?? 1) === 0,
      `ledgers remaining=${ledgersLeft?.n}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
  failed++;
  failures.push("fatal test setup/execution error");
} finally {
  await cleanupData().catch((error) => {
    console.error(`Cleanup error: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
    failures.push("fixture cleanup");
  });
  await fixtureAuth?.cleanup?.().catch((error) => {
    console.error(`Auth fixture cleanup error: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
    failures.push("auth fixture cleanup");
  });
  await pool.end().catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed${failed ? ` — ${failures.join(" | ")}` : ""}`);
  process.exit(failed ? 1 : 0);
}