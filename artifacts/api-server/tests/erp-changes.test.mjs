/**
 * Regression suite for the pending-ERP-changes task:
 *   [A] Dashboard payables breakdown includes Rent and the total reconciles.
 *   [F-N] POS discount/coupon settings: persistence, independence, server-side
 *         enforcement on create AND edit, historical invoices untouched.
 *   [O-Q] Hierarchy role edit: same record updated in place, validation,
 *         duplicate-name rejection, level-1 protection, audit logging.
 *   [R] Unauthenticated callers cannot change settings or hierarchy data.
 *
 * Runs against the DEVELOPMENT database. Creates clearly-marked ZZERP fixtures
 * and deletes every one of them at the end; general_settings is snapshotted
 * and restored byte-for-byte.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZERP';
const WH = 1;

let authToken = '';
let passed = 0, failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}

async function apiReq(method, path, body, token = authToken) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const post = (p, b, t) => apiReq('POST', p, b, t);
const patch = (p, b, t) => apiReq('PATCH', p, b, t);
const put = (p, b, t) => apiReq('PUT', p, b, t);
const get = (p, t) => apiReq('GET', p, undefined, t);
const r2 = (n) => Math.round(n * 100) / 100;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

// ── Settings helpers ────────────────────────────────────────────────────────
// PATCH /company/settings REPLACES the whole generalSettings blob, so every
// write here merges over the live blob, and cleanup restores the snapshot.
let savedGeneralSettings = null;
async function currentGeneralSettings() {
  const res = await get('/company/settings');
  return res.data?.generalSettings ?? {};
}
async function setFlags(flags) {
  const merged = { ...(await currentGeneralSettings()), ...flags };
  return patch('/company/settings', { generalSettings: merged });
}

// ── Fixtures & cleanup ──────────────────────────────────────────────────────
const fixtures = { itemA: 0, custId: 0, purchaseId: 0 };
const createdRoleIds = [];

async function cleanup() {
  const { rows: strays } = await sql(
    `SELECT s.id, s.invoice_number FROM sales s JOIN customers c ON c.id = s.customer_id WHERE c.name LIKE $1 ORDER BY s.id DESC`,
    [`${TAG}%`]);
  for (const s of strays) {
    await post(`/sales/${s.id}/cancel`, {}).catch(() => {});
    if (s.invoice_number) await sql(`DELETE FROM receipts WHERE voucher_number = $1 OR narration LIKE '%' || $1 || '%'`, [s.invoice_number]);
    await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [s.id]);
    await sql(`DELETE FROM sales WHERE id = $1`, [s.id]);
  }
  if (fixtures.purchaseId) { await apiReq('DELETE', `/purchases/${fixtures.purchaseId}`).catch(() => {}); fixtures.purchaseId = 0; }
  await sql(`DELETE FROM purchases WHERE vendor_id IN (SELECT id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_batches WHERE item_id IN (SELECT id FROM items WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM stock_entries WHERE item_id IN (SELECT id FROM items WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM items WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1 AND (code LIKE 'VEND-%' OR code LIKE 'CUST-%' OR code LIKE 'DEBT-%')`, [`${TAG}%`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM activity_log WHERE entity_type = 'hierarchy' AND description LIKE '%' || $1 || '%'`, [TAG]);
  await sql(`DELETE FROM hierarchies WHERE name LIKE $1`, [`${TAG}%`]);
  createdRoleIds.length = 0;
  if (savedGeneralSettings !== null) {
    await patch('/company/settings', { generalSettings: savedGeneralSettings });
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication and fixtures');

// Dev-database default credentials; override via env for any other environment.
const loginRes = await post('/auth/login', {
  username: process.env.TEST_ADMIN_USER || 'admin',
  password: process.env.TEST_ADMIN_PASSWORD || 'marlin1458',
});
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }

await cleanup(); // recover any previous crashed run
savedGeneralSettings = await currentGeneralSettings();

const vendorId = (await sql(
  `INSERT INTO vendors (name, state, gst_number) VALUES ($1,'Karnataka','29ZZERP1234F1Z5') RETURNING id`,
  [`${TAG} Vendor`])).rows[0].id;
fixtures.itemA = (await sql(
  `INSERT INTO items (name, unit, hsn_code, tax_rate, mrp, item_code, barcode, status)
   VALUES ($1,'KG','08119010',5,380,'FG-ZZERP-A','2900000000328','active') RETURNING id`,
  [`${TAG} Mango Pulp`])).rows[0].id;
const custRes = await post('/customers', { name: `${TAG} Buyer`, phone: '9000000001', state: 'Karnataka', address: 'Bengaluru' });
fixtures.custId = custRes.data?.id;
assert('Fixture customer created', !!fixtures.custId);
const purch = await post('/purchases', {
  vendorId, purchaseDate: '2026-07-30', vendorInvoiceDate: '2026-07-29', locationType: 'warehouse', locationId: WH,
  lineItems: [{ materialType: 'item', materialId: fixtures.itemA, quantity: 200, unitCost: 200, mfgDate: '2026-07-01', expiryDate: '2027-07-01' }],
});
fixtures.purchaseId = purch.data?.id;
assert('Stock purchased into warehouse', purch.status === 201, JSON.stringify(purch.data).slice(0, 150));

const saleBody = (extra = {}, lineExtra = {}) => ({
  outletId: WH, locationType: 'warehouse', locationId: WH,
  saleDate: '2026-07-31', paymentMode: 'credit', customerId: fixtures.custId,
  lineItems: [{ itemId: fixtures.itemA, quantity: 2, unitPrice: 380, ...lineExtra }],
  ...extra,
});

try {

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[A] Dashboard payables breakdown: Suppliers · Salary · Rent');
{
  const bi = await get('/dashboard/bi');
  const p = bi.data?.payables ?? {};
  assert('rentPayable present in the payload', p.rentPayable != null, JSON.stringify(p));
  assert('allPayables = suppliers + salary + rent',
    Math.abs(r2(Number(p.total) + Number(p.salaryPayable) + Number(p.rentPayable)) - Number(p.allPayables)) < 0.011,
    JSON.stringify(p));
  const tb = await get('/accounts/trial-balance');
  const rentTB = r2((tb.data?.rows ?? [])
    .filter(r => String(r.code ?? '').startsWith('RENT-PAY'))
    .reduce((s, r) => s + Number(r.credit ?? 0) - Number(r.debit ?? 0), 0));
  assert('rentPayable equals the Rent Payable trial-balance position', Math.abs(rentTB - Number(p.rentPayable)) < 0.011, `tb=${rentTB} bi=${p.rentPayable}`);
  const salTB = r2((tb.data?.rows ?? [])
    .filter(r => String(r.code ?? '').startsWith('SAL-PAY'))
    .reduce((s, r) => s + Number(r.credit ?? 0) - Number(r.debit ?? 0), 0));
  assert('salaryPayable still equals its trial-balance position (unchanged)', Math.abs(salTB - Number(p.salaryPayable)) < 0.011, `tb=${salTB} bi=${p.salaryPayable}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[F/G/H] Discount flag: persistence and enforcement on create');
{
  let res = await setFlags({ posDiscountsEnabled: false, posCouponsEnabled: true });
  assert('Settings PATCH accepted', res.status === 200, JSON.stringify(res.data).slice(0, 120));
  const gs = await currentGeneralSettings();
  assert('posDiscountsEnabled persisted as false (survives refresh/login — DB-stored)', gs.posDiscountsEnabled === false);
  assert('posCouponsEnabled untouched (true)', gs.posCouponsEnabled === true);

  res = await post('/sales', saleBody({}, { unitDiscount: 20 }));
  assert('Per-item discount refused while discounts OFF', res.status === 400 && res.data?.code === 'DISCOUNTS_DISABLED', JSON.stringify(res.data).slice(0, 150));
  res = await post('/sales', saleBody({ billDiscount: 50 }));
  assert('Bill discount refused while discounts OFF', res.status === 400 && res.data?.code === 'DISCOUNTS_DISABLED', JSON.stringify(res.data).slice(0, 150));
  res = await post('/sales', saleBody());
  assert('Plain sale still accepted while discounts OFF', res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

console.log('\n[K] Independence: discounts OFF + coupons ON');
{
  const res = await post('/sales', saleBody({ couponCode: 'ZZERP10', discountTotal: 10 }));
  assert('Coupon sale accepted while discounts OFF but coupons ON', res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

console.log('\n[I/J/L] Coupon flag: enforcement and independence (discounts ON + coupons OFF)');
{
  await setFlags({ posDiscountsEnabled: true, posCouponsEnabled: false });
  let res = await post('/sales', saleBody({ couponCode: 'ZZERP10', discountTotal: 10 }));
  assert('Coupon refused while coupons OFF', res.status === 400 && res.data?.code === 'COUPONS_DISABLED', JSON.stringify(res.data).slice(0, 150));
  res = await post('/sales', saleBody({ discountTotal: 15 }));
  assert('Bare discountTotal (coupon value) refused while coupons OFF', res.status === 400 && res.data?.code === 'COUPONS_DISABLED');
  res = await post('/sales', saleBody({ billDiscount: 40 }));
  assert('Bill discount accepted while discounts ON but coupons OFF', res.status === 201, JSON.stringify(res.data).slice(0, 150));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[M/N] Historical invoices survive flags being switched OFF');
let histId = 0, histInvoice = null;
{
  await setFlags({ posDiscountsEnabled: true, posCouponsEnabled: true });
  const res = await post('/sales', saleBody(
    { billDiscount: 30, couponCode: 'ZZERPHIST', discountTotal: 12 },
    { unitDiscount: 10 },
  ));
  assert('Fully-discounted + couponed sale created while both flags ON', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  histId = res.data?.id;

  await setFlags({ posDiscountsEnabled: false, posCouponsEnabled: false });
  const read = await get(`/sales/${histId}`);
  histInvoice = read.data;
  assert('Historical bill discount intact while flags OFF', Number(read.data?.billDiscount) === 30, JSON.stringify(read.data?.billDiscount));
  assert('Historical coupon code intact while flags OFF', read.data?.couponCode === 'ZZERPHIST', JSON.stringify(read.data?.couponCode));
  assert('Historical coupon value intact while flags OFF', Number(read.data?.discountTotal) === 12);
  const line = (read.data?.lineItems ?? [])[0] ?? {};
  assert('Historical per-unit discount intact while flags OFF', Number(line.unitDiscount) === 10, JSON.stringify(line).slice(0, 200));
}

console.log('\n[M/N-edit] Edits may keep, but not grow, historical amounts while OFF');
{
  const editBody = saleBody(
    { billDiscount: 30, couponCode: 'ZZERPHIST', discountTotal: 12 },
    { unitDiscount: 10 },
  );
  let res = await put(`/sales/${histId}`, editBody);
  assert('Edit KEEPING existing discounts+coupon allowed while flags OFF', res.status === 200, JSON.stringify(res.data).slice(0, 200));
  res = await put(`/sales/${histId}`, saleBody({ billDiscount: 60, couponCode: 'ZZERPHIST', discountTotal: 12 }, { unitDiscount: 10 }));
  assert('Edit INCREASING the bill discount refused while discounts OFF', res.status === 400 && res.data?.code === 'DISCOUNTS_DISABLED', JSON.stringify(res.data).slice(0, 150));
  res = await put(`/sales/${histId}`, saleBody({ billDiscount: 30, couponCode: 'ZZERPNEW', discountTotal: 12 }, { unitDiscount: 10 }));
  assert('Edit swapping in a DIFFERENT coupon refused while coupons OFF', res.status === 400 && res.data?.code === 'COUPONS_DISABLED', JSON.stringify(res.data).slice(0, 150));
  const read = await get(`/sales/${histId}`);
  assert('Rejected edits changed nothing on the stored sale',
    Number(read.data?.billDiscount) === 30 && read.data?.couponCode === 'ZZERPHIST' && Number(read.data?.discountTotal) === 12);
  await setFlags({ posDiscountsEnabled: true, posCouponsEnabled: true });
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[O] Hierarchy role edit updates the SAME record in place');
let roleId = 0, role2Id = 0, rootId = 0;
{
  const { rows: [root] } = await sql(`SELECT id FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`);
  rootId = root.id;

  let res = await post('/hr/hierarchies', { name: `${TAG} Warehouse Lead`, reportsToId: rootId, description: 'test role' });
  assert('Role created reporting to the root', res.status === 201 && res.data?.id, JSON.stringify(res.data).slice(0, 150));
  assert('Level derived from the chain (root + 1)', res.data?.level === 2, `level=${res.data?.level}`);
  roleId = res.data?.id;
  if (roleId) createdRoleIds.push(roleId);

  // A child under the new role, then reparent the child directly to the root:
  // the SAME row must be updated in place and its level re-derived.
  res = await post('/hr/hierarchies', { name: `${TAG} Second Role`, reportsToId: roleId });
  assert('Child role created under the new role', res.status === 201 && res.data?.level === 3, JSON.stringify(res.data).slice(0, 150));
  role2Id = res.data?.id;
  if (role2Id) createdRoleIds.push(role2Id);

  res = await patch(`/hr/hierarchies/${role2Id}`, { reportsToId: rootId });
  assert('Reparent accepted', res.status === 200, JSON.stringify(res.data).slice(0, 150));
  assert('Same role id returned (updated, not recreated)', res.data?.id === role2Id);
  const { rows } = await sql(`SELECT id, level, reports_to_id FROM hierarchies WHERE id = $1`, [role2Id]);
  assert('Row still exists under the same primary key with re-derived level',
    rows.length === 1 && rows[0].reports_to_id === rootId && rows[0].level === 2, JSON.stringify(rows[0] ?? {}));
  const { rows: dupes } = await sql(`SELECT COUNT(*)::int AS n FROM hierarchies WHERE name = $1`, [`${TAG} Second Role`]);
  assert('No duplicate role was created by the edit', dupes[0].n === 1);
  const { rows: permRows } = await sql(`SELECT COUNT(*)::int AS n FROM permissions WHERE hierarchy_id = $1`, [role2Id]);
  const before = permRows[0].n;
  const { rows: permRows2 } = await sql(`SELECT COUNT(*)::int AS n FROM permissions WHERE hierarchy_id = $1`, [role2Id]);
  assert('Permission rows keyed by hierarchy_id untouched by the edit', permRows2[0].n === before);
}

console.log('\n[P] Audit log records before/after values');
{
  const res = await patch(`/hr/hierarchies/${roleId}`, { description: 'updated responsibilities' });
  assert('Description edit accepted', res.status === 200);
  // logActivity is fire-and-forget, so the row can land a beat after the
  // response — poll briefly for the entry belonging to THIS edit.
  let rows = [];
  for (let i = 0; i < 20 && !rows.length; i++) {
    ({ rows } = await sql(
      `SELECT action, metadata, description FROM activity_log
       WHERE entity_type = 'hierarchy' AND entity_id = $1
         AND metadata->'changedFields' ? 'description'
       ORDER BY id DESC LIMIT 1`, [roleId]));
    if (!rows.length) await new Promise(r => setTimeout(r, 100));
  }
  const meta = rows[0]?.metadata ?? {};
  assert('Audit entry written for the hierarchy edit', rows.length === 1 && rows[0].action === 'UPDATE', JSON.stringify(rows[0] ?? {}).slice(0, 150));
  assert('Audit entry carries BEFORE value', meta.before?.description === 'test role', JSON.stringify(meta).slice(0, 200));
  assert('Audit entry carries AFTER value', meta.after?.description === 'updated responsibilities');
  assert('Audit entry names the changed fields', Array.isArray(meta.changedFields) && meta.changedFields.includes('description'));
}

console.log('\n[Q] Validation: duplicates, reporting-chain guards, protected root role');
{
  let res = await patch(`/hr/hierarchies/${role2Id}`, { name: `${TAG} Warehouse Lead` });
  assert('Renaming onto an existing role name → 409 with clear error', res.status === 409 && /already exists/.test(res.data?.error ?? ''), JSON.stringify(res.data).slice(0, 150));
  res = await patch(`/hr/hierarchies/${role2Id}`, { name: `  ${TAG} WAREHOUSE lead ` });
  assert('Case/whitespace-insensitive duplicate also refused', res.status === 409);
  res = await patch(`/hr/hierarchies/${role2Id}`, { name: '   ' });
  assert('Blank name refused', res.status === 400);
  res = await post('/hr/hierarchies', { name: `${TAG} Warehouse Lead`, reportsToId: rootId });
  assert('Creating a duplicate role name → 409', res.status === 409);
  res = await post('/hr/hierarchies', { name: `${TAG} Orphan Role` });
  assert('Creating a role WITHOUT reportsToId refused (no second root)', res.status === 400, JSON.stringify(res.data).slice(0, 150));
  res = await post('/hr/hierarchies', { name: `${TAG} Orphan Role`, reportsToId: 999999 });
  assert('Creating a role under a nonexistent manager refused', res.status === 400, JSON.stringify(res.data).slice(0, 150));

  // Chain guards: self-reporting and loops.
  res = await patch(`/hr/hierarchies/${role2Id}`, { reportsToId: role2Id });
  assert('A role cannot report to itself', res.status === 400, JSON.stringify(res.data).slice(0, 150));
  // roleId currently reports to root; make role2 report to roleId, then try to
  // point roleId at role2 — that would close a loop.
  res = await patch(`/hr/hierarchies/${role2Id}`, { reportsToId: roleId });
  assert('Reparent under a sibling accepted', res.status === 200 && res.data?.level === 3, JSON.stringify(res.data).slice(0, 150));
  res = await patch(`/hr/hierarchies/${roleId}`, { reportsToId: role2Id });
  assert('Reporting loop refused', res.status === 409 && /loop/i.test(res.data?.error ?? ''), JSON.stringify(res.data).slice(0, 150));

  // Root protections: the level-1 role keeps the full-access override, so it
  // can never be reparented, deleted, or duplicated via create.
  const { rows: [adminRole] } = await sql(`SELECT id, name, description FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`);
  if (adminRole) {
    res = await patch(`/hr/hierarchies/${adminRole.id}`, { reportsToId: roleId });
    assert('Reparenting the root administrative role refused', res.status === 403, JSON.stringify(res.data).slice(0, 150));
    res = await patch(`/hr/hierarchies/${adminRole.id}`, { description: adminRole.description ?? '' });
    assert('Editing safe descriptive fields of the root role still allowed', res.status === 200, JSON.stringify(res.data).slice(0, 150));
    res = await apiReq('DELETE', `/hr/hierarchies/${adminRole.id}`);
    assert('DELETING the root administrative role refused', res.status === 403, JSON.stringify(res.data).slice(0, 150));
    const { rows: still } = await sql(`SELECT id FROM hierarchies WHERE id = $1`, [adminRole.id]);
    assert('Root role still present after refused delete', still.length === 1);
  }

  // Deletion order matters: a role that others report to is refused until the
  // reports are moved.
  res = await apiReq('DELETE', `/hr/hierarchies/${roleId}`);
  assert('Deleting a role that others report to refused (409)', res.status === 409 && /report|child hierarch/i.test(res.data?.error ?? ''), JSON.stringify(res.data).slice(0, 150));
  res = await apiReq('DELETE', `/hr/hierarchies/${role2Id}`);
  assert('Deleting a leaf role works', res.status === 204, `status=${res.status}`);
  if (res.status === 204) createdRoleIds.splice(createdRoleIds.indexOf(role2Id), 1);
}

console.log('\n[R] Unauthenticated/unauthorized callers are refused');
{
  let res = await patch('/company/settings', { generalSettings: { posDiscountsEnabled: false } }, '');
  assert('Settings PATCH without a token refused', res.status === 401 || res.status === 403, `status=${res.status}`);
  res = await patch(`/hr/hierarchies/${roleId}`, { level: 2 }, '');
  assert('Hierarchy PATCH without a token refused', res.status === 401 || res.status === 403, `status=${res.status}`);
  res = await patch('/company/settings', { generalSettings: { posDiscountsEnabled: false } }, 'not-a-real-token');
  assert('Settings PATCH with a garbage token refused', res.status === 401 || res.status === 403, `status=${res.status}`);
  const gs = await currentGeneralSettings();
  assert('Flags unchanged by the refused requests', gs.posDiscountsEnabled === true && gs.posCouponsEnabled === true);
}

} catch (e) {
  console.error('\nSUITE ERROR:', e);
  failed++;
  failures.push(`suite crashed: ${e?.message ?? e}`);
} finally {
  console.log('\n[cleanup]');
  try { await cleanup(); console.log('  ✓ fixtures removed, generalSettings restored'); }
  catch (e) { console.error('  ✗ cleanup failed:', e?.message ?? e); }
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log(' -', f)); }
process.exit(failed ? 1 : 0);
