/**
 * Regression for location-specific inventory cost checkpoints.
 *
 * A purchase at location B changes the product master average cost, but must
 * not revalue unchanged stock at location A. The fixtures are disposable and
 * use only the company-local current date and the preceding open date.
 */
import pg from "pg";
import { createTestAdmin } from "./support/testAuth.mjs";

const BASE = process.env.API_URL || "http://localhost:8080/api";
const TAG = "ZZLOCOST";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params = []) => pool.query(text, params);

let fixtureAuth;
let authToken = "";
let vendorId = 0;
let materialId = 0;
let warehouseA = 0;
let warehouseB = 0;
let purchaseA = 0;
let purchaseB = 0;
let transferId = 0;
const warehouseLedgers = new Map();
let passed = 0;
let failed = 0;
const failures = [];

const money = (value) => Math.round(Number(value ?? 0) * 100) / 100;
const closeEnough = (a, b, tolerance = 0.01) => Math.abs(money(a) - money(b)) < tolerance;

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

function statementFigures(statement) {
  const pnl = statement?.profitAndLoss ?? {};
  return {
    revenue: money(pnl.summary?.revenue),
    openingStock: money(pnl.expenses?.openingStock),
    openingPhysical: money(pnl.expenses?.openingStockPhysical),
    openingTransferAdjustment: money(pnl.expenses?.openingStockTransferAdjustment),
    purchases: money(pnl.expenses?.purchases),
    purchaseReturns: money(pnl.expenses?.purchaseReturns),
    directExpenses: money(pnl.expenses?.directExpenses?.total),
    closingStock: money(pnl.incomes?.closingStock),
    cogs: money(pnl.summary?.costOfGoodsSold),
    grossProfit: money(pnl.summary?.grossProfit),
    netProfit: money(pnl.summary?.netProfit),
  };
}

async function companyPnl() {
  const response = await get("/accounts/financial-statements");
  return { response, figures: statementFigures(response.data) };
}

function assertSamePnl(label, before, after) {
  for (const key of ["revenue", "cogs", "grossProfit", "netProfit", "openingStock", "closingStock"]) {
    assert(`${label}: ${key} unchanged`, closeEnough(before[key], after[key]),
      `before=${before[key]} after=${after[key]}`);
  }
}

async function readStatement(date, locationId) {
  const response = await get(
    `/accounts/financial-statements?fromDate=${date}&toDate=${date}` +
    `&locationType=warehouse&locationId=${locationId}`,
  );
  return { response, figures: statementFigures(response.data) };
}

async function assertCompanyIntegrity(date, label) {
  const [books, trial] = await Promise.all([
    get(`/accounts/financial-statements?fromDate=${date}&toDate=${date}`),
    get(`/accounts/trial-balance?toDate=${date}`),
  ]);
  const integrity = books.data?.integrity ?? {};
  const rows = trial.data?.rows ?? [];
  const debit = money(trial.data?.totalDebit ?? rows.reduce((sum, row) => sum + Number(row.debit ?? 0), 0));
  const credit = money(trial.data?.totalCredit ?? rows.reduce((sum, row) => sum + Number(row.credit ?? 0), 0));
  assert(`${label}: Balance Sheet is balanced`, integrity.balanced === true,
    JSON.stringify(integrity).slice(0, 240));
  assert(`${label}: Balance Sheet difference is zero`, money(integrity.difference) === 0,
    `difference=${integrity.difference}`);
  assert(`${label}: Balance Sheet reports no issues`,
    Array.isArray(integrity.issues) && integrity.issues.length === 0,
    JSON.stringify(integrity.issues).slice(0, 240));
  assert(`${label}: company Trial Balance is balanced`,
    trial.status === 200 && trial.data?.balanced === true && closeEnough(debit, credit),
    `debit=${debit} credit=${credit}`);
}

async function createWarehouse(name, suffix) {
  const response = await post("/warehouses", {
    name: `${TAG} ${name} ${suffix}`,
    location: "Bengaluru",
    state: "Karnataka",
    // Same GSTIN keeps this transfer an internal relocation, so the regression
    // isolates stock valuation rather than taxable transfer documents.
    gstNumber: "29ZLCSC1234C1Z5",
  });
  const id = Number(response.data?.id ?? 0);
  const ledgerIds = [
    response.data?.cashLedgerId,
    response.data?.salesLedgerId,
    response.data?.purchaseLedgerId,
  ].filter((value) => Number(value) > 0).map(Number);
  warehouseLedgers.set(id, ledgerIds);
  assert(`Disposable warehouse ${name} is created`, (response.status === 200 || response.status === 201) && id > 0,
    `status=${response.status} body=${JSON.stringify(response.data).slice(0, 220)}`);
  return id;
}

async function purchaseAt(date, locationId, unitCost, invoiceSuffix) {
  const response = await post("/purchases", {
    vendorId,
    purchaseDate: date,
    vendorInvoiceDate: date,
    invoiceNumber: `${TAG}-${invoiceSuffix}-${process.pid}-${Date.now()}`,
    locationType: "warehouse",
    locationId,
    lineItems: [{
      materialType: "material",
      materialId,
      quantity: 10,
      unitCost,
      hsnCode: "0901",
      discount: 0,
      gstRate: 0,
      taxType: "intra",
      mfgDate: date,
      expiryDate: addDays(date, 365),
      batchNumber: `${TAG}-${invoiceSuffix}-${process.pid}`,
    }],
  });
  assert(`Purchase at ${invoiceSuffix} is created`, (response.status === 200 || response.status === 201) &&
    Number(response.data?.id ?? 0) > 0,
  `status=${response.status} body=${JSON.stringify(response.data).slice(0, 260)}`);
  return Number(response.data?.id ?? 0);
}

async function cleanup() {
  // Reverse through the normal API first, then remove only this test's
  // append-only history and snapshots. No lock rows are touched.
  if (transferId) {
    await sql(`DELETE FROM stock_reservations WHERE doc_type = 'stock_transfer' AND doc_id = $1`, [transferId]).catch(() => {});
    await sql(`DELETE FROM stock_transfers WHERE id = $1`, [transferId]).catch(() => {});
    transferId = 0;
  }
  for (const purchaseId of [purchaseB, purchaseA]) {
    if (!purchaseId) continue;
    const response = await del(`/purchases/${purchaseId}`).catch((error) => ({ status: 0, data: { error: String(error) } }));
    assert(`Disposable purchase ${purchaseId} is deleted through the API`, response.status === 204,
      `status=${response.status} body=${JSON.stringify(response.data).slice(0, 220)}`);
  }
  purchaseA = 0;
  purchaseB = 0;

  if (materialId) {
    await sql(`DELETE FROM stock_reservations WHERE material_type = 'material' AND ref_id = $1`, [materialId]).catch(() => {});
    await sql(`DELETE FROM stock_cost_snapshots WHERE material_type = 'material' AND ref_id = $1`, [materialId]).catch(() => {});
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

  for (const [warehouseId, ledgerIds] of warehouseLedgers) {
    if (!warehouseId) continue;
    const response = await del(`/warehouses/${warehouseId}`).catch((error) => ({
      status: 0, data: { error: String(error) },
    }));
    assert(`Disposable warehouse ${warehouseId} is deleted through the API`, response.status === 204,
      `status=${response.status} body=${JSON.stringify(response.data).slice(0, 220)}`);
    if (response.status !== 204 || !ledgerIds.length) continue;
    const { rows: [used] } = await sql(
      `SELECT COUNT(*)::int AS n FROM journal_voucher_lines WHERE ledger_id = ANY($1::int[])`,
      [ledgerIds],
    );
    assert(`Disposable warehouse ${warehouseId} ledgers have no journal history`, Number(used?.n ?? 1) === 0,
      `journal lines=${used?.n}`);
    if (Number(used?.n ?? 0) === 0) {
      await sql(`DELETE FROM account_ledgers WHERE id = ANY($1::int[])`, [ledgerIds]);
    }
  }
  warehouseLedgers.clear();
  warehouseA = 0;
  warehouseB = 0;
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
  const today = companyToday(String(settings?.time_zone || "Asia/Kolkata"));
  const prior = addDays(today, -1);
  const { rows: locks } = await sql(
    `SELECT year, month FROM accounting_period_locks
      WHERE (year = $1 AND month = $2) OR (year = $3 AND month = $4)`,
    [Number(today.slice(0, 4)), Number(today.slice(5, 7)),
      Number(prior.slice(0, 4)), Number(prior.slice(5, 7))],
  );
  assert("Company-local report and prior dates are open (no lock bypassed)", locks.length === 0,
    JSON.stringify(locks));
  if (locks.length > 0) throw new Error("A fixture date is locked; refusing to bypass it");

  const suffix = `${process.pid}-${Date.now()}`;
  warehouseA = await createWarehouse("A", suffix);
  warehouseB = await createWarehouse("B", suffix);
  if (!warehouseA || !warehouseB) throw new Error("Cannot create disposable warehouses");

  vendorId = Number((await sql(
    `INSERT INTO vendors (name, state, gst_number)
     VALUES ($1, 'Karnataka', $2) RETURNING id`,
    [`${TAG} Vendor ${suffix}`, "29ZLCSV1234V1Z5"],
  )).rows[0].id);
  materialId = Number((await sql(
    `INSERT INTO materials
       (name, unit, hsn_code, tax_rate, item_code, status, current_stock)
     VALUES ($1, 'EA', '0901', 0, $2, 'active', 0) RETURNING id`,
    [`${TAG} Material ${suffix}`, `${TAG}-${suffix}`],
  )).rows[0].id);

  // A's dated checkpoint is 10 × ₹100. B's later purchase changes the global
  // master average to ₹150 while A has no movement on the report date.
  purchaseA = await purchaseAt(prior, warehouseA, 100, "A");
  purchaseB = await purchaseAt(today, warehouseB, 200, "B");

  const locationA = await readStatement(today, warehouseA);
  assert("Location A statement request is scoped", locationA.response.data?.locationScoped === true &&
    locationA.response.data?.location?.type === "warehouse" &&
    Number(locationA.response.data?.location?.id) === warehouseA,
  JSON.stringify(locationA.response.data?.location));
  assert("Unchanged location A opening equals closing", closeEnough(
    locationA.figures.openingStock, 1000) && closeEnough(locationA.figures.closingStock, 1000),
  `opening=${locationA.figures.openingStock} closing=${locationA.figures.closingStock}`);
  assert("Unchanged location A has zero COGS", closeEnough(locationA.figures.cogs, 0),
    `cogs=${locationA.figures.cogs}`);
  assert("Unchanged location A has zero gross profit", closeEnough(locationA.figures.grossProfit, 0),
    `grossProfit=${locationA.figures.grossProfit}`);

  await assertCompanyIntegrity(today, "After location B cost change");
  const pnlBeforeTransfer = (await companyPnl()).figures;
  const transfer = await post("/stock/transfers", {
    fromType: "warehouse",
    fromId: warehouseA,
    toType: "warehouse",
    toId: warehouseB,
    transferDate: today,
    lineItems: [{ itemId: materialId, materialType: "material", quantity: 1 }],
    notes: `${TAG} checkpoint transfer`,
  });
  transferId = Number(transfer.data?.id ?? 0);
  assert("Checkpoint-cost transfer is dispatched", transfer.status === 201 && transferId > 0,
    `status=${transfer.status} body=${JSON.stringify(transfer.data).slice(0, 260)}`);
  if (transferId) {
    const pnlAfterDispatch = (await companyPnl()).figures;
    assertSamePnl("Dispatch preserves company valuation", pnlBeforeTransfer, pnlAfterDispatch);
    const receive = await apiReq("PATCH", `/stock/transfers/${transferId}/approve`, { approvedBy: `${TAG} test` });
    assert("Checkpoint-cost transfer is received", receive.status === 200 && !receive.data?.error,
      `status=${receive.status} body=${JSON.stringify(receive.data).slice(0, 260)}`);
    const pnlAfterReceipt = (await companyPnl()).figures;
    assertSamePnl("Receipt preserves company valuation", pnlBeforeTransfer, pnlAfterReceipt);
  }
  const owned = {
    vendorId,
    materialId,
    purchaseIds: [purchaseA, purchaseB],
    warehouseIds: [warehouseA, warehouseB],
  };
  await cleanup();
  const { rows: [left] } = await sql(
    `SELECT
       (SELECT COUNT(*) FROM vendors WHERE id = $1)
       + (SELECT COUNT(*) FROM materials WHERE id = $2)
       + (SELECT COUNT(*) FROM purchases WHERE id = ANY($3::int[]))
       + (SELECT COUNT(*) FROM warehouses WHERE id = ANY($4::int[]))
       + (SELECT COUNT(*) FROM stock_cost_snapshots
           WHERE material_type = 'material' AND ref_id = $2) AS remaining`,
    [owned.vendorId, owned.materialId, owned.purchaseIds, owned.warehouseIds],
  );
  assert("Disposable stock valuation fixtures are cleaned", Number(left?.remaining ?? 1) === 0,
    `remaining=${left?.remaining}`);
  await assertCompanyIntegrity(today, "After fixture cleanup");
}

try {
  await main();
} catch (error) {
  console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
  failed++;
  failures.push("fatal test setup/execution error");
} finally {
  await cleanup().catch((error) => {
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