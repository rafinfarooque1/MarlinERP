/**
 * B2C → B2B invoice conversion when a customer gains a GSTIN — spec §5/§6/§18.
 * Run: node artifacts/api-server/tests/b2c-b2b-conversion.test.mjs
 *
 * Rules under test:
 *   Adding a GSTIN to a customer converts that customer's OPEN-month B2C
 *     invoices to fresh B2B numbers (SB2B series), stamps party_gstin, and
 *     leaves an audit trail per invoice.
 *   Locked-month invoices are SKIPPED (classification is frozen) and the
 *     skip is reported; the customer's GSTIN still saves.
 *   The vacated B2C serials are compacted — but ONLY the gaps the conversion
 *     opened; nothing beneath the first converted serial moves.
 *   Receipts follow the renamed invoices (pair-rename); the B2C counter is
 *     walked back so the next B2C bill continues gaplessly.
 *   GSTR-1 classifies by the STAMPED series: the converted rows report as
 *     B2B, the frozen locked-month row stays B2C despite the current GSTIN.
 *
 * The suite runs at its own throwaway warehouse so no real invoice can ever
 * be touched by resequencing. Everything — sales, receipts, ledgers, the
 * warehouse itself, the temporary period lock — is removed at the end.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZB2B';

// GSTIN check digit (base-36, alternating 1/2 weights) — the API validates
// checksums, so the test builds its own formally-valid GSTINs.
function gstin(prefix14) {
  const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const m = A.indexOf(prefix14[i]) * ((i % 2) ? 2 : 1);
    sum += Math.floor(m / 36) + (m % 36);
  }
  return prefix14 + A[(36 - (sum % 36)) % 36];
}
const GSTIN = gstin('27ZZBCU1234B1Z');     // the customer's new registration
const WH_GSTIN = gstin('29ZZBWH1234A1Z');  // the throwaway warehouse's own
const LY = 2025, LM = 3;                   // March 2025 — temporarily locked
const LOCKED_DATE = '2025-03-10';

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
const patch = (p, b, t) => apiReq('PATCH', p, b, t);
const get = (p, t) => apiReq('GET', p, undefined, t);
const del = (p, t) => apiReq('DELETE', p, undefined, t);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

const fx = { W: 0, vendorId: 0, itemId: 0, customerId: 0 };
const createdSales = [];
const createdPurchases = [];

/** Purge one throwaway warehouse and everything stamped with it. */
async function purgeWarehouse(wid) {
  // Receipts are matched by voucher number STRINGS which repeat across
  // location scopes — the location guard here is what keeps this delete off
  // real business receipts. Never widen it.
  await sql(`DELETE FROM receipts WHERE location_type = 'warehouse' AND location_id = $1`, [wid]);
  await sql(`DELETE FROM sale_payments WHERE sale_id IN
               (SELECT id FROM sales WHERE location_type = 'warehouse' AND location_id = $1)`, [wid]);
  await sql(`DELETE FROM sales WHERE location_type = 'warehouse' AND location_id = $1`, [wid]);
  await sql(`DELETE FROM purchases WHERE location_type = 'warehouse' AND location_id = $1`, [wid]);
  await sql(`DELETE FROM stock_ledger WHERE branch_type = 'warehouse' AND branch_id = $1`, [wid]);
  await sql(`DELETE FROM stock_batches WHERE branch_type = 'warehouse' AND branch_id = $1`, [wid]);
  await sql(`DELETE FROM stock_entries WHERE branch_type = 'warehouse' AND branch_id = $1`, [wid]);
  await sql(`DELETE FROM voucher_sequences WHERE voucher_type LIKE '%@warehouse:' || $1`, [wid]);
  const { rows: [whRow] } = await sql(`SELECT name FROM warehouses WHERE id = $1`, [wid]);
  const rm = await apiReq('DELETE', `/warehouses/${wid}/permanent`,
    { confirmation: `DELETE ${whRow?.name ?? ''}` });
  if (rm.status !== 200) {
    console.warn(`  ! warehouse permanent delete answered ${rm.status}: ${JSON.stringify(rm.data).slice(0, 200)}`);
    await sql(`DELETE FROM warehouse_rent_agreements WHERE warehouse_id = $1`, [wid]).catch(() => {});
    await sql(`DELETE FROM warehouses WHERE id = $1`, [wid]).catch(() => {});
  }
}

async function cleanup() {
  await sql(`DELETE FROM accounting_period_locks WHERE year = $1 AND month = $2`, [LY, LM]);
  await sql(`DELETE FROM period_lock_events WHERE year = $1 AND month = $2`, [LY, LM]);
  for (const id of createdSales.splice(0).reverse()) {
    await post(`/sales/${id}/cancel`, {}).catch(() => {});
    await sql(`DELETE FROM activity_log WHERE entity_type = 'sale' AND entity_id = $1`, [id]).catch(() => {});
  }
  for (const id of createdPurchases.splice(0)) { await del(`/purchases/${id}`).catch(() => {}); }
  // Purge every ZZB2B warehouse by NAME (covers a crashed earlier run whose
  // id this process never saw), then the current one by id.
  const { rows: strays } = await sql(`SELECT id FROM warehouses WHERE name LIKE $1`, [`${TAG}%`]);
  for (const s of strays) await purgeWarehouse(s.id);
  if (fx.W && !strays.some((s) => s.id === fx.W)) await purgeWarehouse(fx.W);
  fx.W = 0;
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND (code LIKE 'VEND-%' OR code LIKE 'CUST-%' OR code LIKE 'CBA-%')`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
}

const saleRow = async (id) => (await sql(
  `SELECT id, invoice_number, invoice_series, invoice_fy, invoice_serial, party_gstin, number_scope
     FROM sales WHERE id = $1`, [id])).rows[0];

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and an isolated throwaway warehouse');

const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup();

const whRes = await post('/warehouses', { name: `${TAG} Warehouse`, address: 'Test Lane', state: 'Karnataka', gstNumber: WH_GSTIN });
fx.W = whRes.data?.id ?? 0;
assert('Throwaway warehouse created (its own numbering scope)', whRes.status === 201 && fx.W > 0,
  JSON.stringify(whRes.data).slice(0, 150));
if (!fx.W) { console.error('FATAL: no warehouse'); await pool.end(); process.exit(1); }

fx.vendorId = (await sql(
  `INSERT INTO vendors (name, state) VALUES ($1,'Karnataka') RETURNING id`, [`${TAG} Vendor`])).rows[0].id;
fx.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-ZZB2B-01','2900000000140','active') RETURNING id`,
  [`${TAG} Item`])).rows[0].id;
const custRes = await post('/customers', { name: `${TAG} Traders`, phone: '9899000002' });
fx.customerId = custRes.data?.id ?? 0;
assert('Customer created WITHOUT a GSTIN', !!fx.customerId, JSON.stringify(custRes.data).slice(0, 120));

const purRes = await post('/purchases', {
  vendorId: fx.vendorId, purchaseDate: new Date().toISOString().slice(0, 10), vendorInvoiceDate: new Date().toISOString().slice(0, 10),
  locationType: 'warehouse', locationId: fx.W,
  lineItems: [{ materialType: 'item', materialId: fx.itemId, quantity: 30, unitCost: 40, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
});
if (purRes.status === 201 && purRes.data?.id) createdPurchases.push(purRes.data.id);
assert('Stock purchased at the throwaway warehouse', purRes.status === 201, JSON.stringify(purRes.data).slice(0, 150));

try {

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Interleaved B2C billing: customer, walk-in, customer, customer (+ one in a month to be locked)');

const TODAY = new Date().toISOString().slice(0, 10);
const mkSale = (extra) => post('/sales', {
  outletId: fx.W, locationType: 'warehouse', locationId: fx.W,
  saleDate: TODAY, paymentMode: 'cash',
  lineItems: [{ itemId: fx.itemId, quantity: 1, unitPrice: 100 }],
  ...extra,
});

const c1 = await mkSale({ customerId: fx.customerId });
const w1 = await mkSale({});
const c2 = await mkSale({ customerId: fx.customerId });
const c3 = await mkSale({ customerId: fx.customerId });
const c4 = await mkSale({ customerId: fx.customerId, saleDate: LOCKED_DATE }); // older FY, will sit in a locked month
for (const r of [c1, w1, c2, c3, c4]) if (r.data?.id) createdSales.push(r.data.id);
assert('All five sales accepted', [c1, w1, c2, c3, c4].every((r) => r.status === 201),
  JSON.stringify([c1, w1, c2, c3, c4].map((r) => `${r.status}:${JSON.stringify(r.data).slice(0, 80)}`)));

const before = {
  c1: await saleRow(c1.data.id), w1: await saleRow(w1.data.id),
  c2: await saleRow(c2.data.id), c3: await saleRow(c3.data.id), c4: await saleRow(c4.data.id),
};
assert('Fresh scope numbers exactly as expected (B2C 1..4 + old-FY 1)',
  before.c1.invoice_serial === 1 && before.w1.invoice_serial === 2 &&
  before.c2.invoice_serial === 3 && before.c3.invoice_serial === 4 &&
  before.c4.invoice_serial === 1 &&
  [before.c1, before.w1, before.c2, before.c3, before.c4].every((r) => r.invoice_series === 'SB2C'),
  JSON.stringify(before, null, 0).slice(0, 400));

const receiptsBefore = (await sql(
  `SELECT voucher_number FROM receipts
    WHERE voucher_number = ANY($1) AND location_type = 'warehouse' AND location_id = $2`,
  [[before.c1, before.w1, before.c2, before.c3, before.c4].map((r) => r.invoice_number), fx.W])).rows;
assert('Every cash sale left a matching receipt', receiptsBefore.length === 5, JSON.stringify(receiptsBefore));

const lockRes = await post(`/accounting-periods/${LY}/${LM}/lock`, { confirm: true });
assert('March 2025 locked (freezes the old invoice)', lockRes.status === 200 || lockRes.status === 201,
  JSON.stringify(lockRes.data).slice(0, 150));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] The customer gains a GSTIN — conversion runs inside the save');

const patchRes = await patch(`/customers/${fx.customerId}`, { gstNumber: GSTIN });
assert('Customer GSTIN saves', patchRes.status === 200, JSON.stringify(patchRes.data).slice(0, 300));
const rec = patchRes.data?.invoiceReclassification;
assert('Save reports the reclassification result', !!rec, JSON.stringify(patchRes.data).slice(0, 300));
assert('Exactly the 3 open-month invoices converted', (rec?.converted?.length ?? 0) === 3, JSON.stringify(rec?.converted));
assert('The walk-in bill was resequenced (1 move)', (rec?.resequenced?.length ?? 0) === 1, JSON.stringify(rec?.resequenced));
assert('The locked month is reported as skipped', (rec?.skippedLockedMonths ?? []).some((m) => /march/i.test(String(m)) || String(m).includes('2025')),
  JSON.stringify(rec?.skippedLockedMonths));

const after = {
  c1: await saleRow(c1.data.id), w1: await saleRow(w1.data.id),
  c2: await saleRow(c2.data.id), c3: await saleRow(c3.data.id), c4: await saleRow(c4.data.id),
};

assert('Converted invoices renumbered into the B2B series 1..3',
  after.c1.invoice_series === 'SB2B' && after.c2.invoice_series === 'SB2B' && after.c3.invoice_series === 'SB2B' &&
  after.c1.invoice_serial === 1 && after.c2.invoice_serial === 2 && after.c3.invoice_serial === 3,
  JSON.stringify([after.c1, after.c2, after.c3]));
assert('Converted invoices carry the customer GSTIN', [after.c1, after.c2, after.c3].every((r) => r.party_gstin === GSTIN));
assert('Printed numbers follow SB2B/FY/serial',
  [after.c1, after.c2, after.c3].every((r) => new RegExp(`^SB2B/\\d{4}-\\d{2}/${String(r.invoice_serial).padStart(6, '0')}$`).test(r.invoice_number)),
  JSON.stringify([after.c1.invoice_number, after.c2.invoice_number, after.c3.invoice_number]));

assert('Walk-in bill compacted down to B2C serial 1 (gapless series)',
  after.w1.invoice_series === 'SB2C' && after.w1.invoice_serial === 1 &&
  after.w1.invoice_number.endsWith('000001'), JSON.stringify(after.w1));

assert('Locked-month invoice untouched: still B2C, same number, no GSTIN stamp',
  after.c4.invoice_series === 'SB2C' && after.c4.invoice_number === before.c4.invoice_number && !after.c4.party_gstin,
  JSON.stringify(after.c4));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] The paper trail moved with the numbers');

const receiptsAfter = (await sql(
  `SELECT voucher_number FROM receipts
    WHERE voucher_number = ANY($1) AND location_type = 'warehouse' AND location_id = $2`,
  [[after.c1, after.c2, after.c3, after.w1].map((r) => r.invoice_number), fx.W])).rows;
assert('Receipts renamed to every NEW invoice number', receiptsAfter.length === 4, JSON.stringify(receiptsAfter));
// A vacated number = an OLD number no sale carries any more. w1's NEW number
// can equal c1's OLD one (compaction fills the gap), so subtract current numbers.
const currentNumbers = new Set([after.c1, after.c2, after.c3, after.w1, after.c4].map((r) => r.invoice_number));
const vacated = [before.c1, before.c2, before.c3, before.w1]
  .map((r) => r.invoice_number).filter((n) => !currentNumbers.has(n));
const staleReceipts = (await sql(
  `SELECT voucher_number FROM receipts
    WHERE voucher_number = ANY($1) AND location_type = 'warehouse' AND location_id = $2`,
  [vacated, fx.W])).rows;
assert('No receipt still bears an old (vacated) number', staleReceipts.length === 0, JSON.stringify(staleReceipts));

const { rows: audits } = await sql(
  `SELECT entity_id FROM activity_log
    WHERE entity_type = 'sale' AND entity_id = ANY($1) AND description ILIKE '%reclassified%'`,
  [[c1.data.id, c2.data.id, c3.data.id]]);
assert('An audit entry exists for each converted invoice', new Set(audits.map((a) => Number(a.entity_id))).size === 3,
  JSON.stringify(audits));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Counter continuity — the next B2C bill continues gaplessly');

const w2 = await mkSale({});
if (w2.data?.id) createdSales.push(w2.data.id);
const w2row = await saleRow(w2.data.id);
assert('Next walk-in bill draws B2C serial 2 (no collision, no gap)',
  w2.status === 201 && w2row.invoice_series === 'SB2C' && w2row.invoice_serial === 2, JSON.stringify(w2row));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] GSTR-1 follows the STAMPED series, not the current GSTIN');

const ym = TODAY.slice(0, 7);
const g1 = await get(`/gst/gstr1?from=${ym}-01&to=${ym}-31`);
const g1text = JSON.stringify(g1.data);
assert('GSTR-1 (current month) lists the converted numbers under B2B',
  g1.status === 200 && [after.c1, after.c2, after.c3].every((r) => g1text.includes(r.invoice_number)),
  g1text.slice(0, 300));

const g2 = await get(`/gst/gstr1?from=2025-03-01&to=2025-03-31`);
const b2bText = JSON.stringify(g2.data?.b2b ?? g2.data?.b2bInvoices ?? '');
assert('GSTR-1 (locked month) keeps the frozen invoice OUT of B2B despite the GSTIN',
  g2.status === 200 && !b2bText.includes(after.c4.invoice_number), b2bText.slice(0, 300));

} finally {
  console.log('\n[cleanup]');
  await cleanup();
  const { rows: [left] } = await sql(
    `SELECT (SELECT count(*) FROM warehouses WHERE name LIKE $1)::int AS wh,
            (SELECT count(*) FROM accounting_period_locks WHERE year=$2 AND month=$3)::int AS locks,
            (SELECT count(*) FROM customers WHERE name LIKE $1)::int AS cust`,
    [`${TAG}%`, LY, LM]);
  console.log(`  residue: warehouses=${left.wh} locks=${left.locks} customers=${left.cust}`);
  await pool.end();
}

console.log(`\n${'─'.repeat(60)}\nPASSED ${passed}  FAILED ${failed}`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  ✗ ${f}`)); }
process.exit(failed ? 1 : 0);
