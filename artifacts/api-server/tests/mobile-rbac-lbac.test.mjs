/**
 * Cross-role RBAC + LBAC proof for the mobile app's API surface (task: role
 * matrix, location security, honest deny behaviour).
 * Run: node artifacts/api-server/tests/mobile-rbac-lbac.test.mjs
 *
 * What it proves:
 *   [1] Page-gate matrix — for FIVE roles (admin L1, management L2 HO,
 *       manager L3 wh1, sales-officer L4 wh1, manager L3 wh2) every probed
 *       endpoint answers 403 exactly when the role's own permission rows say
 *       "no view/add/edit", and never 403 when they say yes. Expectations are
 *       DERIVED from GET /company/permissions at runtime, so the suite follows
 *       the business's live permission matrix instead of pinning today's copy.
 *   [2] Deny shape — denied write = 403; permitted-but-empty write = 400
 *       (validation, not authority); nonexistent id = 404. A client can trust
 *       the distinction.
 *   [3] LBAC spoof matrix — a wh1-scoped manager cannot read or touch wh2
 *       data via query params, via x-location-* headers, by direct id, by
 *       dispatch transition, by payment insert, or by posting a sale bearing a
 *       wh2 body location. Same checks pass symmetrically for the wh2 manager
 *       against wh1.
 *   [4] Voucher gates & LBAC — receipt/payment/journal voucher lists obey the
 *       page gates; a branch user cannot list foreign-stamped money vouchers
 *       via header spoof, and cannot create a receipt into another location's
 *       cash ledger.
 *   [5] Permission disclosure — non-L1 callers receive only their own
 *       hierarchy's permission rows.
 *   [6] Read-only proof — trial balance and row counts identical after the run;
 *       every temp user is deleted through the app's own endpoints.
 *
 * Fixtures — created through the app's own user management wherever possible:
 *   - ONE bootstrap admin (zztest338m-adm) is inserted via SQL. This is
 *     unavoidable: the suite must never assume or reset the real admin's
 *     password, and without an admin session no user can be created at all.
 *     It is the only SQL-created row, and it is removed at the end.
 *   - All other roles are created via POST /hr/employees as that admin, log in
 *     with the app's default initial password, and are forced through
 *     POST /auth/change-password — which doubles as the API-level regression
 *     for the forced-password-change flow.
 *   - Outlet-employee role: the Outlet module is switched OFF in this
 *     business's settings (outletsEnabled=false, zero outlet rows), so outlet
 *     users cannot exist. The suite proves the 409 deny-path instead; the role
 *     itself is reported NOT VERIFIED.
 *   - Cleanup: DELETE /hr/employees/:id for API-created users; SQL only for
 *     the bootstrap admin and the login-audit rows (no app path deletes those).
 * No sales/purchases are created — write probes use empty/foreign bodies that
 * must be refused.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'zztest338m';
const PASSWORD = 'ZzTest!12345';
// bcrypt of the password above (cost 10) — same hash used by earlier 338 fixtures.
const HASH = '$2b$10$IuHNFJwf3V9qR9dujVlZA.Uk1CupNfxuIcDuQfpMDtwVekihk.0/C';

let passed = 0, failed = 0;
const failures = [];
function assert(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
}

async function apiReq(method, path, body, token, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const r2 = (n) => Math.round(n * 100) / 100;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (t, p) => pool.query(t, p);

async function snapshotTB(adminToken) {
  const res = await apiReq('GET', '/accounts/trial-balance', undefined, adminToken);
  const rows = res.data?.rows ?? [];
  return {
    dr: r2(rows.reduce((s, r) => s + Number(r.debit ?? 0), 0)),
    cr: r2(rows.reduce((s, r) => s + Number(r.credit ?? 0), 0)),
  };
}
async function writeCounts() {
  return (await sql(`
    SELECT (SELECT COUNT(*) FROM sales)                AS sales,
           (SELECT COUNT(*) FROM sale_payments)        AS pays,
           (SELECT COUNT(*) FROM sale_dispatch_status) AS dispatch,
           (SELECT COUNT(*) FROM receipts)             AS receipts,
           (SELECT COUNT(*) FROM stock_ledger)         AS sl
  `)).rows[0];
}

async function cleanup() {
  await sql(`DELETE FROM login_attempts WHERE username LIKE $1`, [`${TAG}%`]).catch(() => {});
  await sql(`DELETE FROM login_lockouts WHERE username LIKE $1`, [`${TAG}%`]).catch(() => {});
  // App-created fixtures carry an auto-seeded pay-structure row that blocks
  // the employee FK — remove it first (crash-heal path only; the normal path
  // deletes users through DELETE /hr/employees/:id).
  await sql(`DELETE FROM pay_components WHERE employee_id IN (SELECT id FROM employees WHERE username LIKE $1)`, [`${TAG}%`]).catch(() => {});
  await sql(`DELETE FROM employees WHERE username LIKE $1`, [`${TAG}%`]);
}

// ── [0] Fixtures ────────────────────────────────────────────────────────────
console.log('\n[0] Roles and logins');
await cleanup(); // heal a crashed previous run

// A mid-run throw must still remove the SQL-created temp users; the startup
// self-heal above is the second line of defence for a hard crash.
process.on('unhandledRejection', async (err) => {
  console.error('FATAL (unhandled):', err);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});

// Derive hierarchy ids from the live tree — never hardcode business rows.
const hier = (await sql(`SELECT id, name, level FROM hierarchies ORDER BY level, id`)).rows;
const byLevel = (lvl) => hier.filter((h) => Number(h.level) === lvl);
const admin  = byLevel(1)[0];
const mgmt   = byLevel(2)[0];
const l3     = byLevel(3);
const l4     = byLevel(4)[0] ?? l3[l3.length - 1];
const mgrH   = l3[0];
assert('Hierarchy tree yields L1/L2/L3/L4 roles', !!admin && !!mgmt && !!mgrH && !!l4,
  JSON.stringify(hier));
if (!admin || !mgrH) { console.error('FATAL: hierarchy roles missing'); process.exit(1); }

const USERS = [
  { key: 'adm', hierarchy: admin, branchType: 'headoffice', branchId: 1 },
  { key: 'ho',  hierarchy: mgmt ?? admin, branchType: 'headoffice', branchId: 1 },
  { key: 'mgr', hierarchy: mgrH, branchType: 'warehouse', branchId: 1 },
  { key: 'emp', hierarchy: l4,   branchType: 'warehouse', branchId: 1 },
  { key: 'wh2', hierarchy: mgrH, branchType: 'warehouse', branchId: 2 },
];
const tok = {};    // key -> token
const perms = {};  // key -> { level, rows }
const empIds = {}; // key -> employee id (for app-path deletion)

// Bootstrap admin — the ONE SQL fixture (see header for why).
await sql(
  `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, is_active, join_date)
   VALUES ($1, $2, $3, $4, 'headoffice', 1, 0, true, '2026-08-01')`,
  [`ZZ338M adm (${admin.name})`, `${TAG}-adm`, HASH, admin.id]);
{
  const login = await apiReq('POST', '/auth/login', { username: `${TAG}-adm`, password: PASSWORD });
  tok.adm = login.data?.token ?? '';
  assert(`adm (${admin.name} L1 @ headoffice) bootstrap login`, !!tok.adm, `status=${login.status}`);
  if (!tok.adm) { console.error('FATAL: bootstrap login failed'); await cleanup(); process.exit(1); }
}

// The app hands every new employee the same initial password and forces a
// change on first login — so each fixture user exercises that exact flow.
const DEFAULT_INITIAL_PASSWORD = 'marlin1458'; // lib/passwordPolicy.ts
for (const u of USERS.filter((x) => x.key !== 'adm')) {
  const created = await apiReq('POST', '/hr/employees', {
    name: `ZZ338M ${u.key} (${u.hierarchy.name})`,
    username: `${TAG}-${u.key}`,
    hierarchyId: u.hierarchy.id,
    branchType: u.branchType,
    branchId: u.branchId,
    salary: 0,
    joinDate: '2026-08-01',
  }, tok.adm);
  empIds[u.key] = created.data?.id;
  assert(`${u.key} created via POST /hr/employees`, created.status === 201 && !!empIds[u.key],
    `status=${created.status} ${JSON.stringify(created.data).slice(0, 120)}`);

  const first = await apiReq('POST', '/auth/login', { username: `${TAG}-${u.key}`, password: DEFAULT_INITIAL_PASSWORD });
  // Login returns { token, employee } — the forced-change flag rides on the
  // employee object.
  const mustChange = first.data?.employee?.mustChangePassword ?? first.data?.employee?.must_change_password;
  const changed = await apiReq('POST', '/auth/change-password',
    { currentPassword: DEFAULT_INITIAL_PASSWORD, newPassword: PASSWORD }, first.data?.token);
  const relogin = await apiReq('POST', '/auth/login', { username: `${TAG}-${u.key}`, password: PASSWORD });
  tok[u.key] = relogin.data?.token ?? '';
  assert(`${u.key} (${u.hierarchy.name} L${u.hierarchy.level} @ ${u.branchType}${u.branchType === 'warehouse' ? ' ' + u.branchId : ''}) first-login → forced change → re-login`,
    first.status === 200 && mustChange === true && changed.status === 200 && !!tok[u.key],
    `first=${first.status} mustChange=${mustChange} change=${changed.status} relogin=${relogin.status}`);
}
if (Object.values(tok).some((t) => !t)) { console.error('FATAL: a login failed'); await cleanup(); process.exit(1); }

// Outlet-employee role: prove WHY it cannot be covered. The Outlet module is
// off (outletsEnabled=false) and both outlet creation and outlet staffing must
// refuse with the documented 409 — the role is NOT VERIFIED, not skipped
// silently.
{
  const o = await apiReq('POST', '/outlets', { name: `${TAG} outlet`, warehouseId: 1 }, tok.adm);
  const e = await apiReq('POST', '/hr/employees', {
    name: `ZZ338M outlet probe`, username: `${TAG}-out`, hierarchyId: l4.id,
    branchType: 'outlet', branchId: 1, salary: 0, joinDate: '2026-08-01',
  }, tok.adm);
  assert('Outlet module off: outlet create AND outlet staffing both 409 (role NOT VERIFIED by design)',
    o.status === 409 && o.data?.code === 'OUTLETS_DISABLED' && e.status === 409 && e.data?.code === 'OUTLETS_DISABLED',
    `outlet=${o.status}/${o.data?.code} employee=${e.status}/${e.data?.code}`);
}

const tbBefore = await snapshotTB(tok.adm);
const countsBefore = await writeCounts();

// Live permission rows per user → derived expectations.
for (const u of USERS) {
  const res = await apiReq('GET', '/company/permissions', undefined, tok[u.key]);
  perms[u.key] = { level: Number(u.hierarchy.level), rows: Array.isArray(res.data) ? res.data : [] };
}
// Mirrors the client + server rule: level 1 = full access, else any-of rows.
function allowed(userKey, keys, action) {
  const p = perms[userKey];
  if (p.level === 1) return true;
  const u = USERS.find((x) => x.key === userKey);
  const field = { view: 'canView', add: 'canAdd', edit: 'canEdit', delete: 'canDelete' }[action];
  return p.rows.some((r) => r.hierarchyId === u.hierarchy.id && keys.includes(r.module ?? '') && r[field] === true);
}

// Reference sale ids per location (read-only, taken from live data).
const wh1SaleId = (await apiReq('GET', '/sales?locationType=warehouse&locationId=1', undefined, tok.adm)).data?.[0]?.id;
const wh2SaleId = (await apiReq('GET', '/sales?locationType=warehouse&locationId=2', undefined, tok.adm)).data?.[0]?.id;
assert('Reference sales exist in both warehouses', !!wh1SaleId && !!wh2SaleId, `wh1=${wh1SaleId} wh2=${wh2SaleId}`);

// ── [1] Page-gate matrix ────────────────────────────────────────────────────
console.log('\n[1] Page-gate matrix (expectations derived from live permission rows)');

const K = {
  salesList: ['page:/sales/pos', 'page:/returns', 'page:/'],
  saleDetail: ['page:/sales/pos', 'page:/operations/dispatch'],
  dispatch: ['page:/operations/dispatch'],
  stock: ['page:/', 'page:/production/item-master', 'page:/headoffice/stock-verification', 'page:/sales/pos', 'page:/headoffice/stock', 'page:/transfers'],
  dash: ['page:/'],
  payroll: ['page:/hr/payroll'],
  attendance: ['page:/hr/attendance'],
  receipts: ['page:/accounts/vouchers', 'page:/operations/receipt-voucher'],
  payments: ['page:/accounts/vouchers', 'page:/operations/payment-voucher'],
  jv: ['page:/accounts/vouchers'],
};
const GET_PROBES = [
  { label: 'GET /sales',          path: '/sales',            keys: K.salesList },
  { label: 'GET /dispatch/queue', path: '/dispatch/queue',   keys: K.dispatch },
  { label: 'GET /stock',          path: '/stock',            keys: K.stock },
  { label: 'GET /dashboard/bi',   path: '/dashboard/bi',     keys: K.dash },
  { label: 'GET /hr/payroll',     path: '/hr/payroll',       keys: K.payroll },
  { label: 'GET /hr/attendance',  path: '/hr/attendance',    keys: K.attendance },
  { label: 'GET /hr/leaves',      path: '/hr/leaves',        keys: K.attendance },
  { label: 'GET /accounts/receipts',         path: '/accounts/receipts',         keys: K.receipts },
  { label: 'GET /accounts/payments',         path: '/accounts/payments',         keys: K.payments },
  { label: 'GET /accounts/journal-vouchers', path: '/accounts/journal-vouchers', keys: K.jv },
];

for (const u of USERS) {
  console.log(`  — ${u.key} (${u.hierarchy.name})`);
  for (const probe of GET_PROBES) {
    const want = allowed(u.key, probe.keys, 'view');
    const res = await apiReq('GET', probe.path, undefined, tok[u.key]);
    assert(`${u.key} ${probe.label} → ${want ? 'allowed' : '403'}`,
      want ? (res.status >= 200 && res.status < 300) : res.status === 403,
      `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
  }
  // Sale detail: permission gate first (403), then location scope (404), then 200.
  {
    const want = allowed(u.key, K.saleDetail, 'view');
    const inScope = u.branchType === 'headoffice' || u.branchId === 1;
    const expect = !want ? 403 : (inScope ? 200 : 404);
    const res = await apiReq('GET', `/sales/${wh1SaleId}`, undefined, tok[u.key]);
    assert(`${u.key} GET /sales/:id (wh1) → ${expect}`, res.status === expect, `status=${res.status}`);
  }
}

// ── [2] Deny shape: 403 vs 400 vs 404 ───────────────────────────────────────
console.log('\n[2] Deny shape — authority vs validation vs existence');
for (const u of USERS) {
  const canCreate = allowed(u.key, ['page:/sales/pos'], 'add');
  const res = await apiReq('POST', '/sales', {}, tok[u.key]);
  assert(`${u.key} empty POST /sales → ${canCreate ? '400 (validation)' : '403 (authority)'}`,
    canCreate ? res.status === 400 : res.status === 403, `status=${res.status}`);

  // Body validation runs before the sale lookup, so an empty body is 400 for
  // every permitted caller regardless of scope — the SAME answer whether the
  // sale is theirs, foreign, or nonexistent, so it is not a location oracle.
  // (A VALID body against a foreign sale gets 404 — proven in section [3].)
  const canDispatch = allowed(u.key, K.dispatch, 'edit');
  const res2 = await apiReq('POST', `/dispatch/${wh1SaleId}/status`, {}, tok[u.key]);
  assert(`${u.key} empty POST /dispatch/:id/status → ${canDispatch ? '400' : '403'}`,
    canDispatch ? res2.status === 400 : res2.status === 403,
    `status=${res2.status} ${JSON.stringify(res2.data).slice(0, 80)}`);
}
{
  const res = await apiReq('GET', '/sales/999999999', undefined, tok.adm);
  assert('Nonexistent sale id → 404 (not 500)', res.status === 404, `status=${res.status}`);
}

// ── [3] LBAC spoof matrix ───────────────────────────────────────────────────
console.log('\n[3] LBAC — location spoofing (both directions)');

// Foreign-location sale id sets, fetched as admin, used for leak detection.
const wh1Ids = new Set(((await apiReq('GET', '/sales?locationType=warehouse&locationId=1', undefined, tok.adm)).data ?? []).map((s) => s.id));
const wh2Ids = new Set(((await apiReq('GET', '/sales?locationType=warehouse&locationId=2', undefined, tok.adm)).data ?? []).map((s) => s.id));
assert('Leak-detection id sets are non-empty', wh1Ids.size > 0 && wh2Ids.size > 0);

async function lbacChecks(attacker, foreignName, foreignId, foreignIds, foreignSaleId) {
  const t = tok[attacker];
  const leak = (rows) => (rows ?? []).filter((s) => foreignIds.has(s.id)).length;

  if (allowed(attacker, K.salesList, 'view')) {
    const q = await apiReq('GET', `/sales?locationType=warehouse&locationId=${foreignId}`, undefined, t);
    assert(`${attacker}: query-param spoof leaks no ${foreignName} sales`,
      q.status === 200 ? leak(q.data) === 0 : q.status === 403 || q.status === 404,
      `status=${q.status} leaked=${q.status === 200 ? leak(q.data) : '-'}`);

    const h = await apiReq('GET', '/sales', undefined, t,
      { 'x-location-type': 'warehouse', 'x-location-id': String(foreignId) });
    assert(`${attacker}: x-location-* header spoof leaks no ${foreignName} sales`,
      h.status === 200 ? leak(h.data) === 0 : h.status === 403,
      `status=${h.status} leaked=${h.status === 200 ? leak(h.data) : '-'}`);
  }
  if (allowed(attacker, K.saleDetail, 'view')) {
    const d = await apiReq('GET', `/sales/${foreignSaleId}`, undefined, t);
    assert(`${attacker}: direct GET of a ${foreignName} sale → 404`, d.status === 404, `status=${d.status}`);
  }
  if (allowed(attacker, K.dispatch, 'view')) {
    const q = await apiReq('GET', '/dispatch/queue', undefined, t);
    assert(`${attacker}: dispatch queue shows no ${foreignName} sales`,
      q.status === 200 && (q.data ?? []).filter((r) => foreignIds.has(r.saleId ?? r.sale_id ?? r.id)).length === 0,
      `status=${q.status}`);
  }
  if (allowed(attacker, K.dispatch, 'edit')) {
    const before = (await sql(`SELECT COUNT(*) c FROM sale_dispatch_status WHERE sale_id = $1`, [foreignSaleId])).rows[0].c;
    const w = await apiReq('POST', `/dispatch/${foreignSaleId}/status`, { status: 'READY' }, t);
    const after = (await sql(`SELECT COUNT(*) c FROM sale_dispatch_status WHERE sale_id = $1`, [foreignSaleId])).rows[0].c;
    assert(`${attacker}: dispatch transition on a ${foreignName} sale → 404, nothing written`,
      w.status === 404 && before === after, `status=${w.status} rows ${before}→${after}`);
  }
  {
    // Deliberately EXCESSIVE amount: on an in-scope sale this would trip the
    // overpayment 400, whose message quotes the balance due. Out of scope it
    // must hit the location gate FIRST — 403/404 with no balance figures —
    // otherwise a foreign branch can read any bill's outstanding balance by
    // probing sale ids (the oracle fixed in this round).
    const before = (await sql(`SELECT COUNT(*) c FROM sale_payments WHERE sale_id = $1`, [foreignSaleId])).rows[0].c;
    const p = await apiReq('POST', `/sales/${foreignSaleId}/payments`, { method: 'cash', amount: 999999999 }, t);
    const after = (await sql(`SELECT COUNT(*) c FROM sale_payments WHERE sale_id = $1`, [foreignSaleId])).rows[0].c;
    const body = JSON.stringify(p.data ?? {});
    const leaksBalance = body.includes('balanceDue') || body.includes('EXCEEDS_OUTSTANDING') || body.includes('excess');
    assert(`${attacker}: payment probe into a ${foreignName} sale refused, nothing written, no balance leaked`,
      (p.status === 403 || p.status === 404) && before === after && !leaksBalance,
      `status=${p.status} rows ${before}→${after} body=${body.slice(0, 100)}`);
  }
  if (allowed(attacker, ['page:/sales/pos'], 'add')) {
    // A plausible body aimed at the foreign warehouse; the location gate must
    // refuse it as AUTHORITY (403), and no sale row may appear.
    const ref = (await apiReq('GET', `/sales/${foreignSaleId}`, undefined, tok.adm)).data;
    const line = (ref?.lineItems ?? ref?.line_items ?? [])[0];
    const before = (await sql(`SELECT COUNT(*) c FROM sales`)).rows[0].c;
    const res = await apiReq('POST', '/sales', {
      locationType: 'warehouse', locationId: foreignId, outletId: foreignId,
      saleDate: '2026-08-16', paymentMode: 'cash',
      lineItems: [{ itemId: line?.itemId ?? line?.item_id ?? 1, quantity: 1, unitPrice: Number(line?.unitPrice ?? line?.unit_price ?? 99999) }],
    }, t);
    const after = (await sql(`SELECT COUNT(*) c FROM sales`)).rows[0].c;
    if (res.status === 201 && res.data?.id) { // gate failed — undo before reporting
      await apiReq('POST', `/sales/${res.data.id}/cancel`, {}, tok.adm).catch(() => {});
      await sql(`DELETE FROM sale_payments WHERE sale_id = $1`, [res.data.id]);
      await sql(`DELETE FROM sales WHERE id = $1`, [res.data.id]);
    }
    assert(`${attacker}: POST /sales with ${foreignName} body location → 403, no row created`,
      res.status === 403 && before === after, `status=${res.status} sales ${before}→${after}`);
  }
}

await lbacChecks('mgr', 'wh2', 2, wh2Ids, wh2SaleId);
await lbacChecks('wh2', 'wh1', 1, wh1Ids, wh1SaleId);
await lbacChecks('emp', 'wh2', 2, wh2Ids, wh2SaleId);

// ── [4] Voucher gates & LBAC ────────────────────────────────────────────────
console.log('\n[4] Money vouchers — list scope and foreign-till creation');

// Each warehouse's own cash ledger, derived from live data (never hardcoded).
const whCash = Object.fromEntries(
  (await sql(`SELECT id, cash_ledger_id FROM warehouses ORDER BY id`)).rows
    .map((r) => [Number(r.id), Number(r.cash_ledger_id)]),
);

async function voucherLbac(attacker, foreignName, foreignId) {
  const t = tok[attacker];
  // Money-voucher rows can come back snake_case (list endpoints return raw
  // rows) — check both casings when hunting for foreign-stamped vouchers.
  const stampedForeign = (rows) => (rows ?? []).filter((r) =>
    (r.location_type ?? r.locationType) === 'warehouse' &&
    Number(r.location_id ?? r.locationId) === foreignId).length;

  if (allowed(attacker, K.receipts, 'view')) {
    const h = await apiReq('GET', '/accounts/receipts', undefined, t,
      { 'x-location-type': 'warehouse', 'x-location-id': String(foreignId) });
    assert(`${attacker}: receipts list under ${foreignName} header spoof shows no foreign vouchers`,
      h.status === 200 ? stampedForeign(h.data) === 0 : h.status === 403,
      `status=${h.status} foreign=${h.status === 200 ? stampedForeign(h.data) : '-'}`);
  }
  if (allowed(attacker, K.payments, 'view')) {
    const h = await apiReq('GET', '/accounts/payments', undefined, t,
      { 'x-location-type': 'warehouse', 'x-location-id': String(foreignId) });
    assert(`${attacker}: payments list under ${foreignName} header spoof shows no foreign vouchers`,
      h.status === 200 ? stampedForeign(h.data) === 0 : h.status === 403,
      `status=${h.status} foreign=${h.status === 200 ? stampedForeign(h.data) : '-'}`);
  }
  if (allowed(attacker, K.receipts, 'add')) {
    // Collection into ANOTHER location's cash box: the receiving-leg scope
    // check must refuse it as authority, and no receipts row may appear.
    const before = (await sql(`SELECT COUNT(*) c FROM receipts`)).rows[0].c;
    const res = await apiReq('POST', '/accounts/receipts', {
      receiptDate: new Date().toISOString().slice(0, 10),
      receivedFromLedgerId: whCash[attacker === 'wh2' ? 2 : 1],
      receivedInLedgerId: whCash[foreignId],
      amount: 1,
    }, t);
    const after = (await sql(`SELECT COUNT(*) c FROM receipts`)).rows[0].c;
    assert(`${attacker}: receipt into the ${foreignName} till → 403, no voucher created`,
      res.status === 403 && before === after,
      `status=${res.status} receipts ${before}→${after} ${JSON.stringify(res.data).slice(0, 90)}`);
  }
}
await voucherLbac('mgr', 'wh2', 2);
await voucherLbac('wh2', 'wh1', 1);
await voucherLbac('emp', 'wh2', 2);

// ── [5] Permission disclosure ───────────────────────────────────────────────
console.log('\n[5] Permission rows disclosure');
for (const u of USERS.filter((x) => Number(x.hierarchy.level) !== 1)) {
  const rows = perms[u.key].rows;
  assert(`${u.key} sees only its own hierarchy's permission rows`,
    rows.length > 0 && rows.every((r) => r.hierarchyId === u.hierarchy.id),
    `foreign=${rows.filter((r) => r.hierarchyId !== u.hierarchy.id).length}`);
}

// ── [6] Read-only proof + cleanup ───────────────────────────────────────────
console.log('\n[6] Read-only proof and cleanup');
const countsAfter = await writeCounts();
assert('No business rows created by the whole matrix',
  JSON.stringify(countsBefore) === JSON.stringify(countsAfter),
  `${JSON.stringify(countsBefore)} → ${JSON.stringify(countsAfter)}`);
const tbAfter = await snapshotTB(tok.adm);
assert('Trial balance unchanged', tbBefore.dr === tbAfter.dr && tbBefore.cr === tbAfter.cr,
  `${tbBefore.dr}/${tbBefore.cr} → ${tbAfter.dr}/${tbAfter.cr}`);

// App-path deletion for API-created users; SQL only for the bootstrap admin
// and login-audit rows (which have no app delete path).
for (const u of USERS.filter((x) => x.key !== 'adm')) {
  const del = await apiReq('DELETE', `/hr/employees/${empIds[u.key]}`, undefined, tok.adm);
  assert(`${u.key} deleted via DELETE /hr/employees/:id`, del.status === 204,
    `status=${del.status} ${JSON.stringify(del.data).slice(0, 90)}`);
}
await cleanup();
const strays = (await sql(`SELECT COUNT(*) c FROM employees WHERE username LIKE $1`, [`${TAG}%`])).rows[0].c;
assert('All temp users deleted', Number(strays) === 0, `strays=${strays}`);

await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('Failures:', failures); process.exit(1); }
