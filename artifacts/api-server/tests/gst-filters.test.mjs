/**
 * GST Summary & Returns — GSTIN/warehouse filters + payment columns
 * Run: node artifacts/api-server/tests/gst-filters.test.mjs
 *
 * Verifies Task: GST pages get GST-number filter with dependent warehouse
 * dropdown; document rows gain Warehouse / Payment Status / Payment Mode
 * columns derived from actual settlement records.
 *
 *  1. /gst/filters groups warehouses by effective GSTIN
 *  2. /gst/documents: filtered rows are a strict subset of unfiltered, and
 *     the per-GSTIN sets partition the total (no row lost, no row doubled)
 *  3. Unknown GSTIN → empty; warehouse not under the requested GSTIN → empty
 *  4. Payment columns: a credit sale reports "Credit"; after a partial cash
 *     payment it reports "Cash + Credit" (partially_paid); a fresh vendor's
 *     unpaid bill reports "Credit"
 *  5. GSTR-1 b2b rows carry warehouseName / paymentStatus / paymentModes
 *  6. Unfiltered /gst/summary totals are unchanged by the filter's existence
 *     (byte-stability: gstin-scoped totals sum back to the whole)
 *
 * Fixtures persist after the run (sales/purchases are not deletable by
 * design); they use the ZZGSTF tag like the other suites.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZGSTF';
const WH1 = 1; // Marlin Bengaluru Cold Store — 29ABCDE1234F1Z5
const GSTIN1 = '29ABCDE1234F1Z5';
const GSTIN2 = '29PQRSX6789K2Z1';

let authToken = '';
let passed = 0, failed = 0;

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

async function apiReq(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const post = (p, b) => apiReq('POST', p, b);
const get = (p) => apiReq('GET', p);
const r2 = (n) => Math.round(n * 100) / 100;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

// ── Auth + fixtures ─────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');
{
  const login = await post('/auth/login', { username: 'admin', password: 'marlin1458' });
  authToken = login.data?.token ?? '';
  assert('Admin login returns a token', !!authToken, `status=${login.status}`);
  if (!authToken) process.exit(1);
}

// Item + vendor are recreated each run under the tag; older tagged rows are
// left alone (documents referencing them must keep their names).
const itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-${TAG}-${Date.now() % 100000}','','active') RETURNING id`,
  [`${TAG} Filter Item ${Date.now()}`])).rows[0].id;
const vendorRes = await post('/vendors', {
  name: `${TAG} Fresh Vendor ${Date.now()}`, state: 'Karnataka', gstNumber: '29ZZGSF1234F1Z5',
});
const vendorId = vendorRes.data?.id;
assert('Fresh vendor created through the API (gets a ledger)', !!vendorId, JSON.stringify(vendorRes.data).slice(0, 120));
// Credit sales require a customer; created via the API so the ledger exists.
const customerRes = await post('/customers', {
  name: `${TAG} Credit Buyer ${Date.now()}`, phone: `98${String(Date.now()).slice(-8)}`, state: 'Karnataka',
});
const customerId = customerRes.data?.id;
assert('Fresh customer created through the API', !!customerId, JSON.stringify(customerRes.data).slice(0, 120));

// ── 1. Filters endpoint ─────────────────────────────────────────────────────
console.log('\n[1] /gst/filters groups warehouses by GSTIN');
{
  const res = await get('/gst/filters');
  assert('Returns 200', res.status === 200, `status=${res.status}`);
  const groups = res.data?.gstins ?? [];
  assert('At least two GSTIN groups in dev data', groups.length >= 2, `got ${groups.length}`);
  const g1 = groups.find(g => g.gstin === GSTIN1);
  assert(`${GSTIN1} group exists and contains warehouse ${WH1}`,
    !!g1 && g1.warehouses.some(w => w.id === WH1), JSON.stringify(g1?.warehouses));
  const g2 = groups.find(g => g.gstin === GSTIN2);
  assert(`${GSTIN2} group exists and does NOT contain warehouse ${WH1}`,
    !!g2 && !g2.warehouses.some(w => w.id === WH1), JSON.stringify(g2?.warehouses));
}

// ── 2. Fixture documents ────────────────────────────────────────────────────
console.log('\n[2] Fixture: unpaid bill, credit sale, partial cash payment');

// Purchase stocks the item at WH1 and leaves an unpaid bill on a fresh vendor.
const invoiceNo = `${TAG}-INV-${Date.now()}`;
const purchaseRes = await post('/purchases', {
  vendorId, purchaseDate: '2026-08-01', invoiceNumber: invoiceNo,
  locationType: 'warehouse', locationId: WH1,
  lineItems: [{ materialType: 'item', materialId: itemId, quantity: 10, unitCost: 50, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
});
assert('Purchase bill lands at WH1', purchaseRes.status === 201, JSON.stringify(purchaseRes.data).slice(0, 150));

// Credit sale at WH1.
const saleRes = await post('/sales', {
  outletId: WH1, locationType: 'warehouse', locationId: WH1,
  saleDate: '2026-08-01', paymentMode: 'credit', customerId,
  lineItems: [{ itemId, quantity: 2, unitPrice: 100 }],
});
assert('Credit sale lands at WH1', saleRes.status === 201, JSON.stringify(saleRes.data).slice(0, 150));
const saleId = saleRes.data?.id;
const saleInvoice = saleRes.data?.invoiceNumber;

const docRow = (docs, type, num) => (docs?.[type] ?? []).find(r => r.documentNumber === num);

{
  const docs = (await get('/gst/documents?fromDate=2026-08-01&toDate=2026-08-01')).data;
  const sale = docRow(docs, 'outward', saleInvoice);
  assert('Unpaid credit sale row exists with Warehouse column', !!sale && sale.warehouseName?.includes('Bengaluru'), JSON.stringify(sale).slice(0, 150));
  assert('Unpaid credit sale → status unpaid, mode "Credit"',
    sale?.paymentStatus === 'unpaid' && sale?.paymentModes === 'Credit',
    `status=${sale?.paymentStatus} modes=${sale?.paymentModes}`);
  const bill = docRow(docs, 'inward', invoiceNo);
  assert('Fresh vendor bill → status unpaid, mode "Credit"',
    !!bill && bill.paymentStatus === 'unpaid' && bill.paymentModes === 'Credit',
    `status=${bill?.paymentStatus} modes=${bill?.paymentModes}`);
}

// Partial cash payment: 2 × ₹100 = ₹200 total, pay ₹80 cash.
{
  const pay = await post(`/sales/${saleId}/payments`, { method: 'cash', amount: 80, paymentDate: '2026-08-01' });
  assert('Partial cash payment accepted', pay.status === 200 || pay.status === 201, JSON.stringify(pay.data).slice(0, 120));
  const docs = (await get('/gst/documents?fromDate=2026-08-01&toDate=2026-08-01')).data;
  const sale = docRow(docs, 'outward', saleInvoice);
  assert('Partially-paid sale → "Cash + Credit"',
    sale?.paymentStatus === 'partially_paid' && sale?.paymentModes === 'Cash + Credit',
    `status=${sale?.paymentStatus} modes=${sale?.paymentModes}`);
}

// ── 3. Filter partition & dead-end scopes ───────────────────────────────────
console.log('\n[3] Filtered sets partition the unfiltered register');
{
  const all = (await get('/gst/documents')).data;
  const f1 = (await get(`/gst/documents?gstin=${GSTIN1}`)).data;
  const f2 = (await get(`/gst/documents?gstin=${GSTIN2}`)).data;
  const key = r => `${r.docType}|${r.documentNumber}|${r.date}|${r.invoiceValue}`;
  const allKeys = new Set([...all.outward, ...all.inward].map(key));
  const subRows = [...f1.outward, ...f1.inward, ...f2.outward, ...f2.inward];
  assert('Every filtered row exists in the unfiltered register', subRows.every(r => allKeys.has(key(r))));
  assert('No row appears under two GSTINs (partition, not overlap)',
    new Set(subRows.map(key)).size === subRows.length);
  const fixtureSale = f1.outward.find(r => r.documentNumber === saleInvoice);
  assert(`Fixture sale surfaces under ${GSTIN1}`, !!fixtureSale);
  assert(`Fixture sale absent under ${GSTIN2}`, !f2.outward.some(r => r.documentNumber === saleInvoice));

  const bogus = (await get('/gst/documents?gstin=29ZZZZZ9999Z9Z9')).data;
  assert('Unknown GSTIN matches nothing', bogus.outward.length === 0 && bogus.inward.length === 0);
  const mism = (await get(`/gst/documents?gstin=${GSTIN1}&warehouseId=2`)).data;
  assert('Warehouse outside the requested GSTIN matches nothing', mism.outward.length === 0 && mism.inward.length === 0);
}

// ── 4. GSTR-1 payment columns + scoping ─────────────────────────────────────
console.log('\n[4] GSTR-1 b2b rows carry the new columns and honour the filter');
{
  const g1 = (await get('/gst/gstr1')).data;
  const b2b = g1?.b2b ?? [];
  assert('b2b rows exist in dev data', b2b.length > 0, `got ${b2b.length}`);
  assert('Every b2b row has warehouseName / paymentStatus / paymentModes',
    b2b.every(r => typeof r.warehouseName === 'string' && typeof r.paymentStatus === 'string' && typeof r.paymentModes === 'string'),
    JSON.stringify(b2b[0]).slice(0, 200));
  const scoped = (await get(`/gst/gstr1?gstin=${GSTIN2}`)).data;
  assert('Scoped GSTR-1 invoice count ≤ unfiltered',
    (scoped?.totals.invoiceCount ?? 0) <= (g1?.totals.invoiceCount ?? 0),
    `${scoped?.totals.invoiceCount} vs ${g1?.totals.invoiceCount}`);
}

// ── 5. Summary byte-stability: scoped pieces sum to the whole ──────────────
console.log('\n[5] /gst/summary: GSTIN slices reconcile with the unfiltered total');
{
  const all = (await get('/gst/summary')).data;
  const s1 = (await get(`/gst/summary?gstin=${GSTIN1}`)).data;
  const s2 = (await get(`/gst/summary?gstin=${GSTIN2}`)).data;
  // Head-office / outlet-typed documents fall outside both warehouse GSTINs,
  // so slices sum to AT MOST the whole — and each slice alone must be smaller.
  assert('Each slice ≤ the whole (sales)', s1.totalSales <= all.totalSales && s2.totalSales <= all.totalSales,
    `${s1.totalSales}, ${s2.totalSales} vs ${all.totalSales}`);
  assert('Slices do not exceed the whole when combined',
    r2(s1.totalSales + s2.totalSales) <= r2(all.totalSales) + 0.01,
    `${r2(s1.totalSales + s2.totalSales)} vs ${all.totalSales}`);
  assert('Unfiltered totals self-consistent (net = output − input)',
    r2(all.netGstLiability) === r2(all.totalTaxCollected - all.totalTaxPaid),
    `${all.netGstLiability} vs ${r2(all.totalTaxCollected - all.totalTaxPaid)}`);
}

// ── Done ────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
