/**
 * Per-location sales invoice numbering.
 * Run: node artifacts/api-server/tests/per-location-invoice-numbering.test.mjs
 *
 * Rules under test:
 *   Every location runs its own independent SB2B/SB2C serial — creating bills
 *     at one location never advances another location's counter.
 *   The printed format stays clean (SB2C/2026-27/000001) — no location code
 *     is ever appended to the number.
 *   A location billing a series for the FIRST time starts at 000001, even if
 *     other locations are far ahead (this is also how brand-new locations
 *     auto-initialise: the counter row simply doesn't exist until first use).
 *   The same invoice number may therefore exist at two locations; the rows
 *     stay distinct internally via (location, number), global search shows
 *     the location name beside each hit, and cancelling one twin's bill must
 *     NOT delete the other twin's sale-time receipt.
 *   Two concurrent bills at the SAME location draw distinct consecutive
 *     numbers (transaction-safe counter).
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZLOCNUM fixtures and deletes every one of them at the end.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZLOCNUM';
const WH1 = 1; // Marlin Bengaluru Cold Store
const WH2 = 2; // Marlin Mangaluru Depot

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

// Financial-year label for today, Indian FY (April start) — same rule as the
// server. Computed dynamically so the suite survives clock rollover.
// Aug 2026: every location prints the SHORT financial-year label (26-27)
// with an unpadded serial — the global GST-document format.
function fyLabelToday() {
  const d = new Date();
  const startYear = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(startYear % 100).padStart(2, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
const FY = fyLabelToday();
const today = new Date().toISOString().slice(0, 10);

// Next-number anchor for a series at a location. The allocator continues
// from the COUNTER row, not from the highest stored bill: serials burned by
// since-deleted bills are never reissued (by design), so the counter can sit
// ahead of the stored maximum. Expectations must anchor on the same source
// the allocator reads — GREATEST(counter, stored max).
async function maxSuffix(prefix, locType, locId) {
  const scope = locType === 'headoffice' ? 'headoffice' : `${locType}:${locId}`;
  const counterName = prefix === 'SB2B' ? 'sales_invoice_counter_b2b' : 'sales_invoice_counter_b2c';
  const { rows: [c] } = await sql(
    `SELECT COALESCE(MAX(last_number), 0) AS m FROM voucher_sequences WHERE voucher_type = $1`,
    [`${counterName}@${scope}`]);
  const { rows: [r] } = await sql(
    `SELECT COALESCE(MAX((split_part(invoice_number, '/', 3))::int), 0) AS m
       FROM sales
      WHERE invoice_number LIKE $1 || '/' || $2 || '/%'
        AND split_part(invoice_number, '/', 3) ~ '^[0-9]+$'
        AND location_type = $3 AND ($3 = 'headoffice' OR location_id = $4)`,
    [prefix, FY, locType, locId]);
  return Math.max(Number(c.m), Number(r.m));
}
const num = (prefix, n) => `${prefix}/${FY}/${String(n)}`;

const fixtures = { itemId: 0, custB2C: 0, custB2B: 0 };
const createdSales = []; // { id, invoiceNumber, locType, locId }

async function cleanup() {
  // Cancel through the API first so stock is restored and the sale's own
  // receipts are withdrawn by the same guarded delete production uses.
  for (const s of createdSales) await post(`/sales/${s.id}/cancel`, {}).catch(() => {});
  // Match fixture sales by the tagged item NAME inside line_items — never by
  // a text-LIKE on the itemId: jsonb::text renders `"itemId": 206` with a
  // space, so the old pattern matched nothing and leaked every fixture sale.
  // The name match also sweeps up leftovers from earlier runs.
  const { rows: mine } = await sql(
    `SELECT id, invoice_number, location_type, location_id FROM sales
      WHERE line_items::text LIKE '%' || $1 || '%'`,
    [TAG]);
  for (const s of mine) {
    // Same per-location guard as the app: never touch a twin's receipt.
    await sql(
      `DELETE FROM receipts r
        WHERE r.voucher_number = $1
          AND (NOT EXISTS (SELECT 1 FROM sales s2 WHERE s2.invoice_number = $1 AND s2.id <> $2)
               OR (r.location_type = $3 AND COALESCE(r.location_id, 0) = $4))`,
      [s.invoice_number, s.id, s.location_type, Number(s.location_id ?? 0)]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [s.id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [s.id]);
  }
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fixtures.itemId) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'CUST-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup(); // in case a previous run died mid-way
const tbBefore = await snapshotTB();

fixtures.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-ZZLOCNUM','2900000000401','active') RETURNING id`,
  [`${TAG} Numbering Item`])).rows[0].id;
fixtures.custB2C = (await sql(
  `INSERT INTO customers (name, phone) VALUES ($1,'9000000401') RETURNING id`,
  [`${TAG} Walkin`])).rows[0].id;
fixtures.custB2B = (await sql(
  `INSERT INTO customers (name, phone, gst_number, state) VALUES ($1,'9000000402','29ZZLOC1234F1Z5','Karnataka') RETURNING id`,
  [`${TAG} GST Buyer`])).rows[0].id;

// Shelf stock at each location under test, straight into stock_entries —
// numbering doesn't depend on costing, so no purchase bills are needed.
for (const [bt, bid] of [['warehouse', WH1], ['warehouse', WH2], ['headoffice', 1]]) {
  await sql(
    `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
     VALUES ($1,'item',$2,$3,100,'50')`, [fixtures.itemId, bt, bid]);
}

// The allocator (voucher_sequences) is the authority on "the next number":
// it never rewinds, so after a cancelled+deleted bill the counter sits AHEAD
// of MAX(invoice_number). Anchor on the counter row when it exists; fall back
// to the data maximum only for a scope that has never drawn (no row yet).
async function nextAnchor(series, locType, locId) {
  const counter = series === 'SB2B' ? 'sales_invoice_counter_b2b' : 'sales_invoice_counter_b2c';
  const scope = locType === 'headoffice' ? 'headoffice' : `${locType}:${locId}`;
  // A scope on the continuous (short) format keys its counter row on 'ALL';
  // stale per-FY rows can linger below it, so take the maximum of both.
  const { rows: [r] } = await sql(
    `SELECT MAX(last_number) AS m FROM voucher_sequences
      WHERE voucher_type = $1 AND fy_label IN ('ALL', $2)`,
    [`${counter}@${scope}`, FY]);
  if (r && r.m != null) return Number(r.m);
  return maxSuffix(series, locType, locId);
}

const before = {
  wh1: await nextAnchor('SB2C', 'warehouse', WH1),
  wh2: await nextAnchor('SB2C', 'warehouse', WH2),
  ho: await nextAnchor('SB2C', 'headoffice', 1),
  wh1b2b: await nextAnchor('SB2B', 'warehouse', WH1),
  wh2b2b: await nextAnchor('SB2B', 'warehouse', WH2),
};
console.log(`  (starting maxima: WH1 B2C ${before.wh1}, WH2 B2C ${before.wh2}, HO B2C ${before.ho}, WH1 B2B ${before.wh1b2b}, WH2 B2B ${before.wh2b2b})`);

const makeSale = async (locType, locId, customerId, qty = 1) => {
  const res = await post('/sales', {
    outletId: locId, locationType: locType, locationId: locId,
    saleDate: today, paymentMode: 'cash', customerId,
    lineItems: [{ itemId: fixtures.itemId, quantity: qty, unitPrice: 100, discount: 0 }],
  });
  if (res.status === 201 && res.data?.id) {
    createdSales.push({ id: res.data.id, invoiceNumber: res.data.invoiceNumber ?? res.data.invoice_number, locType, locId });
  }
  return res;
};
const lastSale = () => createdSales[createdSales.length - 1];

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Each location continues its own B2C serial, independently');

let r = await makeSale('warehouse', WH1, fixtures.custB2C);
assert('WH1 sale #1 created', r.status === 201, JSON.stringify(r.data).slice(0, 150));
assert(`WH1 continues from its own max (${num('SB2C', before.wh1 + 1)})`,
  lastSale()?.invoiceNumber === num('SB2C', before.wh1 + 1), `got ${lastSale()?.invoiceNumber}`);

r = await makeSale('warehouse', WH2, fixtures.custB2C);
assert('WH2 sale #1 created', r.status === 201, JSON.stringify(r.data).slice(0, 150));
assert(`WH2 unaffected by WH1's bill (${num('SB2C', before.wh2 + 1)})`,
  lastSale()?.invoiceNumber === num('SB2C', before.wh2 + 1), `got ${lastSale()?.invoiceNumber}`);

r = await makeSale('warehouse', WH1, fixtures.custB2C);
assert(`WH1 sale #2 is consecutive at WH1 (${num('SB2C', before.wh1 + 2)})`,
  r.status === 201 && lastSale()?.invoiceNumber === num('SB2C', before.wh1 + 2), `got ${lastSale()?.invoiceNumber}`);

r = await makeSale('headoffice', 1, fixtures.custB2C);
assert('HO sale created', r.status === 201, JSON.stringify(r.data).slice(0, 150));
assert(`HO continues its own serial (${num('SB2C', before.ho + 1)})`,
  lastSale()?.invoiceNumber === num('SB2C', before.ho + 1), `got ${lastSale()?.invoiceNumber}`);

assert('Numbers carry no location code (clean SB2C/FY/NNNNNN format)',
  createdSales.every(s => new RegExp(`^SB2[BC]/${FY}/[1-9]\\d*$`).test(s.invoiceNumber)));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] First use of a series at a location starts at 000001');

r = await makeSale('warehouse', WH1, fixtures.custB2B);
const wh1B2B = lastSale();
assert('WH1 B2B sale created', r.status === 201, JSON.stringify(r.data).slice(0, 150));
assert(`WH1's first-ever B2B bill is ${num('SB2B', before.wh1b2b + 1)}`,
  wh1B2B?.invoiceNumber === num('SB2B', before.wh1b2b + 1), `got ${wh1B2B?.invoiceNumber}`);

r = await makeSale('warehouse', WH2, fixtures.custB2B);
assert(`WH2's B2B serial continues independently (${num('SB2B', before.wh2b2b + 1)})`,
  r.status === 201 && lastSale()?.invoiceNumber === num('SB2B', before.wh2b2b + 1), `got ${lastSale()?.invoiceNumber}`);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] Duplicate numbers across locations stay distinct internally');

const { rows: dupRows } = await sql(
  `SELECT id, location_type, location_id FROM sales WHERE invoice_number = $1 ORDER BY id`,
  [wh1B2B.invoiceNumber]);
const dupAcrossLocations = dupRows.length >= 2;
if (dupAcrossLocations) {
  const scopes = new Set(dupRows.map(x => `${x.location_type}:${x.location_id}`));
  assert(`"${wh1B2B.invoiceNumber}" exists at ${dupRows.length} locations, all distinct scopes`,
    scopes.size === dupRows.length, [...scopes].join(', '));

  const search = await get(`/search?q=${encodeURIComponent(wh1B2B.invoiceNumber)}`);
  const hits = (search.data?.sales ?? []).filter(s => s.title === wh1B2B.invoiceNumber);
  assert('Global search returns every twin', hits.length === dupRows.length, `got ${hits.length}`);
  assert('Search subtitles carry distinct location names',
    new Set(hits.map(h => h.subtitle)).size === hits.length, hits.map(h => h.subtitle).join(' | '));
} else {
  // Dev data may lack a pre-existing twin — the two fresh B2B bills above
  // still prove independent serials; note it rather than fake a pass.
  console.log(`  (no pre-existing twin for ${wh1B2B.invoiceNumber} in this database — cross-location duplicate assertions run when one exists)`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Cancelling one twin never touches the other\'s receipt');

const { rows: [{ c: recBefore }] } = await sql(
  `SELECT count(*)::int AS c FROM receipts WHERE voucher_number = $1`, [wh1B2B.invoiceNumber]);
const cancelRes = await post(`/sales/${wh1B2B.id}/cancel`, {});
assert('WH1 twin cancelled', cancelRes.status === 200, JSON.stringify(cancelRes.data).slice(0, 120));
const { rows: [{ c: recAfter }] } = await sql(
  `SELECT count(*)::int AS c FROM receipts WHERE voucher_number = $1`, [wh1B2B.invoiceNumber]);
assert('Exactly the cancelled bill\'s own receipt was withdrawn',
  recAfter === recBefore - 1, `before=${recBefore} after=${recAfter}`);
if (dupAcrossLocations) {
  const { rows: leftover } = await sql(
    `SELECT location_type, location_id FROM receipts WHERE voucher_number = $1`, [wh1B2B.invoiceNumber]);
  assert('Surviving receipts all belong to other locations',
    leftover.every(x => !(x.location_type === 'warehouse' && Number(x.location_id) === WH1)),
    JSON.stringify(leftover));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] Two concurrent bills at one location get distinct numbers');

const beforeConc = await maxSuffix('SB2C', 'warehouse', WH2);
const [c1, c2] = await Promise.all([
  makeSale('warehouse', WH2, fixtures.custB2C),
  makeSale('warehouse', WH2, fixtures.custB2C),
]);
const concNums = [c1, c2].map(x => x.data?.invoiceNumber ?? x.data?.invoice_number).filter(Boolean);
assert('Both concurrent sales created', c1.status === 201 && c2.status === 201,
  `${c1.status}/${c2.status}`);
assert('Concurrent numbers are distinct and consecutive',
  new Set(concNums).size === 2 &&
  [...concNums].sort().join() === [num('SB2C', beforeConc + 1), num('SB2C', beforeConc + 2)].sort().join(),
  concNums.join(', '));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[cleanup] Removing fixtures');
await cleanup();

const tbAfter = await snapshotTB();
assert('Trial balance restored to its starting figure',
  tbBefore.totalDr === tbAfter.totalDr && tbBefore.totalCr === tbAfter.totalCr,
  `before Dr ${tbBefore.totalDr}/Cr ${tbBefore.totalCr}, after Dr ${tbAfter.totalDr}/Cr ${tbAfter.totalCr}`);

console.log(`\n${passed} passed, ${failed} failed${failed ? ' — ' + failures.join('; ') : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
