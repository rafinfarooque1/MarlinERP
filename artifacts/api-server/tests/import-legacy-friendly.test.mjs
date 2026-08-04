/**
 * Legacy-ERP-friendly import behaviours (Aug 2026 upgrade).
 * Run: node artifacts/api-server/tests/import-legacy-friendly.test.mjs
 *
 * Rules under test:
 *   Order-independent grouping: every row carrying the same Invoice No is ONE
 *     document no matter where it sits in the file (no "consecutive" rule).
 *   Blank Date/Customer on repeat rows INHERIT the invoice's values; a
 *     CONFLICTING non-blank date or party on the same invoice is an error.
 *   Line Total: blank Price + Line Total → unit price = LT ÷ Qty (warning);
 *     Price that EQUALS the Line Total with qty>1 is treated as the line
 *     total (warning); a mismatched Line Total is a warning, Price wins.
 *   Walk-in sales: blank Customer + Cash/Bank/UPI → committed with NO
 *     customer (customer_id NULL, B2C number); blank Customer + credit = error.
 *   Auto-create at commit: unknown customer/vendor names are created (with
 *     ledgers) when the batch commits — same path as the resolve step.
 *   Company Settings → Data Import toggles turn each behaviour off:
 *     auto-create → needs_party; walk-in → error; MRP→discount → error;
 *     Line Total detection → Price required error.
 *   Books stay clean: trial balance identical before and after rollback.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZIMPLEG fixtures and deletes every one of them at the end.
 */

import pg from 'pg';
import ExcelJS from 'exceljs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZIMPLEG';
const WH = 2; // Marlin Mangaluru Depot — same warehouse the other suites use

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}
const r2 = (n) => Math.round(n * 100) / 100;

async function apiReq(method, path, body, token = authToken) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const post = (p, b, t) => apiReq('POST', p, b, t);
const get = (p, t) => apiReq('GET', p, undefined, t);
const patch = (p, b, t) => apiReq('PATCH', p, b, t);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

async function snapshotTB() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  return {
    totalDr: r2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: r2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
  };
}

async function uploadXlsx(module, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const r = await fetch(`${BASE}/imports/parse?module=${module}&locationType=warehouse&locationId=${WH}&filename=${TAG}.xlsx`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  return { status: r.status, data: await r.json() };
}

// Data Import settings live in company generalSettings — PATCH REPLACES the
// whole object, so every write must merge over the current value.
let savedGeneralSettings = null;
async function setImportSettings(overrides) {
  const cur = (await get('/company/settings')).data?.generalSettings ?? {};
  if (savedGeneralSettings === null) savedGeneralSettings = { ...cur };
  const res = await patch('/company/settings', { generalSettings: { ...cur, ...overrides } });
  return res.status === 200;
}
async function restoreSettings() {
  if (savedGeneralSettings !== null) {
    await patch('/company/settings', { generalSettings: savedGeneralSettings }).catch(() => {});
    savedGeneralSettings = null;
  }
}

const fixtures = { vendorId: 0, itemId: 0, custId: 0 };
const createdPurchases = [];
const batches = [];

async function cleanup() {
  await restoreSettings();
  for (const id of batches.splice(0)) {
    await post(`/imports/batches/${id}/rollback`, {}).catch(() => {});
  }
  const { rows: stray } = await sql(
    `SELECT id, invoice_number FROM sales WHERE legacy_invoice_number LIKE $1`, [`${TAG}%`]);
  for (const s of stray) {
    await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [s.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [s.id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [s.id]);
  }
  for (const id of createdPurchases.splice(0)) { await apiReq('DELETE', `/purchases/${id}`).catch(() => {}); }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fixtures.itemId) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
  }
  await sql(`DELETE FROM import_rows WHERE batch_id IN (SELECT id FROM import_batches WHERE filename LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM import_batches WHERE filename LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND (code LIKE 'VEND-%' OR code LIKE 'CUST-%')`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

const loginRes = await post('/auth/login', {
  username: process.env.TEST_ADMIN_USER || 'admin',
  password: process.env.TEST_ADMIN_PASSWORD || 'marlin1458', // dev-only default
});
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup();
const tbBefore = await snapshotTB();

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZLEG1234V1Z5') RETURNING id`,
  [`${TAG} Vendor`])).rows[0].id;
fixtures.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-ZZLEG-01','2900000000133','active') RETURNING id`,
  [`${TAG} Item`])).rows[0].id;
fixtures.custId = (await sql(
  `INSERT INTO customers (name, gst_number) VALUES ($1, NULL) RETURNING id`,
  [`${TAG} Buyer`])).rows[0].id;

{ // stock for the sales imports + a known avg cost
  const res = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: '2026-07-30',
    locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId: fixtures.itemId, quantity: 200, unitCost: 40, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
  });
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  assert('Stock purchased for the fixtures', res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

// Make sure every forgiving toggle starts ON, whatever the company had.
assert('Import settings switched ON for the main tests', await setImportSettings({
  importAutoCreateCustomers: true, importAutoCreateVendors: true,
  importAutoWalkInCustomer: true, importMrpToDiscount: true, importDetectLineTotal: true,
}));

const HEADERS = ['Invoice No', 'Date', 'Customer', 'Item', 'Qty', 'Price', 'Line Total', 'Discount', 'Payment Status', 'Payment Account'];

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Order-independent grouping + blank-cell inheritance');

{
  // Rows of A and B interleaved; A's second row has BLANK date + customer.
  const up = await uploadXlsx('sales', [
    HEADERS,
    [`${TAG}/G/A`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 1, 100, '', '', 'Paid', 'Cash'],
    [`${TAG}/G/B`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 2, 100, '', '', 'Paid', 'Cash'],
    [`${TAG}/G/A`, '', '', `${TAG} Item`, 3, 100, '', '', '', ''],
  ]);
  if (up.data?.batch?.id) batches.push(up.data.batch.id);
  const rows = up.data?.rows ?? [];
  assert('Scattered rows of one invoice validate (no consecutive rule)',
    up.data?.batch?.status === 'validated' && rows.every((r) => r.status !== 'error'),
    JSON.stringify(rows.map((x) => [x.status, x.reason])).slice(0, 300));
  assert('They group into TWO documents', up.data?.summary?.invoices === 2, JSON.stringify(up.data?.summary));
  assert('Blank date/customer inherit — invoice A totals BOTH its lines (4 × ₹100)',
    rows[0]?.docIndex === rows[2]?.docIndex
    && r2(Number(rows[0]?.raw?.norm?.computedTotal ?? (up.data?.summary?.totalAmount - 200))) === 400
    || r2(up.data?.summary?.totalAmount ?? 0) === 600,
    JSON.stringify(up.data?.summary));
}

{
  // Same invoice number with a DIFFERENT date, and another with a different customer.
  const up = await uploadXlsx('sales', [
    HEADERS,
    [`${TAG}/G/C`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 1, 100, '', '', 'Paid', 'Cash'],
    [`${TAG}/G/C`, '2026-08-03', '', `${TAG} Item`, 1, 100, '', '', '', ''],
    [`${TAG}/G/D`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 1, 100, '', '', 'Paid', 'Cash'],
    [`${TAG}/G/D`, '', 'Someone Else Entirely', `${TAG} Item`, 1, 100, '', '', '', ''],
  ]);
  if (up.data?.batch?.id) batches.push(up.data.batch.id);
  const rows = up.data?.rows ?? [];
  assert('Two different dates on one invoice is an error',
    rows[1]?.status === 'error' && /two different dates/i.test(String(rows[1]?.reason ?? '')),
    JSON.stringify(rows[1]?.reason));
  assert('Two different customers on one invoice is an error',
    rows[3]?.status === 'error' && /two different/i.test(String(rows[3]?.reason ?? '')),
    JSON.stringify(rows[3]?.reason));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] Line Total handling');

{
  const up = await uploadXlsx('sales', [
    HEADERS,
    // Blank price + Line Total 500 for qty 5 → unit price 100.
    [`${TAG}/L/1`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 5, '', 500, '', 'Paid', 'Cash'],
    // Price column actually holds the line total: 4 × unit 100 written as 400.
    [`${TAG}/L/2`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 4, 400, 400, '', 'Paid', 'Cash'],
    // Mismatch: 2 × 100 ≠ 350 → warning, Price wins.
    [`${TAG}/L/3`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 2, 100, 350, '', 'Paid', 'Cash'],
    // DISCOUNTED derivation: blank price + LT 180 for qty 2 with ₹10/unit
    // discount → gross unit price 100 (LT is net), committed total = 180.
    [`${TAG}/L/4`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 2, '', 180, 10, 'Paid', 'Cash'],
    // Price≈LT with a discount is AMBIGUOUS → never unpacked, Price wins.
    [`${TAG}/L/5`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 4, 400, 400, 5, 'Paid', 'Cash'],
  ]);
  if (up.data?.batch?.id) batches.push(up.data.batch.id);
  const rows = up.data?.rows ?? [];
  // The parse response strips `raw` — read the normalised lines from the DB.
  const { rows: dbRows } = await sql(
    `SELECT raw FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [up.data.batch.id]);
  const normPrice = (i) => Number(dbRows[i]?.raw?.norm?.line?.price ?? 0);
  assert('Blank Price is derived from Line Total ÷ Qty (warning, not error)',
    rows[0]?.status === 'warning' && /worked out/i.test(String(rows[0]?.reason ?? ''))
    && normPrice(0) === 100,
    JSON.stringify([rows[0]?.status, rows[0]?.reason, normPrice(0)]));
  assert('Price equal to the Line Total (qty>1) is unpacked to the unit price',
    rows[1]?.status === 'warning' && /LINE TOTAL/i.test(String(rows[1]?.reason ?? ''))
    && normPrice(1) === 100,
    JSON.stringify([rows[1]?.status, rows[1]?.reason, normPrice(1)]));
  assert('Mismatched Line Total is a warning and the Price column wins',
    rows[2]?.status === 'warning' && /does not match/i.test(String(rows[2]?.reason ?? ''))
    && normPrice(2) === 100,
    JSON.stringify([rows[2]?.status, rows[2]?.reason, normPrice(2)]));
  assert('Discounted blank Price adds the discount back (gross ₹100, LT is net)',
    rows[3]?.status === 'warning' && /AFTER the ₹10\.00\/unit discount/i.test(String(rows[3]?.reason ?? ''))
    && normPrice(3) === 100,
    JSON.stringify([rows[3]?.status, rows[3]?.reason, normPrice(3)]));
  assert('Price≈Line Total with a discount is NOT unpacked — Price wins',
    rows[4]?.status === 'warning' && /does not match/i.test(String(rows[4]?.reason ?? ''))
    && normPrice(4) === 400,
    JSON.stringify([rows[4]?.status, rows[4]?.reason, normPrice(4)]));
  assert('Line-Total batch totals price all five invoices (500+400+200+180+1580)',
    r2(up.data?.summary?.totalAmount ?? 0) === 2860, JSON.stringify(up.data?.summary));

  // Commit and prove the DISCOUNTED derived line lands as exactly the LT.
  const commit = await post(`/imports/batches/${up.data.batch.id}/commit`, {});
  assert('Line-Total batch commits', commit.status === 200 && commit.data?.summary?.imported === 5,
    JSON.stringify(commit.data?.summary));
  const { rows: [l4] } = await sql(
    `SELECT total_amount::float8 AS total FROM sales WHERE legacy_invoice_number = $1`, [`${TAG}/L/4`]);
  assert('Committed discounted-LT sale totals the Line Total ₹180 (no double discount)',
    l4 && r2(l4.total) === 180, JSON.stringify(l4));
}

{
  // Purchases: blank Rate + LT 380 for qty 10 with a 5% discount → gross
  // rate 40 (LT is net of the discount), taxable value = the LT.
  const up = await uploadXlsx('purchases', [
    ['Vendor Invoice No', 'Date', 'Vendor', 'Item', 'Qty', 'Purchase Rate', 'Line Total', 'Discount %', 'Payment Status', 'Payment Account'],
    [`${TAG}/LP/1`, '2026-08-04', `${TAG} Vendor`, `${TAG} Item`, 10, '', 380, 5, 'Unpaid', ''],
  ]);
  if (up.data?.batch?.id) batches.push(up.data.batch.id);
  const rows = up.data?.rows ?? [];
  const { rows: [dbRow] } = await sql(
    `SELECT raw FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [up.data.batch.id]);
  const rate = Number(dbRow?.raw?.norm?.line?.rate ?? 0);
  assert('Discounted blank purchase Rate derives the GROSS rate ₹40',
    rows[0]?.status === 'warning' && /AFTER the 5% discount/i.test(String(rows[0]?.reason ?? '')) && rate === 40,
    JSON.stringify([rows[0]?.status, rows[0]?.reason, rate]));
  assert('Purchase preview taxable value equals the Line Total ₹380',
    r2(up.data?.summary?.totalTaxable ?? 0) === 380, JSON.stringify(up.data?.summary));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] Walk-in sales (blank customer)');

{
  const up = await uploadXlsx('sales', [
    HEADERS,
    [`${TAG}/W/1`, '2026-08-04', '', `${TAG} Item`, 2, 100, '', '', 'Paid', 'Cash'],
    [`${TAG}/W/2`, '2026-08-04', '', `${TAG} Item`, 1, 100, '', '', '', 'Customer Credit'],
  ]);
  const batchId = up.data?.batch?.id ?? 0;
  if (batchId) batches.push(batchId);
  const rows = up.data?.rows ?? [];
  assert('Blank customer + Cash = walk-in warning',
    rows[0]?.status === 'warning' && rows[0]?.walkIn === true && /walk-in/i.test(String(rows[0]?.reason ?? '')),
    JSON.stringify([rows[0]?.status, rows[0]?.walkIn, rows[0]?.reason]));
  assert('Blank customer + credit is an error',
    rows[1]?.status === 'error' && /credit sale needs|required for a credit/i.test(String(rows[1]?.reason ?? '')),
    JSON.stringify(rows[1]?.reason));
  assert('Summary counts the walk-in invoice', up.data?.summary?.walkInInvoices === 1, JSON.stringify(up.data?.summary));

  const commit = await post(`/imports/batches/${batchId}/commit`, {});
  assert('Walk-in batch commits the walk-in sale', commit.status === 200 && commit.data?.summary?.imported === 1,
    JSON.stringify(commit.data?.summary));
  const { rows: [sale] } = await sql(
    `SELECT customer_id, invoice_number, total_amount::float8 AS total FROM sales WHERE legacy_invoice_number = $1`,
    [`${TAG}/W/1`]);
  assert('Walk-in sale has NO customer on the bill', sale && sale.customer_id === null, JSON.stringify(sale));
  assert('Walk-in sale draws a B2C invoice number', sale && /^SB2C/i.test(String(sale.invoice_number)), JSON.stringify(sale));
  assert('Walk-in sale total is the priced ₹200', sale && r2(sale.total) === 200, JSON.stringify(sale));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Auto-create unknown parties at commit');

{
  const up = await uploadXlsx('sales', [
    HEADERS,
    [`${TAG}/N/1`, '2026-08-04', `${TAG} New Customer`, `${TAG} Item`, 1, 100, '', '', 'Paid', 'Cash'],
  ]);
  const batchId = up.data?.batch?.id ?? 0;
  if (batchId) batches.push(batchId);
  const rows = up.data?.rows ?? [];
  assert('Unknown customer is a warning (not needs_party) with auto-create ON',
    rows[0]?.status === 'warning' && rows[0]?.willCreateParty === `${TAG} New Customer`
    && /created automatically/i.test(String(rows[0]?.reason ?? '')),
    JSON.stringify([rows[0]?.status, rows[0]?.willCreateParty, rows[0]?.reason]));
  assert('Preview lists the name under partiesToCreate',
    (up.data?.summary?.partiesToCreate ?? []).includes(`${TAG} New Customer`), JSON.stringify(up.data?.summary?.partiesToCreate));

  const commit = await post(`/imports/batches/${batchId}/commit`, {});
  assert('Commit creates the customer and imports the sale',
    commit.status === 200 && commit.data?.summary?.imported === 1
    && (commit.data?.partiesCreated ?? []).some((p) => p.name === `${TAG} New Customer`),
    JSON.stringify({ s: commit.data?.summary, p: commit.data?.partiesCreated }));
  const { rows: [cust] } = await sql(`SELECT id, notes FROM customers WHERE name = $1`, [`${TAG} New Customer`]);
  assert('Created customer carries the batch note', cust && /automatically during import batch/i.test(String(cust.notes)), JSON.stringify(cust));
  const { rows: [led] } = await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${cust?.id ?? 0}`]);
  assert('Created customer got its debtor ledger', !!led?.id);
  const { rows: [sale] } = await sql(`SELECT customer_id FROM sales WHERE legacy_invoice_number = $1`, [`${TAG}/N/1`]);
  assert('The sale is linked to the created customer', sale && Number(sale.customer_id) === Number(cust?.id), JSON.stringify(sale));
}

{
  const up = await uploadXlsx('purchases', [
    ['Vendor Invoice No', 'Date', 'Vendor', 'Item', 'Qty', 'Purchase Rate', 'Payment Status', 'Payment Account'],
    [`${TAG}/P/1`, '2026-08-04', `${TAG} New Vendor`, `${TAG} Item`, 10, 40, 'Unpaid', ''],
  ]);
  const batchId = up.data?.batch?.id ?? 0;
  if (batchId) batches.push(batchId);
  const rows = up.data?.rows ?? [];
  assert('Unknown vendor is a warning with auto-create ON',
    rows[0]?.status === 'warning' && rows[0]?.willCreateParty === `${TAG} New Vendor`,
    JSON.stringify([rows[0]?.status, rows[0]?.willCreateParty, rows[0]?.reason]));

  const commit = await post(`/imports/batches/${batchId}/commit`, {});
  assert('Commit creates the vendor and imports the bill',
    commit.status === 200 && commit.data?.summary?.imported === 1
    && (commit.data?.partiesCreated ?? []).some((p) => p.name === `${TAG} New Vendor`),
    JSON.stringify({ s: commit.data?.summary, p: commit.data?.partiesCreated }));
  const { rows: [vend] } = await sql(`SELECT id FROM vendors WHERE name = $1`, [`${TAG} New Vendor`]);
  const { rows: [vled] } = await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`VEND-${vend?.id ?? 0}`]);
  assert('Created vendor got its creditor ledger', !!vled?.id);
  const { rows: [pur] } = await sql(`SELECT vendor_id FROM purchases WHERE invoice_number = $1`, [`${TAG}/P/1`]);
  assert('The bill is linked to the created vendor', pur && Number(pur.vendor_id) === Number(vend?.id), JSON.stringify(pur));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] Toggles OFF force the strict behaviours');

assert('Import settings switched OFF', await setImportSettings({
  importAutoCreateCustomers: false, importAutoCreateVendors: false,
  importAutoWalkInCustomer: false, importMrpToDiscount: false, importDetectLineTotal: false,
}));

{
  const up = await uploadXlsx('sales', [
    HEADERS,
    // Unknown customer → needs_party (resolve step), not a warning.
    [`${TAG}/O/1`, '2026-08-04', `${TAG} Stranger`, `${TAG} Item`, 1, 100, '', '', 'Paid', 'Cash'],
    // Blank customer → plain error now.
    [`${TAG}/O/2`, '2026-08-04', '', `${TAG} Item`, 1, 100, '', '', 'Paid', 'Cash'],
    // Below-MRP price (MRP 100) → error now.
    [`${TAG}/O/3`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 1, 80, '', '', 'Paid', 'Cash'],
    // Blank price + Line Total → Price required error now.
    [`${TAG}/O/4`, '2026-08-04', `${TAG} Buyer`, `${TAG} Item`, 2, '', 200, '', 'Paid', 'Cash'],
  ]);
  if (up.data?.batch?.id) batches.push(up.data.batch.id);
  const rows = up.data?.rows ?? [];
  assert('Unknown customer needs the resolve step with auto-create OFF',
    rows[0]?.status === 'needs_party' && rows[0]?.missingParty === `${TAG} Stranger`,
    JSON.stringify([rows[0]?.status, rows[0]?.missingParty]));
  assert('Blank customer is an error with walk-in OFF',
    rows[1]?.status === 'error' && /Customer is required/i.test(String(rows[1]?.reason ?? '')),
    JSON.stringify(rows[1]?.reason));
  assert('Below-MRP price is an error with MRP-to-discount OFF',
    rows[2]?.status === 'error' && /below the Item Master MRP/i.test(String(rows[2]?.reason ?? '')),
    JSON.stringify(rows[2]?.reason));
  assert('Blank price stays an error with Line Total detection OFF',
    rows[3]?.status === 'error' && /Price is required/i.test(String(rows[3]?.reason ?? '')),
    JSON.stringify(rows[3]?.reason));
}

await restoreSettings();

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[cleanup] Rolling back batches and removing fixtures');

await cleanup();
{
  const { rows: leftCust } = await sql(`SELECT id FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  const { rows: leftSales } = await sql(`SELECT id FROM sales WHERE legacy_invoice_number LIKE $1`, [`${TAG}%`]);
  assert('Fixture rows fully removed', leftCust.length === 0 && leftSales.length === 0,
    `customers=${leftCust.length} sales=${leftSales.length}`);
  const tbAfter = await snapshotTB();
  assert('Trial balance matches the pre-test snapshot',
    tbAfter.totalDr === tbBefore.totalDr && tbAfter.totalCr === tbBefore.totalCr,
    `before=${JSON.stringify(tbBefore)} after=${JSON.stringify(tbAfter)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('Failed:', failures); process.exitCode = 1; }
await pool.end();
