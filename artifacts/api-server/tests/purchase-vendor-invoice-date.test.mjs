/**
 * Purchase entry — Vendor Invoice Date + Direct-Expense other charges
 * Run: node artifacts/api-server/tests/purchase-vendor-invoice-date.test.mjs
 *
 * Covers the Task-290 server contract:
 *  · vendor_invoice_date is REQUIRED (and must be ISO) on CREATE;
 *  · it round-trips through list / GET-by-id / DB storage;
 *  · PATCH semantics: omitted = keep, string = change (validated), null = clear;
 *  · a legacy bill without the date stays NULL through metadata edits — the
 *    server never fabricates a backfill;
 *  · other-charge NEW picks must sit under Direct Expense (SYS-DIREXP);
 *    a stored legacy (non-DIREXP expense) charge is grandfathered on edit,
 *    but adding a second non-DIREXP ledger to the same bill is refused;
 *  · trial balance is balanced throughout and returns to baseline after the
 *    test bills are deleted (books unchanged).
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZTEST fixtures and removes every one of them at the end.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZTEST';

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
const del = (p, t) => apiReq('DELETE', p, undefined, t);
const patch = (p, b, t) => apiReq('PATCH', p, b, t);
const r2 = (n) => Math.round(n * 100) / 100;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

/** Total Dr / Cr across the whole trial balance. */
async function snapshotTB() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  return {
    totalDr: r2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: r2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
    balanced: res.data?.balanced ?? true,
  };
}

const createdPurchases = [];
const fixtures = { vendorId: 0, materialId: 0, ledgerDirect: 0, ledgerLegacy: 0, ledgerLegacy2: 0 };
let WH_OK = 0;

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

async function cleanup() {
  for (const id of createdPurchases) { await del(`/purchases/${id}`).catch(() => {}); }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_batches WHERE item_id IN (SELECT id FROM materials WHERE name LIKE $1) AND material_type = 'material'`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_entries WHERE item_id IN (SELECT id FROM materials WHERE name LIKE $1) AND material_type = 'material'`, [`${TAG}%`]);
  await sql(`DELETE FROM materials WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'VEND-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  // Test charge ledgers last — the bills referencing them are gone by now.
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code IS NULL`, [`${TAG}%`]);
}
await cleanup(); // in case a previous run died mid-way

// Receiving warehouse — first live warehouse with a state and GSTIN on file.
{
  const { rows } = await sql(
    `SELECT id FROM warehouses
      WHERE COALESCE(gst_number,'') <> '' AND COALESCE(state,'') <> ''
        AND disabled_at IS NULL ORDER BY id`);
  if (!rows.length) { console.error('FATAL: no usable warehouse'); process.exit(1); }
  WH_OK = Number(rows[0].id);
}

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Kerala','32ZZTES1234F1Z5') RETURNING id`,
  [`${TAG} VID Vendor`])).rows[0].id;

fixtures.materialId = (await sql(
  `INSERT INTO materials (name, unit, hsn_code, tax_rate, item_code, barcode, status, current_stock)
   VALUES ($1,'KG','08119090',5,'RM-ZZTEST-91','2900000000091','active',0) RETURNING id`,
  [`${TAG} VID Berry`])).rows[0].id;

// Charge ledgers: one postable child under SYS-DIREXP (the only kind a new
// pick may use), and two expense ledgers OUTSIDE it (legacy-style picks).
{
  const dir = await sql(`SELECT id FROM account_ledgers WHERE code = 'SYS-DIREXP'`);
  // Legacy-style parent: an expense group outside BOTH the Direct Expense and
  // the Purchase subtrees — the only placement the OLD any-expense rule allowed.
  const indirectParent = await sql(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM account_ledgers WHERE code IN ('SYS-DIREXP','SYS-PUR')
       UNION ALL
       SELECT c.id FROM account_ledgers c JOIN sub ON c.parent_id = sub.id)
     SELECT id FROM account_ledgers
      WHERE type='expense' AND is_group = true
        AND id NOT IN (SELECT id FROM sub)
      ORDER BY id LIMIT 1`);
  if (!dir.rows.length || !indirectParent.rows.length) { console.error('FATAL: chart groups missing'); process.exit(1); }
  const mkLedger = async (name, parentId) => (await sql(
    `INSERT INTO account_ledgers (name, type, parent_id, is_group, is_active)
     VALUES ($1,'expense',$2,false,true) RETURNING id`, [name, parentId])).rows[0].id;
  fixtures.ledgerDirect = await mkLedger(`${TAG} Freight Inward`, dir.rows[0].id);
  fixtures.ledgerLegacy = await mkLedger(`${TAG} Old Misc Expense`, indirectParent.rows[0].id);
  fixtures.ledgerLegacy2 = await mkLedger(`${TAG} Old Misc Expense 2`, indirectParent.rows[0].id);
}

const line = (over = {}) => ({
  materialType: 'material', materialId: fixtures.materialId,
  quantity: 1, unitCost: 100, mfgDate: '2026-01-01', expiryDate: '2027-01-01', ...over,
});
const bill = (over = {}) => ({
  vendorId: fixtures.vendorId, purchaseDate: '2026-08-10', vendorInvoiceDate: '2026-08-08',
  locationType: 'warehouse', locationId: WH_OK, lineItems: [line()], ...over,
});
async function createBill(body, token) {
  const res = await post('/purchases', body, token);
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  return res;
}

const tbBefore = await snapshotTB();
assert('Trial balance is balanced before the test', tbBefore.balanced, `Dr=${tbBefore.totalDr} Cr=${tbBefore.totalCr}`);

// ── [1] Vendor Invoice Date required + validated on CREATE ─────────────────
console.log('\n[1] Vendor Invoice Date is mandatory and validated on create');
{
  const missing = { ...bill() };
  delete missing.vendorInvoiceDate;
  const res1 = await createBill(missing);
  assert('Create WITHOUT vendorInvoiceDate is refused (400)', res1.status === 400, `status=${res1.status} ${JSON.stringify(res1.data).slice(0, 120)}`);
  assert('…and the error names the field', /vendor invoice date/i.test(String(res1.data?.error ?? '')), JSON.stringify(res1.data).slice(0, 160));

  const res2 = await createBill(bill({ vendorInvoiceDate: '10-08-2026' }));
  assert('Create with non-ISO vendorInvoiceDate is refused (400)', res2.status === 400, `status=${res2.status}`);

  const res3 = await createBill(bill({ vendorInvoiceDate: '2026-13-45' }));
  assert('Create with an impossible calendar date is refused (400)', res3.status === 400, `status=${res3.status}`);

  const res4 = await createBill(bill({ vendorInvoiceDate: '' }));
  assert('Create with an empty-string date is refused (400)', res4.status === 400, `status=${res4.status}`);
}

// ── [2] Stored + returned everywhere ────────────────────────────────────────
console.log('\n[2] Valid date is stored and round-trips (create → DB → GET → list)');
let billA = 0;
{
  const res = await createBill(bill());
  assert('Create with a valid vendorInvoiceDate succeeds (201)', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  billA = res.data?.id ?? 0;
  assert('201 response echoes vendorInvoiceDate', res.data?.vendorInvoiceDate === '2026-08-08', `got ${res.data?.vendorInvoiceDate}`);

  const db = await sql(`SELECT vendor_invoice_date::text AS d FROM purchases WHERE id=$1`, [billA]);
  assert('DB column holds the date (DATE type, raw SQL read)', db.rows[0]?.d === '2026-08-08', `got ${db.rows[0]?.d}`);

  const back = await get(`/purchases/${billA}`);
  assert('GET by id returns vendorInvoiceDate', back.data?.vendorInvoiceDate === '2026-08-08', `got ${back.data?.vendorInvoiceDate}`);

  const list = await get(`/purchases?page=1&limit=50&q=${encodeURIComponent(TAG + ' VID Vendor')}`);
  const row = (list.data?.rows ?? []).find(r => r.id === billA);
  assert('List row carries vendorInvoiceDate (reports/exports read this)', row?.vendorInvoiceDate === '2026-08-08', `got ${row?.vendorInvoiceDate}`);
}

// ── [3] PATCH semantics: omit = keep, string = change, null = clear ────────
console.log('\n[3] Edit semantics — keep / change / clear / validate');
{
  // Metadata-only edit WITHOUT the field: date must be untouched.
  const keep = await patch(`/purchases/${billA}`, { notes: 'ZZTEST keep-date edit' });
  assert('Metadata edit without the field keeps the date', keep.status === 200 && keep.data?.vendorInvoiceDate === '2026-08-08', `status=${keep.status} got ${keep.data?.vendorInvoiceDate}`);

  // Full line-items edit WITHOUT the field: still kept (separate code path).
  const keepFull = await patch(`/purchases/${billA}`, { lineItems: [line({ quantity: 2 })] });
  assert('Line-items edit without the field keeps the date', keepFull.status === 200 && keepFull.data?.vendorInvoiceDate === '2026-08-08', `status=${keepFull.status} got ${keepFull.data?.vendorInvoiceDate}`);

  const change = await patch(`/purchases/${billA}`, { vendorInvoiceDate: '2026-08-09' });
  assert('Edit can change the date', change.status === 200 && change.data?.vendorInvoiceDate === '2026-08-09', `status=${change.status} got ${change.data?.vendorInvoiceDate}`);

  const badEdit = await patch(`/purchases/${billA}`, { vendorInvoiceDate: 'next tuesday' });
  assert('Edit with a garbage date is refused (400)', badEdit.status === 400, `status=${badEdit.status}`);

  const clear = await patch(`/purchases/${billA}`, { vendorInvoiceDate: null });
  assert('Edit can clear the date (null)', clear.status === 200 && (clear.data?.vendorInvoiceDate ?? null) === null, `status=${clear.status} got ${clear.data?.vendorInvoiceDate}`);
  const db = await sql(`SELECT vendor_invoice_date FROM purchases WHERE id=$1`, [billA]);
  assert('Cleared date is NULL in the DB', db.rows[0]?.vendor_invoice_date === null);
}

// ── [4] Legacy bills: absent stays absent ───────────────────────────────────
console.log('\n[4] Legacy bill without the date stays NULL — no fake backfill');
{
  // billA now has NULL vendor_invoice_date — exactly a legacy row.
  const meta = await patch(`/purchases/${billA}`, { notes: 'ZZTEST legacy metadata edit' });
  assert('Metadata edit on a legacy bill succeeds', meta.status === 200, `status=${meta.status}`);
  assert('…and the response reports the date as null, not a fabrication', (meta.data?.vendorInvoiceDate ?? null) === null, `got ${meta.data?.vendorInvoiceDate}`);
  const db = await sql(`SELECT vendor_invoice_date FROM purchases WHERE id=$1`, [billA]);
  assert('DB still NULL after the edit', db.rows[0]?.vendor_invoice_date === null);
}

// ── [5] Other charges: Direct Expense only for new picks ────────────────────
console.log('\n[5] Other charges — new picks must be Direct Expense; stored legacy grandfathered');
let billB = 0;
{
  const bad = await createBill(bill({ otherCharges: [{ ledgerId: fixtures.ledgerLegacy, amount: 50 }] }));
  assert('Create with a non-Direct-Expense charge ledger is refused (400)', bad.status === 400, `status=${bad.status}`);
  assert('…and the error says Direct Expense', /direct expense/i.test(String(bad.data?.error ?? '')), JSON.stringify(bad.data).slice(0, 200));

  const good = await createBill(bill({ otherCharges: [{ ledgerId: fixtures.ledgerDirect, amount: 50 }] }));
  assert('Create with a Direct Expense charge ledger succeeds (201)', good.status === 201, JSON.stringify(good.data).slice(0, 200));
  billB = good.data?.id ?? 0;

  // Simulate a HISTORICAL bill: swap the stored charge to the legacy (non-
  // DIREXP) ledger by raw SQL, the way old bills actually hold them.
  await sql(`UPDATE purchases SET other_charges = $1::jsonb WHERE id = $2`,
    [JSON.stringify([{ ledgerId: fixtures.ledgerLegacy, amount: 50 }]), billB]);

  // Re-submitting the SAME stored ledger on edit is grandfathered.
  const grandf = await patch(`/purchases/${billB}`, { otherCharges: [{ ledgerId: fixtures.ledgerLegacy, amount: 60 }] });
  assert('Edit keeping the stored legacy charge ledger is allowed (grandfathered)', grandf.status === 200, `status=${grandf.status} ${JSON.stringify(grandf.data).slice(0, 160)}`);

  // …but a NEW non-DIREXP pick on the same bill is still refused.
  const mixed = await patch(`/purchases/${billB}`, {
    otherCharges: [
      { ledgerId: fixtures.ledgerLegacy, amount: 60 },
      { ledgerId: fixtures.ledgerLegacy2, amount: 10 },
    ],
  });
  assert('Adding a NEW non-Direct-Expense ledger on edit is refused (400)', mixed.status === 400, `status=${mixed.status}`);

  // A NEW Direct Expense pick alongside the grandfathered one is fine.
  const okMix = await patch(`/purchases/${billB}`, {
    otherCharges: [
      { ledgerId: fixtures.ledgerLegacy, amount: 60 },
      { ledgerId: fixtures.ledgerDirect, amount: 15 },
    ],
  });
  assert('Grandfathered + new Direct Expense charge together are allowed', okMix.status === 200, `status=${okMix.status} ${JSON.stringify(okMix.data).slice(0, 160)}`);
  const total = Number(okMix.data?.otherChargesTotal ?? NaN);
  assert('otherChargesTotal reflects both charges (75)', r2(total) === 75, `got ${total}`);
}

// ── [6] Books unchanged after the test bills go ─────────────────────────────
console.log('\n[6] Trial balance balanced throughout; baseline restored after delete');
{
  const mid = await snapshotTB();
  assert('TB balanced with test bills in the books', mid.balanced, `Dr=${mid.totalDr} Cr=${mid.totalCr}`);

  for (const id of [...createdPurchases]) { await del(`/purchases/${id}`); }
  createdPurchases.length = 0;

  const after = await snapshotTB();
  assert('TB balanced after deleting the test bills', after.balanced, `Dr=${after.totalDr} Cr=${after.totalCr}`);
  assert('TB totals return to the pre-test baseline',
    after.totalDr === tbBefore.totalDr && after.totalCr === tbBefore.totalCr,
    `before Dr=${tbBefore.totalDr}/Cr=${tbBefore.totalCr} after Dr=${after.totalDr}/Cr=${after.totalCr}`);
}

// ───────────────────────────────────────────────────────────────────────────
await cleanup();
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
