/**
 * Purchase reversal stock-ledger names — regression tests
 * Run: node artifacts/api-server/tests/purchase-reversal-ledger-names.test.mjs
 *
 * Guards the Task-300 fix: purchase EDIT and DELETE reversals must stamp real
 * item names/units into stock_ledger. The stored line JSON deliberately never
 * carries materialName/unit (priceBill strips them; names resolve at read
 * time), so the reversal writers must resolve from the masters — reading the
 * stored fields silently produces blank audit rows, which name-tagged suite
 * cleanups then miss (the root cause of 293 orphan rows found in the Aug 2026
 * audit).
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZTESTRVN fixtures and deletes all of them at the end.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZTESTRVN';

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
const del = (p, t) => apiReq('DELETE', p, undefined, t);
const patch = (p, b, t) => apiReq('PATCH', p, b, t);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

const fixtures = { vendorId: 0, materialId: 0 };
const createdPurchases = [];

console.log('\n[0] Authentication and fixtures');
const loginRes = await post('/auth/login', {
  username: process.env.TEST_USERNAME || 'admin',
  password: process.env.TEST_PASSWORD || 'marlin1458',
});
authToken = loginRes.data?.token ?? '';
assert('Login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

async function cleanup() {
  for (const id of createdPurchases) { await del(`/purchases/${id}`).catch(() => {}); }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  // Named rows — and this working at all is part of what the suite proves.
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fixtures.materialId) {
    await sql(`DELETE FROM stock_ledger WHERE material_type = 'material' AND ref_id = $1`, [fixtures.materialId]);
    await sql(`DELETE FROM stock_batches WHERE material_type = 'material' AND item_id = $1`, [fixtures.materialId]);
    await sql(`DELETE FROM stock_entries WHERE material_type = 'material' AND item_id = $1`, [fixtures.materialId]);
  }
  await sql(`DELETE FROM materials WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'VEND-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
}
await cleanup(); // in case a previous run died mid-way

// Receiving warehouse — first live warehouse with a state and GSTIN on file
// (live business rows; never hardcode ids).
const { rows: whRows } = await sql(
  `SELECT id, state, gst_number FROM warehouses
    WHERE COALESCE(gst_number,'') <> '' AND COALESCE(state,'') <> ''
      AND disabled_at IS NULL ORDER BY id`);
if (!whRows.length) { console.error('FATAL: no warehouse with state + GSTIN'); process.exit(1); }
const WH = Number(whRows[0].id);
const WH_STATE = whRows[0].state;
const WH_CODE = String(whRows[0].gst_number).slice(0, 2);

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,$2,$3) RETURNING id`,
  [`${TAG} Vendor`, WH_STATE, `${WH_CODE}ZZRVN1234F1Z5`])).rows[0].id;
fixtures.materialId = (await sql(
  `INSERT INTO materials (name, unit, hsn_code, tax_rate, item_code, barcode, status, current_stock)
   VALUES ($1,'KG','08119090',5,'RM-ZZRVN-01','2900000000916','active',0) RETURNING id`,
  [`${TAG} Frozen Mango`])).rows[0].id;
const MAT_NAME = `${TAG} Frozen Mango`;

const line = (over = {}) => ({
  materialType: 'material', materialId: fixtures.materialId,
  quantity: 2, unitCost: 100, mfgDate: '2026-08-01', expiryDate: '2027-08-01', ...over,
});
const bill = (over = {}) => ({
  vendorId: fixtures.vendorId, purchaseDate: '2026-08-10', vendorInvoiceDate: '2026-08-09',
  locationType: 'warehouse', locationId: WH, lineItems: [line({ batchNumber: 'ZZRVN-B1' })], ...over,
});

async function reversalRows(purchaseId) {
  const { rows } = await sql(
    `SELECT item_name, unit, notes, qty_change::float8 AS qty
       FROM stock_ledger
      WHERE txn_type = 'purchase_reversal' AND doc_type = 'purchase' AND doc_id = $1
      ORDER BY id`, [purchaseId]);
  return rows;
}

let exitCode = 0;
try {
  // ── [1] Edit reversal stamps names ────────────────────────────────────────
  console.log('\n[1] Edit reversal (line replaced) stamps item name and unit');
  const created = await post('/purchases', bill());
  assert('Bill created (201)', created.status === 201 && created.data?.id, `status=${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
  const billId = created.data.id;
  createdPurchases.push(billId);

  // Positive control: the inbound rows are named (pre-existing behavior).
  const inbound = await sql(
    `SELECT item_name, unit FROM stock_ledger
      WHERE doc_type='purchase' AND doc_id=$1 AND txn_type <> 'purchase_reversal'`, [billId]);
  assert('Inbound ledger rows exist and are named', inbound.rows.length >= 1
    && inbound.rows.every(r => r.item_name === MAT_NAME && r.unit === 'KG'),
    JSON.stringify(inbound.rows));

  // Replacing the line's batch changes the pairing key (kind:id:batch), so the
  // old line is fully reversed and the new one applied.
  const edited = await patch(`/purchases/${billId}`, {
    lineItems: [line({ batchNumber: 'ZZRVN-B2', quantity: 3, unitCost: 110 })],
  });
  assert('Edit replacing the line succeeds (200)', edited.status === 200, `status=${edited.status} ${JSON.stringify(edited.data).slice(0, 200)}`);

  const afterEdit = (await reversalRows(billId)).filter(r => String(r.notes || '').includes('edit'));
  assert('Edit wrote at least one reversal row', afterEdit.length >= 1, `rows=${afterEdit.length}`);
  assert('Edit reversal rows carry the real item name', afterEdit.every(r => r.item_name === MAT_NAME),
    JSON.stringify(afterEdit.map(r => r.item_name)));
  assert('Edit reversal rows carry the real unit', afterEdit.every(r => r.unit === 'KG'),
    JSON.stringify(afterEdit.map(r => r.unit)));
  assert('Edit reversal is outbound for the old quantity', afterEdit.some(r => r.qty === -2),
    JSON.stringify(afterEdit.map(r => r.qty)));

  // ── [2] Delete reversal stamps names ──────────────────────────────────────
  console.log('\n[2] Delete reversal stamps item name and unit');
  const removed = await del(`/purchases/${billId}`);
  assert('Bill delete succeeds (204)', removed.status === 204, `status=${removed.status}`);

  const afterDelete = (await reversalRows(billId)).filter(r => String(r.notes || '').includes('deleted'));
  assert('Delete wrote at least one reversal row', afterDelete.length >= 1, `rows=${afterDelete.length}`);
  assert('Delete reversal rows carry the real item name', afterDelete.every(r => r.item_name === MAT_NAME),
    JSON.stringify(afterDelete.map(r => r.item_name)));
  assert('Delete reversal rows carry the real unit', afterDelete.every(r => r.unit === 'KG'),
    JSON.stringify(afterDelete.map(r => r.unit)));
  assert('Delete reversal is outbound for the current quantity', afterDelete.some(r => r.qty === -3),
    JSON.stringify(afterDelete.map(r => r.qty)));

  // ── [3] No blank-named rows escaped ───────────────────────────────────────
  console.log('\n[3] No blank-named reversal rows for this document');
  const blanks = await sql(
    `SELECT COUNT(*)::int AS n FROM stock_ledger
      WHERE doc_type='purchase' AND doc_id=$1 AND (COALESCE(item_name,'')='' OR COALESCE(unit,'')='')`, [billId]);
  assert('Zero blank name/unit ledger rows for the bill', blanks.rows[0].n === 0, `count=${blanks.rows[0].n}`);
} catch (e) {
  console.error('FATAL:', e);
  exitCode = 1;
} finally {
  console.log('\n[cleanup]');
  await cleanup();
  const left = await sql(`SELECT COUNT(*)::int AS n FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  assert('Cleanup left no tagged ledger rows', left.rows[0].n === 0, `count=${left.rows[0].n}`);
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('Failures:', failures); }
process.exit(exitCode || (failed ? 1 : 0));
