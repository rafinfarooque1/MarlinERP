/**
 * Import Data × Location support + safe delete (rollback).
 * Run: node artifacts/api-server/tests/import-location-support.test.mjs
 *
 * Rules under test:
 *   Master templates (customers/vendors/ledgers) carry a REQUIRED Location
 *     column: blank = error, unknown name = error, valid name = record owned
 *     by that location.
 *   Party ledgers (CUST-) inherit the party's location stamp.
 *   Imported ledgers store location_type/location_id and the chart shows it.
 *   Transaction files carry an OPTIONAL Location cross-check column: a value
 *     naming a different location than the batch's picked location = error.
 *   Every record a batch CREATES is stamped import_batch_id; batches expose
 *     a human display id (IMP000123) and a location name.
 *   Rollback (Delete) returns per-type removedCounts + automatic verification
 *     (books balanced, zero leftover stamps) and writes a rich audit entry.
 *   Rollback is refused (403) for roles below level 2 even WITH the page
 *     delete right.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZIMPLOC fixtures and deletes every one of them at the end.
 */

import pg from 'pg';
import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZIMPLOC';
const WH = 2; // Marlin Mangaluru Depot — same warehouse the other suites use

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}
const r2 = (n) => Math.round(n * 100) / 100;

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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

async function snapshotTB() {
  const res = await get('/accounts/trial-balance');
  const rows = res.data?.rows ?? [];
  return {
    totalDr: r2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    totalCr: r2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
  };
}

async function uploadXlsx(module, headers, rows, extraQs = '') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const r = await fetch(`${BASE}/imports/parse?module=${module}&filename=${TAG}-${module}.xlsx${extraQs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  return { status: r.status, data: await r.json() };
}

const fixtures = { vendorId: 0, itemId: 0, whName: '' };
const createdPurchases = [];
const batchIds = { customers: 0, ledgers: 0, sales: 0 };

async function cleanup() {
  for (const id of Object.values(batchIds)) {
    if (id) await post(`/imports/batches/${id}/rollback`, {}).catch(() => {});
  }
  batchIds.customers = batchIds.ledgers = batchIds.sales = 0;
  // Stragglers from a half-dead run
  const { rows: stray } = await sql(
    `SELECT id, invoice_number FROM sales WHERE legacy_invoice_number LIKE $1`, [`${TAG}%`]);
  for (const s of stray) {
    await sql(`DELETE FROM receipts WHERE voucher_number = $1`, [s.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [s.id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [s.id]);
  }
  for (const id of createdPurchases) { await del(`/purchases/${id}`).catch(() => {}); }
  createdPurchases.length = 0;
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  if (fixtures.itemId) {
    await sql(`DELETE FROM stock_batches WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
    await sql(`DELETE FROM stock_entries WHERE item_id = $1 AND material_type = 'item'`, [fixtures.itemId]);
  }
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM opening_balances WHERE ledger_id IN (SELECT id FROM account_ledgers WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM import_rows WHERE batch_id IN (SELECT id FROM import_batches WHERE filename LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM import_batches WHERE filename LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM employees WHERE username LIKE $1`, [`${TAG.toLowerCase()}%`]);
  await sql(`DELETE FROM permissions WHERE hierarchy_id IN (SELECT id FROM hierarchies WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM hierarchies WHERE name LIKE $1 AND reports_to_id IS NOT NULL ORDER BY level DESC`, [`${TAG}%`]).catch(async () => {
    // ORDER BY not valid in DELETE — delete children first the manual way
    const { rows } = await sql(`SELECT id FROM hierarchies WHERE name LIKE $1 ORDER BY level DESC`, [`${TAG}%`]);
    for (const h of rows) await sql(`DELETE FROM hierarchies WHERE id = $1`, [h.id]);
  });
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

const loginRes = await post('/auth/login', { username: 'admin', password: process.env.TEST_ADMIN_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup();
const tbBefore = await snapshotTB();
fixtures.whName = (await sql(`SELECT name FROM warehouses WHERE id = $1`, [WH])).rows[0].name;

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Sample templates carry the Location column');

for (const mod of ['customers', 'vendors', 'ledgers', 'sales', 'receipts']) {
  const r = await fetch(`${BASE}/imports/templates/${mod}`, { headers: { Authorization: `Bearer ${authToken}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const headers = [];
  ws.getRow(1).eachCell((c) => headers.push(String(c.value ?? '')));
  assert(`${mod} template has a Location column`, headers.some((h) => /location/i.test(h)), JSON.stringify(headers));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] Customer import — Location is required, validated and scope-checked');

{
  const up = await uploadXlsx('customers',
    ['Name', 'Location', 'Opening Balance', 'Dr/Cr'],
    [
      [`${TAG} NoLoc Trader`, '', 1000, 'Dr'],
      [`${TAG} BadLoc Trader`, 'Atlantis Depot', 0, ''],
      [`${TAG} HO Trader`, 'Head Office', 500, 'Dr'],
      [`${TAG} Depot Trader`, fixtures.whName, 0, ''],
    ]);
  batchIds.customers = up.data.batch?.id ?? 0;
  assert('File parses into a batch', batchIds.customers > 0, `status=${up.status} ${JSON.stringify(up.data).slice(0, 200)}`);
  const rows = up.data.rows ?? [];
  const byName = (n) => rows.find((r) => (r.values?.name ?? r.values?.Name ?? '').includes(n));
  const noLoc = byName('NoLoc'), badLoc = byName('BadLoc'), ho = byName('HO Trader'), depot = byName('Depot');
  assert('Blank Location row is an error', noLoc?.status === 'error' && /location is required/i.test(noLoc?.reason ?? ''), JSON.stringify(noLoc).slice(0, 200));
  assert('Unknown location name is an error', badLoc?.status === 'error' && /does not match/i.test(badLoc?.reason ?? ''), JSON.stringify(badLoc).slice(0, 200));
  assert('Head Office row is valid', ho && ho.status !== 'error', JSON.stringify(ho).slice(0, 200));
  assert('Warehouse-name row is valid', depot && depot.status !== 'error', JSON.stringify(depot).slice(0, 200));

  const dispId = up.data.batch?.displayId ?? '';
  assert('Batch carries an IMP display id', new RegExp(`^IMP\\d{6}$`).test(dispId) && dispId === `IMP${String(batchIds.customers).padStart(6, '0')}`, dispId);

  const commit = await post(`/imports/batches/${batchIds.customers}/commit`, {});
  assert('Commit imports the 2 valid rows', commit.status === 200 && commit.data?.batch?.importedRows === 2, JSON.stringify(commit.data).slice(0, 250));

  const { rows: custs } = await sql(
    `SELECT name, location_type, location_id, import_batch_id FROM customers WHERE name LIKE $1 ORDER BY name`, [`${TAG}%`]);
  assert('Only the 2 valid customers were created', custs.length === 2, JSON.stringify(custs));
  const hoC = custs.find((c) => c.name.includes('HO Trader'));
  const depC = custs.find((c) => c.name.includes('Depot Trader'));
  assert('HO customer is owned by Head Office', hoC?.location_type === 'headoffice', JSON.stringify(hoC));
  assert('Depot customer is owned by the warehouse', depC?.location_type === 'warehouse' && Number(depC?.location_id) === WH, JSON.stringify(depC));
  assert('Both created customers carry the batch stamp', custs.every((c) => Number(c.import_batch_id) === batchIds.customers), JSON.stringify(custs));

  const { rows: leds } = await sql(
    `SELECT name, code, location_type, location_id, import_batch_id FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'CUST-%'`, [`${TAG}%`]);
  assert('Party ledgers were provisioned for both', leds.length === 2, JSON.stringify(leds));
  assert('Party ledgers inherit the party location', leds.every((l) => l.location_type != null), JSON.stringify(leds));
  assert('Party ledgers carry the batch stamp', leds.every((l) => Number(l.import_batch_id) === batchIds.customers), JSON.stringify(leds));

  const hist = await get('/imports/batches');
  const b = (hist.data?.batches ?? []).find((x) => x.id === batchIds.customers);
  assert('History exposes displayId and locationName', b && b.displayId === dispId && 'locationName' in b, JSON.stringify(b).slice(0, 200));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] Ledger import — Location required, stored and shown on the chart');

{
  const up = await uploadXlsx('ledgers',
    ['Ledger Name', 'Ledger Group', 'Location', 'Opening Balance', 'Dr/Cr'],
    [
      [`${TAG} Depot Electricity`, 'Indirect Expense', fixtures.whName, 250, 'Dr'],
      [`${TAG} NoLoc Expense`, 'Indirect Expense', '', 0, ''],
    ]);
  batchIds.ledgers = up.data.batch?.id ?? 0;
  const rows = up.data.rows ?? [];
  const good = rows.find((r) => JSON.stringify(r.values).includes('Depot Electricity'));
  const bad = rows.find((r) => JSON.stringify(r.values).includes('NoLoc Expense'));
  assert('Located ledger row is valid', good && good.status !== 'error', JSON.stringify(good).slice(0, 200));
  assert('Blank-location ledger row is an error', bad?.status === 'error' && /location is required/i.test(bad?.reason ?? ''), JSON.stringify(bad).slice(0, 200));

  const commit = await post(`/imports/batches/${batchIds.ledgers}/commit`, {});
  assert('Ledger commit imports 1 row', commit.status === 200 && commit.data?.batch?.importedRows === 1, JSON.stringify(commit.data).slice(0, 200));

  const { rows: [led] } = await sql(
    `SELECT id, location_type, location_id, import_batch_id FROM account_ledgers WHERE name = $1`, [`${TAG} Depot Electricity`]);
  assert('Imported ledger stores its owning location', led?.location_type === 'warehouse' && Number(led?.location_id) === WH, JSON.stringify(led));
  assert('Imported ledger carries the batch stamp', Number(led?.import_batch_id) === batchIds.ledgers, JSON.stringify(led));
  const { rows: [ob] } = await sql(`SELECT import_batch_id FROM opening_balances WHERE ledger_id = $1`, [led?.id]);
  assert('Its opening balance carries the batch stamp too', Number(ob?.import_batch_id) === batchIds.ledgers, JSON.stringify(ob));

  const chart = await get('/accounts/chart');
  const findNode = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.name === `${TAG} Depot Electricity`) return n;
      const hit = findNode(n.children);
      if (hit) return hit;
    }
    return null;
  };
  const node = findNode(chart.data);
  assert('Chart of Accounts shows the ledger location', node?.locationName === fixtures.whName, JSON.stringify({ got: node?.locationName, want: fixtures.whName }));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Sales import — optional Location column must match the batch location');

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZLOC1234V1Z5') RETURNING id`,
  [`${TAG} Import Vendor`])).rows[0].id;
fixtures.itemId = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,200,'FG-ZZLOC-01','2900000000133','active') RETURNING id`,
  [`${TAG} Import Item`])).rows[0].id;
{
  const res = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: '2026-07-30',
    locationType: 'warehouse', locationId: WH,
    lineItems: [{ materialType: 'item', materialId: fixtures.itemId, quantity: 20, unitCost: 50, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
  });
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  assert('Stock purchased for the import item', res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

{
  const up = await uploadXlsx('sales',
    ['Invoice No', 'Date', 'Customer', 'Item', 'Qty', 'Unit', 'Price', 'Payment Mode', 'Location'],
    [
      [`${TAG}/OLD/1`, '2026-08-04', `${TAG} HO Trader`, `${TAG} Import Item`, 1, 'KG', 200, 'Cash', fixtures.whName],
      [`${TAG}/OLD/2`, '2026-08-04', `${TAG} HO Trader`, `${TAG} Import Item`, 1, 'KG', 200, 'Cash', 'Head Office'],
      [`${TAG}/OLD/3`, '2026-08-04', `${TAG} HO Trader`, `${TAG} Import Item`, 1, 'KG', 200, 'Cash', 'Atlantis Depot'],
    ],
    `&locationType=warehouse&locationId=${WH}`);
  batchIds.sales = up.data.batch?.id ?? 0;
  const rows = up.data.rows ?? [];
  const byInv = (n) => rows.find((r) => JSON.stringify(r.values).includes(`OLD/${n}`));
  assert('Matching-location row is valid', byInv(1) && byInv(1).status !== 'error', JSON.stringify(byInv(1)).slice(0, 250));
  assert('Different-location row is an error', byInv(2)?.status === 'error' && /does not match/.test(byInv(2)?.reason ?? ''), JSON.stringify(byInv(2)).slice(0, 250));
  assert('Unknown-location row is an error', byInv(3)?.status === 'error', JSON.stringify(byInv(3)).slice(0, 250));

  const commit = await post(`/imports/batches/${batchIds.sales}/commit`, {});
  assert('Sales commit imports the valid invoice', commit.status === 200 && commit.data?.batch?.importedRows === 1, JSON.stringify(commit.data).slice(0, 250));

  const { rows: [sale] } = await sql(
    `SELECT id, invoice_number, import_batch_id FROM sales WHERE legacy_invoice_number = $1`, [`${TAG}/OLD/1`]);
  assert('Imported sale carries the batch stamp', Number(sale?.import_batch_id) === batchIds.sales, JSON.stringify(sale));
  const { rows: [rcpt] } = await sql(
    `SELECT import_batch_id FROM receipts WHERE voucher_number = $1`, [sale?.invoice_number]);
  assert('Its sale receipt carries the batch stamp', Number(rcpt?.import_batch_id) === batchIds.sales, JSON.stringify(rcpt));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] Delete is role-restricted — page right alone is NOT enough');

{
  const rootId = (await sql(`SELECT id FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`)).rows[0].id;
  const mk = await post('/hr/hierarchies', { name: `${TAG} Mid`, reportsToId: rootId, description: 'test fixture' });
  const midId = mk.data?.id;
  const mk2 = await post('/hr/hierarchies', { name: `${TAG} Clerk`, reportsToId: midId, description: 'test fixture' });
  const clerkHier = mk2.data?.id;
  assert('Level-3 test role created', !!clerkHier, JSON.stringify(mk2.data).slice(0, 150));

  // Give the level-3 role FULL page rights on Import Data — the role gate
  // must still refuse.
  await post('/company/permissions', { hierarchyId: clerkHier, module: 'page:/company/import', canView: true, canAdd: true, canEdit: true, canDelete: true, canDownload: true });
  const hash = bcrypt.hashSync('marlin1458', 10);
  await sql(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, must_change_password, is_active)
     VALUES ($1, $2, $3, $4, 'warehouse', $5, 10000, '2026-01-01', false, true)`,
    [`${TAG} Clerk`, `${TAG.toLowerCase()}_clerk`, hash, clerkHier, WH]);
  const clerkTok = (await post('/auth/login', { username: `${TAG.toLowerCase()}_clerk`, password: 'marlin1458' })).data?.token ?? '';
  assert('Clerk can log in', !!clerkTok);

  const attempt = await post(`/imports/batches/${batchIds.sales}/rollback`, {}, clerkTok);
  assert('Level-3 user is refused with 403 despite page delete right', attempt.status === 403 && /admin or management/i.test(attempt.data?.error ?? ''), `status=${attempt.status} ${JSON.stringify(attempt.data).slice(0, 150)}`);
  const { rows: [still] } = await sql(`SELECT status FROM import_batches WHERE id = $1`, [batchIds.sales]);
  assert('Batch is untouched after the refusal', still?.status === 'committed', JSON.stringify(still));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[6] Admin delete — counts, verification and audit trail');

{
  const rb = await post(`/imports/batches/${batchIds.sales}/rollback`, {});
  assert('Sales batch delete succeeds', rb.status === 200, JSON.stringify(rb.data).slice(0, 250));
  assert('Response reports 1 sale removed', rb.data?.removedCounts?.sales === 1, JSON.stringify(rb.data?.removedCounts));
  assert('Response reports the receipt removed', (rb.data?.removedCounts?.receipts ?? 0) >= 1, JSON.stringify(rb.data?.removedCounts));
  assert('Automatic verification passed', rb.data?.verification?.ok === true, JSON.stringify(rb.data?.verification));
  assert('Verification confirms books balanced', rb.data?.verification?.booksBalanced === true, JSON.stringify(rb.data?.verification));
  assert('Verification confirms zero leftover stamps', rb.data?.verification?.leftoverStamps === 0, JSON.stringify(rb.data?.verification));
  const { rows: gone } = await sql(`SELECT id FROM sales WHERE import_batch_id = $1`, [batchIds.sales]);
  assert('No sale still carries the batch stamp', gone.length === 0, JSON.stringify(gone));

  const dispId = `IMP${String(batchIds.sales).padStart(6, '0')}`;
  await new Promise((r) => setTimeout(r, 700)); // audit write is fire-and-forget
  const { rows: [audit] } = await sql(
    `SELECT description, metadata FROM activity_log
      WHERE module = 'imports' AND action = 'DELETE' AND entity_id = $1
      ORDER BY id DESC LIMIT 1`, [batchIds.sales]);
  assert('Audit entry names the display id', (audit?.description ?? '').includes(dispId), (audit?.description ?? '').slice(0, 200));
  assert('Audit metadata carries counts + verification', audit?.metadata?.removedCounts?.sales === 1 && audit?.metadata?.verification?.ok === true, JSON.stringify(audit?.metadata ?? null).slice(0, 250));
  batchIds.sales = 0;
}

{
  const rb = await post(`/imports/batches/${batchIds.ledgers}/rollback`, {});
  assert('Ledger batch delete succeeds', rb.status === 200, JSON.stringify(rb.data).slice(0, 250));
  assert('Counts report the ledger and its opening balance', rb.data?.removedCounts?.ledgers === 1 && rb.data?.removedCounts?.openingBalances === 1, JSON.stringify(rb.data?.removedCounts));
  assert('Verification passed', rb.data?.verification?.ok === true, JSON.stringify(rb.data?.verification));
  batchIds.ledgers = 0;
}

{
  const rb = await post(`/imports/batches/${batchIds.customers}/rollback`, {});
  assert('Customer batch delete succeeds', rb.status === 200, JSON.stringify(rb.data).slice(0, 250));
  assert('Counts report 2 customers and their 2 ledgers', rb.data?.removedCounts?.customers === 2 && rb.data?.removedCounts?.ledgers === 2, JSON.stringify(rb.data?.removedCounts));
  assert('Verification passed', rb.data?.verification?.ok === true, JSON.stringify(rb.data?.verification));
  const { rows: left } = await sql(`SELECT id FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  assert('The imported customers are gone', left.length === 0, JSON.stringify(left));
  batchIds.customers = 0;
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[7] Books end where they started');

await cleanup();
const tbAfter = await snapshotTB();
assert('Trial balance Dr unchanged', Math.abs(tbAfter.totalDr - tbBefore.totalDr) < 0.02, `${tbBefore.totalDr} → ${tbAfter.totalDr}`);
assert('Trial balance Cr unchanged', Math.abs(tbAfter.totalCr - tbBefore.totalCr) < 0.02, `${tbBefore.totalCr} → ${tbAfter.totalCr}`);
assert('Trial balance still balances', Math.abs(tbAfter.totalDr - tbAfter.totalCr) < 0.02, `${tbAfter.totalDr} vs ${tbAfter.totalCr}`);

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) { console.log('Failed:'); failures.forEach((f) => console.log(`  - ${f}`)); }
await pool.end();
process.exit(failed > 0 ? 1 : 0);
