/**
 * Per-location invoice numbering — identity COLUMNS + plain unique indexes.
 * Run: node artifacts/api-server/tests/sales-number-identity.test.mjs
 *
 * Rules under test:
 *   Every sale row is stamped with its internal identity at creation:
 *     number_scope / invoice_series / invoice_fy / invoice_serial.
 *   Each location runs an independent serial; concurrent bills at three
 *     locations never collide and each location's serials are gapless.
 *   The printed number stays clean (SB2C/2026-27/000001 — no location code).
 *   The DB itself enforces the identity via PLAIN btree unique indexes —
 *     duplicate (scope, number) refused, same number at another location OK.
 *   The publish-breaking CASE-expression index is gone from the database.
 *   Global search distinguishes twin numbers by location name.
 *   Reports, GST, dashboard, invoice detail keep working; TB stays balanced.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZNUMID fixtures and deletes every one of them at the end.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZNUMID';

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

// The three billing locations under test (PART 10 of the spec): Head Office
// plus two warehouses. HO's placeholder id in sales is 1 (match on type).
const LOCS = [
  { label: 'Head Office', type: 'headoffice', id: 1, scope: 'headoffice' },
  { label: 'Warehouse 1', type: 'warehouse', id: 1, scope: 'warehouse:1' },
  { label: 'Warehouse 2', type: 'warehouse', id: 2, scope: 'warehouse:2' },
];

const fixtures = { vendorId: 0, itemId: 0 };
const createdPurchases = [];
const createdSales = [];

async function cleanup() {
  for (const id of createdSales.splice(0).reverse()) {
    await post(`/sales/${id}/cancel`, {}).catch(() => {});
    const { rows: [row] } = await sql(`SELECT invoice_number, number_scope FROM sales WHERE id = $1`, [id]);
    if (row) {
      await sql(`DELETE FROM receipts WHERE voucher_number = $1
                   AND (SELECT count(*) FROM sales s2 WHERE s2.invoice_number = $1) <= 1`, [row.invoice_number]);
    }
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [id]);
  }
  // Direct-SQL twins from the DB-enforcement section, if a run died mid-way.
  await sql(`DELETE FROM sales WHERE invoice_number LIKE 'ZZNI/%'`);
  for (const id of createdPurchases.splice(0)) { await del(`/purchases/${id}`).catch(() => {}); }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fixtures.itemId) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'VEND-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication, fixtures, and stock at all three locations');

const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup();
const tbBefore = await snapshotTB();

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZNUM1234V1Z5') RETURNING id`,
  [`${TAG} Vendor`])).rows[0].id;
fixtures.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-ZZNUMI-01','2900000000126','active') RETURNING id`,
  [`${TAG} Item`])).rows[0].id;

for (const loc of LOCS) {
  const res = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: '2026-08-01', vendorInvoiceDate: '2026-07-31',
    locationType: loc.type, locationId: loc.id,
    lineItems: [{ materialType: 'item', materialId: fixtures.itemId, quantity: 10, unitCost: 40, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
  });
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  assert(`Stock purchased at ${loc.label}`, res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

// Everything below runs inside try/finally: however a section dies, the
// fixtures are swept before the process exits (plus the sweep-on-start above
// as a second net for a hard crash).
try {

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Simultaneous billing at three locations — independent, gapless, clean');

const makeSale = (loc) => post('/sales', {
  outletId: loc.id, locationType: loc.type, locationId: loc.id,
  saleDate: '2026-08-04', paymentMode: 'cash',
  lineItems: [{ itemId: fixtures.itemId, quantity: 1, unitPrice: 100 }],
});

// Two bills per location, all six requests IN FLIGHT AT ONCE.
const results = await Promise.all(LOCS.flatMap((loc) => [makeSale(loc), makeSale(loc)]));
for (const r of results) if (r.status === 201 && r.data?.id) createdSales.push(r.data.id);
assert('All six concurrent sales are accepted', results.every((r) => r.status === 201),
  JSON.stringify(results.map((r) => r.status)));
// Aug 2026: every location bills in the SHORT format — SB2C/26-27/528
// (short FY label, no zero padding, continuous serial).
assert('Every printed number is clean SB2C/FY/serial — no location code',
  results.every((r) => /^SB2C\/\d{2}-\d{2}\/[1-9]\d*$/.test(r.data?.invoiceNumber ?? r.data?.invoice_number ?? '')),
  JSON.stringify(results.map((r) => r.data?.invoiceNumber ?? r.data?.invoice_number)));

const { rows: idRows } = await sql(
  `SELECT id, invoice_number, number_scope, invoice_series, invoice_fy, invoice_serial
     FROM sales WHERE id = ANY($1) ORDER BY id`, [createdSales]);
assert('Every new sale is stamped with its full internal identity',
  idRows.length === 6 && idRows.every((r) =>
    r.number_scope && r.invoice_series === 'SB2C' && /^\d{2}-\d{2}$/.test(r.invoice_fy ?? '') && Number.isInteger(r.invoice_serial)),
  JSON.stringify(idRows));
assert('Stamped serial matches the printed number exactly',
  idRows.every((r) => r.invoice_number === `${r.invoice_series}/${r.invoice_fy}/${String(r.invoice_serial)}`),
  JSON.stringify(idRows.map((r) => [r.invoice_number, r.invoice_serial])));

for (const loc of LOCS) {
  const mine = idRows.filter((r) => r.number_scope === loc.scope).map((r) => r.invoice_serial).sort((a, b) => a - b);
  assert(`${loc.label} drew two CONSECUTIVE serials of its own (scope ${loc.scope})`,
    mine.length === 2 && mine[1] === mine[0] + 1, JSON.stringify(mine));
}
assert('No two of the six bills share (scope, number)',
  new Set(idRows.map((r) => `${r.number_scope}|${r.invoice_number}`)).size === 6);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] The DATABASE enforces the identity — plain indexes, no CASE');

{
  const { rows: idx } = await sql(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'sales' AND indexname IN
       ('uq_sales_scope_invoice_number', 'uq_sales_scope_series_fy_serial',
        'uq_sales_invoice_number_per_location', 'uq_sales_invoice_number')`);
  const names = idx.map((r) => r.indexname);
  assert('Both plain-column unique indexes exist',
    names.includes('uq_sales_scope_invoice_number') && names.includes('uq_sales_scope_series_fy_serial'),
    JSON.stringify(names));
  assert('The old CASE-expression and global indexes are gone',
    !names.includes('uq_sales_invoice_number_per_location') && !names.includes('uq_sales_invoice_number'),
    JSON.stringify(names));
  const { rows: [caseIdx] } = await sql(
    `SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND indexdef ILIKE '%CASE%'`);
  assert('NO index anywhere in the schema uses a CASE expression (publish-safe)', caseIdx.n === 0, `n=${caseIdx.n}`);
  const { rows: [nullScope] } = await sql(`SELECT count(*)::int AS n FROM sales WHERE number_scope IS NULL`);
  assert('Every existing sale row has been backfilled with its scope', nullScope.n === 0, `null=${nullScope.n}`);
}

const TWIN = 'ZZNI/2099-00/000042';
{
  const ins = (scope, locType, locId) => sql(
    `INSERT INTO sales (invoice_number, location_type, location_id, sale_date, line_items, subtotal, tax_total,
                        discount_total, total_amount, payment_mode, payment_status, amount_paid,
                        number_scope, invoice_series, invoice_fy, invoice_serial)
     VALUES ($1, $2, $3, '2026-08-04', '[]'::jsonb, 0, 0, 0, 0, 'cash', 'paid', 0, $4, 'ZZNI', '2099-00', 42)
     RETURNING id`, [TWIN, locType, locId, scope]);
  await ins('warehouse:1', 'warehouse', 1);
  let dupErr = null;
  try { await ins('warehouse:1', 'warehouse', 1); } catch (e) { dupErr = e; }
  assert('Duplicate (location, number) is refused BY THE DATABASE',
    dupErr?.code === '23505', `code=${dupErr?.code ?? 'none'}`);
  let twinErr = null;
  try { await ins('warehouse:2', 'warehouse', 2); } catch (e) { twinErr = e; }
  assert('The SAME printed number at ANOTHER location is allowed', twinErr === null, String(twinErr));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] Global search tells twin numbers apart by location');

{
  const res = await get(`/search?q=${encodeURIComponent(TWIN)}`);
  const hits = (res.data?.sales ?? []).filter((h) => h.title === TWIN);
  const blob = JSON.stringify(hits);
  assert('Search finds BOTH sales carrying the twin number', res.status === 200 && hits.length === 2,
    `status=${res.status} hits=${hits.length} ${JSON.stringify(res.data).slice(0, 200)}`);
  assert('The two results carry DIFFERENT location names',
    hits.length === 2 && new Set(hits.map((h) => h.subtitle)).size === 2, blob.slice(0, 300));
  await sql(`DELETE FROM sales WHERE invoice_number = $1`, [TWIN]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Reports, GST, dashboard and invoice detail keep working');

for (const [label, path] of [
  ['Sales register', '/reports/sales-register?from=2026-08-01&to=2026-08-31'],
  ['Trial balance', '/accounts/trial-balance'],
  ['Financial statements (P&L + BS)', '/accounts/financial-statements'],
  ['Day book', '/reports/fin/day-book?from=2026-08-04&to=2026-08-04'],
  ['GSTR-1', '/gst/gstr1?from=2026-08-01&to=2026-08-31'],
  ['GSTR-3B', '/gst/gstr3b?month=2026-08'],
  ['Dashboard BI', '/dashboard/bi?from=2026-08-01&to=2026-08-31'],
]) {
  const res = await get(path);
  assert(`${label} responds 200`, res.status === 200, `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
}
{
  const res = await get(`/sales/${createdSales[0]}`);
  const num = res.data?.invoiceNumber ?? res.data?.invoice_number;
  assert('Invoice detail (print source) returns the sale with its number',
    res.status === 200 && /^SB2C\//.test(num ?? ''), `status=${res.status} num=${num}`);
}
{
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  const dr = r2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0));
  const cr = r2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0));
  assert('Trial balance BALANCES with the six new bills in the books', dr === cr, `dr=${dr} cr=${cr}`);
}

// ───────────────────────────────────────────────────────────────────────────
} finally {
  console.log('\n[cleanup] Removing fixtures');
  await cleanup();
}
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
