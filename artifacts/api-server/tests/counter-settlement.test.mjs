/**
 * Counter-settlement payment history (audit F-1) — scenario battery.
 * Run: TEST_USERNAME=... TEST_PASSWORD=... node artifacts/api-server/tests/counter-settlement.test.mjs
 *
 * Verifies the producer fix end-to-end against the dev database:
 *   1. A cash (counter-settled) sale writes EXACTLY ONE sale_payments history
 *      row — source 'counter', amount = bill total, dated the sale date.
 *   2. Editing the sale restates that row (never duplicates it).
 *   3. Converting to credit removes it — credit bills never get invented
 *      history; converting back to cash recreates it.
 *   4. Cancellation is NOT blocked by the counter row (it is till money, not a
 *      banked collection) and removes it with the bill.
 *   5. A credit sale creates no history rows at all.
 *   6. The trial balance ends exactly where it started — the history rows are
 *      display/reconciliation records, never postings.
 *
 * Self-cleaning: every sale it creates is cancelled before exit; the temp
 * customer is deleted. Safe on the live dev database.
 */

const BASE = process.env.API_URL || 'http://localhost:8080/api';
let authToken = '';
let passed = 0, failed = 0;

function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

async function apiReq(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const post = (p, b) => apiReq('POST', p, b);
const put  = (p, b) => apiReq('PUT', p, b);
const get  = (p)    => apiReq('GET', p);
const del  = (p)    => apiReq('DELETE', p);
const round2 = (n) => Math.round(n * 100) / 100;

async function snapshotTB() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  return {
    totalDr: round2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: round2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
  };
}
const legsOf = async (saleId) => (await get(`/sales/${saleId}/payments`)).data ?? [];

// ── [0] Auth ────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication');
if (!process.env.TEST_USERNAME || !process.env.TEST_PASSWORD) {
  console.error('FATAL: TEST_USERNAME / TEST_PASSWORD must be set.'); process.exit(1);
}
const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME, password: process.env.TEST_PASSWORD });
authToken = loginRes.data?.token ?? '';
assert('Login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) process.exit(1);

// ── Shared fixtures (derived, per dev-data rules) ──────────────────────────
const [itemsRes, warehousesRes] = await Promise.all([get('/items'), get('/warehouses')]);
const items = itemsRes.data ?? [];
const warehouses = warehousesRes.data ?? [];
const taxableItem = items.find(i => Number(i.taxRate) > 0);
const warehouse = warehouses[0];
if (!taxableItem || !warehouse) { console.error('FATAL: need a taxable item and a warehouse.'); process.exit(1); }
const unitPrice = Math.max(100, Number(taxableItem.mrp ?? 0));
const today = new Date().toISOString().slice(0, 10);
const saleBody = (mode, price, customerId) => ({
  outletId: warehouse.id, locationType: 'warehouse', locationId: warehouse.id,
  saleDate: today, paymentMode: mode,
  ...(customerId ? { customerId } : {}),
  lineItems: [{ itemId: taxableItem.id, quantity: 1, unitPrice: price, discount: 0, taxAmount: 0 }],
});

const tb0 = await snapshotTB();
let s1 = null, s2 = null, tempCustomerId = null;

try {
  // ── [1] Cash sale writes exactly one counter history row ────────────────
  console.log('\n[1] Cash sale → exactly one counter-settlement history row');
  const r1 = await post('/sales', saleBody('cash', unitPrice));
  assert('Cash sale created', !r1.data?.error, JSON.stringify(r1.data).slice(0, 200));
  s1 = r1.data;
  if (s1?.id) {
    const total = Number(s1.totalAmount);
    let legs = await legsOf(s1.id);
    assert('Exactly ONE payment history row', legs.length === 1, `got ${legs.length}`);
    const leg = legs[0] ?? {};
    assert("Row is source 'counter'", leg.source === 'counter', `source=${leg.source}`);
    assert('Row method is cash', leg.method === 'cash', `method=${leg.method}`);
    assert('Row amount = bill total', Math.abs(Number(leg.amount) - total) < 0.005, `amount=${leg.amount} total=${total}`);
    assert('Row dated the sale date', String(leg.paymentDate).slice(0, 10) === today, `date=${leg.paymentDate}`);
    assert('Cash needs no reconciliation (status empty)', leg.reconciliationStatus == null, `recon=${leg.reconciliationStatus}`);
    assert('Σ history = amount paid', Math.abs(legs.reduce((s, l) => s + Number(l.amount), 0) - Number(s1.amountPaid)) < 0.005);

    // ── [2] Edit (same mode, new price) restates — never duplicates ───────
    console.log('\n[2] Edit keeps ONE row, restated to the new total');
    const e1 = await put(`/sales/${s1.id}`, saleBody('cash', unitPrice + 10));
    assert('Edit accepted', !e1.data?.error, JSON.stringify(e1.data).slice(0, 200));
    const newTotal = Number(e1.data?.totalAmount ?? 0);
    legs = await legsOf(s1.id);
    assert('Still exactly ONE history row', legs.length === 1, `got ${legs.length}`);
    assert('Amount follows the edited total', Math.abs(Number(legs[0]?.amount) - newTotal) < 0.005, `amount=${legs[0]?.amount} total=${newTotal}`);

    // ── [3] Convert to credit → history removed, not invented ─────────────
    console.log('\n[3] Cash → credit conversion removes the counter row');
    const cr = await post('/customers', { name: `ZZ Counter Test ${Date.now()}`, creditLimit: 1000000 });
    tempCustomerId = cr.data?.id ?? null;
    assert('Temp customer created', !!tempCustomerId, JSON.stringify(cr.data).slice(0, 120));
    const e2 = await put(`/sales/${s1.id}`, saleBody('credit', unitPrice + 10, tempCustomerId));
    assert('Conversion accepted', !e2.data?.error, JSON.stringify(e2.data).slice(0, 200));
    legs = await legsOf(s1.id);
    assert('Credit bill has ZERO history rows', legs.length === 0, `got ${legs.length}`);
    assert('Amount paid re-derived to 0', Math.abs(Number(e2.data?.amountPaid ?? -1)) < 0.005, `amountPaid=${e2.data?.amountPaid}`);
    assert("Status is unpaid", e2.data?.paymentStatus === 'unpaid', `status=${e2.data?.paymentStatus}`);

    // ── [4] Convert back to cash → one fresh counter row ──────────────────
    console.log('\n[4] Credit → cash conversion recreates exactly one row');
    const e3 = await put(`/sales/${s1.id}`, saleBody('cash', unitPrice + 10, tempCustomerId));
    assert('Conversion accepted', !e3.data?.error, JSON.stringify(e3.data).slice(0, 200));
    legs = await legsOf(s1.id);
    assert('Exactly ONE history row again', legs.length === 1, `got ${legs.length}`);
    assert("Fresh row is source 'counter'", legs[0]?.source === 'counter', `source=${legs[0]?.source}`);
    assert('Amount = bill total', Math.abs(Number(legs[0]?.amount) - Number(e3.data?.totalAmount)) < 0.005);

    // ── [5] Cancel: counter money never blocks, row leaves with the bill ──
    console.log('\n[5] Cancellation is not blocked and leaves no orphan row');
    const c1 = await post(`/sales/${s1.id}/cancel`, {});
    assert('Paid-at-counter sale cancels cleanly', c1.status === 200, `status=${c1.status} ${JSON.stringify(c1.data).slice(0, 150)}`);
    legs = await legsOf(s1.id);
    assert('No history rows remain after cancel', legs.length === 0, `got ${legs.length}`);
    if (c1.status === 200) s1 = null;
  }

  // ── [6] Credit sale never gets invented history ──────────────────────────
  console.log('\n[6] Credit sale → zero history rows');
  if (tempCustomerId) {
    const r2 = await post('/sales', saleBody('credit', unitPrice, tempCustomerId));
    assert('Credit sale created', !r2.data?.error, JSON.stringify(r2.data).slice(0, 200));
    s2 = r2.data;
    if (s2?.id) {
      const legs2 = await legsOf(s2.id);
      assert('Zero history rows on a credit sale', legs2.length === 0, `got ${legs2.length}`);
      const c2 = await post(`/sales/${s2.id}/cancel`, {});
      assert('Credit sale cancelled (cleanup)', c2.status === 200, `status=${c2.status}`);
      if (c2.status === 200) s2 = null;
    }
  }
} finally {
  // Self-cleaning even on assertion crashes.
  if (s1?.id) await post(`/sales/${s1.id}/cancel`, {}).catch(() => {});
  if (s2?.id) await post(`/sales/${s2.id}/cancel`, {}).catch(() => {});
  if (tempCustomerId) {
    const d = await del(`/customers/${tempCustomerId}`).catch(() => null);
    if (!d || d.status >= 300) console.warn(`  (warn) temp customer ${tempCustomerId} not deleted — remove manually`);
  }
}

// ── [7] Books untouched — the history rows are never postings ──────────────
console.log('\n[7] Trial balance ends exactly where it started');
const tb1 = await snapshotTB();
assert('Total Dr unchanged', Math.abs(tb1.totalDr - tb0.totalDr) < 0.01, `before=${tb0.totalDr} after=${tb1.totalDr}`);
assert('Total Cr unchanged', Math.abs(tb1.totalCr - tb0.totalCr) < 0.01, `before=${tb0.totalCr} after=${tb1.totalCr}`);

console.log(`\n${'─'.repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
