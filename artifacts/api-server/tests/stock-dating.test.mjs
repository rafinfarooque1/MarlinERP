/**
 * Date-based stock, cash grouping & purchase-edit reconciliation — integration tests
 * Run: node artifacts/api-server/tests/stock-dating.test.mjs
 *
 * Covers the acceptance criteria for the Balance-Sheet cash grouping and
 * date-based stock work:
 *   1. Every per-location cash ledger sits under the standard Cash group.
 *   2. A NEW location's cash ledger lands under Cash automatically.
 *   3. Backdated purchases enter stock history on the BILL date (txn_date).
 *   4. Purchase edits reconcile stock exactly: quantity, expiry/mfg dates,
 *      line removal (no orphan zero-quantity lots), bill-date changes (full
 *      and metadata-only), and receiving-location moves.
 *   5. Closing stock of a period == opening stock of the next period.
 *   6. Books integrity stays balanced with no forced balancing entries.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZDATE fixtures and deletes every one of them at the end.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZDATE';
// Two ENABLED warehouses, resolved from the live DB after login — the dev DB
// now carries the real business's warehouses, so hardcoded ids go stale
// ("Warehouse #3 does not exist" broke the location-move section).
let WH_A = 0; // primary warehouse for the dated bill
let WH_B = 0; // second warehouse for the location-move case

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
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
const get = (p, t) => apiReq('GET', p, undefined, t);
const post = (p, b, t) => apiReq('POST', p, b, t);
const patch = (p, b, t) => apiReq('PATCH', p, b, t);
const del = (p, t) => apiReq('DELETE', p, undefined, t);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (q, params = []) => pool.query(q, params);

const fixtures = { vendorId: 0, matA: 0, matB: 0, whNewId: 0 };
const createdPurchases = [];

async function cleanup() {
  for (const id of createdPurchases) { await del(`/purchases/${id}`).catch(() => {}); }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1 OR notes LIKE $1`, [`${TAG}%`]);
  const matIds = [fixtures.matA, fixtures.matB].filter(Boolean);
  if (matIds.length) {
    await sql(`DELETE FROM stock_ledger WHERE material_type = 'material' AND ref_id = ANY($1::int[])`, [matIds]);
    await sql(`DELETE FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type = 'material'`, [matIds]);
    await sql(`DELETE FROM stock_entries WHERE item_id = ANY($1::int[]) AND material_type = 'material'`, [matIds]);
  }
  await sql(`DELETE FROM materials WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND code LIKE 'VEND-%'`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  // The disposable warehouse from the provisioning test, plus its ledgers —
  // only when nothing posted against them (nothing ever should have).
  const { rows: whs } = await sql(`SELECT id FROM warehouses WHERE name LIKE $1`, [`${TAG}%`]);
  for (const w of whs) {
    const codes = [`WH-CASH-${w.id}`, `WH-SAL-${w.id}`, `WH-PUR-${w.id}`];
    const { rows: [used] } = await sql(
      `SELECT COUNT(*)::int AS n FROM journal_voucher_lines
        WHERE ledger_id IN (SELECT id FROM account_ledgers WHERE code = ANY($1::text[]))`, [codes]);
    await sql(`DELETE FROM warehouses WHERE id = $1`, [w.id]);
    if (!used || used.n === 0) await sql(`DELETE FROM account_ledgers WHERE code = ANY($1::text[])`, [codes]);
  }
}

/** Sum of a material's company-wide stock as of a business date, per txn_date. */
async function qtyAsOf(matId, asOf) {
  const { rows: [r] } = await sql(
    `SELECT COALESCE(SUM(qty_change::numeric), 0) AS q FROM stock_ledger
      WHERE material_type = 'material' AND ref_id = $1
        AND COALESCE(txn_date, created_at::date) <= $2::date`, [matId, asOf]);
  return Number(r.q);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');
const loginRes = await post('/auth/login', { username: process.env.TEST_USERNAME || 'admin', password: process.env.TEST_PASSWORD || 'marlin1458' });
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);

{
  const { rows: whs } = await sql(
    `SELECT id FROM warehouses WHERE disabled_at IS NULL ORDER BY id LIMIT 2`);
  if (whs.length < 2) { console.error('Need two enabled warehouses for the location-move case'); process.exit(1); }
  WH_A = Number(whs[0].id);
  WH_B = Number(whs[1].id);
  console.log(`  (using warehouses #${WH_A} and #${WH_B})`);
}
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }
await cleanup(); // in case a previous run died mid-way

fixtures.vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZDAT1234F1Z5') RETURNING id`,
  [`${TAG} Vendor`])).rows[0].id;
fixtures.matA = (await sql(
  `INSERT INTO materials (name, unit, hsn_code, tax_rate, item_code, status, current_stock)
   VALUES ($1,'KG','08119090',5,'RM-ZZDATE-A','active',0) RETURNING id`, [`${TAG} Mat A`])).rows[0].id;
fixtures.matB = (await sql(
  `INSERT INTO materials (name, unit, hsn_code, tax_rate, item_code, status, current_stock)
   VALUES ($1,'KG','08119090',5,'RM-ZZDATE-B','active',0) RETURNING id`, [`${TAG} Mat B`])).rows[0].id;

const lineA = (over = {}) => ({
  materialType: 'material', materialId: fixtures.matA, quantity: 10, unitCost: 100,
  mfgDate: '2026-06-01', expiryDate: '2027-03-31', batchNumber: `${TAG}-LOT-1`, ...over,
});

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Cash grouping: every location cash ledger under the Cash group');
{
  const { rows: [bad] } = await sql(`
    SELECT COUNT(*)::int AS n FROM account_ledgers l
     WHERE (l.code LIKE 'WH-CASH-%' OR l.code LIKE 'OUTLET-CASH-%')
       AND l.parent_id IS DISTINCT FROM (SELECT id FROM account_ledgers WHERE code = 'STD-CASH')`);
  assert('No location cash ledger outside the Cash group', bad.n === 0, `${bad.n} misplaced`);
}

console.log('\n[2] A NEW location cash ledger lands under Cash automatically');
{
  const mk = await post('/warehouses', {
    name: `${TAG} Provision WH`, location: 'Bengaluru', state: 'Karnataka', gstNumber: '29ZZDAT9999F1Z5',
  });
  assert('Disposable warehouse created', mk.status === 200 || mk.status === 201, `status=${mk.status}`);
  fixtures.whNewId = mk.data?.id ?? 0;
  const { rows: [led] } = await sql(`
    SELECT l.code, p.code AS parent_code FROM account_ledgers l
      LEFT JOIN account_ledgers p ON p.id = l.parent_id
     WHERE l.code = $1`, [`WH-CASH-${fixtures.whNewId}`]);
  assert('New warehouse cash ledger exists', !!led);
  assert('…and its parent is the Cash group', led?.parent_code === 'STD-CASH', `parent=${led?.parent_code}`);
}

console.log('\n[3] Backdated purchase enters stock history on the BILL date');
const D1 = '2026-07-10', D2 = '2026-07-15', D3 = '2026-07-18';
let billId = 0;
{
  const mk = await post('/purchases', {
    vendorId: fixtures.vendorId, purchaseDate: D1, vendorInvoiceDate: D1, invoiceNumber: `${TAG}-INV-1`,
    locationType: 'warehouse', locationId: WH_A, lineItems: [lineA()],
  });
  assert('Backdated bill created', mk.status === 200 || mk.status === 201, JSON.stringify(mk.data).slice(0, 200));
  billId = mk.data?.id ?? 0;
  if (billId) createdPurchases.push(billId);
  const { rows } = await sql(
    `SELECT txn_date::text AS d FROM stock_ledger WHERE doc_type='purchase' AND doc_id=$1`, [billId]);
  assert('Ledger rows carry the bill date, not the insert date', rows.length > 0 && rows.every(r => r.d === D1),
    rows.map(r => r.d).join(','));
  assert('Stock as of the day before the bill is zero', (await qtyAsOf(fixtures.matA, '2026-07-09')) === 0);
  assert('Stock as of the bill date is the bill quantity', (await qtyAsOf(fixtures.matA, D1)) === 10);
}

console.log('\n[4] Edit: quantity change reconciles stock and lots exactly');
{
  const ed = await patch(`/purchases/${billId}`, { lineItems: [lineA({ quantity: 6 })] });
  assert('Quantity edit accepted', ed.status === 200, JSON.stringify(ed.data).slice(0, 200));
  const { rows: [se] } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric),0) AS q FROM stock_entries WHERE item_id=$1 AND material_type='material'`, [fixtures.matA]);
  assert('Location stock equals the edited quantity', Number(se.q) === 6, `q=${se.q}`);
  const { rows: lots } = await sql(
    `SELECT quantity::numeric AS q FROM stock_batches WHERE item_id=$1 AND material_type='material'`, [fixtures.matA]);
  assert('Exactly one lot remains', lots.length === 1, `${lots.length} lots`);
  assert('…with the edited quantity, no zero-qty orphans', lots.length === 1 && Number(lots[0].q) === 6);
  const { rows: revs } = await sql(
    `SELECT txn_date::text AS d FROM stock_ledger WHERE doc_type='purchase' AND doc_id=$1 AND txn_type='purchase_reversal'`, [billId]);
  assert('Reversal rows dated on the bill date (history stays continuous)', revs.length > 0 && revs.every(r => r.d === D1));
}

console.log('\n[5] Edit: mfg/expiry date corrections reach the lot');
{
  const ed = await patch(`/purchases/${billId}`, {
    lineItems: [lineA({ quantity: 6, mfgDate: '2026-06-15', expiryDate: '2027-06-30' })],
  });
  assert('Expiry edit accepted', ed.status === 200);
  const { rows: [lot] } = await sql(
    `SELECT mfg_date::text AS m, expiry_date::text AS e FROM stock_batches WHERE item_id=$1 AND material_type='material'`, [fixtures.matA]);
  assert('Lot expiry updated', lot?.e === '2027-06-30', `expiry=${lot?.e}`);
  assert('Lot mfg date updated', lot?.m === '2026-06-15', `mfg=${lot?.m}`);
}

console.log('\n[6] Edit: bill-date change moves stock history (full edit)');
{
  const ed = await patch(`/purchases/${billId}`, {
    purchaseDate: D2, lineItems: [lineA({ quantity: 6, mfgDate: '2026-06-15', expiryDate: '2027-06-30' })],
  });
  assert('Date edit accepted', ed.status === 200);
  assert('Stock as of the OLD date is now zero', (await qtyAsOf(fixtures.matA, D1)) === 0);
  assert('Stock as of the NEW date is the bill quantity', (await qtyAsOf(fixtures.matA, D2)) === 6);
}

console.log('\n[7] Edit: metadata-only date change re-dates the whole trail');
{
  const ed = await patch(`/purchases/${billId}`, { purchaseDate: D3 });
  assert('Metadata-only date edit accepted', ed.status === 200);
  const { rows } = await sql(
    `SELECT DISTINCT txn_date::text AS d FROM stock_ledger WHERE doc_type='purchase' AND doc_id=$1`, [billId]);
  assert('Every ledger row of the bill re-dated', rows.length === 1 && rows[0].d === D3, rows.map(r => r.d).join(','));
  assert('Stock as of the previous date is zero', (await qtyAsOf(fixtures.matA, D2)) === 0);
  assert('Stock as of the new date is the bill quantity', (await qtyAsOf(fixtures.matA, D3)) === 6);
}

console.log('\n[8] Edit: removing a line leaves no orphan lot');
{
  const two = await patch(`/purchases/${billId}`, {
    lineItems: [
      lineA({ quantity: 6, mfgDate: '2026-06-15', expiryDate: '2027-06-30' }),
      { materialType: 'material', materialId: fixtures.matB, quantity: 4, unitCost: 50,
        mfgDate: '2026-06-01', expiryDate: '2027-03-31', batchNumber: `${TAG}-LOT-2` },
    ],
  });
  assert('Second line added', two.status === 200, JSON.stringify(two.data).slice(0, 200));
  const { rows: [b1] } = await sql(`SELECT COUNT(*)::int AS n FROM stock_batches WHERE batch_number=$1`, [`${TAG}-LOT-2`]);
  assert('Second lot exists after add', b1.n === 1);
  const one = await patch(`/purchases/${billId}`, {
    lineItems: [lineA({ quantity: 6, mfgDate: '2026-06-15', expiryDate: '2027-06-30' })],
  });
  assert('Second line removed', one.status === 200);
  const { rows: [b2] } = await sql(`SELECT COUNT(*)::int AS n FROM stock_batches WHERE batch_number=$1`, [`${TAG}-LOT-2`]);
  assert('Removed line leaves NO lot row (not even zero-qty)', b2.n === 0, `${b2.n} rows`);
  const { rows: [sb] } = await sql(
    `SELECT COALESCE(SUM(quantity::numeric),0) AS q FROM stock_entries WHERE item_id=$1 AND material_type='material'`, [fixtures.matB]);
  assert('Removed line leaves no stock', Number(sb.q) === 0, `q=${sb.q}`);
}

console.log('\n[9] Edit: receiving-location move re-homes stock, lots and the bill');
{
  const mv = await patch(`/purchases/${billId}`, {
    locationType: 'warehouse', locationId: WH_B,
    lineItems: [lineA({ quantity: 6, mfgDate: '2026-06-15', expiryDate: '2027-06-30' })],
  });
  assert('Location move accepted', mv.status === 200, JSON.stringify(mv.data).slice(0, 200));
  const { rows: se } = await sql(
    `SELECT branch_id, quantity::numeric AS q FROM stock_entries
      WHERE item_id=$1 AND material_type='material' AND branch_type='warehouse' ORDER BY branch_id`, [fixtures.matA]);
  const atA = se.find(r => Number(r.branch_id) === WH_A);
  const atB = se.find(r => Number(r.branch_id) === WH_B);
  assert('Old location holds zero', !atA || Number(atA.q) === 0, `A=${atA?.q}`);
  assert('New location holds the bill quantity', Number(atB?.q ?? 0) === 6, `B=${atB?.q}`);
  const { rows: [lot] } = await sql(
    `SELECT branch_id FROM stock_batches WHERE item_id=$1 AND material_type='material' AND quantity::numeric > 0`, [fixtures.matA]);
  assert('Lot lives at the new location', Number(lot?.branch_id) === WH_B, `branch=${lot?.branch_id}`);
  const { rows: [row] } = await sql(`SELECT location_id FROM purchases WHERE id=$1`, [billId]);
  assert('Bill row carries the new location', Number(row.location_id) === WH_B);
  const noMove = await patch(`/purchases/${billId}`, { locationType: 'warehouse', locationId: WH_A });
  assert('Move without line items is refused', noMove.status === 400, `status=${noMove.status}`);

  // Move BACK: the bill returns to its original home with its dates intact —
  // no stale lot at the destination may resurrect old mfg/expiry via upsert.
  const back = await patch(`/purchases/${billId}`, {
    locationType: 'warehouse', locationId: WH_A,
    lineItems: [lineA({ quantity: 6, mfgDate: '2026-06-15', expiryDate: '2027-06-30' })],
  });
  assert('Move back accepted', back.status === 200, JSON.stringify(back.data).slice(0, 200));
  const { rows: backLots } = await sql(
    `SELECT branch_id, quantity::numeric AS q, mfg_date::text AS m, expiry_date::text AS e
       FROM stock_batches WHERE item_id=$1 AND material_type='material' AND quantity::numeric > 0`, [fixtures.matA]);
  assert('One live lot after move-back, at the original location',
    backLots.length === 1 && Number(backLots[0].branch_id) === WH_A, JSON.stringify(backLots));
  assert('Move-back lot keeps the corrected mfg/expiry',
    backLots[0]?.m === '2026-06-15' && backLots[0]?.e === '2027-06-30', JSON.stringify(backLots[0]));
  const { rows: [zombie] } = await sql(
    `SELECT COUNT(*)::int AS n FROM stock_batches
      WHERE item_id=$1 AND material_type='material' AND quantity::numeric <= 0.0005`, [fixtures.matA]);
  assert('No zero-qty zombie lots left at either location', zombie.n === 0, `${zombie.n} rows`);
}

console.log('\n[10] Range reporting: closing stock of D == opening stock of D+1');
{
  for (const [D, Dnext] of [['2026-07-14', '2026-07-15'], ['2026-07-20', '2026-07-21']]) {
    const a = await get(`/accounts/financial-statements?fromDate=2026-04-01&toDate=${D}`);
    const b = await get(`/accounts/financial-statements?fromDate=${Dnext}&toDate=2026-07-31`);
    const closing = Number(a.data?.profitAndLoss?.incomes?.closingStock ?? NaN);
    const opening = Number(b.data?.profitAndLoss?.expenses?.openingStock ?? NaN);
    assert(`Closing(${D}) equals Opening(${Dnext})`, Number.isFinite(closing) && closing === opening,
      `closing=${closing} opening=${opening}`);
  }
}

console.log('\n[11] Delete: the bill leaves history as if dated movements never happened');
{
  const rm = await del(`/purchases/${billId}`);
  assert('Bill deleted', rm.status === 204, `status=${rm.status}`);
  createdPurchases.length = 0;
  const { rows: [lots] } = await sql(
    `SELECT COUNT(*)::int AS n FROM stock_batches WHERE item_id = ANY($1::int[]) AND material_type='material'`,
    [[fixtures.matA, fixtures.matB]]);
  assert('No lots remain for the bill', lots.n === 0, `${lots.n} rows`);
  assert('Stock as of any date is zero again', (await qtyAsOf(fixtures.matA, '2026-07-31')) === 0);
  const { rows: revs } = await sql(
    `SELECT txn_date::text AS d FROM stock_ledger WHERE doc_type='purchase' AND doc_id=$1 AND notes LIKE 'Purchase deleted%'`, [billId]);
  assert('Delete reversal dated on the bill date', revs.length > 0 && revs.every(r => r.d === D3), revs.map(r => r.d).join(','));
}

console.log('\n[12] Books integrity: balanced, no orphans, no forced entries');
{
  // As-at date must be TODAY: the dev DB now holds imported real business data
  // whose stock baseline postdates July 2026, so a backdated closing-stock
  // valuation is (correctly) refused by the history-reach guard.
  const AS_AT = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const fs2 = await get(`/accounts/financial-statements?fromDate=2026-04-01&toDate=${AS_AT}`);
  const integ = fs2.data?.integrity ?? {};
  assert('Balance Sheet balanced', integ.balanced === true, JSON.stringify(integ).slice(0, 200));
  assert('Difference is exactly zero', Number(integ.difference ?? NaN) === 0);
  assert('No integrity issues reported', Array.isArray(integ.issues) && integ.issues.length === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[cleanup]');
await cleanup();
const { rows: [left] } = await sql(
  `SELECT (SELECT COUNT(*) FROM vendors WHERE name LIKE $1)
        + (SELECT COUNT(*) FROM materials WHERE name LIKE $1)
        + (SELECT COUNT(*) FROM warehouses WHERE name LIKE $1)
        + (SELECT COUNT(*) FROM purchases WHERE invoice_number LIKE $1) AS n`, [`${TAG}%`]);
assert('All ZZDATE fixtures removed', Number(left.n) === 0, `${left.n} left`);

await pool.end();
console.log(`\n${passed} passed, ${failed} failed${failed ? ` — ${failures.join(' | ')}` : ''}`);
process.exit(failed ? 1 : 0);
