/**
 * POS discount system — per-unit item discount + pre-tax bill discount.
 * Run: node artifacts/api-server/tests/sale-discounts.test.mjs
 *
 * Rules under test:
 *   ITEM discount is ₹ PER UNIT off the MRP: ud 10 on qty 10 × ₹100 = ₹900,
 *     never ₹990. Bounded 0 ≤ ud ≤ unitPrice, enforced server-side.
 *   BILL discount is ONE pre-tax amount allocated across lines in proportion
 *     to their post-item-discount value, paise-exact (shares sum EXACTLY),
 *     reducing each line's taxable value and GST.
 *   Legacy lines that carry only `discount` keep line-TOTAL semantics forever.
 *   Stored line `discount` = itemDiscount + billDiscountShare so historical
 *     consumers recomputing qty×price−discount stay correct.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZTEST fixtures and deletes every one of them at the end.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZTEST';
const WH = 2; // Marlin Mangaluru Depot — same warehouse the other suites use

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;

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

async function stockOf(itemId) {
  const { rows } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric), 0) AS q FROM stock_entries
      WHERE item_id = $1 AND material_type = 'item' AND branch_type = 'warehouse' AND branch_id = $2`,
    [itemId, WH]);
  return Number(rows[0].q);
}
async function saleRow(id) {
  const { rows } = await sql(
    `SELECT invoice_number, subtotal::numeric AS subtotal, tax_total::numeric AS tax_total,
            discount_total::numeric AS discount_total, bill_discount::numeric AS bill_discount,
            total_amount::numeric AS total, line_items
       FROM sales WHERE id = $1`, [id]);
  return rows[0];
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
const createdSales = [];
let preLots = [], preEntries = [], preLotIds = [], preEntryIds = [];

async function cleanup() {
  for (const id of createdSales.slice().reverse()) {
    await post(`/sales/${id}/cancel`, {}).catch(() => {});
    const row = await saleRow(id).catch(() => null);
    if (row) await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [row.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [id]);
  }
  createdSales.length = 0;
  for (const id of createdPurchases) { await del(`/purchases/${id}`).catch(() => {}); }
  createdPurchases.length = 0;
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  const ids = [fixtures.itemA, fixtures.itemB].filter(Boolean);
  if (ids.length) {
    await sql(`DELETE FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type = 'item' AND NOT (id = ANY($2::int[]))`, [ids, preLotIds]);
    await sql(`DELETE FROM stock_entries WHERE item_id = ANY($1::int[]) AND material_type = 'item' AND NOT (id = ANY($2::int[]))`, [ids, preEntryIds]);
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
  [`${TAG} Discount Vendor`])).rows[0].id;
// MRP 99.99, not 100: the sale API enforces price ≥ master MRP, and the
// fractional-quantity section below sells this item at exactly ₹99.99 to
// exercise sub-paisa rounding. Every other section sells it at ₹100+.
fixtures.itemA = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,99.99,'FG-ZZTEST-DA','2900000000111','active') RETURNING id`,
  [`${TAG} Disc Item A5`])).rows[0].id;
fixtures.itemB = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119020',12,200,'FG-ZZTEST-DB','2900000000112','active') RETURNING id`,
  [`${TAG} Disc Item B12`])).rows[0].id;

// Orphaned stock rows under reused item ids are not ours (see the edit-sale
// suite for the full story) — record and restore rather than delete.
preLots = (await sql(`SELECT id, quantity::text AS q FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type='item'`,
  [[fixtures.itemA, fixtures.itemB]])).rows;
preEntries = (await sql(`SELECT id, quantity::text AS q FROM stock_entries WHERE item_id = ANY($1::int[]) AND material_type='item'`,
  [[fixtures.itemA, fixtures.itemB]])).rows;
preLotIds = preLots.map(r => r.id);
preEntryIds = preEntries.map(r => r.id);
{
  const preQty = [...preLots, ...preEntries].reduce((s, r) => s + Number(r.q), 0);
  if (preQty !== 0) {
    console.error(`FATAL: reused item ids carry pre-existing stock (${preQty}); pick a clean dev DB`);
    await cleanup(); process.exit(1);
  }
}

for (const [materialId, quantity] of [[fixtures.itemA, 200], [fixtures.itemB, 100]]) {
  const res = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: '2026-07-30',
    locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId, quantity, unitCost: 50, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
  });
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  assert(`Purchase of ${quantity} units lands (item ${materialId})`, res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

const salePayload = (lineItems, extra = {}) => ({
  outletId: WH, locationType: 'warehouse', locationId: WH,
  saleDate: '2026-07-31', paymentMode: 'cash', lineItems, ...extra,
});
async function createSale(lineItems, extra = {}) {
  const res = await post('/sales', salePayload(lineItems, extra));
  if (res.status === 201 && res.data?.id) createdSales.push(res.data.id);
  return res;
}
const lines = (row) => (typeof row.line_items === 'string' ? JSON.parse(row.line_items) : row.line_items);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[A] Per-unit item discount, inclusive: 10 × ₹100 MRP, ₹10/unit off → ₹900');
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100, unitDiscount: 10 }]);
  assert('Sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  const row = await saleRow(res.data.id);
  assert('Total is ₹900 (₹90 × 10), NOT ₹990', near(row.total, 900), `total=${row.total}`);
  const li = lines(row)[0];
  assert('Stored line discount = ₹100 (derived ud × qty)', near(li.discount, 100), `discount=${li.discount}`);
  assert('Stored unitDiscount = 10', near(li.unitDiscount, 10), `ud=${li.unitDiscount}`);
  assert('billDiscountShare = 0 (no bill discount)', near(li.billDiscountShare ?? 0, 0));
  assert('GST extracted from the DISCOUNTED price: taxable 857.14', near(row.subtotal, 857.14), `subtotal=${row.subtotal}`);
  assert('GST total 42.86', near(row.tax_total, 42.86), `tax=${row.tax_total}`);
  assert('CGST/SGST split is exact (21.43 + 21.43)', near(li.cgst + li.sgst, 42.86) && near(li.cgst, 21.43), `cgst=${li.cgst} sgst=${li.sgst}`);
}

console.log('\n[B] No discounts: 10 × ₹100 → ₹1000, all fields zero');
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100 }]);
  assert('Sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 150));
  const row = await saleRow(res.data.id);
  assert('Total is ₹1000', near(row.total, 1000), `total=${row.total}`);
  assert('bill_discount stored as 0', near(row.bill_discount, 0));
  assert('Line discount 0', near(lines(row)[0].discount ?? 0, 0));
}

console.log('\n[C] Exclusive pricing: 1 × ₹200 − ₹20/unit, 5% on top → ₹189');
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 1, unitPrice: 200, unitDiscount: 20, priceMode: 'exclusive' }]);
  assert('Sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 150));
  const row = await saleRow(res.data.id);
  assert('Taxable = ₹180 (discounted price IS the base)', near(row.subtotal, 180), `subtotal=${row.subtotal}`);
  assert('GST = ₹9 added on top', near(row.tax_total, 9), `tax=${row.tax_total}`);
  assert('Total = ₹189', near(row.total, 189), `total=${row.total}`);
}

console.log('\n[D] Inclusive pricing, same figures: 1 × ₹200 − ₹20/unit → ₹180 all-in');
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 1, unitPrice: 200, unitDiscount: 20 }]);
  assert('Sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 150));
  const row = await saleRow(res.data.id);
  assert('Total = ₹180 (customer pays the discounted MRP)', near(row.total, 180), `total=${row.total}`);
  assert('Taxable back-calculated: 171.43', near(row.subtotal, 171.43), `subtotal=${row.subtotal}`);
  assert('GST 8.57', near(row.tax_total, 8.57), `tax=${row.tax_total}`);
}

console.log('\n[E] Bill discount ₹500 on ₹5000 — paise-exact proportional allocation');
{
  // A: 30 × 100 = 3000 (weight 60%), B: 10 × 200 = 2000 (weight 40%)
  const res = await createSale(
    [{ itemId: fixtures.itemA, quantity: 30, unitPrice: 100 },
     { itemId: fixtures.itemB, quantity: 10, unitPrice: 200 }],
    { billDiscount: 500 });
  assert('Sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  const row = await saleRow(res.data.id);
  const [a, b] = lines(row);
  assert('bill_discount stored = 500', near(row.bill_discount, 500), `bd=${row.bill_discount}`);
  assert('Line A share = ₹300 (60%)', near(a.billDiscountShare, 300), `a=${a.billDiscountShare}`);
  assert('Line B share = ₹200 (40%)', near(b.billDiscountShare, 200), `b=${b.billDiscountShare}`);
  assert('Shares sum EXACTLY to the bill discount',
    Math.round((a.billDiscountShare + b.billDiscountShare) * 100) === 50000);
  assert('Grand total = ₹4500', near(row.total, 4500), `total=${row.total}`);
  // Each line taxed on its post-allocation value, at its own rate.
  assert('Line A taxed on 2700 @5% incl (taxable 2571.43)', near(a.taxableAmount, 2571.43), `a.taxable=${a.taxableAmount}`);
  assert('Line B taxed on 1800 @12% incl (taxable 1607.14)', near(b.taxableAmount, 1607.14), `b.taxable=${b.taxableAmount}`);
  assert('Stored line discount = share (no item discount)', near(a.discount, 300) && near(b.discount, 200));
}

console.log('\n[E2] Odd split: ₹100 over three equal lines — largest remainder, exact sum');
{
  const res = await createSale(
    [{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100 },
     { itemId: fixtures.itemA, quantity: 10, unitPrice: 100 },
     { itemId: fixtures.itemA, quantity: 10, unitPrice: 100 }],
    { billDiscount: 100 });
  assert('Sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 150));
  const row = await saleRow(res.data.id);
  const shares = lines(row).map(li => Number(li.billDiscountShare));
  const sumPaise = shares.reduce((s, x) => s + Math.round(x * 100), 0);
  assert('Shares sum to exactly ₹100.00 (no lost/invented paisa)', sumPaise === 10000, `shares=${shares.join(',')}`);
  assert('Every share within 1 paisa of the exact third', shares.every(s => Math.abs(s - 100 / 3) < 0.011), `shares=${shares.join(',')}`);
  assert('Grand total ₹2900', near(row.total, 2900), `total=${row.total}`);
}

console.log('\n[F] Mixed rates + BOTH discounts');
{
  // A: 10 × 100, ud 10 → basis 900 · B: 5 × 200 → basis 1000 · bill 190
  // Shares: 900/1900×190 = 90 and 100. Adjusted: 810 @5%, 900 @12%.
  const res = await createSale(
    [{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100, unitDiscount: 10 },
     { itemId: fixtures.itemB, quantity: 5, unitPrice: 200 }],
    { billDiscount: 190 });
  assert('Sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  const row = await saleRow(res.data.id);
  const [a, b] = lines(row);
  assert('Line A: discount = 100 item + 90 share = 190', near(a.discount, 190), `a.discount=${a.discount}`);
  assert('Line B: discount = 0 item + 100 share = 100', near(b.discount, 100), `b.discount=${b.discount}`);
  assert('Line A taxable 771.43 @5% incl of 810', near(a.taxableAmount, 771.43), `a.taxable=${a.taxableAmount}`);
  assert('Line B taxable 803.57 @12% incl of 900', near(b.taxableAmount, 803.57), `b.taxable=${b.taxableAmount}`);
  assert('Grand total = 1900 − 190 = ₹1710', near(row.total, 1710), `total=${row.total}`);
  assert('subtotal + tax = total (bill discount not double-deducted)',
    near(Number(row.subtotal) + Number(row.tax_total), Number(row.total)));
}

console.log('\n[G] Edit changes ud 10 → 15: money moves, stock does NOT');
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100, unitDiscount: 10 }]);
  assert('Sale accepted at ₹900', res.status === 201 && near((await saleRow(res.data.id)).total, 900));
  const stockBefore = await stockOf(fixtures.itemA);
  const edit = await put(`/sales/${res.data.id}`, salePayload(
    [{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100, unitDiscount: 15 }]));
  assert('Edit accepted', edit.status === 200, JSON.stringify(edit.data).slice(0, 200));
  const row = await saleRow(res.data.id);
  assert('Total now ₹850 (₹85 × 10)', near(row.total, 850), `total=${row.total}`);
  assert('Stored unitDiscount now 15', near(lines(row)[0].unitDiscount, 15));
  assert('Stock unchanged by the discount-only edit', await stockOf(fixtures.itemA) === stockBefore,
    `before=${stockBefore} after=${await stockOf(fixtures.itemA)}`);
  const { rows: [rec] } = await sql(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount::numeric),0) AS amt FROM receipts WHERE voucher_number = $1`,
    [row.invoice_number]);
  assert('ONE receipt, restated to ₹850', rec.n === 1 && near(rec.amt, 850), `n=${rec.n} amt=${rec.amt}`);
}

console.log('\n[H] Historical lines: legacy line-TOTAL `discount` keeps its meaning');
{
  // An old client (or an untouched historical invoice re-saved) sends only
  // `discount` — a line TOTAL. ₹50 on 10 × ₹100 must mean ₹950, never ₹500.
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100, discount: 50 }]);
  assert('Legacy-shape sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 150));
  const row = await saleRow(res.data.id);
  assert('₹50 deducted ONCE from the line total → ₹950', near(row.total, 950), `total=${row.total}`);
  const li = lines(row)[0];
  assert('No unitDiscount invented on a legacy line', li.unitDiscount === undefined || li.unitDiscount === null,
    `ud=${li.unitDiscount}`);
  assert('Legacy line discount stored unchanged (50)', near(li.discount, 50));
  // Same rule through an EDIT that still speaks the old shape.
  const edit = await put(`/sales/${res.data.id}`, salePayload(
    [{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100, discount: 60 }]));
  assert('Legacy-shape edit accepted', edit.status === 200, JSON.stringify(edit.data).slice(0, 150));
  assert('Edited legacy discount still line-total → ₹940', near((await saleRow(res.data.id)).total, 940));
}

console.log('\n[V] Validation: the server refuses nonsense regardless of the client');
{
  const over = await createSale([{ itemId: fixtures.itemA, quantity: 5, unitPrice: 100, unitDiscount: 101 }]);
  assert('unitDiscount > unitPrice rejected 400', over.status === 400, `status=${over.status}`);
  const negUd = await createSale([{ itemId: fixtures.itemA, quantity: 5, unitPrice: 100, unitDiscount: -5 }]);
  assert('Negative unitDiscount rejected 400', negUd.status === 400, `status=${negUd.status}`);
  const bigBill = await createSale([{ itemId: fixtures.itemA, quantity: 5, unitPrice: 100 }], { billDiscount: 501 });
  assert('billDiscount > goods value rejected 400', bigBill.status === 400, `status=${bigBill.status}`);
  const negBill = await createSale([{ itemId: fixtures.itemA, quantity: 5, unitPrice: 100 }], { billDiscount: -1 });
  assert('Negative billDiscount rejected 400', negBill.status === 400, `status=${negBill.status}`);
  const edgeOk = await createSale([{ itemId: fixtures.itemA, quantity: 2, unitPrice: 100, unitDiscount: 100 }]);
  assert('unitDiscount == unitPrice (free goods) accepted', edgeOk.status === 201, JSON.stringify(edgeOk.data).slice(0, 150));
  if (edgeOk.status === 201) assert('Free-goods line totals ₹0', near((await saleRow(edgeOk.data.id)).total, 0));
}

console.log('\n[FQ] Fractional quantity (kg goods): sub-paisa bases round before tax');
{
  // 2.5 kg × ₹99.99 − ₹0.33/unit → itemDisc 0.83 (0.825 rounded), basis
  // 249.98 − 0.83 = 249.15 wait: 2.5 × 99.99 = 249.975 → the MONEY path must
  // round to the paisa exactly once, the same way on server and client.
  const res = await createSale(
    [{ itemId: fixtures.itemA, quantity: 2.5, unitPrice: 99.99, unitDiscount: 0.33 }],
    { billDiscount: 7.77 });
  assert('Fractional-qty sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  const row = await saleRow(res.data.id);
  const li = lines(row)[0];
  // itemDisc = round2(0.33 × 2.5) = 0.83; basis = round2(249.975 − 0.83) = 249.15
  // wait, basis = round2(2.5 × 99.99 − 0.83) = round2(249.145) = 249.15 ✓
  // adjusted = 249.15 − 7.77 = 241.38 → inclusive 5%: taxable 229.89, tax 11.49
  assert('Line discount = 0.83 + 7.77 = 8.60', near(li.discount, 8.6), `discount=${li.discount}`);
  assert('Share = full bill discount (single line)', near(li.billDiscountShare, 7.77));
  assert('Taxable rounds once: 229.89', near(li.taxableAmount, 229.89), `taxable=${li.taxableAmount}`);
  assert('Total is paise-clean: 241.38', near(row.total, 241.38), `total=${row.total}`);
  assert('Stored figures reconcile: taxable + tax = total',
    near(Number(li.taxableAmount) + Number(li.taxAmount), Number(row.total)));
}

console.log('\n[X] Books stay coherent across all of it');
{
  const tb = await snapshotTB();
  assert('Trial balance still balanced', tb.balanced && tb.totalDr === tb.totalCr, `${tb.totalDr} vs ${tb.totalCr}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[cleanup] Removing fixtures');
await cleanup();
assert('Fixture stock fully removed', await stockOf(fixtures.itemA) === 0 && await stockOf(fixtures.itemB) === 0);
const tbFinal = await snapshotTB();
assert('Trial balance matches the pre-test snapshot',
  tbFinal.totalDr === tbBefore.totalDr && tbFinal.totalCr === tbBefore.totalCr,
  `before ${tbBefore.totalDr}/${tbBefore.totalCr} after ${tbFinal.totalDr}/${tbFinal.totalCr}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failed:', failures.join(' | '));
await pool.end();
process.exit(failed ? 1 : 0);
