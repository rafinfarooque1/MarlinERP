/**
 * POS Edit-Sale stock validation — integration tests
 * Run: node artifacts/api-server/tests/sale-edit-stock.test.mjs
 *
 * The rule under test: editing an existing sale must validate quantities as a
 * DELTA against the sale's own already-deducted allocation, never the full new
 * quantity against today's shelf stock. The server does this by crediting the
 * old lines back inside the edit transaction before validating the new ones,
 * so the effective ceiling per item is (original qty + currently available).
 *
 * Scenario (from the bug report): invoice holds 60, shelf shows 6.
 *   discount-only edit → save succeeds, zero stock movement
 *   60→50 valid (10 back) · 60→64 valid (4 more out) · 60→66 valid · 60→67 rejected
 *   removed line restores its quantity · a NEW line gets plain current-stock
 *   validation · a manipulated over-stock API request is refused server-side.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. It creates
 * clearly-marked ZZTEST fixtures and deletes every one of them at the end,
 * so the dev database is left as it was found.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZTEST';
const WH = 2; // Marlin Mangaluru Depot — same warehouse the purchase suite uses

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}

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
const put = (p, b, t) => apiReq('PUT', p, b, t);
const get = (p, t) => apiReq('GET', p, undefined, t);
const del = (p, t) => apiReq('DELETE', p, undefined, t);
const r2 = (n) => Math.round(n * 100) / 100;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

/** On-hand stock_entries quantity for an item at the test warehouse. */
async function stockOf(itemId) {
  const { rows } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric), 0) AS q FROM stock_entries
      WHERE item_id = $1 AND material_type = 'item' AND branch_type = 'warehouse' AND branch_id = $2`,
    [itemId, WH]);
  return Number(rows[0].q);
}
/** Sum of live lots for an item at the test warehouse (batch layer). */
async function lotSumOf(itemId) {
  const { rows } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric), 0) AS q FROM stock_batches
      WHERE item_id = $1 AND material_type = 'item' AND branch_type = 'warehouse' AND branch_id = $2`,
    [itemId, WH]);
  return Number(rows[0].q);
}
async function saleRow(id) {
  const { rows } = await sql(`SELECT invoice_number, total_amount::numeric AS total, line_items FROM sales WHERE id = $1`, [id]);
  return rows[0];
}
async function receiptsFor(invoiceNumber) {
  const { rows } = await sql(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount::numeric),0) AS total FROM receipts WHERE voucher_number = $1`,
    [invoiceNumber]);
  return { n: rows[0].n, total: Number(rows[0].total) };
}
async function snapshotTB() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  return {
    totalDr: r2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: r2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
    balanced: res.data?.balanced ?? true,
  };
}

const fixtures = { vendorId: 0, itemA: 0, itemB: 0 };
const createdPurchases = [];
let saleId = 0, invoiceNumber = '';
// Item ids can be REUSED from long-deleted items, and dev carries orphaned
// zero-quantity stock rows (e.g. an old "OPENING" lot) under those ids. They
// are not ours: exclude them from assertions and leave them exactly as found.
let preLots = [], preEntries = [], preLotIds = [], preEntryIds = [];

async function cleanup() {
  // The sale first (cancel returns its stock so the purchase bills become
  // deletable), then bills through the API so lots and postings unwind
  // exactly as a real delete would, then the raw fixture rows.
  if (saleId) await post(`/sales/${saleId}/cancel`, {}).catch(() => {});
  await sql(`DELETE FROM receipts WHERE voucher_number IN (SELECT invoice_number FROM sales WHERE location_type='warehouse' AND location_id=$1 AND line_items::text LIKE '%"itemId":'||$2||'%')`, [WH, fixtures.itemA || -1]).catch(() => {});
  if (saleId) {
    const row = await saleRow(saleId).catch(() => null);
    if (row) await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [row.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [saleId]);
    await sql(`DELETE FROM sales WHERE id = $1`, [saleId]);
  }
  for (const id of createdPurchases) { await del(`/purchases/${id}`).catch(() => {}); }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  const ids = [fixtures.itemA, fixtures.itemB].filter(Boolean);
  if (ids.length) {
    await sql(`DELETE FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type = 'item' AND NOT (id = ANY($2::int[]))`, [ids, preLotIds]);
    await sql(`DELETE FROM stock_entries WHERE item_id = ANY($1::int[]) AND material_type = 'item' AND NOT (id = ANY($2::int[]))`, [ids, preEntryIds]);
    // Rows that predate the test are left in place at their original quantity,
    // in case a credit path picked one of them as its target row.
    for (const r of preLots) await sql(`UPDATE stock_batches SET quantity = $1 WHERE id = $2`, [r.q, r.id]);
    for (const r of preEntries) await sql(`UPDATE stock_entries SET quantity = $1 WHERE id = $2`, [r.q, r.id]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'VEND-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

const loginRes = await post('/auth/login', { username: 'admin', password: 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup(); // in case a previous run died mid-way
const tbBefore = await snapshotTB();

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZTES1234F1Z5') RETURNING id`,
  [`${TAG} EditSale Vendor`])).rows[0].id;
fixtures.itemA = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-ZZTEST-A','2900000000101','active') RETURNING id`,
  [`${TAG} EditSale Item A`])).rows[0].id;
fixtures.itemB = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119020',5,80,'FG-ZZTEST-B','2900000000102','active') RETURNING id`,
  [`${TAG} EditSale Item B`])).rows[0].id;

// Orphaned stock rows already sitting under our (reused) item ids are not ours.
// Record id AND quantity: the app's write paths may credit INTO one of these
// rows (they select by item+location, not by provenance), so cleanup restores
// their original quantities instead of deleting them.
preLots = (await sql(`SELECT id, quantity::text AS q FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type='item'`,
  [[fixtures.itemA, fixtures.itemB]])).rows;
preEntries = (await sql(`SELECT id, quantity::text AS q FROM stock_entries WHERE item_id = ANY($1::int[]) AND material_type='item'`,
  [[fixtures.itemA, fixtures.itemB]])).rows;
preLotIds = preLots.map(r => r.id);
preEntryIds = preEntries.map(r => r.id);
// The quantity assertions below read totals the way the app does (all rows).
// A pre-existing row with stock in it would shift every figure: refuse to run
// rather than produce confusing failures downstream.
{
  const preQty = [...preLots, ...preEntries].reduce((s, r) => s + Number(r.q), 0);
  if (preQty !== 0) {
    console.error(`FATAL: reused item ids carry pre-existing stock (${preQty}); pick a clean dev DB`);
    await cleanup(); process.exit(1);
  }
}

// Stock the warehouse through real purchase bills: 66 of A, 20 of B.
for (const [materialId, quantity] of [[fixtures.itemA, 66], [fixtures.itemB, 20]]) {
  const res = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: '2026-07-30',
    locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId, quantity, unitCost: 50, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
  });
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  assert(`Purchase of ${quantity} units lands (item ${materialId})`, res.status === 201, JSON.stringify(res.data).slice(0, 150));
}
assert('Item A opens with 66 on hand', await stockOf(fixtures.itemA) === 66);
assert('Item B opens with 20 on hand', await stockOf(fixtures.itemB) === 20);

// The invoice at the heart of the bug: 60 sold, 6 left on the shelf.
const lineA = (quantity, discount = 0) => ({ itemId: fixtures.itemA, quantity, unitPrice: 100, discount });
const lineB = (quantity) => ({ itemId: fixtures.itemB, quantity, unitPrice: 80, discount: 0 });
const salePayload = (lineItems) => ({
  outletId: WH, locationType: 'warehouse', locationId: WH,
  saleDate: '2026-07-31', paymentMode: 'cash', lineItems,
});
{
  const res = await post('/sales', salePayload([lineA(60)]));
  saleId = res.data?.id ?? 0;
  invoiceNumber = res.data?.invoiceNumber ?? '';
  assert('Sale of 60 units created', res.status === 201 && !!saleId, JSON.stringify(res.data).slice(0, 150));
  assert('Shelf shows 6 after the sale', await stockOf(fixtures.itemA) === 6);
}
if (!saleId) { console.error('FATAL: no sale'); await cleanup(); process.exit(1); }
const editSale = (lineItems) => put(`/sales/${saleId}`, salePayload(lineItems));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] TEST 1+8 — discount-only edit with qty 60 and only 6 on the shelf');
{
  const before = await saleRow(saleId);
  const res = await editSale([lineA(60, 400)]);
  assert('Save succeeds (this was the reported bug)', res.status === 200, JSON.stringify(res.data).slice(0, 200));
  assert('Stock unchanged — zero net movement', await stockOf(fixtures.itemA) === 6);
  assert('Lot layer matches the shelf', await lotSumOf(fixtures.itemA) === 6);
  const after = await saleRow(saleId);
  assert('Invoice total changed by the discount', Number(after.total) < Number(before.total));
  assert('Invoice number preserved through the edit', after.invoice_number === invoiceNumber);
  const rec = await receiptsFor(invoiceNumber);
  assert('Exactly ONE accounting receipt, restated to the new total',
    rec.n === 1 && Math.abs(rec.total - Number(after.total)) < 0.01, `n=${rec.n} amt=${rec.total} vs ${after.total}`);
}

console.log('\n[2] TEST 2 — 60 → 50 returns 10 to stock');
{
  const res = await editSale([lineA(50)]);
  assert('Reduction accepted', res.status === 200, JSON.stringify(res.data).slice(0, 150));
  assert('Shelf back up to 16', await stockOf(fixtures.itemA) === 16);
  assert('Returned units land back in their lots', await lotSumOf(fixtures.itemA) === 16);
}

console.log('\n[3] TEST 3 — 60 → 64 deducts only the 4 extra');
{
  await editSale([lineA(60)]); // reset to the canonical 60/6 position
  assert('Reset to 60 leaves 6 on the shelf', await stockOf(fixtures.itemA) === 6);
  const res = await editSale([lineA(64)]);
  assert('Increase within (60 held + 6 free) accepted', res.status === 200, JSON.stringify(res.data).slice(0, 150));
  assert('Only 4 more units left the shelf', await stockOf(fixtures.itemA) === 2);
}

console.log('\n[4] TEST 4 — up to the exact ceiling of 66');
{
  const res = await editSale([lineA(66)]);
  assert('66 (the exact maximum) accepted', res.status === 200, JSON.stringify(res.data).slice(0, 150));
  assert('Shelf is now empty', await stockOf(fixtures.itemA) === 0);
}

console.log('\n[5] TEST 5 — 67 is one unit too many: full rollback');
{
  const before = await saleRow(saleId);
  const res = await editSale([lineA(67)]);
  assert('Over-ceiling edit rejected with INSUFFICIENT_STOCK',
    res.status === 400 && res.data?.code === 'INSUFFICIENT_STOCK', `status=${res.status} ${JSON.stringify(res.data).slice(0, 150)}`);
  const after = await saleRow(saleId);
  assert('Invoice untouched by the failed edit',
    Number(after.total) === Number(before.total) && JSON.stringify(after.line_items) === JSON.stringify(before.line_items));
  assert('Stock untouched by the failed edit', await stockOf(fixtures.itemA) === 0);
  const rec = await receiptsFor(invoiceNumber);
  assert('Accounting untouched by the failed edit', rec.n === 1 && Math.abs(rec.total - Number(before.total)) < 0.01);
}

console.log('\n[6] TEST 7 — a NEW line gets plain current-stock validation');
{
  await editSale([lineA(60)]); // back to 60 held / 6 free
  const over = await editSale([lineA(60), lineB(21)]); // only 20 of B exist
  assert('New line beyond current stock rejected', over.status === 400 && over.data?.code === 'INSUFFICIENT_STOCK',
    `status=${over.status}`);
  assert('Rejected edit moved no stock of A', await stockOf(fixtures.itemA) === 6);
  assert('Rejected edit moved no stock of B', await stockOf(fixtures.itemB) === 20);
  const ok = await editSale([lineA(60), lineB(5)]);
  assert('New line within current stock accepted', ok.status === 200, JSON.stringify(ok.data).slice(0, 150));
  assert('New line deducted from B', await stockOf(fixtures.itemB) === 15);
}

console.log('\n[7] TEST 6 — removing a line returns its full quantity');
{
  const res = await editSale([lineA(60)]);
  assert('Line removal accepted', res.status === 200, JSON.stringify(res.data).slice(0, 150));
  assert('Removed line’s 5 units returned to B', await stockOf(fixtures.itemB) === 20);
  assert('B’s lots restored, no duplicate lots', await lotSumOf(fixtures.itemB) === 20);
  const { rows } = await sql(
    `SELECT id, batch_number, quantity::text AS q, source FROM stock_batches
      WHERE item_id = $1 AND material_type='item' AND branch_type='warehouse' AND branch_id=$2
        AND NOT (id = ANY($3::int[])) ORDER BY id`,
    [fixtures.itemB, WH, preLotIds]);
  assert('B still has exactly its one purchase lot — restores merged, no replacement lot rows',
    rows.length === 1, `lots=${JSON.stringify(rows)}`);
}

console.log('\n[7b] Same item on TWO lines — the ceiling is shared, not per line');
{
  // Held 60 + 6 free. Split as 30+30 (=60) is fine; 34+33 (=67) must fail as a
  // whole even though each line alone is under the 66 ceiling.
  const ok = await editSale([lineA(30), lineA(30)]);
  assert('Two lines summing to the held quantity accepted', ok.status === 200, JSON.stringify(ok.data).slice(0, 150));
  assert('Split lines moved no net stock', await stockOf(fixtures.itemA) === 6);
  const over = await editSale([lineA(34), lineA(33)]);
  assert('Two lines summing past the ceiling rejected as a whole',
    over.status === 400 && over.data?.code === 'INSUFFICIENT_STOCK', `status=${over.status}`);
  assert('Rejected split edit rolled back fully', await stockOf(fixtures.itemA) === 6);
  const back = await editSale([lineA(60)]);
  assert('Restored to a single 60 line', back.status === 200 && await stockOf(fixtures.itemA) === 6);
}

console.log('\n[8] TEST 9 — manipulated API request far beyond stock');
{
  const res = await editSale([lineA(999)]);
  assert('Server refuses 999 regardless of any frontend validation',
    res.status === 400 && res.data?.code === 'INSUFFICIENT_STOCK', `status=${res.status}`);
  assert('Nothing moved', await stockOf(fixtures.itemA) === 6);
}

console.log('\n[9] TEST 10 — no duplicate movements or postings after all edits');
{
  // Net ledger trail for item A across every edit must equal exactly the 60
  // the invoice finally holds: reversals and re-applies cancel pairwise.
  const { rows } = await sql(
    `SELECT COALESCE(SUM(qty_change::numeric),0) AS net FROM stock_ledger
      WHERE item_name = $1 AND doc_type = 'sale' AND doc_id = $2`,
    [`${TAG} EditSale Item A`, saleId]);
  assert('Stock ledger nets to exactly −60 for the invoice', Number(rows[0].net) === -60, `net=${rows[0].net}`);
  assert('Shelf + invoice = purchased total (66)', (await stockOf(fixtures.itemA)) + 60 === 66);
  assert('Entry and lot layers agree for A', await stockOf(fixtures.itemA) === await lotSumOf(fixtures.itemA));
  const rec = await receiptsFor(invoiceNumber);
  const finalSale = await saleRow(saleId);
  assert('Still exactly one receipt, at the final total',
    rec.n === 1 && Math.abs(rec.total - Number(finalSale.total)) < 0.01, `n=${rec.n}`);
  const tb = await snapshotTB();
  assert('Trial balance still balanced', tb.balanced && tb.totalDr === tb.totalCr, `${tb.totalDr} vs ${tb.totalCr}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[cleanup] Removing fixtures');
await cleanup();
assert('Item A fixture rows fully removed', await stockOf(fixtures.itemA) === 0 && await lotSumOf(fixtures.itemA) === 0);
const tbFinal = await snapshotTB();
assert('Trial balance matches the pre-test snapshot',
  tbFinal.totalDr === tbBefore.totalDr && tbFinal.totalCr === tbBefore.totalCr,
  `before ${tbBefore.totalDr}/${tbBefore.totalCr} after ${tbFinal.totalDr}/${tbFinal.totalCr}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failed:', failures.join(' | '));
await pool.end();
process.exit(failed ? 1 : 0);
