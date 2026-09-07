/**
 * Received transfer inventory integration tests.
 *
 * Run: node artifacts/api-server/tests/stock-transfer-receiving.test.mjs
 *
 * This suite uses isolated, no-GST warehouse/material fixtures so the test
 * exercises physical inventory without creating accounting documents. The
 * transfer endpoints are still used for every stock transition.
 */

import pg from 'pg';
import bcrypt from 'bcryptjs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZTRFDATE';
const D0 = '2026-08-19';
const D1 = '2026-08-20';
const D2 = '2026-08-21';
const D3 = '2026-08-22';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (query, params = []) => pool.query(query, params);
const PROBE_USER = 'zztrfdate_admin';
const PROBE_PASS = 'ZzTrfDate#1';

let authToken = '';
let materialId = 0;
let sourceId = 0;
let destinationId = 0;
const transferIds = [];
let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function apiReq(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...headers,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const response = await fetch(`${BASE}${path}`, opts);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

const get = (path, headers) => apiReq('GET', path, undefined, headers);
const post = (path, body) => apiReq('POST', path, body);
const patch = (path, body) => apiReq('PATCH', path, body);

async function locationQty(branchId) {
  const { rows: [row] } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric), 0) AS quantity
       FROM stock_entries
      WHERE item_id = $1 AND material_type = 'material'
        AND branch_type = 'warehouse' AND branch_id = $2`,
    [materialId, branchId],
  );
  return Number(row?.quantity ?? 0);
}

async function qtyAsOf(branchId, asOf) {
  const { rows: [row] } = await sql(
    `SELECT COALESCE(SUM(qty_change::numeric), 0) AS quantity
       FROM stock_ledger
      WHERE material_type = 'material' AND ref_id = $1
        AND branch_type = 'warehouse' AND branch_id = $2
        AND COALESCE(txn_date, created_at::date) <= $3::date`,
    [materialId, branchId, asOf],
  );
  return Number(row?.quantity ?? 0);
}

async function transferLedger(transferId) {
  const { rows } = await sql(
    `SELECT txn_type, branch_id, qty_change::numeric AS qty, txn_date::text AS txn_date
       FROM stock_ledger
      WHERE doc_type = 'stock_transfer' AND doc_id = $1
      ORDER BY id`,
    [transferId],
  );
  return rows;
}

async function cleanup() {
  if (transferIds.length) {
    await sql(`DELETE FROM stock_reservations WHERE doc_type = 'stock_transfer' AND doc_id = ANY($1::int[])`, [transferIds]);
    await sql(`DELETE FROM stock_ledger WHERE doc_type = 'stock_transfer' AND doc_id = ANY($1::int[])`, [transferIds]);
    await sql(`DELETE FROM stock_batches WHERE source = 'transfer' AND source_id = ANY($1::int[])`, [transferIds]);
    await sql(`DELETE FROM stock_transfers WHERE id = ANY($1::int[])`, [transferIds]);
  }
  if (materialId) {
    await sql(
      `DELETE FROM stock_ledger
        WHERE material_type = 'material' AND ref_id = $1
          AND branch_type = 'warehouse' AND branch_id = ANY($2::int[])`,
      [materialId, [sourceId, destinationId]],
    );
    await sql(
      `DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'material'
         AND branch_type = 'warehouse' AND branch_id = ANY($2::int[])`,
      [materialId, [sourceId, destinationId]],
    );
    await sql(
      `DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'material'
         AND branch_type = 'warehouse' AND branch_id = ANY($2::int[])`,
      [materialId, [sourceId, destinationId]],
    );
    await sql(`DELETE FROM materials WHERE id = $1`, [materialId]);
  }
  await sql(`DELETE FROM warehouses WHERE id = ANY($1::int[])`, [[sourceId, destinationId].filter(Boolean)]);
  await sql(`DELETE FROM login_lockouts WHERE username = $1`, [PROBE_USER]).catch(() => {});
  await sql(`DELETE FROM login_attempts WHERE username = $1`, [PROBE_USER]).catch(() => {});
  await sql(`DELETE FROM employees WHERE username = $1`, [PROBE_USER]).catch(() => {});
}

console.log('\n[0] Authentication and isolated fixtures');
try {
  const { rows: [admin] } = await sql(`SELECT hierarchy_id FROM employees WHERE username = 'admin'`);
  if (!admin) throw new Error('No admin row available to clone for the test user');
  await sql(`DELETE FROM login_lockouts WHERE username = $1`, [PROBE_USER]).catch(() => {});
  await sql(`DELETE FROM login_attempts WHERE username = $1`, [PROBE_USER]).catch(() => {});
  await sql(`DELETE FROM employees WHERE username = $1`, [PROBE_USER]).catch(() => {});
  await sql(
    `INSERT INTO employees
       (name, username, password_hash, hierarchy_id, branch_type, branch_id,
        salary, join_date, is_active, must_change_password)
     VALUES ($1, $2, $3, $4, 'headoffice', 0, 0, CURRENT_DATE, true, false)`,
    [`${TAG} Admin`, PROBE_USER, bcrypt.hashSync(PROBE_PASS, 10), admin.hierarchy_id],
  );
  const login = await apiReq('POST', '/auth/login', {
    username: PROBE_USER,
    password: PROBE_PASS,
  });
  authToken = login.data?.token ?? '';
  assert('Admin login returns a token', !!authToken, `status=${login.status}`);
  if (!authToken) throw new Error('Cannot obtain authentication token');

  // These locations deliberately have blank GST numbers, keeping this suite
  // on the internal challan path and avoiding unrelated accounting cleanup.
  const source = await sql(
    `INSERT INTO warehouses (name, state, gst_number) VALUES ($1, 'Karnataka', '') RETURNING id`,
    [`${TAG} Source`],
  );
  sourceId = Number(source.rows[0].id);
  const destination = await sql(
    `INSERT INTO warehouses (name, state, gst_number) VALUES ($1, 'Karnataka', '') RETURNING id`,
    [`${TAG} Destination`],
  );
  destinationId = Number(destination.rows[0].id);
  const material = await sql(
    `INSERT INTO materials
       (name, unit, hsn_code, tax_rate, cost, avg_cost, current_stock, item_code, status)
     VALUES ($1, 'KG', '08119090', 0, 100, 100, 12, $2, 'active')
     RETURNING id`,
    [`${TAG} Material`, `${TAG}-MAT`],
  );
  materialId = Number(material.rows[0].id);
  await sql(
    `INSERT INTO stock_entries
       (item_id, material_type, branch_type, branch_id, quantity, cost_price)
     VALUES ($1, 'material', 'warehouse', $2, 12, 100)`,
    [materialId, sourceId],
  );
  await sql(
    `INSERT INTO stock_batches
       (item_id, material_type, branch_type, branch_id, batch_number, quantity, unit_cost, source, source_id)
     VALUES ($1, 'material', 'warehouse', $2, $3, 12, 100, 'test', NULL)`,
    [materialId, sourceId, `${TAG}-LOT`],
  );
  // Give the historical stock reconstruction an explicit opening movement.
  // The accounting assertions exercise the transfer adjustment, not the
  // untracked-stock fallback.
  await sql(
    `INSERT INTO stock_ledger
       (txn_type, material_type, ref_id, item_name, unit, branch_type, branch_id,
        branch_name, qty_change, unit_cost, doc_type, doc_id, notes, txn_date)
     VALUES ('opening_stock', 'material', $1, $2, 'KG', 'warehouse', $3,
             $4, 12, 100, 'test_fixture', NULL, $5, $6::date)`,
    [materialId, `${TAG} Material`, sourceId, `${TAG} Source`, `${TAG} opening`, '2026-08-18'],
  );
  assert('Created isolated source and destination fixtures', sourceId > 0 && destinationId > 0 && materialId > 0);

  console.log('\n[1] Pending transfer deducts only the source');
  const first = await post('/stock/transfers', {
    fromType: 'warehouse', fromId: sourceId,
    toType: 'warehouse', toId: destinationId,
    transferDate: D1,
    lineItems: [{ itemId: materialId, materialType: 'material', quantity: 4, costPrice: 100 }],
    notes: `${TAG} full receipt`,
  });
  const firstId = Number(first.data?.id ?? 0);
  if (firstId) transferIds.push(firstId);
  assert('Transfer created', first.status === 201 && firstId > 0, JSON.stringify(first.data).slice(0, 240));
  assert('Pending transfer leaves destination unchanged', (await locationQty(destinationId)) === 0);
  assert('Dispatch deducts source stock', (await locationQty(sourceId)) === 8);
  const firstPendingLedger = await transferLedger(firstId);
  assert('Dispatch ledger row uses transfer business date',
    firstPendingLedger.length === 1 &&
    firstPendingLedger[0].txn_type === 'transfer_out' &&
    firstPendingLedger[0].txn_date === D1,
    JSON.stringify(firstPendingLedger));

  console.log('\n[2] Full receipt is one destination movement and is historical');
  const full = await patch(`/stock/transfers/${firstId}/approve`, {
    receivedLineItems: [{ itemId: materialId, materialType: 'material', quantity: 4 }],
    approvedBy: 'ZZTRFDATE',
  });
  assert('Full receipt completes', full.status === 200 && full.data?.status === 'completed', JSON.stringify(full.data));
  assert('Destination stock increases by received quantity', (await locationQty(destinationId)) === 4);
  const { rows: [fullReservation] } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric), 0) AS quantity
       FROM stock_reservations
      WHERE doc_type = 'stock_transfer' AND doc_id = $1
        AND kind = 'in_transit' AND status = 'active'`, [firstId],
  );
  assert('Full receipt releases all in-transit reservations', Number(fullReservation.quantity) === 0);
  const firstRows = await transferLedger(firstId);
  assert('Exactly one destination transfer-in ledger row exists',
    firstRows.filter(r => r.txn_type === 'transfer_in' && Number(r.branch_id) === destinationId).length === 1,
    JSON.stringify(firstRows));
  assert('Destination transfer-in uses transfer business date',
    firstRows.some(r => r.txn_type === 'transfer_in' && r.txn_date === D1),
    JSON.stringify(firstRows));
  assert('Historical destination opening is zero before receipt', (await qtyAsOf(destinationId, D0)) === 0);
  assert('Historical destination closing includes receipt', (await qtyAsOf(destinationId, D1)) === 4);

  // Legacy transfer rows can have a non-null zero unit cost even though the
  // product's authoritative inventory valuation has a real weighted-average
  // cost. The books must use that fallback or a transfer manufactures COGS.
  await sql(
    `UPDATE stock_ledger
        SET unit_cost = 0
      WHERE doc_type = 'stock_transfer' AND doc_id = $1`,
    [firstId],
  );
  assert('Zero-cost legacy transfer fixture is prepared', true);

  const destinationLedger = await get(
    `/stock/ledger?from=${D1}&to=${D1}&txnType=transfer_in&branchType=warehouse`,
    { 'x-location-type': 'warehouse', 'x-location-id': String(destinationId) },
  );
  assert('Ledger API returns the received movement for the destination',
    destinationLedger.status === 200 &&
    destinationLedger.data?.rows?.length === 1 &&
    destinationLedger.data.rows[0].txnDate === D1,
    JSON.stringify(destinationLedger.data).slice(0, 400));
  const sourceLedger = await get(
    `/stock/ledger?from=${D1}&to=${D1}&txnType=transfer_in`,
    { 'x-location-type': 'warehouse', 'x-location-id': String(sourceId) },
  );
  assert('Location filter excludes destination receipt from source view',
    sourceLedger.status === 200 && sourceLedger.data?.rows?.length === 0,
    JSON.stringify(sourceLedger.data).slice(0, 300));
  const stockView = await get(`/stock?branchType=warehouse&branchId=${destinationId}&materialType=material`);
  assert('Destination stock endpoint reports received quantity',
    stockView.status === 200 && Number(stockView.data?.[0]?.quantity ?? stockView.data?.rows?.[0]?.quantity ?? 0) === 4,
    JSON.stringify(stockView.data).slice(0, 300));

  const duplicateReceive = await patch(`/stock/transfers/${firstId}/approve`, {
    receivedLineItems: [{ itemId: materialId, materialType: 'material', quantity: 4 }],
  });
  assert('Second receipt is refused', duplicateReceive.status === 400, JSON.stringify(duplicateReceive.data));
  assert('Second receipt does not change destination stock', (await locationQty(destinationId)) === 4);

  console.log('\n[3] Short receipt carries only actual quantity and preserves in-transit shortfall');
  const second = await post('/stock/transfers', {
    fromType: 'warehouse', fromId: sourceId,
    toType: 'warehouse', toId: destinationId,
    transferDate: D2,
    lineItems: [{ itemId: materialId, materialType: 'material', quantity: 2, costPrice: 100 }],
    notes: `${TAG} short receipt`,
  });
  const secondId = Number(second.data?.id ?? 0);
  if (secondId) transferIds.push(secondId);
  assert('Second transfer created', second.status === 201 && secondId > 0);
  const short = await patch(`/stock/transfers/${secondId}/approve`, {
    receivedLineItems: [{ itemId: materialId, materialType: 'material', quantity: 1 }],
  });
  assert('Short receipt completes', short.status === 200 && short.data?.shortReceived?.length === 1, JSON.stringify(short.data));
  assert('Short receipt credits only one unit', (await locationQty(destinationId)) === 5);
  const shortRows = await transferLedger(secondId);
  assert('Short receipt has one transfer-in row for actual quantity',
    shortRows.filter(r => r.txn_type === 'transfer_in').length === 1 &&
    Number(shortRows.find(r => r.txn_type === 'transfer_in').qty) === 1 &&
    shortRows.find(r => r.txn_type === 'transfer_in').txn_date === D2,
    JSON.stringify(shortRows));
  const { rows: [inTransit] } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric), 0) AS quantity
       FROM stock_reservations
      WHERE doc_type = 'stock_transfer' AND doc_id = $1
        AND kind = 'in_transit' AND status = 'active'`,
    [secondId],
  );
  assert('Shortfall remains visible as one active in-transit unit', Number(inTransit.quantity) === 1);
  assert('Historical destination closing includes both receipts', (await qtyAsOf(destinationId, D2)) === 5);

  console.log('\n[4] Rejection restores source and never credits destination');
  const third = await post('/stock/transfers', {
    fromType: 'warehouse', fromId: sourceId,
    toType: 'warehouse', toId: destinationId,
    transferDate: D3,
    lineItems: [{ itemId: materialId, materialType: 'material', quantity: 1, costPrice: 100 }],
    notes: `${TAG} rejection`,
  });
  const thirdId = Number(third.data?.id ?? 0);
  if (thirdId) transferIds.push(thirdId);
  assert('Third transfer created', third.status === 201 && thirdId > 0);
  assert('Third pending transfer does not credit destination', (await locationQty(destinationId)) === 5);
  const rejected = await patch(`/stock/transfers/${thirdId}/reject`, { rejectionReason: `${TAG} test rejection` });
  assert('Transfer rejection succeeds', rejected.status === 200 && rejected.data?.status === 'rejected', JSON.stringify(rejected.data));
  assert('Rejection restores source stock', (await locationQty(sourceId)) === 6);
  assert('Rejection leaves destination unchanged', (await locationQty(destinationId)) === 5);
  const thirdRows = await transferLedger(thirdId);
  assert('Rejection return is dated and belongs to source',
    thirdRows.length === 2 &&
    thirdRows.some(r => r.txn_type === 'transfer_out' && r.txn_date === D3) &&
    thirdRows.some(r => r.txn_type === 'transfer_in' && Number(r.branch_id) === sourceId && r.txn_date === D3),
    JSON.stringify(thirdRows));
  const duplicateReject = await patch(`/stock/transfers/${thirdId}/reject`, { rejectionReason: 'duplicate' });
  assert('Second rejection is refused', duplicateReject.status === 400, JSON.stringify(duplicateReject.data));
  const { rows: [rejectedReservation] } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric), 0) AS quantity
       FROM stock_reservations
      WHERE doc_type = 'stock_transfer' AND doc_id = $1
        AND kind = 'in_transit' AND status = 'active'`, [thirdId],
  );
  assert('Rejected transfer releases all in-transit reservations', Number(rejectedReservation.quantity) === 0);

  console.log('\n[5] Consolidated stock remains reconciled with in-transit shortfall');
  const { rows: [onHand] } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric), 0) AS quantity
       FROM stock_entries
      WHERE item_id = $1 AND material_type = 'material'
        AND branch_type = 'warehouse' AND branch_id = ANY($2::int[])`,
    [materialId, [sourceId, destinationId]],
  );
  assert('On-hand source plus destination equals 11 units', Number(onHand.quantity) === 11);
  assert('On-hand plus active in-transit equals original 12 units', Number(onHand.quantity) + Number(inTransit.quantity) === 12);

  console.log('\n[6] Transfer values adjust opening stock, never closing stock');
  const statement = async (from, to, locationId) => {
    const result = await get(
      `/accounts/financial-statements?fromDate=${from}&toDate=${to}&locationType=warehouse&locationId=${locationId}`,
    );
    return result.data;
  };
  const sourceDay = await statement(D0, D1, sourceId);
  const destinationDay = await statement(D0, D1, destinationId);
  assert('Source opening is reduced by dispatched transfer value',
    Number(sourceDay?.profitAndLoss?.expenses?.openingStock) === 800,
    JSON.stringify(sourceDay?.profitAndLoss?.expenses));
  assert('Destination opening is increased by received transfer value',
    Number(destinationDay?.profitAndLoss?.expenses?.openingStock) === 400,
    JSON.stringify(destinationDay?.profitAndLoss?.expenses));
  assert('Transfer does not get added to source closing stock',
    Number(sourceDay?.profitAndLoss?.incomes?.closingStock) === 800,
    JSON.stringify(sourceDay?.profitAndLoss?.incomes));
  assert('Transfer does not get added to destination closing stock',
    Number(destinationDay?.profitAndLoss?.incomes?.closingStock) === 400,
    JSON.stringify(destinationDay?.profitAndLoss?.incomes));
  assert('Completed transfer is P&L-neutral at both locations',
    Number(sourceDay?.profitAndLoss?.summary?.costOfGoodsSold) === 0 &&
    Number(destinationDay?.profitAndLoss?.summary?.costOfGoodsSold) === 0 &&
    Number(sourceDay?.profitAndLoss?.netProfit) === 0 &&
    Number(destinationDay?.profitAndLoss?.netProfit) === 0,
    JSON.stringify({ source: sourceDay?.profitAndLoss?.summary, destination: destinationDay?.profitAndLoss?.summary }));

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Calcutta' });
  const currentSource = await statement(D0, today, sourceId);
  const currentDestination = await statement(D0, today, destinationId);
  assert('Short receipt and active in-transit balance keep source P&L neutral',
    Number(currentSource?.profitAndLoss?.summary?.costOfGoodsSold) === 0 &&
    Number(currentSource?.profitAndLoss?.netProfit) === 0,
    JSON.stringify(currentSource?.profitAndLoss?.summary));
  assert('Short receipt keeps destination P&L neutral',
    Number(currentDestination?.profitAndLoss?.summary?.costOfGoodsSold) === 0 &&
    Number(currentDestination?.profitAndLoss?.netProfit) === 0,
    JSON.stringify(currentDestination?.profitAndLoss?.summary));

} catch (error) {
  console.error(`\nFATAL: ${error instanceof Error ? error.stack : String(error)}`);
  failed++;
} finally {
  try {
    await cleanup();
  } catch (error) {
    console.error(`\nCLEANUP FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    failed++;
  }
  await pool.end();
}

console.log(`\n${'─'.repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);