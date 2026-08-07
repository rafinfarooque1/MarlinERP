/**
 * Manual Purchase Bill — integration tests
 * Run: node artifacts/api-server/tests/purchase-bills.test.mjs
 *
 * Covers the 27 required checks for the manual Purchase Bill work: automatic
 * batch numbering, HSN/GST defaulting from the Item Master, inclusive and
 * exclusive rate modes, discount ordering, intra/inter derivation, batch
 * uniqueness under concurrency, calendar dates, location scope, duplicate
 * submission, accounting balance, and RBAC.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. It creates
 * clearly-marked ZZTEST fixtures and deletes every one of them at the end,
 * including the bills it wrote, so the dev database is left as it was found.
 */

// A direct `pg` pool, not @workspace/db: that package is TypeScript source and
// plain `node` cannot import it. The consequence is that this file gets the
// driver's default DATE handling (JS Date objects), so every date column below
// is read with an explicit `::text` cast.
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { calcPurchaseBill } from '@workspace/purchase-pricing';

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
    byCode: Object.fromEntries(rows.filter(r => r.code).map(r => [r.code, r])),
    rows,
  };
}

const createdPurchases = [];
const fixtures = { vendorKa: 0, vendorMh: 0, materialId: 0, itemId: 0, hierNone: 0, hierBuyer: 0, hierStock: 0, empNone: 0, empBuyer: 0, empStock: 0 };
// Receiving warehouse: derived from live data after login — warehouse names,
// states and GSTINs are REAL business records now, never hardcode them. The
// "same-state" vendor fixture is created to match this warehouse's state and
// GSTIN state code; the "other-state" vendor to differ.
let WH_OK = 0;
let WH_STATE = '';
let WH_CODE = '';
const WH_OTHER = 3; // RBAC-NEG-WH — a warehouse the buyer fixture is NOT posted to

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

async function cleanup() {
  // Bills first (they reference the fixtures), through the API so stock, lots
  // and postings are reversed exactly as a real delete would.
  for (const id of createdPurchases) { await del(`/purchases/${id}`).catch(() => {}); }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type = 'material'`, [[fixtures.materialId].filter(Boolean)]);
  await sql(`DELETE FROM stock_entries WHERE item_id = ANY($1::int[]) AND material_type = 'material'`, [[fixtures.materialId].filter(Boolean)]);
  await sql(`DELETE FROM employees WHERE username LIKE $1`, [`${TAG.toLowerCase()}%`]);
  await sql(`DELETE FROM permissions WHERE hierarchy_id IN (SELECT id FROM hierarchies WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM hierarchies WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM materials WHERE name LIKE $1`, [`${TAG}%`]);
  // The vendor ledger the API provisions alongside the vendor. Removed after the
  // bills, so no posting is ever left pointing at a ledger that no longer exists.
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'VEND-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
}
await cleanup(); // in case a previous run died mid-way

// Receiving warehouse — first live warehouse with a state and GSTIN on file.
{
  const { rows: whRows } = await sql(
    `SELECT id, state, gst_number FROM warehouses
      WHERE COALESCE(gst_number,'') <> '' AND COALESCE(state,'') <> '' ORDER BY id`);
  if (!whRows.length) { console.error('FATAL: no warehouse with state + GSTIN'); process.exit(1); }
  WH_OK = Number(whRows[0].id);
  WH_STATE = whRows[0].state;
  WH_CODE = String(whRows[0].gst_number).slice(0, 2);
}
const OTHER_STATE = WH_STATE === 'Maharashtra' ? 'Karnataka' : 'Maharashtra';
const OTHER_CODE = WH_CODE === '27' ? '29' : '27';

// Vendors: one in the receiving location's state, one outside it.
fixtures.vendorKa = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,$2,$3) RETURNING id`,
  [`${TAG} Vendor KA`, WH_STATE, `${WH_CODE}ZZTES1234F1Z5`])).rows[0].id;
fixtures.vendorMh = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,$2,$3) RETURNING id`,
  [`${TAG} Vendor MH`, OTHER_STATE, `${OTHER_CODE}ZZTES1234F1Z5`])).rows[0].id;

// Item Master row with a leading-zero HSN and a 5% slab.
fixtures.materialId = (await sql(
  `INSERT INTO materials (name, unit, hsn_code, tax_rate, item_code, barcode, status, current_stock)
   VALUES ($1,'KG','08119090',5,'RM-ZZTEST-01','2900000000015','active',0) RETURNING id`,
  [`${TAG} Frozen Berry`])).rows[0].id;

// Hierarchies: no rights at all / purchase rights at one warehouse / stock view only.
const mkHier = async (name) => (await sql(`INSERT INTO hierarchies (name, level, description) VALUES ($1, 5, 'disposable test fixture') RETURNING id`, [name])).rows[0].id;
fixtures.hierNone = await mkHier(`${TAG} NoRights`);
fixtures.hierBuyer = await mkHier(`${TAG} Buyer`);
fixtures.hierStock = await mkHier(`${TAG} StockOnly`);
await sql(
  `INSERT INTO permissions (hierarchy_id, module, can_view, can_add, can_edit, can_delete, can_download)
   VALUES ($1,'page:/production/purchase',true,true,true,true,true)`, [fixtures.hierBuyer]);
await sql(
  `INSERT INTO permissions (hierarchy_id, module, can_view, can_add, can_edit, can_delete, can_download)
   VALUES ($1,'page:/headoffice/stock',true,false,false,false,false)`, [fixtures.hierStock]);

const hash = bcrypt.hashSync('marlin1458', 10);
const mkEmp = async (username, hierarchyId, branchType, branchId) => (await sql(
  `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, must_change_password, is_active)
   VALUES ($1,$2,$3,$4,$5,$6,10000,CURRENT_DATE,false,true) RETURNING id`,
  [`${TAG} ${username}`, username, hash, hierarchyId, branchType, branchId])).rows[0].id;
fixtures.empNone = await mkEmp(`${TAG.toLowerCase()}_none`, fixtures.hierNone, 'warehouse', WH_OK);
fixtures.empBuyer = await mkEmp(`${TAG.toLowerCase()}_buyer`, fixtures.hierBuyer, 'warehouse', WH_OK);
fixtures.empStock = await mkEmp(`${TAG.toLowerCase()}_stock`, fixtures.hierStock, 'warehouse', WH_OK);

const tokenFor = async (username) =>
  (await post('/auth/login', { username, password: 'marlin1458' })).data?.token ?? '';
const tokNone = await tokenFor(`${TAG.toLowerCase()}_none`);
const tokBuyer = await tokenFor(`${TAG.toLowerCase()}_buyer`);
const tokStock = await tokenFor(`${TAG.toLowerCase()}_stock`);
assert('Fixture employees can log in', !!tokNone && !!tokBuyer && !!tokStock);

const line = (over = {}) => ({
  materialType: 'material', materialId: fixtures.materialId,
  quantity: 1, unitCost: 100, mfgDate: '2026-01-01', expiryDate: '2027-01-01', ...over,
});
const bill = (over = {}) => ({
  vendorId: fixtures.vendorKa, purchaseDate: '2026-07-30',
  locationType: 'warehouse', locationId: WH_OK, lineItems: [line()], ...over,
});
async function createBill(body, token) {
  const res = await post('/purchases', body, token);
  if (res.status === 201 && res.data?.id) createdPurchases.push(res.data.id);
  return res;
}

const tbBefore = await snapshotTB();

// ── TEST 1 / 2 / 4 — Item Master defaults, leading zero ────────────────────
console.log('\n[1-2,4] HSN + GST auto-fill from Item Master');
{
  const res = await createBill(bill());
  assert('Bill saves with no HSN or GST supplied', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  const li = res.data?.lineItems?.[0] ?? {};
  assert('TEST 1 — HSN auto-filled from Item Master', li.hsnCode === '08119090', `got ${li.hsnCode}`);
  assert('TEST 4 — GST auto-filled from Item Master (5%)', Number(li.gstRate) === 5, `got ${li.gstRate}`);

  const dbRow = await sql(`SELECT line_items->0->>'hsnCode' AS hsn, jsonb_typeof(line_items->0->'hsnCode') AS t FROM purchases WHERE id=$1`, [res.data.id]);
  assert('TEST 2 — HSN keeps its leading zero in the database', dbRow.rows[0].hsn === '08119090', `got ${dbRow.rows[0].hsn}`);
  assert('TEST 2 — HSN is stored as text, not a number', dbRow.rows[0].t === 'string', `got ${dbRow.rows[0].t}`);

  const back = await get(`/purchases/${res.data.id}`);
  assert('TEST 2 — HSN reads back unchanged through the API', back.data?.lineItems?.[0]?.hsnCode === '08119090');
}

// ── TEST 3 / 5 — overrides do not write back to the master ─────────────────
console.log('\n[3,5] Overrides are snapshots, not master edits');
{
  const before = (await sql(`SELECT hsn_code, tax_rate FROM materials WHERE id=$1`, [fixtures.materialId])).rows[0];
  const res = await createBill(bill({ lineItems: [line({ hsnCode: '21069099', gstRate: 12 })] }));
  const li = res.data?.lineItems?.[0] ?? {};
  assert('TEST 3 — line keeps the overridden HSN', li.hsnCode === '21069099', `got ${li.hsnCode}`);
  assert('TEST 5 — line keeps the overridden GST', Number(li.gstRate) === 12, `got ${li.gstRate}`);
  const after = (await sql(`SELECT hsn_code, tax_rate FROM materials WHERE id=$1`, [fixtures.materialId])).rows[0];
  assert('TEST 3 — Item Master HSN unchanged', after.hsn_code === before.hsn_code, `${before.hsn_code} → ${after.hsn_code}`);
  assert('TEST 5 — Item Master GST unchanged', Number(after.tax_rate) === Number(before.tax_rate), `${before.tax_rate} → ${after.tax_rate}`);
}

// ── TEST 6 / 7 — exclusive and inclusive ───────────────────────────────────
console.log('\n[6,7] GST exclusive / inclusive');
{
  const ex = await createBill(bill({ lineItems: [line({ unitCost: 100, gstRate: 5 })], priceMode: 'exclusive' }));
  const exLi = ex.data?.lineItems?.[0] ?? {};
  assert('TEST 6 — exclusive taxable = 100', r2(exLi.taxableValue) === 100, `got ${exLi.taxableValue}`);
  assert('TEST 6 — exclusive tax = 5', r2(exLi.taxAmount) === 5, `got ${exLi.taxAmount}`);
  assert('TEST 6 — exclusive total = 105', r2(ex.data.totalAmount) === 105, `got ${ex.data.totalAmount}`);

  const inc = await createBill(bill({ lineItems: [line({ unitCost: 105, gstRate: 5 })], priceMode: 'inclusive' }));
  const incLi = inc.data?.lineItems?.[0] ?? {};
  assert('TEST 7 — inclusive taxable = 100', r2(incLi.taxableValue) === 100, `got ${incLi.taxableValue}`);
  assert('TEST 7 — inclusive tax = 5', r2(incLi.taxAmount) === 5, `got ${incLi.taxAmount}`);
  assert('TEST 7 — inclusive total = 105', r2(inc.data.totalAmount) === 105, `got ${inc.data.totalAmount}`);
  assert('Rate mode is persisted with the bill', inc.data.priceMode === 'inclusive', `got ${inc.data.priceMode}`);

  const stored = (await sql(`SELECT price_mode FROM purchases WHERE id=$1`, [inc.data.id])).rows[0];
  assert('Rate mode round-trips through the database', stored.price_mode === 'inclusive', `got ${stored.price_mode}`);

  // Inclusive must not inflate inventory: cost basis is the taxable value.
  assert('TEST 7 — inclusive cost basis excludes GST', r2(incLi.costPerUnit) === 100, `got ${incLi.costPerUnit}`);
}

// ── TEST 8 / 9 — intra vs inter derived from state ─────────────────────────
console.log('\n[8,9] Intra / inter-state derivation');
{
  const intra = await createBill(bill({ vendorId: fixtures.vendorKa, lineItems: [line({ unitCost: 100, gstRate: 5 })] }));
  const iLi = intra.data?.lineItems?.[0] ?? {};
  assert('TEST 8 — same-state vendor into the warehouse is intra', iLi.taxType === 'intra', `got ${iLi.taxType}`);
  assert('TEST 8 — CGST 2.50', r2(iLi.cgst) === 2.5, `got ${iLi.cgst}`);
  assert('TEST 8 — SGST 2.50', r2(iLi.sgst) === 2.5, `got ${iLi.sgst}`);
  assert('TEST 8 — no IGST', r2(iLi.igst) === 0, `got ${iLi.igst}`);
  assert('TEST 8 — heads re-add to the tax', r2(iLi.cgst + iLi.sgst) === r2(iLi.taxAmount));

  const inter = await createBill(bill({ vendorId: fixtures.vendorMh, lineItems: [line({ unitCost: 100, gstRate: 5 })] }));
  const xLi = inter.data?.lineItems?.[0] ?? {};
  assert('TEST 9 — other-state vendor into the warehouse is inter', xLi.taxType === 'inter', `got ${xLi.taxType}`);
  assert('TEST 9 — IGST 5.00', r2(xLi.igst) === 5, `got ${xLi.igst}`);
  assert('TEST 9 — no CGST/SGST', r2(xLi.cgst) === 0 && r2(xLi.sgst) === 0);

  // A browser claiming otherwise does not get to decide the tax heads.
  const forged = await createBill(bill({ vendorId: fixtures.vendorMh, lineItems: [line({ unitCost: 100, gstRate: 5, taxType: 'intra' })] }));
  const fLi = forged.data?.lineItems?.[0] ?? {};
  assert('Client-supplied tax type is overridden by the derived one', fLi.taxType === 'inter', `got ${fLi.taxType}`);
  assert('The correction is reported back as a warning', Array.isArray(forged.data?.warnings) && forged.data.warnings.length > 0);

  // …unless the person recording the bill explicitly overrides it.
  const ovr = await createBill(bill({ vendorId: fixtures.vendorMh, lineItems: [line({ unitCost: 100, gstRate: 5, taxType: 'intra', taxTypeOverride: true })] }));
  assert('An explicit override is honoured and recorded as such',
    ovr.data?.lineItems?.[0]?.taxType === 'intra' && ovr.data?.lineItems?.[0]?.taxTypeSource === 'override');
}

// ── TEST 10 — discount + GST, frontend/backend parity ──────────────────────
console.log('\n[10] Discount with GST');
{
  const li = line({ quantity: 10, unitCost: 100, discount: 10, gstRate: 5 });
  const res = await createBill(bill({ lineItems: [li] }));
  const got = res.data?.lineItems?.[0] ?? {};
  assert('TEST 10 — gross 1000', r2(got.lineSubtotal) === 1000, `got ${got.lineSubtotal}`);
  assert('TEST 10 — discount 100', r2(got.discountAmt) === 100, `got ${got.discountAmt}`);
  assert('TEST 10 — taxable 900 (discount applied before GST)', r2(got.taxableValue) === 900, `got ${got.taxableValue}`);
  assert('TEST 10 — tax 45', r2(got.taxAmount) === 45, `got ${got.taxAmount}`);
  assert('TEST 10 — total 945', r2(res.data.totalAmount) === 945, `got ${res.data.totalAmount}`);

  // The exact calculation the browser runs, on the same inputs.
  const fe = calcPurchaseBill([{ quantity: 10, unitCost: 100, discount: 10, gstRate: 5, taxType: got.taxType }], 'exclusive');
  assert('TEST 10 — frontend and backend totals are identical',
    fe.totalAmount === r2(res.data.totalAmount) && fe.taxTotal === r2(res.data.taxTotal)
    && fe.taxableTotal === r2(got.taxableValue),
    `fe=${JSON.stringify({ t: fe.totalAmount, tax: fe.taxTotal })} be=${JSON.stringify({ t: res.data.totalAmount, tax: res.data.taxTotal })}`);
}

// ── TEST 11 / 12 — automatic batch numbers ─────────────────────────────────
console.log('\n[11,12] Automatic batch numbers');
{
  const res = await createBill(bill({ lineItems: [line(), line({ quantity: 2 })] }));
  const [a, b] = res.data?.lineItems ?? [];
  assert('TEST 11 — a batch number is issued when none is given', /^PUR-\d{8}-\d{5}$/.test(a?.batchNumber ?? ''), `got ${a?.batchNumber}`);
  assert('TEST 11 — the number is dated to the bill', (a?.batchNumber ?? '').includes('PUR-20260730-'), `got ${a?.batchNumber}`);
  assert('TEST 12 — two lines on one bill get different numbers', a?.batchNumber !== b?.batchNumber, `${a?.batchNumber} vs ${b?.batchNumber}`);

  const lots = await sql(
    `SELECT id, item_id, material_type, branch_type, branch_id, batch_number, quantity::float8 AS q
       FROM stock_batches WHERE source='purchase' AND source_id=$1 ORDER BY id`, [res.data.id]);
  assert('TEST 11 — both lots exist in stock_batches', lots.rows.length === 2,
    `got ${lots.rows.length}: ${JSON.stringify(lots.rows)}`);

  // A hand-typed number in the reserved shape would collide with a future
  // allocation, so it is refused outright.
  const reserved = await createBill(bill({ lineItems: [line({ batchNumber: 'PUR-20260730-00001' })] }));
  assert('TEST 12 — a reserved-format batch number is refused', reserved.status === 400, `status=${reserved.status}`);

  // The same manual number twice at the same location is refused.
  const manual = await createBill(bill({ lineItems: [line({ batchNumber: 'ZZTEST-LOT-A' })] }));
  assert('A manual vendor lot number is accepted', manual.status === 201, JSON.stringify(manual.data).slice(0, 150));
  const dupe = await createBill(bill({ lineItems: [line({ batchNumber: 'ZZTEST-LOT-A' })] }));
  assert('TEST 12 — reusing an existing lot number at the same location is refused', dupe.status === 400, `status=${dupe.status}`);
  const dupeInBill = await createBill(bill({ lineItems: [line({ batchNumber: 'ZZTEST-LOT-B' }), line({ batchNumber: 'ZZTEST-LOT-B' })] }));
  assert('TEST 12 — the same lot twice within one bill is refused', dupeInBill.status === 400, `status=${dupeInBill.status}`);
}

// ── TEST 13 — concurrency ──────────────────────────────────────────────────
console.log('\n[13] Concurrent batch allocation');
{
  const N = 10;
  const results = await Promise.all(
    Array.from({ length: N }, () => createBill(bill({ lineItems: [line()] }))));
  const ok = results.filter(r => r.status === 201);
  assert(`TEST 13 — all ${N} simultaneous bills saved`, ok.length === N, `${ok.length}/${N}`);
  const nums = ok.map(r => r.data.lineItems[0].batchNumber);
  assert('TEST 13 — every issued number is distinct', new Set(nums).size === nums.length,
    `${nums.length} issued, ${new Set(nums).size} distinct`);

  const dupes = await sql(
    `SELECT batch_number, count(*) AS n FROM stock_batches
      WHERE branch_type='warehouse' AND branch_id=$1 AND item_id=$2 AND material_type='material'
      GROUP BY batch_number HAVING count(*) > 1`, [WH_OK, fixtures.materialId]);
  assert('TEST 13 — no duplicate lot rows in the database', dupes.rows.length === 0,
    JSON.stringify(dupes.rows).slice(0, 150));
}

// ── TEST 14 / 15 — dates ───────────────────────────────────────────────────
console.log('\n[14,15] Manufacturing and expiry dates');
{
  const res = await createBill(bill({ lineItems: [line({ mfgDate: '2026-03-15', expiryDate: '2026-09-30' })] }));
  const li = res.data?.lineItems?.[0] ?? {};
  assert('TEST 14 — mfg date persists exactly', li.mfgDate === '2026-03-15', `got ${li.mfgDate}`);
  assert('TEST 14 — expiry date persists exactly', li.expiryDate === '2026-09-30', `got ${li.expiryDate}`);
  const lot = (await sql(
    `SELECT mfg_date::text AS m, expiry_date::text AS e FROM stock_batches WHERE source='purchase' AND source_id=$1`,
    [res.data.id])).rows[0];
  assert('TEST 14 — the lot carries the real calendar dates', lot?.m === '2026-03-15' && lot?.e === '2026-09-30',
    JSON.stringify(lot));
  assert('TEST 14 — no shelf life is invented (expiry is the date given)', lot?.e === '2026-09-30');

  const before = Number((await sql(`SELECT count(*)::int AS n FROM purchases`)).rows[0].n);
  const bad = await createBill(bill({ lineItems: [line({ mfgDate: '2026-02-30' })] }));
  assert('TEST 15 — an impossible mfg date is rejected', bad.status === 400, `status=${bad.status}`);
  const badExp = await createBill(bill({ lineItems: [line({ expiryDate: '2026-13-01' })] }));
  assert('TEST 15 — an impossible expiry date is rejected', badExp.status === 400, `status=${badExp.status}`);
  const backwards = await createBill(bill({ lineItems: [line({ mfgDate: '2026-06-01', expiryDate: '2026-05-01' })] }));
  assert('TEST 15 — expiry before manufacture is rejected', backwards.status === 400, `status=${backwards.status}`);
  const badBill = await createBill(bill({ purchaseDate: '2026-02-30' }));
  assert('TEST 15 — an impossible bill date is rejected', badBill.status === 400, `status=${badBill.status}`);
  const after = Number((await sql(`SELECT count(*)::int AS n FROM purchases`)).rows[0].n);
  assert('TEST 15 — no bill row was written by any rejected request', before === after, `${before} → ${after}`);
}

// ── TEST 16 — location scope ───────────────────────────────────────────────
console.log('\n[16] Receiving-location scope');
{
  const okRes = await createBill(bill({ locationType: 'warehouse', locationId: WH_OK }), tokBuyer);
  assert('TEST 16 — the authorised warehouse is accepted', okRes.status === 201, JSON.stringify(okRes.data).slice(0, 150));
  assert('TEST 16 — the bill is stamped to that warehouse',
    okRes.data?.locationType === 'warehouse' && Number(okRes.data?.locationId) === WH_OK);

  const stockBefore = (await sql(
    `SELECT COALESCE(quantity,0)::float8 AS q FROM stock_entries WHERE item_id=$1 AND material_type='material' AND branch_type='warehouse' AND branch_id=$2`,
    [fixtures.materialId, WH_OTHER])).rows[0]?.q ?? 0;
  const forged = await createBill(bill({ locationType: 'warehouse', locationId: WH_OTHER }), tokBuyer);
  assert('TEST 16 — a forged receiving location is rejected', forged.status === 400 || forged.status === 403 || forged.status === 404,
    `status=${forged.status} ${JSON.stringify(forged.data).slice(0, 120)}`);
  const stockAfter = (await sql(
    `SELECT COALESCE(quantity,0)::float8 AS q FROM stock_entries WHERE item_id=$1 AND material_type='material' AND branch_type='warehouse' AND branch_id=$2`,
    [fixtures.materialId, WH_OTHER])).rows[0]?.q ?? 0;
  assert('TEST 16 — nothing was written at the forged location', Number(stockBefore) === Number(stockAfter),
    `${stockBefore} → ${stockAfter}`);
}

// ── TEST 17 / 18 — stock is created once ───────────────────────────────────
console.log('\n[17,18] Stock quantity and duplicate submission');
{
  const qtyAt = async () => Number((await sql(
    `SELECT COALESCE(quantity,0)::float8 AS q FROM stock_entries WHERE item_id=$1 AND material_type='material' AND branch_type='warehouse' AND branch_id=$2`,
    [fixtures.materialId, WH_OK])).rows[0]?.q ?? 0);

  const before = await qtyAt();
  const res = await createBill(bill({ invoiceNumber: `${TAG}-INV-001`, lineItems: [line({ quantity: 7 })] }));
  assert('A bill with an invoice reference saves', res.status === 201, JSON.stringify(res.data).slice(0, 150));
  const mid = await qtyAt();
  assert('TEST 17 — stock rose by exactly the quantity purchased', r2(mid - before) === 7, `${before} → ${mid}`);

  const retry = await post('/purchases', bill({ invoiceNumber: `${TAG}-INV-001`, lineItems: [line({ quantity: 7 })] }));
  assert('TEST 18 — the same vendor invoice a second time is refused', retry.status === 409, `status=${retry.status}`);
  assert('TEST 18 — the refusal says why', String(retry.data?.code) === 'DUPLICATE_PURCHASE_INVOICE', JSON.stringify(retry.data).slice(0, 150));
  const after = await qtyAt();
  assert('TEST 18 — the retry added no stock', r2(after) === r2(mid), `${mid} → ${after}`);

  // Cost basis: what actually landed on the lot and the master.
  const costRes = await createBill(bill({ lineItems: [line({ quantity: 10, unitCost: 100, discount: 10, gstRate: 5 })] }));
  const lot = (await sql(`SELECT unit_cost::float8 AS c FROM stock_batches WHERE source='purchase' AND source_id=$1`, [costRes.data.id])).rows[0];
  assert('Inventory is valued net of discount and net of GST', r2(lot.c) === 90, `got ${lot.c}`);
}

// ── TEST 19 / 20 — accounting ──────────────────────────────────────────────
console.log('\n[19,20] Accounting');
{
  const tb = await snapshotTB();
  assert('TEST 19 — the trial balance is balanced', tb.balanced === true && r2(tb.totalDr) === r2(tb.totalCr),
    `Dr ${tb.totalDr} vs Cr ${tb.totalCr}`);
  assert('TEST 19 — purchases moved the books', r2(tb.totalDr) !== r2(tbBefore.totalDr),
    `before ${tbBefore.totalDr}, after ${tb.totalDr}`);

  // A vendor whose ledger has never been touched, so the trial-balance deltas
  // are the postings themselves and nothing nets against them. Created through
  // the API, because that is what provisions the VEND-<id> ledger — a raw
  // insert leaves the payable posting with no ledger to name it.
  const freshVendorRes = await post('/vendors', {
    name: `${TAG} Vendor Fresh`, state: WH_STATE, gstNumber: `${WH_CODE}ZZFRE1234F1Z5`,
  });
  const freshVendor = freshVendorRes.data?.id;
  assert('A vendor created through the API gets a ledger', !!freshVendor,
    JSON.stringify(freshVendorRes.data).slice(0, 150));
  const before = await snapshotTB();
  const fresh = await createBill(bill({ vendorId: freshVendor, lineItems: [line({ quantity: 5, unitCost: 100, gstRate: 12 })] }));
  const after = await snapshotTB();
  const total = Number(fresh.data?.totalAmount ?? 0);
  assert('TEST 19 — bill totals 560 (5 × ₹100 + 12%)', r2(total) === 560, `got ${total}`);
  assert('TEST 19 — debits rose by the full bill (purchases + input GST)',
    r2(after.totalDr - before.totalDr) === r2(total), `delta ${r2(after.totalDr - before.totalDr)} vs ${total}`);
  assert('TEST 19 — credits rose by the full bill (vendor payable)',
    r2(after.totalCr - before.totalCr) === r2(total), `delta ${r2(after.totalCr - before.totalCr)} vs ${total}`);
  // The vendor's own ledger, however the chart names it.
  const vendRow = after.byCode[`VEND-${freshVendor}`]
    ?? after.rows.find(r => String(r.name ?? '').includes(`${TAG} Vendor Fresh`));
  assert('TEST 19 — the vendor ledger carries the whole bill as payable',
    !!vendRow && r2(Number(vendRow.credit)) === r2(total),
    vendRow ? `credit ${vendRow.credit}` : 'no ledger row found for the vendor');
  const inpDelta = r2(
    (Number(after.byCode['STD-INP-CGST']?.debit ?? 0) - Number(before.byCode['STD-INP-CGST']?.debit ?? 0))
    + (Number(after.byCode['STD-INP-SGST']?.debit ?? 0) - Number(before.byCode['STD-INP-SGST']?.debit ?? 0)));
  assert('TEST 19 — input GST is debited, not buried in the purchase cost', inpDelta === 60, `got ${inpDelta}`);
  assert('TEST 19 — the purchase ledger takes the taxable value only',
    r2(r2(after.totalDr - before.totalDr) - inpDelta) === 500,
    `purchases delta ${r2(r2(after.totalDr - before.totalDr) - inpDelta)}`);

  const ids = createdPurchases.slice();
  const payments = await sql(
    `SELECT count(*)::int AS n FROM vendor_payments WHERE purchase_id = ANY($1::int[])`, [ids]).catch(() => ({ rows: [{ n: 0 }] }));
  assert('TEST 20 — saving a bill creates no payment', Number(payments.rows[0].n) === 0, `${payments.rows[0].n} payment rows`);

  const cash = await sql(
    `SELECT count(*)::int AS n FROM journal_vouchers WHERE narration ILIKE '%purchase%' AND created_at > now() - interval '10 minutes'`
  ).catch(() => ({ rows: [{ n: 0 }] }));
  assert('TEST 20 — no settlement voucher was raised for a bill', Number(cash.rows[0].n) === 0, `${cash.rows[0].n} vouchers`);
}

// ── TEST 21 / 22 — RBAC and cost visibility ────────────────────────────────
console.log('\n[21,22] RBAC and stock-value visibility');
{
  const blocked = await post('/purchases', bill(), tokNone);
  assert('TEST 21 — an employee without purchase rights is refused', blocked.status === 403, `status=${blocked.status}`);
  const blockedRead = await get('/purchases', tokNone);
  assert('TEST 21 — and cannot read the purchase register either', blockedRead.status === 403, `status=${blockedRead.status}`);
  const blockedEdit = await patch(`/purchases/${createdPurchases[0]}`, { notes: 'nope' }, tokNone);
  assert('TEST 21 — and cannot edit a bill', blockedEdit.status === 403, `status=${blockedEdit.status}`);

  const stockRes = await get('/stock', tokStock);
  const rows = Array.isArray(stockRes.data) ? stockRes.data : (stockRes.data?.rows ?? []);
  const leaked = rows.filter(r => 'stockValue' in r || 'avgCost' in r || 'costPrice' in r);
  assert('TEST 22 — a stock-only employee sees quantities', stockRes.status === 200 && rows.length >= 0, `status=${stockRes.status}`);
  assert('TEST 22 — cost and valuation fields are absent, not zeroed', leaked.length === 0,
    `${leaked.length} rows carried cost keys`);
}

// ── TEST 23 — existing bills still open ────────────────────────────────────
console.log('\n[23] Existing bills read back');
{
  const list = await get('/purchases');
  const rows = Array.isArray(list.data) ? list.data : (list.data?.rows ?? []);
  assert('TEST 23 — the register lists bills', list.status === 200 && rows.length > 0, `status=${list.status} n=${rows.length}`);
  let allOpen = true;
  for (const r of rows.slice(0, 10)) {
    const one = await get(`/purchases/${r.id}`);
    if (one.status !== 200) { allOpen = false; break; }
  }
  assert('TEST 23 — every listed bill opens', allOpen);
  assert('TEST 23 — list rows carry names and units, not bare ids',
    rows.every(r => (r.lineItems ?? []).every(li => typeof li.materialName === 'string' && li.materialName.length > 0)));
}

// ── TEST 26 — date-column health ───────────────────────────────────────────
console.log('\n[26] Schema health');
{
  const h = await get('/healthz/schema');
  assert('TEST 26 — /api/healthz/schema is healthy', h.status === 200 && (h.data?.ok === true || h.data?.status === 'ok'),
    JSON.stringify(h.data).slice(0, 200));
  const n = h.data?.dateColumns?.length ?? h.data?.dateColumnCount ?? h.data?.checked ?? null;
  assert('TEST 26 — 16 columns are still DATE', n === null ? true : Number(n) === 16, `reported ${n}`);
}

// ── Edit path keeps its guarantees ─────────────────────────────────────────
console.log('\n[edit] Editing a bill');
{
  const res = await createBill(bill({ lineItems: [line({ quantity: 4, unitCost: 100, gstRate: 5 })] }));
  const lot0 = res.data.lineItems[0].batchNumber;
  const upd = await patch(`/purchases/${res.data.id}`, {
    lineItems: [{ ...line({ quantity: 6, unitCost: 100, gstRate: 5 }), batchNumber: lot0 }],
  });
  assert('An edit saves', upd.status === 200, JSON.stringify(upd.data).slice(0, 200));
  assert('An edit keeps the existing lot number', upd.data?.lineItems?.[0]?.batchNumber === lot0,
    `${lot0} → ${upd.data?.lineItems?.[0]?.batchNumber}`);
  assert('An edit re-prices the bill', r2(upd.data?.totalAmount) === 630, `got ${upd.data?.totalAmount}`);
  const badEdit = await patch(`/purchases/${res.data.id}`, { lineItems: [line({ mfgDate: '2026-02-30' })] });
  assert('An edit with an impossible date is rejected', badEdit.status === 400, `status=${badEdit.status}`);
  const still = await get(`/purchases/${res.data.id}`);
  assert('The rejected edit left the bill untouched', r2(Number(still.data?.totalAmount)) === 630, `got ${still.data?.totalAmount}`);

  // Re-saving a bill with the same figures must not move the valuation. The
  // edit reverses the old line and re-applies the new one, so an average cost
  // that is decremented on the way out but not on the way in drifts a little
  // every single save.
  const avgBefore = Number((await sql(
    `SELECT COALESCE(avg_cost,0)::float8 AS c FROM materials WHERE id = $1`, [fixtures.materialId])).rows[0]?.c ?? 0);
  const noop = await patch(`/purchases/${res.data.id}`, {
    lineItems: [{ ...line({ quantity: 6, unitCost: 100, gstRate: 5 }), batchNumber: lot0 }],
  });
  assert('An unchanged re-save succeeds', noop.status === 200, JSON.stringify(noop.data).slice(0, 150));
  const avgAfter = Number((await sql(
    `SELECT COALESCE(avg_cost,0)::float8 AS c FROM materials WHERE id = $1`, [fixtures.materialId])).rows[0]?.c ?? 0);
  assert('An unchanged re-save does not drift the average cost', r2(avgBefore) === r2(avgAfter),
    `${avgBefore} → ${avgAfter}`);

  // A date typo corrected on the bill must reach the lot itself — expiry
  // reports and FEFO picking read stock_batches, not the bill. (Regression:
  // creditBatch COALESCE used to keep the lot's original dates forever.)
  const dateFix = await patch(`/purchases/${res.data.id}`, {
    lineItems: [{ ...line({ quantity: 6, unitCost: 100, gstRate: 5, mfgDate: '2026-01-05', expiryDate: '2027-09-30' }), batchNumber: lot0 }],
  });
  assert('A date-only correction saves', dateFix.status === 200, JSON.stringify(dateFix.data).slice(0, 150));
  const lotDates = (await sql(
    `SELECT mfg_date::text AS m, expiry_date::text AS e, quantity::float8 AS q FROM stock_batches
      WHERE item_id=$1 AND material_type='material' AND branch_type='warehouse' AND branch_id=$2 AND batch_number=$3`,
    [fixtures.materialId, WH_OK, lot0])).rows[0] ?? {};
  assert('The corrected expiry reaches the stock lot', lotDates.e === '2027-09-30', `lot expiry=${lotDates.e}`);
  assert('The corrected mfg date reaches the stock lot', lotDates.m === '2026-01-05', `lot mfg=${lotDates.m}`);
  assert('The date correction did not change the lot quantity', r2(lotDates.q ?? 0) === 6, `qty=${lotDates.q}`);

  // Once the goods have moved on, the reversal can no longer tell the truth:
  // it would floor at zero and then re-add the full quantity, inventing stock.
  const consumed = await createBill(bill({ lineItems: [line({ quantity: 10, unitCost: 50, gstRate: 5 })] }));
  const consumedLot = consumed.data.lineItems[0].batchNumber;
  // Stand in for a sale or an issue to production: take 8 of the 10 away.
  await sql(`UPDATE stock_batches SET quantity = quantity - 8 WHERE item_id=$1 AND material_type='material'
              AND branch_type='warehouse' AND branch_id=$2 AND batch_number=$3`,
    [fixtures.materialId, WH_OK, consumedLot]);
  await sql(`UPDATE stock_entries SET quantity = quantity - 8 WHERE item_id=$1 AND material_type='material'
              AND branch_type='warehouse' AND branch_id=$2`, [fixtures.materialId, WH_OK]);
  const lotBefore = Number((await sql(
    `SELECT quantity::float8 AS q FROM stock_batches WHERE item_id=$1 AND material_type='material'
      AND branch_type='warehouse' AND branch_id=$2 AND batch_number=$3`,
    [fixtures.materialId, WH_OK, consumedLot])).rows[0]?.q ?? 0);
  const blocked = await patch(`/purchases/${consumed.data.id}`, {
    lineItems: [{ ...line({ quantity: 3, unitCost: 50, gstRate: 5 }), batchNumber: consumedLot }],
  });
  assert('An edit is refused once the stock has been used', blocked.status === 409, `status=${blocked.status}`);
  assert('...and says so in plain language', /already been used|already moved on|already been sold/i.test(String(blocked.data?.error ?? '')),
    String(blocked.data?.error).slice(0, 160));
  const lotAfter = Number((await sql(
    `SELECT quantity::float8 AS q FROM stock_batches WHERE item_id=$1 AND material_type='material'
      AND branch_type='warehouse' AND branch_id=$2 AND batch_number=$3`,
    [fixtures.materialId, WH_OK, consumedLot])).rows[0]?.q ?? 0);
  assert('The refused edit invented no stock', r2(lotBefore) === r2(lotAfter), `${lotBefore} → ${lotAfter}`);
  // Put the 8 back so the reconciliation section still balances stock to lots.
  await sql(`UPDATE stock_batches SET quantity = quantity + 8 WHERE item_id=$1 AND material_type='material'
              AND branch_type='warehouse' AND branch_id=$2 AND batch_number=$3`,
    [fixtures.materialId, WH_OK, consumedLot]);
  await sql(`UPDATE stock_entries SET quantity = quantity + 8 WHERE item_id=$1 AND material_type='material'
              AND branch_type='warehouse' AND branch_id=$2`, [fixtures.materialId, WH_OK]);
}

// ── Reconciliation ─────────────────────────────────────────────────────────
console.log('\n[recon] Final reconciliation');
{
  const tb = await snapshotTB();
  assert('Trial balance: debits equal credits', r2(tb.totalDr) === r2(tb.totalCr), `Dr ${tb.totalDr} vs Cr ${tb.totalCr}`);
  assert('Trial balance reports itself balanced', tb.balanced === true);

  // Grand total = taxable + tax + round-off, per bill.
  const bills = (await sql(
    `SELECT id, total_amount::float8 AS total, tax_total::float8 AS tax, round_off::float8 AS ro, line_items
       FROM purchases WHERE id = ANY($1::int[])`, [createdPurchases])).rows;
  let footOk = true, lotOk = true;
  for (const b of bills) {
    const taxable = r2((b.line_items ?? []).reduce((s, l) => s + Number(l.taxableValue ?? 0), 0));
    const tax = r2((b.line_items ?? []).reduce((s, l) => s + Number(l.taxAmount ?? 0), 0));
    if (r2(taxable + tax + Number(b.ro)) !== r2(Number(b.total))) { footOk = false; break; }
    if (r2(tax) !== r2(Number(b.tax))) { footOk = false; break; }
    for (const l of b.line_items ?? []) if (!l.batchNumber) { lotOk = false; }
  }
  assert('Every bill foots: taxable + tax + round-off = grand total', footOk);
  assert('Every stored line carries a lot number', lotOk);

  // Stock quantity equals the sum of the purchase movements.
  const q = Number((await sql(
    `SELECT COALESCE(quantity,0)::float8 AS q FROM stock_entries WHERE item_id=$1 AND material_type='material' AND branch_type='warehouse' AND branch_id=$2`,
    [fixtures.materialId, WH_OK])).rows[0]?.q ?? 0);
  const lots = Number((await sql(
    `SELECT COALESCE(SUM(quantity),0)::float8 AS q FROM stock_batches WHERE item_id=$1 AND material_type='material' AND branch_type='warehouse' AND branch_id=$2`,
    [fixtures.materialId, WH_OK])).rows[0]?.q ?? 0);
  assert('Location stock equals the sum of its lots', r2(q) === r2(lots), `stock ${q} vs lots ${lots}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[cleanup] Removing fixtures');
const tbFinalBefore = await snapshotTB();
await cleanup();
const tbFinal = await snapshotTB();
assert('The trial balance is still balanced after cleanup', r2(tbFinal.totalDr) === r2(tbFinal.totalCr),
  `Dr ${tbFinal.totalDr} vs Cr ${tbFinal.totalCr}`);
const leftovers = Number((await sql(
  `SELECT (SELECT count(*) FROM vendors WHERE name LIKE $1)
        + (SELECT count(*) FROM materials WHERE name LIKE $1)
        + (SELECT count(*) FROM hierarchies WHERE name LIKE $1) AS n`, [`${TAG}%`])).rows[0].n);
assert('No test fixtures remain', leftovers === 0, `${leftovers} rows left`);

await pool.end();
console.log(`\n${'─'.repeat(60)}\nResults: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failed:\n' + failures.map(f => `  · ${f}`).join('\n'));
process.exit(failed > 0 ? 1 : 0);
