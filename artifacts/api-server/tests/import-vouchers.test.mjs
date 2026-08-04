/**
 * Receipt & payment voucher imports — allocation, advances, rollback (Task #226).
 * Run: node artifacts/api-server/tests/import-vouchers.test.mjs
 * Requires the dev API server (API_URL, default http://localhost:8080/api) and DATABASE_URL.
 *
 * Under test:
 *   Explicit against-invoice allocation settles ONLY that document.
 *   Blank against-invoice auto-allocates FIFO oldest-first, with a RUNNING
 *     outstanding shared across the file (row 3 sees what rows 1–2 took).
 *   Excess spills into CADV/VADV advances via the existing advance ledgers.
 *   Validation: in-file + DB duplicate voucher numbers, unknown parties
 *     (resolvable inline), amounts ≤ 0, bad dates, unknown accounts,
 *     missing/settled invoice refs, wrong party type.
 *   Commit: vouchers carry source='allocation', verbatim voucher numbers,
 *     books stay balanced; blank numbers draw from the sequence.
 *   Rollback: dues restored, advances withdrawn; a consumed advance blocks
 *     the WHOLE batch with a per-voucher reason.
 *
 * Creates clearly-marked ZZTESTIVCH fixtures and deletes all of them at the end.
 */

import pg from 'pg';
import ExcelJS from 'exceljs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZTESTIVCH';
const WH = 2; // Marlin Mangaluru Depot — same warehouse the other suites use

let authToken = '';
let passed = 0, failed = 0;
const failures = [];
function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;

async function apiReq(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const post = (p, b) => apiReq('POST', p, b);
const get = (p) => apiReq('GET', p);
const del = (p) => apiReq('DELETE', p);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

/** Build an xlsx upload and parse it through the import endpoint. */
async function uploadRows(module, headers, rows, { loc = `warehouse|${WH}`, filename = `${TAG}-${module}.xlsx` } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  let url = `${BASE}/imports/parse?module=${module}&filename=${encodeURIComponent(filename)}`;
  if (loc) { const [lt, li] = loc.split('|'); url += `&locationType=${lt}&locationId=${li}`; }
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const data = await r.json();
  return { status: r.status, data };
}
const rowByNum = (rows, n) => rows.find((r) => r.rowNumber === n);

const RECEIPT_HDR = ['Voucher No', 'Date', 'Customer', 'Party Type', 'Amount', 'Received In', 'Against Invoice', 'Reference', 'Narration'];
const PAYMENT_HDR = ['Voucher No', 'Date', 'Vendor', 'Party Type', 'Amount', 'Paid From', 'Against Bill', 'Reference', 'Narration'];

const fx = { custId: 0, custName: `${TAG} Debtor`, ghostName: `${TAG} Ghost Buyer`, ghostId: 0,
             vendStockId: 0, vendPayId: 0, vendPayName: `${TAG} Pay Vendor`, itemId: 0,
             s1: null, s2: null, p1: null, p2: null };
const createdSales = [];
const createdPurchases = [];

async function cleanup() {
  // vouchers first (our imports roll themselves back, but a dead run may leave them)
  await sql(`DELETE FROM advance_consumptions WHERE party_id IN (SELECT id FROM customers WHERE name LIKE $1) AND party_kind='customer'`, [`${TAG}%`]);
  await sql(`DELETE FROM sale_payments WHERE clearing_receipt_id IN (SELECT id FROM receipts WHERE voucher_number LIKE 'RIV-%' AND narration LIKE $1)`, [`%${TAG}%`]);
  await sql(`DELETE FROM receipts WHERE received_from_ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM payment_bill_allocations WHERE payment_id IN (SELECT id FROM payments WHERE paid_to_ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1))`, [`${TAG}%`]);
  await sql(`DELETE FROM payments WHERE paid_to_ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1)`, [`${TAG}%`]);
  for (const id of createdSales.slice().reverse()) {
    await post(`/sales/${id}/cancel`, {}).catch(() => {});
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [id]);
  }
  createdSales.length = 0;
  for (const id of createdPurchases) await del(`/purchases/${id}`).catch(() => {});
  createdPurchases.length = 0;
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_batches WHERE item_id IN (SELECT id FROM items WHERE name LIKE $1) AND material_type='item'`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_entries WHERE item_id IN (SELECT id FROM items WHERE name LIKE $1) AND material_type='item'`, [`${TAG}%`]);
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM import_rows WHERE batch_id IN (SELECT id FROM import_batches WHERE filename LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM import_batches WHERE filename LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
}

async function trialBalance() {
  const res = await get('/accounts/trial-balance');
  return res.data?.balanced ?? null;
}
async function salePos(id) {
  const { rows: [r] } = await sql(`SELECT amount_paid::numeric AS paid, payment_status FROM sales WHERE id = $1`, [id]);
  return { paid: Number(r.paid), status: r.payment_status };
}

// ── [0] Setup ───────────────────────────────────────────────────────────────
console.log('\n[0] Auth + fixtures');
{
  const login = await post('/auth/login', { username: 'admin', password: 'marlin1458' });
  authToken = login.data?.token ?? '';
  assert('Admin login', !!authToken, `status=${login.status}`);
  if (!authToken) process.exit(1);
}
await cleanup();

{
  const c = await post('/customers', { name: fx.custName, phone: `97${String(Date.now()).slice(-8)}`, state: 'Karnataka' });
  fx.custId = c.data?.id;
  assert('Customer created via API (ledger provisioned)', c.status === 201 && !!fx.custId, JSON.stringify(c.data).slice(0, 120));

  const vs = await post('/vendors', { name: `${TAG} Stock Vendor`, state: 'Karnataka' });
  fx.vendStockId = vs.data?.id;
  const vp = await post('/vendors', { name: fx.vendPayName, state: 'Karnataka' });
  fx.vendPayId = vp.data?.id;
  assert('Vendors created via API', !!fx.vendStockId && !!fx.vendPayId);

  fx.itemId = (await sql(
    `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
     VALUES ($1,'KG','08119010',5,100,'FG-ZZIVCH-${Date.now() % 100000}','','active') RETURNING id`,
    [`${TAG} Voucher Item`])).rows[0].id;

  // Stock the item, then two credit sales (S1 ₹1000 oldest, S2 ₹500).
  const pr = await post('/purchases', {
    vendorId: fx.vendStockId, purchaseDate: '2026-06-20', locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId: fx.itemId, quantity: 60, unitCost: 50, mfgDate: '2026-06-01', expiryDate: '2027-06-01' }],
  });
  if (pr.data?.id) createdPurchases.push(pr.data.id);
  assert('Stock purchase lands', pr.status === 201, JSON.stringify(pr.data).slice(0, 150));

  const mkSale = async (date, qty) => {
    const r = await post('/sales', {
      outletId: WH, locationType: 'warehouse', locationId: WH,
      saleDate: date, paymentMode: 'credit', customerId: fx.custId,
      lineItems: [{ itemId: fx.itemId, quantity: qty, unitPrice: 100 }],
    });
    if (r.data?.id) createdSales.push(r.data.id);
    return r.data;
  };
  fx.s1 = await mkSale('2026-07-01', 10); // ₹1000
  fx.s2 = await mkSale('2026-07-15', 5);  // ₹500
  assert('Two credit sales created (₹1000 + ₹500)', !!fx.s1?.id && !!fx.s2?.id && !!fx.s1?.invoiceNumber,
    JSON.stringify({ s1: fx.s1?.id, s2: fx.s2?.id }));

  // Two unpaid purchase bills for the pay vendor (P1 ₹300 oldest, P2 ₹200).
  const mkBill = async (date, qty, inv) => {
    const r = await post('/purchases', {
      vendorId: fx.vendPayId, purchaseDate: date, invoiceNumber: inv,
      locationType: 'warehouse', locationId: WH,
      lineItems: [{ materialType: 'item', materialId: fx.itemId, quantity: qty, unitCost: 50, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
    });
    if (r.data?.id) createdPurchases.push(r.data.id);
    return { id: r.data?.id, inv };
  };
  // Bill totals INCLUDE 5% GST: P1 = 6×50×1.05 = ₹315, P2 = 4×50×1.05 = ₹210.
  fx.p1 = await mkBill('2026-07-22', 6, `${TAG}-BILL-1`); // ₹315
  fx.p2 = await mkBill('2026-07-28', 4, `${TAG}-BILL-2`); // ₹210
  assert('Two unpaid vendor bills created (₹315 + ₹210)', !!fx.p1.id && !!fx.p2.id);
}

// ── [1] Templates ───────────────────────────────────────────────────────────
console.log('\n[1] Sample templates download');
for (const m of ['receipts', 'payments']) {
  const r = await fetch(`${BASE}/imports/templates/${m}`, { headers: { Authorization: `Bearer ${authToken}` } });
  assert(`${m} template downloads as xlsx`, r.status === 200 && (r.headers.get('content-type') ?? '').includes('spreadsheet'),
    `status ${r.status}, ct ${r.headers.get('content-type')}`);
}

// ── [2] Parse requires a location ───────────────────────────────────────────
console.log('\n[2] Location gate');
{
  const r = await uploadRows('receipts', RECEIPT_HDR, [['RV-X', '2026-07-20', fx.custName, '', 10, 'Cash', '', '', '']], { loc: null });
  assert('Parse without a location is refused', r.status === 400 && /location/i.test(r.data?.error ?? ''), JSON.stringify(r.data).slice(0, 120));
}

// ── [3] Receipts: validation & allocation plan ──────────────────────────────
console.log('\n[3] Receipts parse — verdicts and running FIFO plan');
const S1 = fx.s1.invoiceNumber, S2 = fx.s2.invoiceNumber;
const existingVno = (await sql(`SELECT voucher_number FROM receipts WHERE voucher_number IS NOT NULL ORDER BY id LIMIT 1`)).rows[0]?.voucher_number ?? null;
let receiptBatch = null, receiptRows = null;
{
  const rows = [
    ['R-IMP-001', '2026-07-20', fx.custName, 'Customer', 400, 'Cash', S1, 'UTR-1', `${TAG} explicit`],   // row 2
    ['R-IMP-002', '2026-07-21', fx.custName, '', 700, 'Cash', '', '', `${TAG} fifo`],                    // row 3
    ['R-IMP-003', '2026-07-22', fx.custName, '', 500, 'Cash', '', '', `${TAG} advance`],                 // row 4
    ['R-IMP-004', '2026-07-23', fx.ghostName, 'Customer', 150, 'Cash', '', '', `${TAG} ghost`],          // row 5
    ['R-IMP-001', '2026-07-23', fx.custName, '', 10, 'Cash', '', '', ''],                                // row 6 dup in-file
    ['R-IMP-005', '2026-07-23', fx.custName, '', 0, 'Cash', '', '', ''],                                 // row 7 amount 0
    ['R-IMP-006', 'not-a-date', fx.custName, '', 10, 'Cash', '', '', ''],                                // row 8 bad date
    ['R-IMP-007', '2026-07-23', fx.custName, '', 10, 'HDFC Nope', '', '', ''],                           // row 9 unknown account
    ['R-IMP-008', '2026-07-23', fx.custName, '', 10, 'Cash', 'NOPE-999', '', ''],                        // row 10 bad ref
    ['', '2026-07-24', fx.custName, '', 25, 'Cash', '', '', `${TAG} novno`],                             // row 11 blank vno → advance
    ['R-IMP-009', '2026-07-23', fx.custName, 'Vendor', 10, 'Cash', '', '', ''],                          // row 12 wrong party type
    ...(existingVno ? [[existingVno, '2026-07-23', fx.custName, '', 10, 'Cash', '', '', '']] : []),      // row 13 DB dup
  ];
  const r = await uploadRows('receipts', RECEIPT_HDR, rows, { filename: `${TAG}-receipts.xlsx` });
  assert('Parse returns 201', r.status === 201, `status ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  receiptBatch = r.data.batch; receiptRows = r.data.rows;

  const st = (n) => rowByNum(receiptRows, n)?.status;
  assert('Explicit-ref row valid', st(2) === 'valid', st(2));
  assert('FIFO row valid', st(3) === 'valid', st(3));
  assert('Overpay row is a warning (advance)', st(4) === 'warning', `${st(4)}: ${rowByNum(receiptRows, 4)?.reason}`);
  assert('Unknown customer → needs_party', st(5) === 'needs_party', st(5));
  assert('In-file duplicate voucher no → error', st(6) === 'error' && /already appeared/i.test(rowByNum(receiptRows, 6)?.reason ?? ''), rowByNum(receiptRows, 6)?.reason);
  assert('Amount 0 → error', st(7) === 'error', rowByNum(receiptRows, 7)?.reason);
  assert('Bad date → error', st(8) === 'error' && /date/i.test(rowByNum(receiptRows, 8)?.reason ?? ''), rowByNum(receiptRows, 8)?.reason);
  assert('Unknown account → error', st(9) === 'error', rowByNum(receiptRows, 9)?.reason);
  assert('Unknown invoice ref → error naming it', st(10) === 'error' && /NOPE-999/.test(rowByNum(receiptRows, 10)?.reason ?? ''), rowByNum(receiptRows, 10)?.reason);
  assert('Blank voucher no → warning (sequence)', st(11) === 'warning' && /next number|sequence/i.test(rowByNum(receiptRows, 11)?.reason ?? ''), rowByNum(receiptRows, 11)?.reason);
  assert('Vendor party type on a receipt → error', st(12) === 'error' && /vendor/i.test(rowByNum(receiptRows, 12)?.reason ?? ''), rowByNum(receiptRows, 12)?.reason);
  if (existingVno) assert('Voucher number already in system → error', st(13) === 'error' && /already recorded/i.test(rowByNum(receiptRows, 13)?.reason ?? ''), rowByNum(receiptRows, 13)?.reason);

  const plan = (n) => rowByNum(receiptRows, n)?.plan;
  assert('Row 2 plan: ₹400 ONLY to the named invoice', plan(2)?.allocations?.length === 1 && plan(2).allocations[0].invoiceNumber === S1 && near(plan(2).allocations[0].amount, 400), JSON.stringify(plan(2)));
  assert('Row 3 plan: FIFO ₹600 → S1 remainder, ₹100 → S2 (running balance)', plan(3)?.allocations?.length === 2 && near(plan(3).allocations[0].amount, 600) && plan(3).allocations[0].invoiceNumber === S1 && near(plan(3).allocations[1].amount, 100) && plan(3).allocations[1].invoiceNumber === S2, JSON.stringify(plan(3)));
  assert('Row 4 plan: ₹400 → S2, ₹100 advance', plan(4)?.allocations?.length === 1 && near(plan(4).allocations[0].amount, 400) && near(plan(4).advance, 100), JSON.stringify(plan(4)));
  assert('Row 11 plan: everything exhausted → full ₹25 advance', plan(11)?.allocations?.length === 0 && near(plan(11).advance, 25), JSON.stringify(plan(11)));
}

// ── [4] Resolve the unknown customer inline ─────────────────────────────────
console.log('\n[4] Resolve-parties');
{
  const r = await post(`/imports/batches/${receiptBatch.id}/resolve-parties`, { parties: [{ name: fx.ghostName, state: 'Karnataka' }] });
  assert('Resolve creates the customer and re-validates', r.status === 200 && r.data.created?.includes(fx.ghostName), JSON.stringify(r.data).slice(0, 200));
  receiptRows = r.data.rows;
  const ghost = rowByNum(receiptRows, 5);
  assert('Ghost row now a warning: full ₹150 parked as advance', ghost?.status === 'warning' && near(ghost?.plan?.advance, 150), JSON.stringify({ s: ghost?.status, p: ghost?.plan }));
  fx.ghostId = (await sql(`SELECT id FROM customers WHERE name = $1`, [fx.ghostName])).rows[0]?.id;
  assert('Ghost customer exists with a ledger', !!fx.ghostId);
}

// ── [5] Commit receipts ─────────────────────────────────────────────────────
console.log('\n[5] Commit — vouchers, allocations, advances, books');
const preS1 = await salePos(fx.s1.id), preS2 = await salePos(fx.s2.id);
{
  const r = await post(`/imports/batches/${receiptBatch.id}/commit`, {});
  assert('Commit imports exactly the 5 clean rows', r.status === 200 && r.data.summary?.imported === 5 && r.data.summary?.failed === 0, JSON.stringify(r.data?.summary) + JSON.stringify(r.data?.failures ?? []).slice(0, 300));

  const { rows: recs } = await sql(
    `SELECT voucher_number, source, amount::numeric AS amount, advance_amount::numeric AS adv, location_type, location_id
       FROM receipts WHERE voucher_number IN ('R-IMP-001','R-IMP-002','R-IMP-003') ORDER BY voucher_number`);
  assert('Voucher numbers kept verbatim (3 supplied)', recs.length === 3, JSON.stringify(recs));
  assert("Provenance stamped — source='allocation', never NULL", recs.every((x) => x.source === 'allocation'), JSON.stringify(recs.map((x) => x.source)));
  assert('Vouchers stamped to the chosen location', recs.every((x) => x.location_type === 'warehouse' && Number(x.location_id) === WH), JSON.stringify(recs.map((x) => [x.location_type, x.location_id])));
  assert('R-IMP-003 parked ₹100 as advance', near(recs.find((x) => x.voucher_number === 'R-IMP-003')?.adv, 100), JSON.stringify(recs));

  const s1 = await salePos(fx.s1.id), s2 = await salePos(fx.s2.id);
  assert('S1 fully settled (₹400 + ₹600)', near(s1.paid, 1000) && s1.status === 'paid', JSON.stringify(s1));
  assert('S2 fully settled (₹100 + ₹400)', near(s2.paid, 500) && s2.status === 'paid', JSON.stringify(s2));

  const { rows: [cadv] } = await sql(
    `SELECT COALESCE(SUM(advance_amount)::numeric,0) AS adv FROM receipts r
      JOIN account_ledgers al ON al.id = r.received_from_ledger_id WHERE al.code = $1`, [`CUST-${fx.custId}`]);
  assert('Customer advance parked = ₹125 (100 + 25)', near(cadv.adv, 125), cadv.adv);
  const { rows: [gadv] } = await sql(
    `SELECT COALESCE(SUM(advance_amount)::numeric,0) AS adv FROM receipts r
      JOIN account_ledgers al ON al.id = r.received_from_ledger_id WHERE al.code = $1`, [`CUST-${fx.ghostId}`]);
  assert('Ghost customer advance = ₹150', near(gadv.adv, 150), gadv.adv);
  const { rows: [cadvLedger] } = await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`CADV-${fx.custId}`]);
  assert('CADV advance ledger exists', !!cadvLedger);

  const detail = await get(`/imports/batches/${receiptBatch.id}`);
  const blankRow = rowByNum(detail.data?.rows ?? [], 11);
  assert('Blank voucher no drew a sequence number', !!blankRow?.created?.voucherNumber && blankRow.created.voucherNumber !== '', JSON.stringify(blankRow?.created));
  assert('Committed rows record actual allocations', near(rowByNum(detail.data?.rows ?? [], 2)?.created?.allocations?.[0]?.amount, 400), JSON.stringify(rowByNum(detail.data?.rows ?? [], 2)?.created));

  assert('Trial balance stays balanced after commit', (await trialBalance()) === true);
}

// ── [6] Rollback receipts ───────────────────────────────────────────────────
console.log('\n[6] Rollback — dues and advances restored');
{
  const r = await post(`/imports/batches/${receiptBatch.id}/rollback`, {});
  assert('Rollback removes all 5 vouchers', r.status === 200 && r.data.removed === 5, JSON.stringify(r.data).slice(0, 200));
  const { rows: [left] } = await sql(`SELECT COUNT(*)::int AS n FROM receipts WHERE voucher_number LIKE 'R-IMP-%'`);
  assert('No imported receipts remain', Number(left.n) === 0, left.n);
  const s1 = await salePos(fx.s1.id), s2 = await salePos(fx.s2.id);
  assert('S1 dues restored', near(s1.paid, preS1.paid) && s1.status === preS1.status, JSON.stringify({ s1, preS1 }));
  assert('S2 dues restored', near(s2.paid, preS2.paid) && s2.status === preS2.status, JSON.stringify({ s2, preS2 }));
  const { rows: [adv] } = await sql(
    `SELECT COALESCE(SUM(advance_amount)::numeric,0) AS adv FROM receipts r
      JOIN account_ledgers al ON al.id = r.received_from_ledger_id WHERE al.code IN ($1, $2)`,
    [`CUST-${fx.custId}`, `CUST-${fx.ghostId}`]);
  assert('All advances withdrawn', near(adv.adv, 0), adv.adv);
  assert('Trial balance stays balanced after rollback', (await trialBalance()) === true);
}

// ── [7] Consumed advance blocks rollback ────────────────────────────────────
console.log('\n[7] Rollback refusal when an advance was consumed downstream');
{
  const up = await uploadRows('receipts', RECEIPT_HDR,
    [['R-IMP-ADV', '2026-07-27', fx.ghostName, '', 200, 'Cash', '', '', `${TAG} adv`]],
    { filename: `${TAG}-adv.xlsx` });
  assert('Advance-only voucher parses as warning', up.status === 201 && up.data.rows[0].status === 'warning', JSON.stringify(up.data.rows?.[0]?.reason));
  const c = await post(`/imports/batches/${up.data.batch.id}/commit`, {});
  assert('Advance voucher commits', c.status === 200 && c.data.summary?.imported === 1, JSON.stringify(c.data?.summary));
  const recId = (await sql(`SELECT id FROM receipts WHERE voucher_number = 'R-IMP-ADV'`)).rows[0]?.id;

  // Simulate downstream consumption: a later sale drew ₹50 of this parked advance.
  await sql(
    `INSERT INTO advance_consumptions (party_kind, party_id, source_receipt_id, amount) VALUES ('customer', $1, $2, 50)`,
    [fx.ghostId, recId]);
  const blockedRes = await post(`/imports/batches/${up.data.batch.id}/rollback`, {});
  assert('Rollback refused with 409', blockedRes.status === 409, `status ${blockedRes.status}: ${JSON.stringify(blockedRes.data).slice(0, 200)}`);
  assert('Refusal names the voucher and the consumed advance',
    blockedRes.data?.blocked?.[0]?.name === 'R-IMP-ADV' && /advance/i.test(blockedRes.data?.blocked?.[0]?.reason ?? ''),
    JSON.stringify(blockedRes.data?.blocked));
  const still = (await sql(`SELECT COUNT(*)::int AS n FROM receipts WHERE voucher_number = 'R-IMP-ADV'`)).rows[0].n;
  assert('Refused rollback left the voucher in place (all-or-nothing)', Number(still) === 1, still);

  // Free the advance → rollback succeeds.
  await sql(`DELETE FROM advance_consumptions WHERE source_receipt_id = $1`, [recId]);
  const ok2 = await post(`/imports/batches/${up.data.batch.id}/rollback`, {});
  assert('Rollback succeeds once the advance is free', ok2.status === 200 && ok2.data.removed === 1, JSON.stringify(ok2.data).slice(0, 150));
}

// ── [8] Payments: explicit + FIFO + advance, commit, rollback ───────────────
console.log('\n[8] Payment vouchers');
{
  const up = await uploadRows('payments', PAYMENT_HDR, [
    ['PV-IMP-001', '2026-07-29', fx.vendPayName, 'Vendor', 100, 'Cash', fx.p1.inv, '', `${TAG} explicit`], // row 2
    ['PV-IMP-002', '2026-07-30', fx.vendPayName, '', 450, 'Cash', '', '', `${TAG} fifo+adv`],              // row 3
    ['PV-IMP-003', '2026-07-30', fx.vendPayName, 'Customer', 10, 'Cash', '', '', ''],                      // row 4 wrong type
  ], { filename: `${TAG}-payments.xlsx` });
  assert('Payments parse returns 201', up.status === 201, `status ${up.status}: ${JSON.stringify(up.data).slice(0, 200)}`);
  const rows = up.data.rows;
  assert('Explicit bill row valid', rowByNum(rows, 2)?.status === 'valid', rowByNum(rows, 2)?.reason);
  assert('Row 2 plan: ₹100 ONLY to the named bill', near(rowByNum(rows, 2)?.plan?.allocations?.[0]?.amount, 100) && rowByNum(rows, 2)?.plan?.allocations?.[0]?.invoiceNumber === fx.p1.inv, JSON.stringify(rowByNum(rows, 2)?.plan));
  assert('Row 3 plan: FIFO ₹215 → P1 remainder, ₹210 → P2, ₹25 advance',
    rowByNum(rows, 3)?.status === 'warning' && near(rowByNum(rows, 3)?.plan?.allocations?.[0]?.amount, 215) && near(rowByNum(rows, 3)?.plan?.allocations?.[1]?.amount, 210) && near(rowByNum(rows, 3)?.plan?.advance, 25),
    JSON.stringify(rowByNum(rows, 3)?.plan));
  assert('Customer party type on a payment → error', rowByNum(rows, 4)?.status === 'error' && /customer/i.test(rowByNum(rows, 4)?.reason ?? ''), rowByNum(rows, 4)?.reason);

  const c = await post(`/imports/batches/${up.data.batch.id}/commit`, {});
  assert('Commit imports the 2 clean payment rows', c.status === 200 && c.data.summary?.imported === 2 && c.data.summary?.failed === 0, JSON.stringify(c.data?.summary) + JSON.stringify(c.data?.failures ?? []).slice(0, 300));

  const { rows: pays } = await sql(
    `SELECT id, voucher_number, source, advance_amount::numeric AS adv FROM payments WHERE voucher_number LIKE 'PV-IMP-%' ORDER BY voucher_number`);
  assert("Payments carry source='allocation'", pays.length === 2 && pays.every((x) => x.source === 'allocation'), JSON.stringify(pays));
  assert('PV-IMP-002 parked ₹25 vendor advance', near(pays.find((x) => x.voucher_number === 'PV-IMP-002')?.adv, 25), JSON.stringify(pays));
  const allocSum = async (purchaseId) => Number((await sql(
    `SELECT COALESCE(SUM(amount)::numeric,0) AS s FROM payment_bill_allocations WHERE purchase_id = $1`, [purchaseId])).rows[0].s);
  assert('P1 fully allocated (₹100 + ₹215)', near(await allocSum(fx.p1.id), 315));
  assert('P2 fully allocated (₹210)', near(await allocSum(fx.p2.id), 210));
  const { rows: [vadv] } = await sql(`SELECT id FROM account_ledgers WHERE code = $1`, [`VADV-${fx.vendPayId}`]);
  assert('VADV advance ledger exists', !!vadv);
  assert('Trial balance stays balanced after payment commit', (await trialBalance()) === true);

  const rb = await post(`/imports/batches/${up.data.batch.id}/rollback`, {});
  assert('Payments rollback removes both vouchers', rb.status === 200 && rb.data.removed === 2, JSON.stringify(rb.data).slice(0, 150));
  assert('Bill allocations unwound', near(await allocSum(fx.p1.id), 0) && near(await allocSum(fx.p2.id), 0));
  const { rows: [leftP] } = await sql(`SELECT COUNT(*)::int AS n FROM payments WHERE voucher_number LIKE 'PV-IMP-%'`);
  assert('No imported payments remain', Number(leftP.n) === 0, leftP.n);
}

// ── Teardown ────────────────────────────────────────────────────────────────
console.log('\n[9] Cleanup');
await cleanup();
{
  const { rows: [n1] } = await sql(`SELECT COUNT(*)::int AS n FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  const { rows: [n2] } = await sql(`SELECT COUNT(*)::int AS n FROM sales WHERE customer_id = $1`, [fx.custId || -1]);
  assert('All fixtures removed', Number(n1.n) === 0 && Number(n2.n) === 0, JSON.stringify({ n1, n2 }));
  assert('Trial balance balanced after cleanup', (await trialBalance()) === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
await pool.end();
process.exit(0);
