/**
 * Sales/Purchase import template semantics (simplified templates).
 * Run: node artifacts/api-server/tests/import-txn-template-semantics.test.mjs
 *
 * Rules under test:
 *   Templates ask business fields only — GST %/CGST/SGST/IGST are NOT in the
 *     downloadable templates (but old files carrying them still cross-check).
 *   Sales prices are GST-INCLUSIVE and Discount is ₹ PER UNIT — an imported
 *     sale's books math is IDENTICAL to the same sale entered manually.
 *   POS-style MRP handling: a price BELOW the Item Master MRP converts to
 *     MRP + the difference as per-unit discount (net unchanged, warning);
 *     the recorded price never sits below the master MRP.
 *   Preview answers batch totals (invoices/qty/taxable/GST/discount/amount)
 *     and commit answers a stamped-record summary; failed rows download as an
 *     Excel error file with an Error Reason column.
 *   Purchase rates stay GST-exclusive with % line discounts; a bill-level
 *     discount in a purchase file is an ERROR (manual entry has none).
 *   Payment Status blank rules: Paid+blank Paid Amount = full; Partial+blank
 *     = error; blank status = unpaid.
 *   Purchases: Payment Account column resolves Cash / Bank / exact ledger
 *     name; blank = the location's cash till; the settlement payment is made
 *     FROM that ledger.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZIMPTPL fixtures and deletes every one of them at the end.
 */

import pg from 'pg';
import ExcelJS from 'exceljs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZIMPTPL';
const WH = 2; // Marlin Mangaluru Depot — same warehouse the other suites use
// Same "today" convention as the import validator (UTC ISO date) — hardcoding
// a date here made every bill "backdated" the day after it was written.
const TODAY = new Date().toISOString().slice(0, 10);

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

async function downloadTemplate(module) {
  const r = await fetch(`${BASE}/imports/templates/${module}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const headers = [];
  ws.getRow(1).eachCell((cell) => headers.push(String(cell.value ?? '')));
  return headers;
}

const fixtures = { vendorId: 0, itemId: 0, custId: 0 };
const createdPurchases = [];
const createdSales = [];
const batches = [];

async function cleanup() {
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
  for (const id of createdSales.splice(0).reverse()) {
    await post(`/sales/${id}/cancel`, {}).catch(() => {});
    const { rows: [row] } = await sql(`SELECT invoice_number FROM sales WHERE id = $1`, [id]);
    if (row) await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [row.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [id]);
  }
  for (const id of createdPurchases.splice(0)) { await del(`/purchases/${id}`).catch(() => {}); }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fixtures.itemId) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
  }
  await sql(`DELETE FROM import_rows WHERE batch_id IN (SELECT id FROM import_batches WHERE filename LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM import_batches WHERE filename LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND (code LIKE 'VEND-%' OR code LIKE 'CUST-%')`, [`${TAG}%`]);
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
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZTPL1234V1Z5') RETURNING id`,
  [`${TAG} Vendor`])).rows[0].id;
fixtures.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-ZZTPL-01','2900000000126','active') RETURNING id`,
  [`${TAG} Item`])).rows[0].id;
fixtures.custId = (await sql(
  `INSERT INTO customers (name, gst_number) VALUES ($1, NULL) RETURNING id`,
  [`${TAG} Buyer`])).rows[0].id;

{ // stock for the sales import + a known avg cost
  const res = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: '2026-07-30',
    locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId: fixtures.itemId, quantity: 50, unitCost: 40, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
  });
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  assert('Stock purchased for the fixtures', res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

// The location's money accounts, for the Payment Account assertions.
const { rows: [cashTill] } = await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`WH-CASH-${WH}`]);
const { rows: bankLeaves } = await sql(
  `SELECT id, name FROM account_ledgers
    WHERE is_group = false AND parent_id IN (SELECT id FROM account_ledgers WHERE code = 'STD-BANK')
    ORDER BY id`);
assert('Cash till exists for the test warehouse', !!cashTill?.id);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Templates carry business columns only');

{
  const h = await downloadTemplate('sales');
  assert('Sales template has NO GST columns', !h.some((x) => /GST %|CGST|SGST|IGST/i.test(x)), JSON.stringify(h));
  assert('Sales template asks for a Payment Account', h.some((x) => /payment account/i.test(x)), JSON.stringify(h));
  assert('Sales Unit column is optional (no *)', h.some((x) => x === 'Unit'), JSON.stringify(h));
}
{
  const h = await downloadTemplate('purchases');
  assert('Purchase template has NO GST or Bill Discount columns', !h.some((x) => /GST %|Bill Discount/i.test(x)), JSON.stringify(h));
  assert('Purchase template asks for the Vendor Invoice No', h.some((x) => /vendor invoice no/i.test(x)), JSON.stringify(h));
  assert('Purchase template asks for a Payment Account', h.some((x) => /payment account/i.test(x)), JSON.stringify(h));
  assert('Purchase template has an optional Unit column', h.some((x) => x === 'Unit'), JSON.stringify(h));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] Imported sale == the same sale entered manually (inclusive price, per-unit discount)');

// qty 2 × ₹200 GST-inclusive, ₹10/unit discount, 5% GST:
// line total = 2×190 = 380 → taxable 361.90, tax 18.10.
let importedSaleTotals = null;
{
  const up = await uploadXlsx('sales', [
    ['Invoice No', 'Date', 'Customer', 'Item', 'Qty', 'Price', 'Discount', 'Payment Status', 'Payment Account'],
    [`${TAG}/S/1`, TODAY, `${TAG} Buyer`, `${TAG} Item`, 2, 200, 10, 'Paid', 'Cash'],
  ]);
  const batchId = up.data?.batch?.id ?? 0;
  if (batchId) batches.push(batchId);
  assert('Sales file validates', up.data?.batch?.status === 'validated' && up.data?.batch?.validRows === 1,
    JSON.stringify((up.data?.rows ?? []).map((x) => x.reason)).slice(0, 300));

  // Preview totals — computed by the same engine that will commit.
  const sum = up.data?.summary;
  assert('Preview summary shows the batch totals',
    sum && sum.invoices === 1 && r2(sum.totalAmount) === 380 && r2(sum.totalGst) === 18.1
    && r2(sum.totalTaxable) === 361.9 && sum.totalQuantity === 2 && r2(sum.totalDiscount) === 20,
    JSON.stringify(sum));

  const commit = await post(`/imports/batches/${batchId}/commit`, {});
  assert('Sales batch commits', commit.status === 200 && commit.data?.batch?.importedRows === 1, JSON.stringify(commit.data).slice(0, 250));

  // Post-commit report — counted from provenance stamps, not loop tallies.
  const det = commit.data?.details;
  assert('Commit answers a stamped-record summary',
    det && det.invoicesImported === 1 && det.invoicesFailed === 0 && det.stockMovements === 1
    && det.gstInvoices === 1 && Number(det.timeTakenMs) > 0,
    JSON.stringify(det));

  const { rows: [sale] } = await sql(
    `SELECT id, subtotal::float8 AS subtotal, tax_total::float8 AS tax, total_amount::float8 AS total
       FROM sales WHERE legacy_invoice_number = $1`, [`${TAG}/S/1`]);
  importedSaleTotals = sale;
  assert('Imported total is the GST-inclusive 380', sale && r2(sale.total) === 380, JSON.stringify(sale));
  assert('Imported taxable value is 361.90', sale && r2(sale.subtotal) === 361.9, JSON.stringify(sale));
  assert('Imported GST is 18.10', sale && r2(sale.tax) === 18.1, JSON.stringify(sale));
}
{
  const res = await post('/sales', {
    outletId: WH, locationType: 'warehouse', locationId: WH,
    saleDate: TODAY, paymentMode: 'cash', customerId: fixtures.custId,
    lineItems: [{ itemId: fixtures.itemId, quantity: 2, unitPrice: 200, unitDiscount: 10 }],
  });
  if (res.status === 201 && res.data?.id) createdSales.push(res.data.id);
  assert('Manual twin sale is accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  const { rows: [manual] } = await sql(
    `SELECT subtotal::float8 AS subtotal, tax_total::float8 AS tax, total_amount::float8 AS total FROM sales WHERE id = $1`,
    [res.data?.id ?? 0]);
  assert('Imported and manual sale math is IDENTICAL',
    manual && importedSaleTotals
    && r2(manual.subtotal) === r2(importedSaleTotals.subtotal)
    && r2(manual.tax) === r2(importedSaleTotals.tax)
    && r2(manual.total) === r2(importedSaleTotals.total),
    `manual=${JSON.stringify(manual)} imported=${JSON.stringify(importedSaleTotals)}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] Sales validation guardrails');

{
  const up = await uploadXlsx('sales', [
    ['Invoice No', 'Date', 'Customer', 'Item', 'Qty', 'Price', 'Discount', 'Payment Status', 'Payment Account'],
    [`${TAG}/S/E1`, TODAY, `${TAG} Buyer`, `${TAG} Item`, 1, 200, '', 'Partial', 'Customer Credit'],
    [`${TAG}/S/E2`, TODAY, `${TAG} Buyer`, `${TAG} Item`, 1, 200, 250, 'Unpaid', 'Customer Credit'],
  ]);
  if (up.data?.batch?.id) batches.push(up.data.batch.id);
  const rows = up.data?.rows ?? [];
  const e1 = rows.find((r) => String(r.raw?.norm?.invoiceNumber ?? '') === `${TAG}/S/E1`) ?? rows[0];
  const e2 = rows.find((r) => String(r.raw?.norm?.invoiceNumber ?? '') === `${TAG}/S/E2`) ?? rows[1];
  assert('Partial with a blank Paid Amount is an error',
    e1?.status === 'error' && /Partial/i.test(String(e1?.reason ?? '')), JSON.stringify(e1?.reason));
  assert('Per-unit discount above the price is an error',
    e2?.status === 'error' && /per unit|per UNIT/i.test(String(e2?.reason ?? '')), JSON.stringify(e2?.reason));

  // Error file: only the failed rows, with the reason on each.
  const ef = await fetch(`${BASE}/imports/batches/${up.data.batch.id}/error-file`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  assert('Error file downloads as xlsx', ef.status === 200 && /spreadsheetml/.test(ef.headers.get('content-type') ?? ''),
    `status=${ef.status} type=${ef.headers.get('content-type')}`);
  const efwb = new ExcelJS.Workbook();
  await efwb.xlsx.load(Buffer.from(await ef.arrayBuffer()));
  const efws = efwb.worksheets[0];
  const efHeaders = [];
  efws.getRow(1).eachCell((cell) => efHeaders.push(String(cell.value ?? '')));
  assert('Error file has the template columns + Error Reason',
    efHeaders.includes('Error Reason') && efHeaders.includes('Invoice No') && efws.rowCount === 3,
    `headers=${JSON.stringify(efHeaders)} rows=${efws.rowCount}`);
  const reasonCol = efHeaders.indexOf('Error Reason') + 1;
  assert('Each failed row carries its reason', /Partial/i.test(String(efws.getRow(2).getCell(reasonCol).value ?? '')),
    JSON.stringify(efws.getRow(2).getCell(reasonCol).value));
}
{
  // POS-style MRP handling: a below-MRP price CONVERTS (never errors) — the
  // line records MRP with the difference as per-unit discount, net unchanged.
  // And a blank Payment Status with a Paid Amount records a part-payment.
  const up = await uploadXlsx('sales', [
    ['Invoice No', 'Date', 'Customer', 'Item', 'Qty', 'Price', 'Payment Status', 'Paid Amount', 'Payment Account'],
    [`${TAG}/S/E3`, TODAY, `${TAG} Buyer`, `${TAG} Item`, 1, 50, 'Unpaid', '', 'Customer Credit'],
    [`${TAG}/S/E4`, TODAY, `${TAG} Buyer`, `${TAG} Item`, 1, 200, '', 120, 'Customer Credit'],
  ]);
  const bId = up.data?.batch?.id ?? 0;
  if (bId) batches.push(bId);
  const rows = up.data?.rows ?? [];
  const e3 = rows[0]; const e4 = rows[1];
  assert('Below-MRP price converts like the POS (warning, not error)',
    e3?.status === 'warning' && /MRP/i.test(String(e3?.reason ?? '')), `status=${e3?.status} reason=${JSON.stringify(e3?.reason)}`);
  // The parse response strips raw.norm — read the stored line from the DB row.
  const { rows: [e3db] } = await sql(
    `SELECT (raw->'norm'->'line'->>'price')::float8 AS price,
            (raw->'norm'->'line'->>'unitDiscount')::float8 AS disc
       FROM import_rows WHERE batch_id = $1 AND row_number = 2`, [bId]);
  assert('Converted line = MRP ₹100 with ₹50/unit discount (net ₹50 unchanged)',
    e3db && r2(e3db.price) === 100 && r2(e3db.disc) === 50, JSON.stringify(e3db));
  const { rows: [e4db] } = await sql(
    `SELECT (raw->'norm'->>'paidAmount')::float8 AS paid FROM import_rows WHERE batch_id = $1 AND row_number = 3`, [bId]);
  assert('Blank status with a Paid Amount validates as a part-payment',
    e4?.status === 'valid' && Number(e4db?.paid ?? 0) === 120,
    `status=${e4?.status} paid=${JSON.stringify(e4db?.paid)} reason=${JSON.stringify(e4?.reason)}`);
}
{
  // The converted sale must land in the books IDENTICAL to the manual twin
  // (manual entry: price ₹100 = MRP, ₹20/unit discount ⇒ import price ₹80).
  const up = await uploadXlsx('sales', [
    ['Invoice No', 'Date', 'Customer', 'Item', 'Qty', 'Price', 'Payment Status', 'Payment Account'],
    [`${TAG}/S/M1`, TODAY, `${TAG} Buyer`, `${TAG} Item`, 1, 80, 'Paid', 'Cash'],
  ]);
  const bId = up.data?.batch?.id ?? 0;
  if (bId) batches.push(bId);
  const commit = await post(`/imports/batches/${bId}/commit`, {});
  assert('Below-MRP sale commits after conversion', commit.status === 200 && commit.data?.batch?.importedRows === 1,
    JSON.stringify(commit.data).slice(0, 250));
  const { rows: [conv] } = await sql(
    `SELECT subtotal::float8 AS subtotal, tax_total::float8 AS tax, total_amount::float8 AS total
       FROM sales WHERE legacy_invoice_number = $1`, [`${TAG}/S/M1`]);
  const manual = await post('/sales', {
    outletId: WH, locationType: 'warehouse', locationId: WH,
    saleDate: TODAY, paymentMode: 'cash', customerId: fixtures.custId,
    lineItems: [{ itemId: fixtures.itemId, quantity: 1, unitPrice: 100, unitDiscount: 20 }],
  });
  if (manual.status === 201 && manual.data?.id) createdSales.push(manual.data.id);
  const { rows: [mtw] } = await sql(
    `SELECT subtotal::float8 AS subtotal, tax_total::float8 AS tax, total_amount::float8 AS total FROM sales WHERE id = $1`,
    [manual.data?.id ?? 0]);
  assert('Converted import == manual sale at MRP with the discount (identical books math)',
    conv && mtw && r2(conv.subtotal) === r2(mtw.subtotal) && r2(conv.tax) === r2(mtw.tax) && r2(conv.total) === r2(mtw.total)
    && r2(conv.total) === 80,
    `imported=${JSON.stringify(conv)} manual=${JSON.stringify(mtw)}`);
}
{
  // Old-ERP file with a GST % column: still mapped, cross-checked, warned — never recorded.
  const up = await uploadXlsx('sales', [
    ['Invoice No', 'Date', 'Customer', 'Item', 'Qty', 'Price', 'GST %', 'Payment Status', 'Payment Account'],
    [`${TAG}/S/W1`, TODAY, `${TAG} Buyer`, `${TAG} Item`, 1, 210, 12, 'Paid', 'Cash'],
  ]);
  if (up.data?.batch?.id) batches.push(up.data.batch.id);
  const row = (up.data?.rows ?? [])[0];
  assert('Old file with a GST % column still validates', up.data?.batch?.status === 'validated', JSON.stringify(row?.reason));
  assert('Mismatched file GST % draws a warning', /gst/i.test(String(row?.reason ?? '')), JSON.stringify(row?.reason));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Purchase Payment Account settles from the named ledger');

const bankName = bankLeaves[0]?.name ?? null;
{
  const header = ['Vendor Invoice No', 'Date', 'Vendor', 'Item', 'Qty', 'Purchase Rate', 'Discount %', 'Payment Status', 'Paid Amount', 'Payment Account'];
  const rows = [header,
    [`${TAG}/P/1`, TODAY, `${TAG} Vendor`, `${TAG} Item`, 10, 40, 0, 'Partial', 100, ''], // blank = cash till
  ];
  if (bankName) rows.push([`${TAG}/P/2`, TODAY, `${TAG} Vendor`, `${TAG} Item`, 5, 40, 0, 'Paid', '', bankName]);
  const up = await uploadXlsx('purchases', rows);
  const batchId = up.data?.batch?.id ?? 0;
  if (batchId) batches.push(batchId);
  assert('Purchase file validates', up.data?.batch?.status === 'validated' && up.data?.batch?.validRows === rows.length - 1,
    JSON.stringify((up.data?.rows ?? []).map((x) => x.reason)).slice(0, 300));
  const commit = await post(`/imports/batches/${batchId}/commit`, {});
  assert('Purchase batch commits', commit.status === 200 && commit.data?.batch?.importedRows === rows.length - 1,
    JSON.stringify(commit.data).slice(0, 250));

  // Bill 1: 10×40 = 400 + 5% GST = 420 total, ₹100 paid from the CASH till.
  const { rows: [p1] } = await sql(
    `SELECT p.id, p.total_amount::float8 AS total FROM purchases p WHERE p.invoice_number = $1 AND p.vendor_id = $2`,
    [`${TAG}/P/1`, fixtures.vendorId]);
  assert('Purchase total stays GST-exclusive math (420.00)', p1 && r2(p1.total) === 420, JSON.stringify(p1));
  const { rows: [pay1] } = await sql(
    `SELECT amount::float8 AS amount, paid_from_ledger_id FROM payments
      WHERE id IN (SELECT payment_id FROM payment_bill_allocations WHERE purchase_id = $1)`, [p1?.id ?? 0]);
  assert('Blank Payment Account pays from the location cash till',
    pay1 && Number(pay1.paid_from_ledger_id) === Number(cashTill.id) && r2(pay1.amount) === 100, JSON.stringify(pay1));

  if (bankName) {
    const { rows: [p2] } = await sql(
      `SELECT p.id, p.total_amount::float8 AS total FROM purchases p WHERE p.invoice_number = $1 AND p.vendor_id = $2`,
      [`${TAG}/P/2`, fixtures.vendorId]);
    const { rows: [pay2] } = await sql(
      `SELECT amount::float8 AS amount, paid_from_ledger_id FROM payments
        WHERE id IN (SELECT payment_id FROM payment_bill_allocations WHERE purchase_id = $1)`, [p2?.id ?? 0]);
    assert('Named bank ledger settles the bank-paid bill in FULL (Paid + blank amount)',
      pay2 && Number(pay2.paid_from_ledger_id) === Number(bankLeaves[0].id) && r2(pay2.amount) === r2(p2.total),
      `pay=${JSON.stringify(pay2)} expected ledger ${bankLeaves[0].id} amount ${p2?.total}`);
  } else {
    console.log('  (no bank leaf ledger in this DB — bank-account assertion skipped)');
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] Purchase validation guardrails');

{
  const up = await uploadXlsx('purchases', [
    ['Vendor Invoice No', 'Date', 'Vendor', 'Item', 'Qty', 'Purchase Rate', 'Bill Discount', 'Payment Status', 'Paid Amount'],
    [`${TAG}/P/E1`, TODAY, `${TAG} Vendor`, `${TAG} Item`, 1, 40, 100, 'Unpaid', ''],
    [`${TAG}/P/E2`, TODAY, `${TAG} Vendor`, `${TAG} Item`, 1, 40, '', 'Partial', ''],
  ]);
  if (up.data?.batch?.id) batches.push(up.data.batch.id);
  const rows = up.data?.rows ?? [];
  const e1 = rows[0]; const e2 = rows[1];
  assert('Bill Discount on a purchase file is an error with a suggestion',
    e1?.status === 'error' && /not supported/i.test(String(e1?.reason ?? '')), JSON.stringify(e1?.reason));
  assert('Purchase Partial with a blank Paid Amount is an error',
    e2?.status === 'error' && /Partial/i.test(String(e2?.reason ?? '')), JSON.stringify(e2?.reason));
}
{
  // Unknown Payment Account name must be an error naming the options.
  const up = await uploadXlsx('purchases', [
    ['Vendor Invoice No', 'Date', 'Vendor', 'Item', 'Qty', 'Purchase Rate', 'Payment Status', 'Paid Amount', 'Payment Account'],
    [`${TAG}/P/E3`, TODAY, `${TAG} Vendor`, `${TAG} Item`, 1, 40, 'Paid', '', 'No Such Account XYZ'],
  ]);
  if (up.data?.batch?.id) batches.push(up.data.batch.id);
  const row = (up.data?.rows ?? [])[0];
  assert('Unknown Payment Account is an error', row?.status === 'error' && /payment account/i.test(String(row?.reason ?? '')),
    JSON.stringify(row?.reason));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[cleanup] Rolling back batches and removing fixtures');
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
