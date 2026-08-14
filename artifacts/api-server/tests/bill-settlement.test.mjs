/**
 * Bill-wise settlement, party advances & auto outstanding adjustment.
 * Run: node artifacts/api-server/tests/bill-settlement.test.mjs
 *
 * Rules under test:
 *   A receipt/payment carrying `allocations` settles those exact bills; any
 *     excess (`advanceAmount`) stays as a CREDIT balance on the customer's own
 *     ledger (single-ledger model — no CADV), or parks on the vendor's
 *     VADV-<id> asset ledger.
 *   Customer "available advance" = max(0, −net(CUST ledger)) — it nets
 *     against everything the customer still owes, by design.
 *   Allocations must never exceed the voucher amount, a bill's balance due,
 *     or target a cancelled sale.
 *   A sale/purchase created with `useAdvance:true` auto-adjusts the party's
 *     available advance, capped at min(available, bill total).
 *   Settlement vouchers are locked for edit; deletable with a full unwind —
 *     refused 409 once the advance slice has been consumed by a later bill.
 *   Purchase bills with allocations refuse deletion (BILL_HAS_ALLOCATIONS).
 *   The ageing reports expose each party's advance; the Trial Balance stays
 *     balanced throughout and returns to baseline after cleanup.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZBSET fixtures and deletes every one of them at the end.
 */
import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZBSET';
const WH = 2; // Marlin Mangaluru Depot — same warehouse the other suites use

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}
const near = (a, b, eps = 0.011) => Math.abs(Number(a) - Number(b)) < eps;
const r2 = (n) => Math.round(Number(n ?? 0) * 100) / 100;

async function apiReq(method, path, body, token = authToken) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

async function snapshotTB() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  return {
    totalDr: r2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: r2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
    balanced: res.data?.balanced ?? true,
  };
}
async function saleRow(id) {
  const { rows } = await sql(
    `SELECT invoice_number, amount_paid::numeric AS paid, payment_status, total_amount::numeric AS total, cancelled_at
       FROM sales WHERE id = $1`, [id]);
  return rows[0];
}
const advance = async (kind, partyId) =>
  (await get(`/accounts/party-advance?kind=${kind}&partyId=${partyId}`)).data;

// ── Fixtures ─────────────────────────────────────────────────────────────────
const fx = { custId: 0, custLedger: 0, vendStockId: 0, vendPayId: 0, vendLedger: 0, itemId: 0 };
const made = { sales: [], purchases: [], receipts: [], payments: [] };
let preLotIds = [], preEntryIds = [];

async function cleanup() {
  // API-first (unwinds allocations properly), SQL as the backstop.
  for (const id of made.receipts) await del(`/accounts/receipts/${id}`).catch(() => {});
  for (const id of made.payments) await del(`/accounts/payments/${id}`).catch(() => {});
  for (const id of made.sales.slice().reverse()) {
    await post(`/sales/${id}/cancel`, {}).catch(() => {});
    const row = await saleRow(id).catch(() => null);
    if (row) await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [row.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [id]);
  }
  made.sales.length = 0;
  for (const id of made.purchases) await del(`/purchases/${id}`).catch(() => {});
  made.purchases.length = 0;

  // SQL purge of anything the API deletes refused (consumed advances etc.)
  await sql(`DELETE FROM advance_consumptions WHERE (party_kind = 'customer' AND party_id IN (SELECT id FROM customers WHERE name LIKE $1)) OR (party_kind = 'vendor' AND party_id IN (SELECT id FROM vendors WHERE name LIKE $1))`, [`${TAG}%`]);
  await sql(`DELETE FROM sale_payments WHERE clearing_receipt_id IN (SELECT id FROM receipts WHERE source = 'allocation' AND received_from_ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1))`, [`${TAG}%`]);
  await sql(`DELETE FROM receipts WHERE received_from_ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM payment_bill_allocations WHERE payment_id IN (SELECT id FROM payments WHERE paid_to_ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1))`, [`${TAG}%`]);
  await sql(`DELETE FROM payments WHERE paid_to_ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM purchase_advance_applications WHERE purchase_id IN (SELECT id FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1))`, [`${TAG}%`]);
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  made.receipts.length = 0; made.payments.length = 0;

  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fx.itemId) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item' AND NOT (id = ANY($2::int[]))`, [fx.itemId, preLotIds]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item' AND NOT (id = ANY($2::int[]))`, [fx.itemId, preEntryIds]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  // Ledgers last — the vendor advance ledger first (child of the container),
  // then party ledgers. (Customers have no separate advance ledger.)
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'VADV-%'`, [`%${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND (code LIKE 'VEND-%' OR code LIKE 'CUST-%')`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

authToken = (await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' })).data?.token ?? '';
assert('Admin login returns a token', !!authToken);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup(); // in case a previous run died mid-way
const tb0 = await snapshotTB();
console.log(`  Baseline TB: Dr ${tb0.totalDr} / Cr ${tb0.totalCr} (balanced=${tb0.balanced})`);

// Parties via the API so their ledgers are provisioned.
{
  const c = await post('/customers', { name: `${TAG} Advance Customer`, phone: '9111100001', state: 'Karnataka' });
  fx.custId = c.data?.id;
  assert('Fixture customer created', c.status === 201 && !!fx.custId, `status ${c.status}`);
  const v1 = await post('/vendors', { name: `${TAG} Stock Vendor`, phone: '9111100002', state: 'Karnataka' });
  fx.vendStockId = v1.data?.id;
  const v2 = await post('/vendors', { name: `${TAG} Pay Vendor`, phone: '9111100003', state: 'Karnataka' });
  fx.vendPayId = v2.data?.id;
  assert('Fixture vendors created', !!fx.vendStockId && !!fx.vendPayId);
  fx.custLedger = Number((await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`CUST-${fx.custId}`])).rows[0]?.id);
  fx.vendLedger = Number((await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`VEND-${fx.vendPayId}`])).rows[0]?.id);
  assert('Party ledgers provisioned', fx.custLedger > 0 && fx.vendLedger > 0);
}

// Zero-GST item so every total is an exact round number.
fx.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',0,100,'FG-ZZBSET-A','2900000000311','active') RETURNING id`,
  [`${TAG} Settle Item`])).rows[0].id;
preLotIds = (await sql(`SELECT id FROM stock_batches WHERE item_id = $1 AND material_type='item'`, [fx.itemId])).rows.map(r => r.id);
preEntryIds = (await sql(`SELECT id FROM stock_entries WHERE item_id = $1 AND material_type='item'`, [fx.itemId])).rows.map(r => r.id);

// Stock for the sales, from the stock vendor (kept out of the settlement tests).
{
  const res = await post('/purchases', {
    vendorId: fx.vendStockId, purchaseDate: '2026-07-01', vendorInvoiceDate: '2026-06-30', locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId: fx.itemId, quantity: 100, unitCost: 40, mfgDate: '2026-06-01', expiryDate: '2027-06-01' }],
  });
  if (res.status === 201) made.purchases.push(res.data.id);
  assert('Stock purchase lands', res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

const cashLeaf = Number((await sql(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH'`)).rows[0].id);

const mkSale = async (qty, extra = {}) => {
  const res = await post('/sales', {
    outletId: WH, locationType: 'warehouse', locationId: WH,
    saleDate: extra.saleDate ?? '2026-08-01', paymentMode: 'credit', customerId: fx.custId,
    lineItems: [{ itemId: fx.itemId, quantity: qty, unitPrice: 100 }], ...extra,
  });
  if (res.status === 201 && res.data?.id) made.sales.push(res.data.id);
  return res;
};
const mkBill = async (qty, unitCost, extra = {}) => {
  const res = await post('/purchases', {
    vendorId: fx.vendPayId, purchaseDate: extra.purchaseDate ?? '2026-08-01',
    vendorInvoiceDate: extra.purchaseDate ?? '2026-08-01',
    locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId: fx.itemId, quantity: qty, unitCost, mfgDate: '2026-06-01', expiryDate: '2027-06-01' }],
    ...extra,
  });
  if (res.status === 201 && res.data?.id) made.purchases.push(res.data.id);
  return res;
};

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[A] Customer: settlement context lists open bills oldest-first');
let S1, S2;
{
  S1 = (await mkSale(5, { saleDate: '2026-07-20' })).data; // ₹500
  S2 = (await mkSale(3, { saleDate: '2026-07-25' })).data; // ₹300
  assert('Two credit sales created (₹500 + ₹300)', !!S1?.id && !!S2?.id && near(S1.totalAmount ?? 500, 500));

  const ctx = (await get(`/accounts/settlement-context?ledgerId=${fx.custLedger}`)).data;
  assert('Context kind = customer', ctx.kind === 'customer' && ctx.partyId === fx.custId, JSON.stringify(ctx).slice(0, 120));
  const b = (ctx.bills ?? []).filter(x => [S1.id, S2.id].includes(x.saleId));
  assert('Both open bills listed with full dues', b.length === 2 && near(b[0].due, 500) && near(b[1].due, 300),
    JSON.stringify(b));
  assert('Oldest bill first', b[0]?.saleId === S1.id);
  assert('No advance yet', near(ctx.advance?.available, 0));

  const nonParty = (await get(`/accounts/settlement-context?ledgerId=${cashLeaf}`)).data;
  assert('Non-party ledger → empty context', nonParty.kind === null && (nonParty.bills ?? []).length === 0);
}

console.log('\n[B] Receipt with a full allocation settles the bill exactly');
let R1;
{
  const res = await post('/accounts/receipts', {
    receiptDate: '2026-08-01', receivedInLedgerId: cashLeaf, receivedFromLedgerId: fx.custLedger,
    amount: 500, allocations: [{ saleId: S1.id, amount: 500 }],
  });
  R1 = res.data;
  if (res.status === 201) made.receipts.push(R1.id);
  assert('Allocation receipt accepted', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  assert('Response echoes the allocation', near(R1?.allocations?.[0]?.amount, 500) && near(R1?.advanceAmount, 0));

  const row = await saleRow(S1.id);
  assert('S1 fully paid', near(row.paid, 500) && row.payment_status === 'paid', `paid=${row.paid} status=${row.payment_status}`);
  const { rows: sp } = await sql(`SELECT amount::numeric AS amount FROM sale_payments WHERE sale_id = $1 AND clearing_receipt_id = $2`, [S1.id, R1.id]);
  assert('sale_payments row linked to the receipt', sp.length === 1 && near(sp[0].amount, 500));

  const list = (await get('/accounts/receipts')).data ?? [];
  const mine = list.find(r => r.id === R1.id);
  assert('Receipt listed as system-locked (origin=system, not editable)',
    !!mine && mine.origin === 'system' && mine.editable === false, JSON.stringify(mine ?? {}).slice(0, 150));
}

console.log('\n[C] Refusals: over-allocation, over-bill, cancelled sale');
{
  const over = await post('/accounts/receipts', {
    receiptDate: '2026-08-01', receivedInLedgerId: cashLeaf, receivedFromLedgerId: fx.custLedger,
    amount: 100, allocations: [{ saleId: S2.id, amount: 200 }],
  });
  assert('Allocations > voucher amount → 400', over.status === 400, `status ${over.status}`);

  const overBill = await post('/accounts/receipts', {
    receiptDate: '2026-08-01', receivedInLedgerId: cashLeaf, receivedFromLedgerId: fx.custLedger,
    amount: 400, allocations: [{ saleId: S2.id, amount: 400 }],
  });
  assert('Allocation > bill due → 400', overBill.status === 400, `status ${overBill.status}`);
}

console.log('\n[D] Overpay parks the excess as a customer advance');
let R2;
{
  const res = await post('/accounts/receipts', {
    receiptDate: '2026-08-02', receivedInLedgerId: cashLeaf, receivedFromLedgerId: fx.custLedger,
    amount: 400, allocations: [{ saleId: S2.id, amount: 300 }], advanceAmount: 100,
  });
  R2 = res.data;
  if (res.status === 201) made.receipts.push(R2.id);
  assert('Overpay receipt accepted (300 to bill + 100 to advance)', res.status === 201, JSON.stringify(res.data).slice(0, 200));

  const adv = await advance('customer', fx.custId);
  assert('party-advance shows ₹100 available', near(adv?.available, 100), JSON.stringify(adv));
  // Single-ledger model: the excess lives as a credit balance on the
  // customer's OWN ledger — no CADV ledger may ever be provisioned.
  const { rows: [cadv] } = await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`CADV-${fx.custId}`]);
  assert('No separate CADV ledger exists', !cadv, JSON.stringify(cadv ?? {}));
  const tbRows = (await get('/accounts/trial-balance')).data?.rows ?? [];
  const custRow = tbRows.find(r => Number(r.ledgerId) === fx.custLedger);
  assert('Customer ledger stands at ₹100 Cr on the Trial Balance',
    !!custRow && near(custRow.credit, 100) && near(custRow.debit, 0), JSON.stringify(custRow ?? {}));

  const recv = (await get('/outstanding/receivables')).data;
  const rc = (recv?.customers ?? []).find(c => c.customerId === fx.custId);
  assert('Receivables report shows the advance', !!rc && near(rc.advance, 100), JSON.stringify({ adv: rc?.advance }));

  const ctx = (await get(`/accounts/settlement-context?ledgerId=${fx.custLedger}`)).data;
  assert('S2 no longer listed (settled)', !(ctx.bills ?? []).some(b => b.saleId === S2.id));

  const tb = await snapshotTB();
  assert('Trial Balance still balanced', tb.balanced && near(tb.totalDr, tb.totalCr, 0.05));
}

console.log('\n[E] A credit sale with useAdvance consumes the advance');
let S3;
{
  const res = await mkSale(2, { useAdvance: true }); // ₹200, advance covers 100
  S3 = res.data;
  assert('Sale accepted with advanceApplied = 100', res.status === 201 && near(S3?.advanceApplied, 100),
    JSON.stringify(res.data).slice(0, 200));
  const row = await saleRow(S3.id);
  assert('S3 shows ₹100 paid / partially_paid', near(row.paid, 100) && row.payment_status === 'partially_paid', `paid=${row.paid} status=${row.payment_status}`);
  const adv = await advance('customer', fx.custId);
  assert('Advance fully consumed', near(adv?.available, 0), JSON.stringify(adv));
}

console.log('\n[F] Deleting a settlement receipt: consumed advance refuses, clean one unwinds');
{
  const refuse = await del(`/accounts/receipts/${R2.id}`);
  assert('Delete of R2 refused 409 (advance already adjusted)', refuse.status === 409, `status ${refuse.status}`);

  const ok = await del(`/accounts/receipts/${R1.id}`);
  assert('Delete of R1 succeeds', ok.status === 204, `status ${ok.status}`);
  made.receipts = made.receipts.filter(id => id !== R1.id);
  const row = await saleRow(S1.id);
  assert('S1 dues restored to ₹500', near(row.paid, 0) && row.payment_status !== 'paid', `paid=${row.paid}`);
  const { rows: sp } = await sql(`SELECT 1 FROM sale_payments WHERE clearing_receipt_id = $1`, [R1.id]);
  assert('Linked sale_payments rows removed', sp.length === 0);
}

console.log('\n[G] Cancelled sale refuses settlement');
{
  const c = await post(`/sales/${S1.id}/cancel`, {});
  assert('S1 cancelled', c.status === 200 || c.status === 201 || c.status === 204, `status ${c.status}`);
  const res = await post('/accounts/receipts', {
    receiptDate: '2026-08-02', receivedInLedgerId: cashLeaf, receivedFromLedgerId: fx.custLedger,
    amount: 100, allocations: [{ saleId: S1.id, amount: 100 }],
  });
  assert('Allocation against a cancelled sale → 409 SALE_CANCELLED',
    res.status === 409 && res.data?.code === 'SALE_CANCELLED', `status ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[H] Vendor: payment with allocations + advance');
let P1, P2, PY1;
{
  P1 = (await mkBill(6, 50, { purchaseDate: '2026-07-22' })).data;  // ₹300
  P2 = (await mkBill(4, 50, { purchaseDate: '2026-07-28' })).data;  // ₹200
  assert('Two vendor bills created (₹300 + ₹200)', !!P1?.id && !!P2?.id);

  const ctx = (await get(`/accounts/settlement-context?ledgerId=${fx.vendLedger}`)).data;
  const b = (ctx.bills ?? []).filter(x => [P1.id, P2.id].includes(x.purchaseId));
  assert('Context kind = vendor, both bills open', ctx.kind === 'vendor' && b.length === 2 && near(b[0].due, 300) && near(b[1].due, 200), JSON.stringify(b));

  const res = await post('/accounts/payments', {
    paymentDate: '2026-08-02', paidFromLedgerId: cashLeaf, paidToLedgerId: fx.vendLedger,
    amount: 600, allocations: [{ purchaseId: P1.id, amount: 300 }, { purchaseId: P2.id, amount: 200 }],
    advanceAmount: 100,
  });
  PY1 = res.data;
  if (res.status === 201) made.payments.push(PY1.id);
  assert('Payment accepted (2 bills + ₹100 advance)', res.status === 201, JSON.stringify(res.data).slice(0, 200));

  const { rows: allocs } = await sql(`SELECT purchase_id, amount::numeric AS amount FROM payment_bill_allocations WHERE payment_id = $1 ORDER BY purchase_id`, [PY1.id]);
  assert('Two allocation rows stored', allocs.length === 2 && near(Number(allocs[0].amount) + Number(allocs[1].amount), 500));

  const adv = await advance('vendor', fx.vendPayId);
  assert('Vendor advance ₹100 available', near(adv?.available, 100), JSON.stringify(adv));
  const { rows: [vadv] } = await sql(`SELECT id, type FROM account_ledgers WHERE code = $1`, [`VADV-${fx.vendPayId}`]);
  assert('VADV ledger provisioned as asset', !!vadv && vadv.type === 'asset', JSON.stringify(vadv ?? {}));

  const pay = (await get('/outstanding/payables')).data;
  const pv = (pay?.vendors ?? []).find(v => v.vendorId === fx.vendPayId);
  const b1 = (pv?.bills ?? []).find(x => x.purchaseId === P1.id);
  assert('Payables: P1 explicitly settled to 0', !pv || !b1 || near(b1.balance, 0), JSON.stringify(b1 ?? {}));
  if (pv) assert('Payables report shows the vendor advance', near(pv.advance, 100), JSON.stringify({ adv: pv.advance }));
}

console.log('\n[I] Purchase with useAdvance consumes the vendor advance');
let P3;
{
  const res = await mkBill(3, 50, { useAdvance: true }); // ₹150, advance covers 100
  P3 = res.data;
  assert('Bill accepted with advanceApplied = 100', res.status === 201 && near(P3?.advanceApplied, 100), JSON.stringify(res.data).slice(0, 200));
  const { rows: apps } = await sql(`SELECT amount::numeric AS amount FROM purchase_advance_applications WHERE purchase_id = $1`, [P3.id]);
  assert('Application row stored', apps.length === 1 && near(apps[0].amount, 100));
  const adv = await advance('vendor', fx.vendPayId);
  assert('Vendor advance fully consumed', near(adv?.available, 0), JSON.stringify(adv));
}

console.log('\n[J] Guards: allocated bill refuses delete; consumed advance blocks voucher delete');
{
  const refuseBill = await del(`/purchases/${P1.id}`);
  assert('Delete of allocated bill → 409 BILL_HAS_ALLOCATIONS',
    refuseBill.status === 409 && refuseBill.data?.code === 'BILL_HAS_ALLOCATIONS', `status ${refuseBill.status} ${JSON.stringify(refuseBill.data).slice(0, 120)}`);

  const refusePay = await del(`/accounts/payments/${PY1.id}`);
  assert('Delete of PY1 refused 409 (advance consumed by P3)', refusePay.status === 409, `status ${refusePay.status}`);

  // Deleting P3 releases the advance again…
  const okP3 = await del(`/purchases/${P3.id}`);
  assert('Delete of P3 (advance application) succeeds', okP3.status === 200 || okP3.status === 204, `status ${okP3.status} ${JSON.stringify(okP3.data).slice(0, 120)}`);
  made.purchases = made.purchases.filter(id => id !== P3.id);
  const adv = await advance('vendor', fx.vendPayId);
  assert('Advance restored to ₹100', near(adv?.available, 100), JSON.stringify(adv));

  // …after which the settlement payment unwinds cleanly.
  const okPay = await del(`/accounts/payments/${PY1.id}`);
  assert('Delete of PY1 now succeeds (full unwind)', okPay.status === 204, `status ${okPay.status}`);
  made.payments = made.payments.filter(id => id !== PY1.id);
  const { rows: left } = await sql(`SELECT 1 FROM payment_bill_allocations WHERE payment_id = $1`, [PY1.id]);
  assert('Allocation rows removed', left.length === 0);
  const ctx = (await get(`/accounts/settlement-context?ledgerId=${fx.vendLedger}`)).data;
  const b = (ctx.bills ?? []).filter(x => [P1.id, P2.id].includes(x.purchaseId));
  assert('Both bills open again after the unwind', b.length === 2, JSON.stringify(b));
}

console.log('\n[L] Slice-precise guard: consumption pins the funding voucher (customer)');
let R3, R4, S5;
{
  // Two advance-only receipts. Distinct amounts on purpose — the double-submit
  // guard refuses same ledger + same amount within seconds.
  const r3 = await post('/accounts/receipts', {
    receiptDate: '2026-08-02', receivedInLedgerId: cashLeaf, receivedFromLedgerId: fx.custLedger,
    amount: 100, allocations: [], advanceAmount: 100,
  });
  R3 = r3.data; if (r3.status === 201) made.receipts.push(R3.id);
  const r4 = await post('/accounts/receipts', {
    receiptDate: '2026-08-03', receivedInLedgerId: cashLeaf, receivedFromLedgerId: fx.custLedger,
    amount: 120, allocations: [], advanceAmount: 120,
  });
  R4 = r4.data; if (r4.status === 201) made.receipts.push(R4.id);
  assert('Two advance-only receipts parked (₹100 + ₹120)', r3.status === 201 && r4.status === 201, `${r3.status}/${r4.status}`);
  const adv0 = await advance('customer', fx.custId);
  // ₹220 parked, but S3 still owes ₹100 — under the single-ledger model the
  // available advance is the NET credit on the customer ledger: 220 − 100.
  assert('Available advance = ₹120 (₹220 parked net of ₹100 still owed)', near(adv0?.available, 120), JSON.stringify(adv0));

  // Consume only ₹30 — FIFO must pin it to R3, the OLDEST voucher.
  const s = await mkSale(2, { useAdvance: true, advanceAmount: 30, saleDate: '2026-08-03' });
  S5 = s.data;
  assert('Sale accepted with advanceApplied = 30', s.status === 201 && near(S5?.advanceApplied, 30), JSON.stringify(s.data).slice(0, 150));
  const { rows: cons } = await sql(
    `SELECT source_receipt_id, amount::numeric AS amount FROM advance_consumptions WHERE consumer_sale_id = $1`, [S5.id]);
  assert('Consumption attributed to R3 (oldest voucher)',
    cons.length === 1 && Number(cons[0].source_receipt_id) === Number(R3.id) && near(cons[0].amount, 30), JSON.stringify(cons));

  // The pool (₹190) would cover R3's ₹100 — an aggregate check would wave the
  // delete through. The reference-based guard must still refuse.
  const refuse = await del(`/accounts/receipts/${R3.id}`);
  assert('Delete of R3 refused 409 even though the pool covers it', refuse.status === 409, `status ${refuse.status}`);
  // R4 funded nothing — deletable although it is the newer voucher.
  const ok4 = await del(`/accounts/receipts/${R4.id}`);
  assert('Delete of R4 succeeds (nothing pinned to it)', ok4.status === 204, `status ${ok4.status}`);
  made.receipts = made.receipts.filter(id => id !== R4.id);

  // Cancelling the sale returns the slice instead of blocking: the advance is
  // the customer's money still, merely parked — no cash moved at this bill.
  const c = await post(`/sales/${S5.id}/cancel`, {});
  assert('Advance-adjusted sale cancels cleanly', c.status === 200, `status ${c.status} ${JSON.stringify(c.data).slice(0, 120)}`);
  const adv1 = await advance('customer', fx.custId);
  // R3's ₹100 is back on the ledger, but S3's ₹100 due still nets it to zero
  // — the netted figure is the whole point of the single-ledger model.
  assert('Available advance back to ₹0 (R3 ₹100 restored, netted by S3 ₹100 due)', near(adv1?.available, 0), JSON.stringify(adv1));
  const { rows: spLeft } = await sql(`SELECT 1 FROM sale_payments WHERE sale_id = $1`, [S5.id]);
  const { rows: acLeft } = await sql(`SELECT 1 FROM advance_consumptions WHERE consumer_sale_id = $1`, [S5.id]);
  assert('Advance payment + attribution rows removed with the cancel', spLeft.length === 0 && acLeft.length === 0);
  const okR3 = await del(`/accounts/receipts/${R3.id}`);
  assert('Delete of R3 now succeeds', okR3.status === 204, `status ${okR3.status}`);
  made.receipts = made.receipts.filter(id => id !== R3.id);
  const tb = await snapshotTB();
  assert('Trial Balance balanced after the customer round-trip', tb.balanced && near(tb.totalDr, tb.totalCr, 0.05));
}

console.log('\n[M] Slice-precise guard: vendor mirror');
let PY2, PY3, P4;
{
  const p2 = await post('/accounts/payments', {
    paymentDate: '2026-08-02', paidFromLedgerId: cashLeaf, paidToLedgerId: fx.vendLedger,
    amount: 100, allocations: [], advanceAmount: 100,
  });
  PY2 = p2.data; if (p2.status === 201) made.payments.push(PY2.id);
  const p3 = await post('/accounts/payments', {
    paymentDate: '2026-08-03', paidFromLedgerId: cashLeaf, paidToLedgerId: fx.vendLedger,
    amount: 120, allocations: [], advanceAmount: 120,
  });
  PY3 = p3.data; if (p3.status === 201) made.payments.push(PY3.id);
  assert('Two advance-only payments parked (₹100 + ₹120)', p2.status === 201 && p3.status === 201, `${p2.status}/${p3.status}`);

  const b = await mkBill(1, 40, { useAdvance: true, advanceAmount: 40 }); // ₹40 bill
  P4 = b.data;
  assert('Bill accepted with advanceApplied = 40', b.status === 201 && near(P4?.advanceApplied, 40), JSON.stringify(b.data).slice(0, 150));
  const { rows: cons } = await sql(
    `SELECT source_payment_id, amount::numeric AS amount FROM advance_consumptions WHERE consumer_purchase_id = $1`, [P4.id]);
  assert('Consumption attributed to PY2 (oldest voucher)',
    cons.length === 1 && Number(cons[0].source_payment_id) === Number(PY2.id) && near(cons[0].amount, 40), JSON.stringify(cons));

  const refuse = await del(`/accounts/payments/${PY2.id}`);
  assert('Delete of PY2 refused 409 despite a covering pool', refuse.status === 409, `status ${refuse.status}`);
  const ok3 = await del(`/accounts/payments/${PY3.id}`);
  assert('Delete of PY3 succeeds (nothing pinned to it)', ok3.status === 204, `status ${ok3.status}`);
  made.payments = made.payments.filter(id => id !== PY3.id);

  const okP4 = await del(`/purchases/${P4.id}`);
  assert('Deleting the consuming bill releases the slice', okP4.status === 200 || okP4.status === 204, `status ${okP4.status} ${JSON.stringify(okP4.data ?? '').slice(0, 120)}`);
  made.purchases = made.purchases.filter(id => id !== P4.id);
  const { rows: acLeft } = await sql(`SELECT 1 FROM advance_consumptions WHERE consumer_purchase_id = $1`, [P4.id]);
  assert('Attribution rows removed with the bill', acLeft.length === 0);
  const okPY2 = await del(`/accounts/payments/${PY2.id}`);
  assert('Delete of PY2 now succeeds', okPY2.status === 204, `status ${okPY2.status}`);
  made.payments = made.payments.filter(id => id !== PY2.id);
  const tb = await snapshotTB();
  assert('Trial Balance balanced after the vendor round-trip', tb.balanced && near(tb.totalDr, tb.totalCr, 0.05));
}

console.log('\n[N] Books stay balanced; cleanup restores the baseline');
{
  const tb = await snapshotTB();
  assert('Trial Balance balanced before cleanup', tb.balanced && near(tb.totalDr, tb.totalCr, 0.05));
}

await cleanup();
{
  const tb1 = await snapshotTB();
  assert('Trial Balance back to baseline totals',
    near(tb1.totalDr, tb0.totalDr, 0.05) && near(tb1.totalCr, tb0.totalCr, 0.05),
    `before Dr ${tb0.totalDr}/Cr ${tb0.totalCr} — after Dr ${tb1.totalDr}/Cr ${tb1.totalCr}`);
  assert('Balanced after cleanup', tb1.balanced);
}

console.log(`\n${'─'.repeat(60)}\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('Failures:'); failures.forEach(f => console.error(` - ${f}`)); }
await pool.end();
process.exit(failed ? 1 : 0);
