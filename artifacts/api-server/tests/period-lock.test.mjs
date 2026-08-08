/**
 * Accounting period (month) locking — spec §7/§8/§18.
 * Run: node artifacts/api-server/tests/period-lock.test.mjs
 *
 * Rules under test:
 *   Absence of a lock row = OPEN month; locking needs confirm:true and an
 *     admin; future months can never be locked; double-lock refused.
 *   Every write family refuses a business date inside a locked month with
 *     HTTP 423, code MONTH_LOCKED and the exact spec message — create, edit
 *     (both old and new date), cancel and delete alike.
 *   A NEW payment dated in an OPEN month against a locked-month credit sale
 *     is ALLOWED (only the payment's own date is guarded).
 *   The pre-lock verification summary reports the month's totals and the
 *     locked flag; unlock demands a reason and confirm; every lock/unlock
 *     lands in the event history with actor and reason.
 *
 * Runs against the DEVELOPMENT database. Creates clearly-marked ZZPLOCK
 * fixtures in May 2023 (a month with no live business activity) and deletes
 * every one of them — including the lock rows and events — at the end.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZPLOCK';
const Y = 2023, M = 5;                    // May 2023 — the test month
const IN_MONTH = '2023-05-15';
const IN_MONTH2 = '2023-05-20';
const LOCKED_MSG = 'This month is locked. Transactions in a locked month cannot be modified. Contact an Administrator to unlock the month.';

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
const patch = (p, b, t) => apiReq('PATCH', p, b, t);
const get = (p, t) => apiReq('GET', p, undefined, t);
const del = (p, t) => apiReq('DELETE', p, undefined, t);

/** The one shape every locked-month rejection must have. */
function assert423(label, res) {
  assert(label,
    res.status === 423 && res.data?.code === 'MONTH_LOCKED' && res.data?.error === LOCKED_MSG,
    `status=${res.status} body=${JSON.stringify(res.data).slice(0, 200)}`);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

const fixtures = { vendorId: 0, itemId: 0, customerId: 0, W: 0, cashLedgerId: 0 };
const createdSales = [];      // ids — swept in reverse
const createdPurchases = [];
let backdatedJvId = 0;

async function unlockRaw() {
  await sql(`DELETE FROM accounting_period_locks WHERE year = $1 AND month = $2`, [Y, M]);
}

async function cleanup() {
  await unlockRaw(); // never leave the test month locked, whatever happened
  for (const id of createdSales.splice(0).reverse()) {
    await post(`/sales/${id}/cancel`, {}).catch(() => {});
    const { rows: [row] } = await sql(
      `SELECT invoice_number, location_type, location_id FROM sales WHERE id = $1`, [id]);
    if (row) {
      // Invoice-number strings repeat across location scopes — the location
      // guard keeps this delete off real business receipts. Never widen it.
      await sql(`DELETE FROM receipts
                  WHERE voucher_number = $1 AND location_type = $2 AND location_id = $3
                    AND (SELECT count(*) FROM sales s2
                          WHERE s2.invoice_number = $1 AND s2.id <> $4
                            AND s2.location_type = $2 AND s2.location_id = $3) = 0`,
        [row.invoice_number, row.location_type, row.location_id, id]);
    }
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [id]);
  }
  if (backdatedJvId) {
    await sql(`DELETE FROM journal_voucher_lines WHERE voucher_id = $1`, [backdatedJvId]);
    await sql(`DELETE FROM journal_vouchers WHERE id = $1`, [backdatedJvId]);
    backdatedJvId = 0;
  }
  for (const id of createdPurchases.splice(0)) { await del(`/purchases/${id}`).catch(() => {}); }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fixtures.itemId) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND (code LIKE 'VEND-%' OR code LIKE 'CUST-%')`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  // Lock/unlock audit rows for the test month are ours: the feature ships
  // with this change, so no real event can predate the suite.
  await sql(`DELETE FROM period_lock_events WHERE year = $1 AND month = $2`, [Y, M]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup();

// Derive a live warehouse rather than hardcoding one (dev DB holds real data).
const { rows: [wh] } = await sql(
  `SELECT id FROM warehouses WHERE disabled_at IS NULL ORDER BY id LIMIT 1`);
fixtures.W = wh.id;
const { rows: [cash] } = await sql(
  `SELECT cash_ledger_id AS id FROM warehouses WHERE id = $1`, [fixtures.W]);
fixtures.cashLedgerId = cash?.id ?? 0;

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state) VALUES ($1, 'Karnataka') RETURNING id`, [`${TAG} Vendor`])).rows[0].id;
fixtures.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,100,'FG-ZZPLK-01','2900000000133','active') RETURNING id`,
  [`${TAG} Item`])).rows[0].id;
const custRes = await post('/customers', { name: `${TAG} Customer`, phone: '9899000001' });
fixtures.customerId = custRes.data?.id ?? 0;
assert('Fixture customer created', custRes.status === 201 || custRes.status === 200, JSON.stringify(custRes.data).slice(0, 120));

const purRes = await post('/purchases', {
  vendorId: fixtures.vendorId, purchaseDate: new Date().toISOString().slice(0, 10),
  locationType: 'warehouse', locationId: fixtures.W,
  lineItems: [{ materialType: 'item', materialId: fixtures.itemId, quantity: 20, unitCost: 40, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
});
if (purRes.status === 201 && purRes.data?.id) createdPurchases.push(purRes.data.id);
assert('Fixture stock purchased', purRes.status === 201, JSON.stringify(purRes.data).slice(0, 150));

try {

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Backdated documents created while the month is still OPEN');

const mkSale = (extra) => post('/sales', {
  outletId: fixtures.W, locationType: 'warehouse', locationId: fixtures.W,
  saleDate: IN_MONTH, lineItems: [{ itemId: fixtures.itemId, quantity: 1, unitPrice: 100 }],
  ...extra,
});
const s1 = await mkSale({ paymentMode: 'cash' });
if (s1.data?.id) createdSales.push(s1.data.id);
assert('Backdated CASH sale accepted while month open', s1.status === 201, JSON.stringify(s1.data).slice(0, 150));
const s2 = await mkSale({ paymentMode: 'credit', customerId: fixtures.customerId });
if (s2.data?.id) createdSales.push(s2.data.id);
assert('Backdated CREDIT sale accepted while month open', s2.status === 201, JSON.stringify(s2.data).slice(0, 150));

// A journal voucher inside the month, to prove delete is refused after lock.
const { rows: ledgerPair } = await sql(
  `SELECT id FROM account_ledgers WHERE code IN ('STD-CASH','STD-BANK') ORDER BY code LIMIT 2`);
if (ledgerPair.length === 2) {
  const jv = await post('/accounts/journal-vouchers', {
    voucherType: 'journal', voucherDate: IN_MONTH, narration: `${TAG} test voucher`,
    lines: [
      { ledgerId: ledgerPair[0].id, debit: 10, credit: 0 },
      { ledgerId: ledgerPair[1].id, debit: 0, credit: 10 },
    ],
  });
  backdatedJvId = jv.data?.id ?? 0;
  assert('Backdated journal voucher accepted while month open', !!backdatedJvId, JSON.stringify(jv.data).slice(0, 150));
} else {
  assert('Backdated journal voucher accepted while month open', false, 'STD-CASH/STD-BANK ledgers not found');
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] Lock mechanics');

const noConfirm = await post(`/accounting-periods/${Y}/${M}/lock`, {});
assert('Lock without confirm:true is refused', noConfirm.status === 400, `status=${noConfirm.status}`);

const lock1 = await post(`/accounting-periods/${Y}/${M}/lock`, { confirm: true });
assert('Lock with confirm succeeds', lock1.status === 200 || lock1.status === 201, JSON.stringify(lock1.data).slice(0, 150));

const lockAgain = await post(`/accounting-periods/${Y}/${M}/lock`, { confirm: true });
assert('Locking an already-locked month is refused', lockAgain.status === 400 || lockAgain.status === 409, `status=${lockAgain.status}`);

const next = new Date(); next.setMonth(next.getMonth() + 1);
const fut = await post(`/accounting-periods/${next.getFullYear()}/${next.getMonth() + 1}/lock`, { confirm: true });
assert('A future month can never be locked', fut.status === 400, `status=${fut.status}`);

const locks = await get('/accounting-periods/locks');
assert('Locks list shows the month with actor', Array.isArray(locks.data) &&
  locks.data.some((l) => l.year === Y && l.month === M && l.lockedBy), JSON.stringify(locks.data).slice(0, 200));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] Every write family refuses a locked-month business date (423)');

assert423('New sale dated in the locked month', await mkSale({ paymentMode: 'cash', saleDate: IN_MONTH2 }));
assert423('Editing an open sale INTO the locked month', await put(`/sales/${createdSales[0]}`, {
  outletId: fixtures.W, locationType: 'warehouse', locationId: fixtures.W,
  saleDate: IN_MONTH2, paymentMode: 'cash',
  lineItems: [{ itemId: fixtures.itemId, quantity: 1, unitPrice: 100 }],
}));
assert423('Cancelling a locked-month sale', await post(`/sales/${createdSales[0]}/cancel`, {}));
assert423('New purchase dated in the locked month', await post('/purchases', {
  vendorId: fixtures.vendorId, purchaseDate: IN_MONTH2, locationType: 'warehouse', locationId: fixtures.W,
  lineItems: [{ materialType: 'item', materialId: fixtures.itemId, quantity: 1, unitCost: 40, mfgDate: '2023-04-01', expiryDate: '2027-01-01' }],
}));
assert423('New journal voucher dated in the locked month', await post('/accounts/journal-vouchers', {
  voucherType: 'journal', voucherDate: IN_MONTH2, lines: [{ ledgerId: 1, debit: 5, credit: 0 }, { ledgerId: 2, debit: 0, credit: 5 }],
}));
assert423('Deleting the locked-month journal voucher', await del(`/accounts/journal-vouchers/${backdatedJvId}`));
assert423('New payment voucher dated in the locked month', await post('/accounts/payments', {
  paymentDate: IN_MONTH2, paidFromLedgerId: 1, paidToLedgerId: 2, amount: 10,
}));
assert423('New receipt voucher dated in the locked month', await post('/accounts/receipts', {
  receiptDate: IN_MONTH2, receivedFromLedgerId: 1, receivedInLedgerId: 2, amount: 10,
}));
assert423('New expense dated in the locked month', await post('/expenses', {
  description: `${TAG} exp`, amount: 10, expenseDate: IN_MONTH2, ledgerAccountId: 1, paymentAccountId: 2, attributeTo: 'company',
}));
assert423('New stock transfer dated in the locked month', await post('/stock/transfers', {
  transferDate: IN_MONTH2, fromType: 'warehouse', fromId: fixtures.W,
  toType: 'headoffice', toId: 1,
  lineItems: [{ itemId: fixtures.itemId, materialType: 'item', materialId: fixtures.itemId, quantity: 1 }],
}));
assert423('Payroll generation for the locked month', await post('/hr/payroll/generate', { year: Y, month: M }));
assert423('Attendance correction dated in the locked month', await put('/hr/attendance', {
  employeeId: 1, date: IN_MONTH2, status: 'present',
}));
assert423('Vendor payment dated in the locked month', await post(`/vendors/${fixtures.vendorId}/payment`, {
  date: IN_MONTH2, amount: 10, cashBankLedgerId: fixtures.cashLedgerId || 1,
}));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Payments against old credit sales stay possible (the one allowed path)');

const payToday = await post(`/sales/${createdSales[1]}/payments`, {
  amount: 50, method: 'cash', paymentDate: new Date().toISOString().slice(0, 10),
});
assert('TODAY-dated payment against the locked-month credit sale is ACCEPTED',
  payToday.status === 200 || payToday.status === 201, `status=${payToday.status} ${JSON.stringify(payToday.data).slice(0, 150)}`);
const payBack = await post(`/sales/${createdSales[1]}/payments`, {
  amount: 10, method: 'cash', paymentDate: IN_MONTH2,
});
assert423('BACKDATED payment into the locked month is refused', payBack);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] Verification summary');

const summary = await get(`/accounting-periods/${Y}/${M}/summary`);
assert('Summary endpoint answers with the month flagged locked',
  summary.status === 200 && summary.data?.locked === true, JSON.stringify(summary.data).slice(0, 200));
assert('Summary counts our two backdated sales',
  Number(summary.data?.totals?.salesCount ?? 0) >= 2, `salesCount=${summary.data?.totals?.salesCount}`);
assert('Summary carries month-end balances and invoice counts',
  summary.data?.asOfMonthEnd && summary.data?.invoiceCounts &&
  Number.isFinite(Number(summary.data.totals?.sales)), JSON.stringify(summary.data).slice(0, 200));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[6] Unlock → correct → re-lock');

const noReason = await post(`/accounting-periods/${Y}/${M}/unlock`, { confirm: true });
assert('Unlock without a reason is refused', noReason.status === 400, `status=${noReason.status}`);

const unlock1 = await post(`/accounting-periods/${Y}/${M}/unlock`, { confirm: true, reason: `${TAG} correcting a test entry` });
assert('Unlock with reason succeeds', unlock1.status === 200, JSON.stringify(unlock1.data).slice(0, 150));

const cancelNow = await post(`/sales/${createdSales[0]}/cancel`, {});
assert('The correction (cancel) succeeds while unlocked', cancelNow.status === 200, `status=${cancelNow.status}`);

const relock = await post(`/accounting-periods/${Y}/${M}/lock`, { confirm: true });
assert('Month can be locked again after the correction', relock.status === 200 || relock.status === 201, `status=${relock.status}`);
assert423('And the freeze holds again (edit refused)', await put(`/sales/${createdSales[1]}`, {
  outletId: fixtures.W, locationType: 'warehouse', locationId: fixtures.W,
  saleDate: IN_MONTH, paymentMode: 'credit', customerId: fixtures.customerId,
  lineItems: [{ itemId: fixtures.itemId, quantity: 1, unitPrice: 100 }],
}));

const unlock2 = await post(`/accounting-periods/${Y}/${M}/unlock`, { confirm: true, reason: `${TAG} test teardown` });
assert('Final unlock for teardown succeeds', unlock2.status === 200, `status=${unlock2.status}`);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[7] Event history');

const events = await get('/accounting-periods/events');
const mine = (Array.isArray(events.data) ? events.data : []).filter((e) => e.year === Y && e.month === M);
assert('History holds 2 locks and 2 unlocks for the test month',
  mine.filter((e) => e.action === 'lock').length === 2 && mine.filter((e) => e.action === 'unlock').length === 2,
  JSON.stringify(mine).slice(0, 300));
assert('Unlock events carry the recorded reason',
  mine.filter((e) => e.action === 'unlock').every((e) => (e.reason ?? '').includes(TAG)));
assert('Every event names the actor', mine.every((e) => !!e.username));

} finally {
  console.log('\n[cleanup]');
  await cleanup();
  const { rows: [left] } = await sql(
    `SELECT (SELECT count(*) FROM accounting_period_locks WHERE year=$1 AND month=$2)::int AS locks,
            (SELECT count(*) FROM sales s JOIN customers c ON c.id = s.customer_id AND c.name LIKE $3)::int AS sales`,
    [Y, M, `${TAG}%`]);
  console.log(`  residue: locks=${left.locks} tagged-sales=${left.sales}`);
  await pool.end();
}

console.log(`\n${'─'.repeat(60)}\nPASSED ${passed}  FAILED ${failed}`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  ✗ ${f}`)); }
process.exit(failed ? 1 : 0);
