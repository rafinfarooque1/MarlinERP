/**
 * Sales import × B2B/B2C invoice numbering.
 * Run: node artifacts/api-server/tests/import-sales-numbering.test.mjs
 *
 * Rules under test:
 *   Imported sales draw the NEXT SB2B/SB2C number from the same allocator as
 *     POS — the file's invoice number is NEVER written to invoice_number.
 *   Series is picked from the customer master's GST number (non-blank = B2B),
 *     exactly like POST /sales.
 *   The file's number is preserved in sales.legacy_invoice_number and the
 *     bill stays searchable by it.
 *   The sale-time receipt is named after the NEW number (books exclusion
 *     invariant), so batch rollback removes it cleanly.
 *   A POS sale created right after an import allocates without collision —
 *     imported numbers can never strand the counter.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZIMPNUM fixtures and deletes every one of them at the end.
 */

import pg from 'pg';
import ExcelJS from 'exceljs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZIMPNUM';
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
const del = (p, t) => apiReq('DELETE', p, undefined, t);

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

const fixtures = { vendorId: 0, itemId: 0, custB2B: 0, custB2C: 0 };
const createdPurchases = [];
const createdSales = [];
let batchId = 0;

async function cleanup() {
  // Imported sales: batch rollback is the proper undo (reversal-equivalent).
  if (batchId) { await post(`/imports/batches/${batchId}/rollback`, {}).catch(() => {}); batchId = 0; }
  await sql(`DELETE FROM import_mappings WHERE source_name LIKE $1`, [`${TAG}%`]).catch(() => {});
  // Any stragglers (a half-committed run): remove by legacy tag.
  const { rows: stray } = await sql(
    `SELECT id, invoice_number FROM sales WHERE legacy_invoice_number LIKE $1`, [`${TAG}%`]);
  for (const s of stray) {
    await post(`/sales/${s.id}/cancel`, {}).catch(() => {});
    await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [s.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [s.id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [s.id]);
  }
  for (const id of createdSales.slice().reverse()) {
    await post(`/sales/${id}/cancel`, {}).catch(() => {});
    const { rows: [row] } = await sql(`SELECT invoice_number FROM sales WHERE id = $1`, [id]);
    if (row) await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [row.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [id]);
  }
  createdSales.length = 0;
  for (const id of createdPurchases) { await del(`/purchases/${id}`).catch(() => {}); }
  createdPurchases.length = 0;
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fixtures.itemId) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND (code LIKE 'VEND-%' OR code LIKE 'CUST-%')`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup(); // in case a previous run died mid-way
const tbBefore = await snapshotTB();

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZIMP1234V1Z5') RETURNING id`,
  [`${TAG} Import Vendor`])).rows[0].id;
fixtures.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,200,'FG-ZZIMPN-01','2900000000119','active') RETURNING id`,
  [`${TAG} Import Item`])).rows[0].id;
fixtures.custB2B = (await sql(
  `INSERT INTO customers (name, gst_number) VALUES ($1,'29ZZIMP1234A1Z5') RETURNING id`,
  [`${TAG} GST Buyer`])).rows[0].id;
fixtures.custB2C = (await sql(
  `INSERT INTO customers (name, gst_number) VALUES ($1, NULL) RETURNING id`,
  [`${TAG} Walkin Buyer`])).rows[0].id;

{
  const res = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: '2026-07-30',
    locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId: fixtures.itemId, quantity: 20, unitCost: 50, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
  });
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  assert('Stock purchased for the import item', res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Import one B2B and one B2C invoice from an xlsx file');

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Sales Invoices');
ws.addRow(['Invoice No', 'Date', 'Customer', 'GSTIN', 'Item', 'Qty', 'Unit', 'Price', 'Payment Mode']);
ws.addRow([`${TAG}/OLD/9001`, '2026-08-04', `${TAG} GST Buyer`, '29ZZIMP1234A1Z5', `${TAG} Import Item`, 1, 'KG', 200, 'Cash']);
ws.addRow([`${TAG}/OLD/9002`, '2026-08-04', `${TAG} Walkin Buyer`, '', `${TAG} Import Item`, 1, 'KG', 200, 'Cash']);
const fileBuf = Buffer.from(await wb.xlsx.writeBuffer());

{
  const r = await fetch(`${BASE}/imports/parse?module=sales&locationType=warehouse&locationId=${WH}&filename=${TAG}.xlsx`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/octet-stream' },
    body: fileBuf,
  });
  const data = await r.json();
  batchId = data.batch?.id ?? 0;
  assert('File parses into a batch', (r.status === 200 || r.status === 201) && batchId > 0, `status=${r.status} ` + JSON.stringify(data).slice(0, 200));
}

// Mapping-first framework: resolve the fixture names, then both rows validate.
{
  const mapped = await post(`/imports/batches/${batchId}/mappings`, { mappings: [
    { kind: 'customer', name: `${TAG} GST Buyer`, targetId: fixtures.custB2B },
    { kind: 'customer', name: `${TAG} Walkin Buyer`, targetId: fixtures.custB2C },
    { kind: 'product', name: `${TAG} Import Item`, targetId: fixtures.itemId },
  ] });
  assert('Both rows validate after mapping', mapped.status === 200 && mapped.data.batch?.validRows === 2,
    `status=${mapped.status} valid=${mapped.data?.batch?.validRows} rows=${JSON.stringify((mapped.data?.rows ?? []).map((x) => x.reason)).slice(0, 200)}`);
}

// Transaction imports go through the wizard now: demo → approve.
const demoRun = await post(`/imports/batches/${batchId}/demo`, {});
assert('Demo run succeeds', demoRun.status === 200, JSON.stringify(demoRun.data).slice(0, 200));
const commit = await post(`/imports/batches/${batchId}/approve`, {});
assert('Commit succeeds for both invoices', commit.status === 200 && commit.data?.batch?.importedRows === 2,
  JSON.stringify(commit.data).slice(0, 250));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] Imported bills carry allocator numbers, file numbers survive as legacy');

const { rows: imported } = await sql(
  `SELECT id, invoice_number, legacy_invoice_number FROM sales
    WHERE legacy_invoice_number LIKE $1 ORDER BY legacy_invoice_number`, [`${TAG}%`]);
assert('Both imported bills exist', imported.length === 2, JSON.stringify(imported));
const b2b = imported.find((r) => r.legacy_invoice_number === `${TAG}/OLD/9001`);
const b2c = imported.find((r) => r.legacy_invoice_number === `${TAG}/OLD/9002`);
assert('GST-customer bill drew an SB2B number', /^SB2B\/\d{4}-\d{2}\/\d{6}$/.test(b2b?.invoice_number ?? ''), b2b?.invoice_number);
assert('Walk-in-customer bill drew an SB2C number', /^SB2C\/\d{4}-\d{2}\/\d{6}$/.test(b2c?.invoice_number ?? ''), b2c?.invoice_number);
assert('File number never landed in invoice_number', imported.every((r) => !r.invoice_number.includes(TAG)));

{
  const { rows } = await sql(`SELECT voucher_number FROM receipts WHERE voucher_number = ANY($1)`,
    [[b2b?.invoice_number, b2c?.invoice_number].filter(Boolean)]);
  assert('Sale receipts are named after the NEW numbers', rows.length === 2, JSON.stringify(rows));
}

{
  const res = await get(`/sales?q=${encodeURIComponent(`${TAG}/OLD/9001`)}`);
  const hit = (res.data ?? [])[0];
  assert('Imported bill is searchable by the OLD file number', res.status === 200 && (res.data ?? []).length === 1
    && (hit?.invoiceNumber ?? hit?.invoice_number) === b2b?.invoice_number, JSON.stringify(res.data).slice(0, 120));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] POS allocation continues cleanly after the import (no counter strand)');

{
  const res = await post('/sales', {
    outletId: WH, locationType: 'warehouse', locationId: WH,
    saleDate: '2026-08-04', paymentMode: 'cash',
    lineItems: [{ itemId: fixtures.itemId, quantity: 1, unitPrice: 200 }],
  });
  if (res.status === 201 && res.data?.id) createdSales.push(res.data.id);
  const num = res.data?.invoiceNumber ?? res.data?.invoice_number;
  assert('POS sale right after the import is accepted', res.status === 201, JSON.stringify(res.data).slice(0, 150));
  assert('POS sale drew a fresh SB2C number', /^SB2C\/\d{4}-\d{2}\/\d{6}$/.test(num ?? ''), num);
  assert('POS number differs from the imported ones', num !== b2c?.invoice_number && num !== b2b?.invoice_number, num);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Batch rollback removes the bills AND their receipts');

{
  const res = await post(`/imports/batches/${batchId}/rollback`, {});
  assert('Rollback succeeds', res.status === 200, JSON.stringify(res.data).slice(0, 150));
  batchId = 0;
  const { rows: [left] } = await sql(
    `SELECT count(*)::int AS n FROM sales WHERE legacy_invoice_number LIKE $1`, [`${TAG}%`]);
  assert('Imported bills are gone', left.n === 0, `left=${left.n}`);
  const { rows: [rcLeft] } = await sql(`SELECT count(*)::int AS n FROM receipts WHERE voucher_number = ANY($1)`,
    [[b2b?.invoice_number, b2c?.invoice_number].filter(Boolean)]);
  assert('Their receipts are gone too', rcLeft.n === 0, `left=${rcLeft.n}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[cleanup] Removing fixtures');
await cleanup();
{
  const { rows: [item] } = await sql(`SELECT count(*)::int AS n FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  assert('Fixture rows fully removed', item.n === 0);
  const tbAfter = await snapshotTB();
  assert('Trial balance matches the pre-test snapshot',
    tbAfter.totalDr === tbBefore.totalDr && tbAfter.totalCr === tbBefore.totalCr,
    `before=${JSON.stringify(tbBefore)} after=${JSON.stringify(tbAfter)}`);
}

await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('Failures:', failures); process.exit(1); }
