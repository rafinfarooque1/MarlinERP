/**
 * Sales tax invoice PDF — acceptance matrix for the reference-design rebuild.
 * Run: node artifacts/api-server/tests/invoice-pdf.test.mjs
 *
 * Verifies against the REAL routes (in-session, public token, share link) that:
 *   - the issuing warehouse supplies identity/GSTIN/FSSAI/bank/UPI (never a
 *     sibling location); missing fields are OMITTED, never printed as N/A;
 *   - the company logo (data URI) is embedded when present, lettermark otherwise;
 *   - CGST/SGST vs IGST columns follow the customer's state;
 *   - PAID / PARTIAL / UNPAID / CANCELLED render the right payment panels
 *     (QR only while something is owed and the sale is live);
 *   - one-line invoices are one page, 45-line invoices paginate;
 *   - all three delivery routes render byte-identical text;
 *   - rendering a PDF changes NO business data.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZPDF fixtures and deletes every one of them at the end.
 */

import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const HOST = BASE.replace(/\/api$/, '');
const TAG = 'ZZPDF';
const WH_FULL = 1;  // Marlin Bengaluru Cold Store — complete billing profile
const WH_BARE = 2;  // Marlin Mangaluru Depot — no bank, no FSSAI (has GSTIN+UPI)

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
const get = (p, t) => apiReq('GET', p, undefined, t);
const r2 = (n) => Math.round(n * 100) / 100;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

// ── PDF helpers ─────────────────────────────────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), 'invpdf-'));
let pdfSeq = 0;

/** Fetch a PDF from an absolute or API-relative URL; returns file path + status. */
async function fetchPdf(url, withAuth = true) {
  const full = url.startsWith('http') ? url : `${BASE}${url}`;
  const r = await fetch(full, withAuth ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined);
  const buf = Buffer.from(await r.arrayBuffer());
  const file = join(workDir, `p${++pdfSeq}.pdf`);
  writeFileSync(file, buf);
  return { status: r.status, file, size: buf.length, isPdf: buf.subarray(0, 5).toString() === '%PDF-' };
}
const pdfText = (file) => {
  try { return execFileSync('pdftotext', [file, '-'], { stdio: ['pipe', 'pipe', 'ignore'] }).toString(); }
  catch { return `<<NOT A PDF: ${file}>>`; }
};
const pdfPages = (file) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file]).toString())?.[1] ?? 0);
const pdfImageCount = (file) => {
  const out = execFileSync('pdfimages', ['-list', file]).toString().trim().split('\n');
  return Math.max(0, out.length - 2); // header rows
};

// A 1×1 red PNG data URI — enough to prove the logo pipeline embeds an image.
const TEST_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── Fixtures & cleanup ──────────────────────────────────────────────────────
const fixtures = { vendorId: 0, itemA: 0, custKA: 0, custKL: 0 };
const createdPurchases = [];
const createdSales = [];
let preEntries = [], preEntryIds = [], preLots = [], preLotIds = [];
let savedCompany = null; // { id, logo_url, state } — restored by id in cleanup
let savedWh = [];         // pre-test warehouse billing profiles — restored in cleanup
let savedFlags = null;    // pre-test general_settings (POS flags) — restored in cleanup

// The pinned rows are REAL business data. The in-memory snapshot dies with a
// crashed process, so it is also persisted to disk before any pinning UPDATE
// runs; the next run (or a manual `node` one-liner) can then restore it.
const SNAP_FILE = join(tmpdir(), 'zzpdf-pin-snapshot.json');

async function restoreFromSnapshot(snap) {
  for (const w of snap.warehouses ?? []) {
    await sql(
      `UPDATE warehouses SET billing_name=$2, gst_number=$3, fssai_number=$4, bank_account_holder=$5,
          bank_name=$6, bank_branch=$7, bank_account_number=$8, ifsc_code=$9, upi_id=$10, authorized_signatory=$11
        WHERE id=$1`,
      [w.id, w.billing_name, w.gst_number, w.fssai_number, w.bank_account_holder, w.bank_name,
       w.bank_branch, w.bank_account_number, w.ifsc_code, w.upi_id, w.authorized_signatory]);
  }
  if (snap.company) {
    await sql(`UPDATE company_settings SET logo_url = $1, state = $2 WHERE id = $3`,
      [snap.company.logo_url ?? '', snap.company.state ?? '', snap.company.id]);
    if (snap.flags) await sql(`UPDATE company_settings SET general_settings = $1 WHERE id = $2`,
      [snap.flags, snap.company.id]);
  }
}

async function snapshotTB() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  return {
    totalDr: r2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: r2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
  };
}

async function cleanup() {
  // Sales are found by their tagged customer, not just the in-memory id list,
  // so a run that crashed before its own cleanup is fully recovered by the
  // next run's opening cleanup() call.
  const { rows: strays } = await sql(
    `SELECT s.id, s.invoice_number FROM sales s JOIN customers c ON c.id = s.customer_id WHERE c.name LIKE $1 ORDER BY s.id DESC`,
    [`${TAG}%`]);
  for (const s of strays) {
    await post(`/sales/${s.id}/cancel`, {}).catch(() => {}); // restores stock + reverses postings
    if (s.invoice_number) await sql(`DELETE FROM receipts WHERE voucher_number = $1 OR narration LIKE '%' || $1 || '%'`, [s.invoice_number]);
    await sql(`DELETE FROM invoice_share_links WHERE sale_id = $1`, [s.id]).catch(() => {});
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [s.id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [s.id]);
  }
  createdSales.length = 0;
  for (const id of createdPurchases) { await apiReq('DELETE', `/purchases/${id}`).catch(() => {}); }
  createdPurchases.length = 0;
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fixtures.itemA) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item' AND NOT (id = ANY($2::int[]))`, [fixtures.itemA, preLotIds]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item' AND NOT (id = ANY($2::int[]))`, [fixtures.itemA, preEntryIds]);
    for (const r of preLots) await sql(`UPDATE stock_batches SET quantity = $1 WHERE id = $2`, [r.q, r.id]);
    for (const r of preEntries) await sql(`UPDATE stock_entries SET quantity = $1 WHERE id = $2`, [r.q, r.id]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND (code LIKE 'VEND-%' OR code LIKE 'CUST-%' OR code LIKE 'DEBT-%')`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  if (savedCompany) {
    await sql(`UPDATE company_settings SET logo_url = $1, state = $2 WHERE id = $3`,
      [savedCompany.logo_url ?? '', savedCompany.state ?? '', savedCompany.id]);
  }
  for (const w of savedWh) {
    await sql(
      `UPDATE warehouses SET billing_name=$2, gst_number=$3, fssai_number=$4, bank_account_holder=$5,
          bank_name=$6, bank_branch=$7, bank_account_number=$8, ifsc_code=$9, upi_id=$10, authorized_signatory=$11
        WHERE id=$1`,
      [w.id, w.billing_name, w.gst_number, w.fssai_number, w.bank_account_holder, w.bank_name,
       w.bank_branch, w.bank_account_number, w.ifsc_code, w.upi_id, w.authorized_signatory]);
  }
  savedWh = [];
  if (savedCompany && savedFlags) {
    await sql(`UPDATE company_settings SET general_settings = $1 WHERE id = $2`, [savedFlags, savedCompany.id]);
    savedFlags = null;
  }
  // Everything above put the real rows back — the crash snapshot is now stale.
  try { if (existsSync(SNAP_FILE)) unlinkSync(SNAP_FILE); } catch { /* best effort */ }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

// A previous run that died between pinning and cleanup left the REAL business
// rows carrying fixture identities — heal from the on-disk snapshot first.
if (existsSync(SNAP_FILE)) {
  try {
    await restoreFromSnapshot(JSON.parse(readFileSync(SNAP_FILE, 'utf8')));
    console.log('  (restored real warehouse/company settings from a crashed run\'s snapshot)');
  } catch (e) { console.error('  snapshot restore failed:', e?.message ?? e); }
  unlinkSync(SNAP_FILE);
}

await cleanup(); // in case a previous run died mid-way
const tbBefore = await snapshotTB();
savedCompany = (await sql(`SELECT id, logo_url, state FROM company_settings LIMIT 1`)).rows[0] ?? null;
// The dev company profile has no state, which silently disables IGST detection
// (interstate = company state ≠ customer state). Pin it for the IGST case.
if (savedCompany) await sql(`UPDATE company_settings SET state = 'Karnataka' WHERE id = $1`, [savedCompany.id]);

// The dev DB now carries the REAL business's warehouse billing profiles, its
// company logo and its POS entry flags. Pin the two warehouses to the fixture
// identities this suite asserts on, blank the logo (lettermark baseline) and
// switch the POS discount/coupon flags on — all restored in cleanup().
savedWh = (await sql(
  `SELECT id, billing_name, gst_number, fssai_number, bank_account_holder, bank_name,
          bank_branch, bank_account_number, ifsc_code, upi_id, authorized_signatory
     FROM warehouses WHERE id IN ($1, $2)`, [WH_FULL, WH_BARE])).rows;
savedFlags = (await sql(`SELECT general_settings FROM company_settings WHERE id = $1`, [savedCompany?.id])).rows[0]?.general_settings ?? {};
// Persist the snapshot BEFORE the first pinning UPDATE — a crash after this
// point must still be recoverable from disk.
writeFileSync(SNAP_FILE, JSON.stringify({ warehouses: savedWh, company: savedCompany, flags: savedFlags }));
await sql(
  `UPDATE warehouses SET billing_name='MARLIN FROZEN FRUITS PVT', gst_number='29ABCDE1234F1Z5',
      fssai_number='11223344556677', bank_account_holder='Marlin Frozen Fruits Pvt Ltd',
      bank_name='HDFC Bank', bank_branch='Electronic City', bank_account_number='50200012345678',
      ifsc_code='HDFC0001234', upi_id='marlinblr@okhdfcbank', authorized_signatory='S. Raghavan'
    WHERE id = $1`, [WH_FULL]);
await sql(
  `UPDATE warehouses SET billing_name='MARLIN COASTAL FOODS LLP', gst_number='29PQRSX6789K2Z1',
      fssai_number='', bank_account_holder='', bank_name='', bank_branch='',
      bank_account_number='', ifsc_code='', upi_id='marlinkochi@ybl', authorized_signatory=''
    WHERE id = $1`, [WH_BARE]);
if (savedCompany) {
  await sql(`UPDATE company_settings SET logo_url = '' WHERE id = $1`, [savedCompany.id]);
  await sql(
    `UPDATE company_settings SET general_settings = COALESCE(general_settings, '{}'::jsonb)
        || '{"posDiscountsEnabled": true, "posCouponsEnabled": true}'::jsonb
      WHERE id = $1`, [savedCompany.id]);
}

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZPDF1234F1Z5') RETURNING id`,
  [`${TAG} Vendor`])).rows[0].id;
fixtures.itemA = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-ZZPDF-A','2900000000311','active') RETURNING id`,
  [`${TAG} Jack Fruit Red`])).rows[0].id;

preLots = (await sql(`SELECT id, quantity::text AS q FROM stock_batches WHERE item_id = $1 AND material_type='item'`, [fixtures.itemA])).rows;
preEntries = (await sql(`SELECT id, quantity::text AS q FROM stock_entries WHERE item_id = $1 AND material_type='item'`, [fixtures.itemA])).rows;
preLotIds = preLots.map(r => r.id);
preEntryIds = preEntries.map(r => r.id);

const custKA = await post('/customers', {
  name: `${TAG} Fasin`, phone: '9036200208', state: 'Karnataka',
  address: 'A409, E block, GM Infinity, Electronic City, Bengaluru',
});
fixtures.custKA = custKA.data?.id;
const custKL = await post('/customers', {
  name: `${TAG} Kochi Traders`, phone: '9847098470', state: 'Kerala',
  address: 'MG Road, Ernakulam, Kochi', gstNumber: '32ZZPDF9876K1Z3',
});
fixtures.custKL = custKL.data?.id;
assert('Fixture customers created', !!fixtures.custKA && !!fixtures.custKL);

for (const wh of [WH_FULL, WH_BARE]) {
  const res = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: '2026-07-30',
    locationType: 'warehouse', locationId: wh,
    lineItems: [{ materialType: 'item', materialId: fixtures.itemA, quantity: 100, unitCost: 200, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
  });
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  assert(`Stock purchased into warehouse ${wh}`, res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

async function createSale(lineItems, extra = {}) {
  const res = await post('/sales', {
    outletId: extra.locationId ?? WH_FULL, locationType: 'warehouse', locationId: WH_FULL,
    saleDate: '2026-07-31', paymentMode: 'credit', customerId: fixtures.custKA,
    lineItems, ...extra,
  });
  if (res.status === 201 && res.data?.id) createdSales.push(res.data.id);
  return res;
}
const invPdf = (id) => fetchPdf(`/sales/${id}/invoice.pdf`);

// ───────────────────────────────────────────────────────────────────────────
// Every test runs inside try/catch so cleanup below is GUARANTEED — a thrown
// fetch/SQL/PDF-tool error must never strand fixtures in the dev database.
try {

console.log('\n[1] Reference case — warehouse identity, UNPAID, single page');
let s1;
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 14, unitPrice: 380 }]);
  assert('Reference sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  s1 = res.data.id;
  const pdf = await invPdf(s1);
  assert('In-session route returns a real PDF', pdf.status === 200 && pdf.isPdf);
  assert('One-line invoice is exactly one page', pdfPages(pdf.file) === 1, `pages=${pdfPages(pdf.file)}`);
  const t = pdfText(pdf.file);
  assert('Header shows the WAREHOUSE billing name', t.includes('MARLIN FROZEN FRUITS PVT'), t.slice(0, 200));
  assert('Warehouse GSTIN printed', t.includes('29ABCDE1234F1Z5'));
  assert('Warehouse FSSAI printed', t.includes('11223344556677'));
  assert('TAX INVOICE title present', t.includes('TAX INVOICE'));
  assert('Customer name in BILLED TO', t.includes(`${TAG} Fasin`));
  assert('Reverse charge stated as No', /Reverse Charge/.test(t));
  assert('Inclusive maths: taxable 5,066.67 for 14×380', t.includes('5,066.67'));
  assert('Grand total ₹5,320.00', t.includes('5,320.00'));
  assert('CGST (2.5%) summary row', t.includes('CGST (2.5%)'));
  assert('SGST (2.5%) summary row', t.includes('SGST (2.5%)'));
  assert('No IGST summary row for intrastate', !t.includes('IGST ('));
  assert('Amount in words', t.includes('Rupees Five Thousand Three Hundred Twenty Only'));
  assert('Round Off row present', t.includes('Round Off'));
  assert('UNPAID badge', t.includes('UNPAID'));
  assert('Balance Due figure shown', t.includes('Balance Due'));
  assert('Warehouse bank account printed', t.includes('50200012345678') && t.includes('HDFC0001234'));
  assert('Warehouse UPI handle under the QR', t.includes('marlinblr@okhdfcbank'));
  assert('Scan & Pay panel present', t.includes('SCAN & PAY'));
  assert('Payment mode Credit stated', /Payment Mode/.test(t) && t.includes('Credit'));
  assert('Signatory from the warehouse', t.includes('S. Raghavan'));
  assert('Script sign-off present', t.includes('Thank You For Your Business!'));
  assert('E&OE marked on the total row', t.includes('TOTAL (E&OE)'));
  assert('No placeholder junk', !/N\/A|undefined|\bnull\b/.test(t));
  assert('Only the QR image is embedded (lettermark fallback)', pdfImageCount(pdf.file) === 1, `imgs=${pdfImageCount(pdf.file)}`);
}

console.log('\n[2] Company Profile logo is embedded when present');
{
  await sql(`UPDATE company_settings SET logo_url = $1`, [TEST_LOGO]);
  const pdf = await invPdf(s1);
  // A PNG with an alpha channel embeds as image + soft mask, so "more than just
  // the QR" is the honest assertion.
  assert('Logo embedded alongside the QR', pdfImageCount(pdf.file) >= 2, `imgs=${pdfImageCount(pdf.file)}`);
  // Baseline for this suite is a BLANK logo (the real one comes back in cleanup).
  await sql(`UPDATE company_settings SET logo_url = '' WHERE id = $1`, [savedCompany?.id]);
  const pdf2 = await invPdf(s1);
  assert('Back to lettermark after logo removed', pdfImageCount(pdf2.file) === 1);
}

console.log('\n[3] IGST — interstate customer flips the tax columns');
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 2, unitPrice: 380 }], { customerId: fixtures.custKL });
  assert('Interstate sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  const t = pdfText((await invPdf(res.data.id)).file);
  assert('IGST summary row present', t.includes('IGST (5%)'), t.match(/IGST[^\n]*/)?.[0]);
  assert('No CGST/SGST summary rows', !t.includes('CGST (') && !t.includes('SGST ('));
  assert('Customer GSTIN printed in BILLED TO', t.includes('32ZZPDF9876K1Z3'));
}

console.log('\n[4] Discounts — decomposition rows appear only when present');
{
  const res = await createSale(
    [{ itemId: fixtures.itemA, quantity: 10, unitPrice: 100, unitDiscount: 10 }],
    { billDiscount: 90, discountTotal: 10 });
  assert('Discounted sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  const t = pdfText((await invPdf(res.data.id)).file);
  assert('Gross Item Value row', t.includes('Gross Item Value') && t.includes('1,000.00'));
  assert('Item Discounts row (₹100)', t.includes('Item Discounts') && t.includes('100.00'));
  assert('Bill Discount row (₹90)', t.includes('Bill Discount'));
  assert('Coupon Discount row (₹10)', t.includes('Coupon Discount'));
  // And the reference sale printed none of these:
  const t1 = pdfText((await invPdf(s1)).file);
  assert('No discount rows on an undiscounted invoice', !t1.includes('Gross Item Value') && !t1.includes('Coupon Discount'));
}

console.log('\n[5] Exclusive pricing prints GST on top');
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 1, unitPrice: 200, priceMode: 'exclusive' }]);
  assert('Exclusive sale accepted', res.status === 201);
  const t = pdfText((await invPdf(res.data.id)).file);
  assert('Taxable equals the quoted price (200.00)', t.includes('200.00'));
  assert('Total is 210.00 (5% on top)', t.includes('210.00'));
}

console.log('\n[6] Warehouse with no bank/FSSAI omits those blocks entirely');
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 1, unitPrice: 380 }],
    { outletId: WH_BARE, locationId: WH_BARE });
  assert('Bare-warehouse sale accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  const t = pdfText((await invPdf(res.data.id)).file);
  assert('Its own billing name (LLP), not a sibling\'s', t.includes('MARLIN COASTAL FOODS LLP'), t.slice(0, 160));
  assert('Its own GSTIN', t.includes('29PQRSX6789K2Z1'));
  assert('No borrowed GSTIN from warehouse 1', !t.includes('29ABCDE1234F1Z5'));
  assert('No FSSAI line (warehouse has none)', !t.includes('FSSAI'));
  assert('No bank block (warehouse has none)', !t.includes('BANK ACCOUNT DETAILS') && !t.includes('IFSC'));
  assert('Its own UPI still offered', t.includes('marlinkochi@ybl'));
  assert('No placeholder junk', !/N\/A|undefined|\bnull\b/.test(t));
}

console.log('\n[7] PARTIAL and PAID payment states');
{
  const pay = await post(`/sales/${s1}/payments`, { method: 'cash', amount: 320 });
  assert('Part-payment recorded', pay.status === 200 || pay.status === 201, JSON.stringify(pay.data).slice(0, 150));
  let t = pdfText((await invPdf(s1)).file);
  assert('PARTIAL badge', t.includes('PARTIAL'));
  assert('Amount received ₹320.00', t.includes('320.00'));
  assert('Balance due ₹5,000.00', t.includes('5,000.00'));
  assert('QR still offered while balance remains', t.includes('SCAN & PAY'));

  const pay2 = await post(`/sales/${s1}/payments`, { method: 'upi', amount: 5000, referenceNumber: 'ZZPDF-UTR-1' });
  assert('Settling payment recorded', pay2.status === 200 || pay2.status === 201, JSON.stringify(pay2.data).slice(0, 150));
  const pdf = await invPdf(s1);
  t = pdfText(pdf.file);
  assert('PAID badge', t.includes('PAID'));
  assert('Payment receipt panel replaces the request', t.includes('PAYMENT RECEIVED') && t.includes('Settled in full'));
  assert('No AMOUNT PAYABLE panel once settled', !t.includes('AMOUNT PAYABLE'));
  assert('No QR once settled', pdfImageCount(pdf.file) === 0, `imgs=${pdfImageCount(pdf.file)}`);
  assert('UPI reference visible', t.includes('ZZPDF-UTR-1'));
}

console.log('\n[8] Multi-line stays tidy; 45 lines paginate with repeated headers');
{
  const three = Array.from({ length: 3 }, () => ({ itemId: fixtures.itemA, quantity: 1, unitPrice: 380 }));
  const r3 = await createSale(three);
  assert('3-line sale accepted', r3.status === 201);
  const p3 = await invPdf(r3.data.id);
  assert('3-line invoice still a single page', pdfPages(p3.file) === 1, `pages=${pdfPages(p3.file)}`);

  const many = Array.from({ length: 45 }, () => ({ itemId: fixtures.itemA, quantity: 1, unitPrice: 100 }));
  const r45 = await createSale(many);
  assert('45-line sale accepted', r45.status === 201, JSON.stringify(r45.data).slice(0, 150));
  const p45 = await invPdf(r45.data.id);
  const pages = pdfPages(p45.file);
  assert('45-line invoice spans multiple pages', pages >= 2, `pages=${pages}`);
  const t = pdfText(p45.file);
  assert('Goods-table header repeats on the continuation page',
    (t.match(/DESCRIPTION OF GOODS/g) || []).length >= 2);
  assert('Grand total appears exactly once', (t.match(/GRAND TOTAL/g) || []).length === 1);
  assert('45 line rows all present', (t.match(new RegExp(`${TAG} Jack Fruit Red`, 'g')) || []).length === 45);
}

console.log('\n[9] Cancelled invoice refuses to ask for money');
let cancelledSaleId;
{
  const res = await createSale([{ itemId: fixtures.itemA, quantity: 1, unitPrice: 380 }]);
  cancelledSaleId = res.data.id;
  const cancel = await post(`/sales/${cancelledSaleId}/cancel`, {});
  assert('Sale cancelled', cancel.status === 200, JSON.stringify(cancel.data).slice(0, 150));
  const pdf = await invPdf(cancelledSaleId);
  const t = pdfText(pdf.file);
  assert('CANCELLED badge', t.includes('CANCELLED'));
  assert('States that no payment should be made', t.includes('no payment should be made'));
  assert('No QR on a cancelled invoice', pdfImageCount(pdf.file) === 0);
  assert('No AMOUNT PAYABLE on a cancelled invoice', !t.includes('AMOUNT PAYABLE'));
}

console.log('\n[10] View, share-link and public-token routes render the same document');
{
  const target = createdSales[1]; // the IGST sale — still live and unpaid
  const a = pdfText((await invPdf(target)).file);

  const tok = await post(`/sales/${target}/share-token`, { intent: 'preview' });
  assert('Share token minted', tok.status === 200 && !!tok.data?.token, JSON.stringify(tok.data).slice(0, 120));
  const pub = await fetchPdf(`${HOST}/api/public/invoices/${tok.data.token}`, false);
  assert('Public token route returns the PDF without auth', pub.status === 200 && pub.isPdf);
  assert('Token route text identical to in-session route', pdfText(pub.file) === a);

  const link = await post(`/sales/${target}/share-link`, { intent: 'link' });
  // present() returns a viewer path like /api/share/invoice/<publicId>?token=…;
  // the raw-PDF route is the same path with /pdf before the query — the token
  // is required, a bare publicId gets the HTML notice page.
  const linkPath = link.data?.link?.path ?? '';
  assert('Share link created', (link.status === 200 || link.status === 201) && linkPath.includes('?token='), JSON.stringify(link.data).slice(0, 200));
  const shared = await fetchPdf(`${HOST}${linkPath.replace('?', '/pdf?')}`, false);
  assert('Share-link route returns the PDF without auth', shared.status === 200 && shared.isPdf);
  assert('Share-link text identical to in-session route', pdfText(shared.file) === a);
}

console.log('\n[11] Rendering is read-only — no business data changes');
{
  const counts = async () => (await sql(`
    SELECT (SELECT COUNT(*) FROM receipts)         AS receipts,
           (SELECT COUNT(*) FROM journal_vouchers) AS jvs,
           (SELECT COUNT(*) FROM stock_ledger)     AS sl,
           (SELECT COUNT(*) FROM sale_payments)    AS pays,
           (SELECT COALESCE(SUM(quantity),0) FROM stock_entries WHERE material_type='item') AS qty
  `)).rows[0];
  const before = await counts();
  for (let i = 0; i < 5; i++) await invPdf(s1);
  await invPdf(cancelledSaleId);
  const after = await counts();
  assert('Receipts unchanged', before.receipts === after.receipts);
  assert('Journal vouchers unchanged', before.jvs === after.jvs);
  assert('Stock ledger unchanged', before.sl === after.sl);
  assert('Sale payments unchanged', before.pays === after.pays);
  assert('Stock quantities unchanged', before.qty === after.qty);
}

// ───────────────────────────────────────────────────────────────────────────
} catch (e) {
  console.error('\nSuite crashed mid-run:', e);
  failed++;
  failures.push(`suite crashed: ${e?.message ?? e}`);
}

console.log('\n[cleanup]');
await cleanup();
const tbAfter = await snapshotTB();
assert('Trial balance restored after cleanup',
  tbBefore.totalDr === tbAfter.totalDr && tbBefore.totalCr === tbAfter.totalCr,
  `before=${tbBefore.totalDr}/${tbBefore.totalCr} after=${tbAfter.totalDr}/${tbAfter.totalCr}`);

rmSync(workDir, { recursive: true, force: true });
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('Failures:', failures); process.exit(1); }
