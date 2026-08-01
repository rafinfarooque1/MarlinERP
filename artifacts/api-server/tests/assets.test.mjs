/**
 * Asset Management module — integration tests
 * Run: node artifacts/api-server/tests/assets.test.mjs
 *
 * Covers: purchase posting per payment mode (Dr STD-FIXED-ASSET / Cr
 * STD-CASH | STD-BANK | VEND-<id>), zero stock movement, GST paise math,
 * date-range filters (`from`/`to`) on the purchases, transfers and disposals
 * lists, transfer + disposal flows updating current location/status,
 * disposed-asset guards, delete-with-voucher, and RBAC denial.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZASSET fixtures and deletes every one of them at the end.
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZASSET';

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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

const fixtures = { vendorId: 0, hierNone: 0, empNone: 0 };
const createdPurchaseIds = [];

async function cleanup() {
  // Purchases first through the API where possible (removes vouchers the same
  // way a real delete would); disposed rows need direct SQL.
  for (const id of createdPurchaseIds) { await del(`/assets/purchases/${id}`).catch(() => {}); }
  const rows = (await sql(
    `SELECT ap.id, ap.journal_voucher_id FROM asset_purchases ap
     JOIN assets a ON a.id = ap.asset_id WHERE a.name LIKE $1`, [`${TAG}%`])).rows;
  for (const r of rows) {
    await sql(`DELETE FROM asset_disposals WHERE asset_purchase_id = $1`, [r.id]);
    await sql(`DELETE FROM asset_transfers WHERE asset_purchase_id = $1`, [r.id]);
    await sql(`DELETE FROM asset_purchases WHERE id = $1`, [r.id]);
    if (r.journal_voucher_id) {
      await sql(`DELETE FROM journal_voucher_lines WHERE voucher_id = $1`, [r.journal_voucher_id]);
      await sql(`DELETE FROM journal_vouchers WHERE id = $1`, [r.journal_voucher_id]);
    }
  }
  await sql(`DELETE FROM assets WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM employees WHERE username LIKE $1`, [`${TAG.toLowerCase()}%`]);
  await sql(`DELETE FROM permissions WHERE hierarchy_id IN (SELECT id FROM hierarchies WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM hierarchies WHERE name LIKE $1`, [`${TAG}%`]);
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

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZASS1234F1Z5') RETURNING id`,
  [`${TAG} Asset Vendor`])).rows[0].id;
// Provision the payable ledger exactly as the vendor API does on save — the
// assets route (like receipts in customers.ts) requires VEND-<id> to exist.
await sql(
  `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
   SELECT $1, 'liability', $2, 'balance_sheet', (SELECT id FROM account_ledgers WHERE code = 'SYS-CREDITORS'), false, $3
   WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
  [`${TAG} Asset Vendor`, `VEND-${fixtures.vendorId}`, `Vendor ledger — ${TAG} Asset Vendor`]);

// A hierarchy with NO asset rights, and an employee inside it (RBAC negative).
fixtures.hierNone = (await sql(
  `INSERT INTO hierarchies (name, level, description) VALUES ($1, 5, 'disposable test fixture') RETURNING id`,
  [`${TAG} NoRights`])).rows[0].id;
const hash = bcrypt.hashSync('ZzAsset#1', 10);
fixtures.empNone = (await sql(
  `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, is_active, must_change_password, join_date)
   VALUES ($1, $2, $3, $4, 'headoffice', 1, true, false, CURRENT_DATE) RETURNING id`,
  [`${TAG} NoRights`, `${TAG.toLowerCase()}_norights`, hash, fixtures.hierNone])).rows[0].id;

const catId = (await sql(`SELECT id FROM asset_categories WHERE name = 'Computer'`)).rows[0]?.id;
assert('Seeded Computer category exists', !!catId);

const stockBaseline = Number((await sql(`SELECT count(*) c FROM stock_entries`)).rows[0].c);
const ledgerBaseline = Number((await sql(`SELECT count(*) c FROM stock_ledger`)).rows[0].c);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Purchase posting per payment mode + GST paise math');

async function voucherLines(purchaseId) {
  return (await sql(
    `SELECT al.code, jl.debit::numeric AS debit, jl.credit::numeric AS credit, jv.source_module
     FROM asset_purchases ap
     JOIN journal_vouchers jv ON jv.id = ap.journal_voucher_id
     JOIN journal_voucher_lines jl ON jl.voucher_id = jv.id
     JOIN account_ledgers al ON al.id = jl.ledger_id
     WHERE ap.id = $1 ORDER BY jl.debit DESC`, [purchaseId])).rows;
}

// Odd-paise GST case: 2 × 1355.55 = 2711.10 → 18% = 487.998 → 488.00
const cash = await post('/assets/purchases', {
  assetName: `${TAG} Laptop`, categoryId: catId, purchaseDate: '2026-07-10',
  invoiceNumber: 'ZZA-1', locationType: 'headoffice', locationId: 1,
  quantity: 2, acquisitionCost: 1355.55, gstRate: 18, paymentMode: 'cash',
});
assert('Cash purchase created (201)', cash.status === 201, `status=${cash.status} ${JSON.stringify(cash.data).slice(0, 200)}`);
if (cash.data?.id) createdPurchaseIds.push(cash.data.id);
assert('GST amount uses one rounding step (488.00)', Number(cash.data?.gstAmount) === 488);
assert('Total = taxable + GST (3199.10)', Number(cash.data?.totalCost) === 3199.10);
let lines = await voucherLines(cash.data.id);
assert('Cash: Dr STD-FIXED-ASSET for total', lines[0]?.code === 'STD-FIXED-ASSET' && Number(lines[0]?.debit) === 3199.10);
assert('Cash: Cr STD-CASH for total', lines[1]?.code === 'STD-CASH' && Number(lines[1]?.credit) === 3199.10);
assert('Voucher source_module = fixed_asset', lines[0]?.source_module === 'fixed_asset');

const bank = await post('/assets/purchases', {
  assetName: `${TAG} Printer`, categoryId: catId, purchaseDate: '2026-07-20',
  locationType: 'headoffice', locationId: 1,
  quantity: 1, acquisitionCost: 8000, gstRate: 18, paymentMode: 'bank',
});
assert('Bank purchase created', bank.status === 201);
if (bank.data?.id) createdPurchaseIds.push(bank.data.id);
lines = await voucherLines(bank.data.id);
assert('Bank: Cr STD-BANK', lines[1]?.code === 'STD-BANK' && Number(lines[1]?.credit) === 9440);

const credit = await post('/assets/purchases', {
  assetName: `${TAG} Freezer`, categoryId: catId, purchaseDate: '2026-07-30',
  locationType: 'headoffice', locationId: 1, vendorId: fixtures.vendorId,
  quantity: 1, acquisitionCost: 25000, gstRate: 18, paymentMode: 'credit',
});
assert('Credit purchase created', credit.status === 201);
if (credit.data?.id) createdPurchaseIds.push(credit.data.id);
lines = await voucherLines(credit.data.id);
assert('Credit: Cr vendor ledger', lines[1]?.code === `VEND-${fixtures.vendorId}` && Number(lines[1]?.credit) === 29500);

const noVendor = await post('/assets/purchases', {
  assetName: `${TAG} Bad`, categoryId: catId, purchaseDate: '2026-07-30',
  locationType: 'headoffice', locationId: 1,
  quantity: 1, acquisitionCost: 100, paymentMode: 'credit',
});
assert('Credit without vendor rejected (400)', noVendor.status === 400);

assert('Zero stock_entries created', Number((await sql(`SELECT count(*) c FROM stock_entries`)).rows[0].c) === stockBaseline);
assert('Zero stock_ledger rows created', Number((await sql(`SELECT count(*) c FROM stock_ledger`)).rows[0].c) === ledgerBaseline);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] Date-range filters (from/to) on the purchases list');

const mine = (res) => (res.data ?? []).filter(a => String(a.assetName).startsWith(TAG));

let res = await get(`/assets/purchases?locationBasis=purchase&from=2026-07-15&to=2026-07-25`);
assert('purchases from/to window returns only the bank purchase',
  mine(res).length === 1 && mine(res)[0].id === bank.data.id,
  `got ${mine(res).map(a => a.assetName).join(',')}`);
res = await get(`/assets/purchases?locationBasis=purchase&from=2026-07-01`);
assert('purchases open-ended from returns all three', mine(res).length === 3);
res = await get(`/assets/purchases?locationBasis=purchase&to=2026-07-11`);
assert('purchases open-ended to returns only the cash purchase',
  mine(res).length === 1 && mine(res)[0].id === cash.data.id);
res = await get(`/assets/purchases?from=bogus`);
assert('malformed date rejected (400)', res.status === 400);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] Transfer flow + date filter');

const whId = (await sql(`SELECT id FROM warehouses ORDER BY id LIMIT 1`)).rows[0].id;
const tr = await post('/assets/transfers', {
  assetPurchaseId: cash.data.id, toType: 'warehouse', toId: whId,
  transferDate: '2026-07-12', approvedBy: 'ZZ Tester', reason: 'test move',
});
assert('Transfer created', tr.status === 201, `status=${tr.status} ${JSON.stringify(tr.data).slice(0, 150)}`);
res = await get(`/assets/purchases?locationBasis=current&q=${TAG}%20Laptop`);
const moved = mine(res)[0];
assert('Asset current location updated', moved?.currentLocationType === 'warehouse' && Number(moved?.currentLocationId) === Number(whId));

res = await get(`/assets/transfers?from=2026-07-12&to=2026-07-12`);
assert('transfers date window includes the row', (res.data ?? []).some(t => t.id === tr.data.id));
res = await get(`/assets/transfers?from=2026-07-13`);
assert('transfers window after the date excludes the row', !(res.data ?? []).some(t => t.id === tr.data.id));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Disposal flow + date filter + guards');

const disp = await post('/assets/disposals', {
  assetPurchaseId: bank.data.id, disposalType: 'scrapped', disposalDate: '2026-07-22', reason: 'test scrap',
});
assert('Disposal created', disp.status === 201);
res = await get(`/assets/purchases?q=${TAG}%20Printer`);
assert('Asset status = scrapped', mine(res)[0]?.status === 'scrapped');

res = await get(`/assets/disposals?from=2026-07-22&to=2026-07-22`);
assert('disposals date window includes the row', (res.data ?? []).some(d => d.id === disp.data.id));
res = await get(`/assets/disposals?to=2026-07-21`);
assert('disposals window before the date excludes the row', !(res.data ?? []).some(d => d.id === disp.data.id));

const trDisposed = await post('/assets/transfers', {
  assetPurchaseId: bank.data.id, toType: 'warehouse', toId: whId, transferDate: '2026-07-23',
});
assert('Transfer of a disposed asset rejected (400)', trDisposed.status === 400);
const delDisposed = await del(`/assets/purchases/${bank.data.id}`);
assert('Delete of a disposed asset rejected (400)', delDisposed.status === 400);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] Delete removes the voucher');

const jvCash = (await sql(`SELECT journal_voucher_id j FROM asset_purchases WHERE id = $1`, [cash.data.id])).rows[0].j;
const delCash = await del(`/assets/purchases/${cash.data.id}`);
assert('Delete active purchase succeeds', delCash.status === 204 || delCash.status === 200);
assert('Voucher removed with it', Number((await sql(`SELECT count(*) c FROM journal_vouchers WHERE id = $1`, [jvCash])).rows[0].c) === 0);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[6] RBAC: role without asset rights is denied');

const badLogin = await post('/auth/login', { username: `${TAG.toLowerCase()}_norights`, password: 'ZzAsset#1' });
const badToken = badLogin.data?.token ?? '';
assert('Fixture user can log in', !!badToken);
for (const p of ['/assets/purchases', '/assets/categories', '/assets/transfers', '/assets/disposals', '/assets/summary']) {
  const r = await get(p, badToken);
  assert(`GET ${p} → 403`, r.status === 403, `status=${r.status}`);
}
const badPost = await post('/assets/purchases', {
  assetName: 'X', categoryId: catId, purchaseDate: '2026-07-01',
  locationType: 'headoffice', locationId: 1, quantity: 1, acquisitionCost: 10, paymentMode: 'cash',
}, badToken);
assert('POST /assets/purchases → 403', badPost.status === 403);

// ───────────────────────────────────────────────────────────────────────────
await cleanup();
await pool.end();

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
