/**
 * Voucher polish regression suite (task: employee ledgers, system badge
 * provenance, admin-only delete, journal balance):
 *   [A] /accounts/voucher-employees — minimal directory (no salary), gated on
 *       any voucher page's view right.
 *   [B] Employee party legs on manual payments/receipts:
 *         · ADV-EMP-* refused (payroll-owned) on create AND when a PATCH
 *           points a leg at one.
 *         · SAL-PAY of an ACTIVE employee at the voucher's own location → 201.
 *         · Head-office employee on a branch voucher → allowed (company-wide).
 *         · Employee of ANOTHER branch → 400 (effective values, also on PATCH).
 *         · Inactive employee → 400.
 *   [C] Admin-only voucher delete: a non-admin WITH the page delete right gets
 *       403 on payments, receipts and journal vouchers; rows survive; the
 *       admin delete then succeeds (unwind intact).
 *   [D] Provenance: list rows carry origin='manual' for user-created vouchers.
 *   [E] Journal balance validation: unbalanced → 400, balanced → 201.
 *
 * Runs against the DEVELOPMENT database. Creates clearly-marked ZZVP fixtures
 * and deletes every one of them at the end.
 */

import pg from 'pg';
import bcrypt from 'bcryptjs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZVP';

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
const get = (p, t) => apiReq('GET', p, undefined, t);
const del = (p, t) => apiReq('DELETE', p, undefined, t);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

const F = { hierId: 0, clerkEmpId: 0, rootId: 0, empIds: [], ledgerIds: [], paymentIds: [], receiptIds: [], jvIds: [] };

async function cleanup() {
  // Vouchers first (admin API delete is exercised in the suite; this is the
  // crash-recovery backstop), then ledgers, then employees/roles.
  await sql(`DELETE FROM journal_voucher_lines WHERE voucher_id IN (SELECT id FROM journal_vouchers WHERE narration LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM journal_vouchers WHERE narration LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM payments WHERE narration LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM receipts WHERE narration LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM account_ledgers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM employees WHERE username LIKE $1 OR name LIKE $2`, [`${TAG.toLowerCase()}%`, `${TAG}%`]);
  await sql(`DELETE FROM permissions WHERE hierarchy_id IN (SELECT id FROM hierarchies WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM hierarchies WHERE name LIKE $1`, [`${TAG}%`]);
}

const today = new Date().toISOString().slice(0, 10);

try {

console.log('\n[0] Authentication and fixtures');
await cleanup(); // recover any previous crashed run

// Never assume the real admin password (and never touch its hash): clone a
// disposable level-1 user under the root hierarchy and log in as that.
const rootHier = (await sql(`SELECT id FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`)).rows[0].id;
const adminHash = bcrypt.hashSync('zzvp-test-pass-1', 10);
await sql(
  `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, must_change_password, is_active)
   VALUES ($1,$2,$3,$4,'headoffice',0,10000,CURRENT_DATE,false,true)`,
  [`${TAG} Admin`, `${TAG.toLowerCase()}_admin`, adminHash, rootHier]);
const loginRes = await post('/auth/login', { username: `${TAG.toLowerCase()}_admin`, password: 'zzvp-test-pass-1' });
authToken = loginRes.data?.token ?? '';
assert('Cloned admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); await cleanup(); await pool.end(); process.exit(1); }

// Derive two live warehouses (A hosts the vouchers; B provides the "other
// branch" employee). Dev DB holds real data — derive, never hardcode.
const whs = (await sql(`SELECT id, cash_ledger_id FROM warehouses WHERE cash_ledger_id IS NOT NULL AND disabled_at IS NULL ORDER BY id`)).rows;
assert('At least two live warehouses with tills to derive fixtures from', whs.length >= 2);
const whA = Number(whs[0].id), tillA = Number(whs[0].cash_ledger_id);
const whB = Number(whs[1].id);

// Non-admin role (level 2, under root) + clerk with FULL voucher page rights —
// proving delete is refused on hierarchy level, not on the permission row.
F.rootId = rootHier;
const createRole = await post('/hr/hierarchies', { name: `${TAG} Clerk`, reportsToId: F.rootId, description: 'disposable test fixture' });
assert('Fixture role created via API', createRole.status === 201 && createRole.data?.id, JSON.stringify(createRole.data).slice(0, 150));
F.hierId = createRole.data?.id;

const hash = bcrypt.hashSync('marlin1458', 10);
F.clerkEmpId = (await sql(
  `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, must_change_password, is_active)
   VALUES ($1,$2,$3,$4,'headoffice',0,10000,CURRENT_DATE,false,true) RETURNING id`,
  [`${TAG} Clerk`, `${TAG.toLowerCase()}_clerk`, hash, F.hierId])).rows[0].id;
const clerkTok = (await post('/auth/login', { username: `${TAG.toLowerCase()}_clerk`, password: 'marlin1458' })).data?.token ?? '';
assert('Fixture clerk can log in', !!clerkTok);

// Party-side employees: at warehouse A (match), warehouse B (foreign),
// head office (company-wide) and an inactive one at A.
async function mkEmployee(label, branchType, branchId, isActive) {
  return (await sql(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, must_change_password, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,12000,CURRENT_DATE,false,$7) RETURNING id`,
    [`${TAG} ${label}`, `${TAG.toLowerCase()}_${label.toLowerCase()}`, hash, F.hierId, branchType, branchId, isActive])).rows[0].id;
}
const empA = await mkEmployee('EmpA', 'warehouse', whA, true);
const empB = await mkEmployee('EmpB', 'warehouse', whB, true);
const empHO = await mkEmployee('EmpHO', 'headoffice', 0, true);
const empOff = await mkEmployee('EmpOff', 'warehouse', whA, false);
F.empIds.push(empA, empB, empHO, empOff);

// Salary-payable ledgers under the standard group (the code prefix is what
// the server keys on), plus one advance ledger to prove the refusal.
const salParent = (await sql(`SELECT id FROM account_ledgers WHERE code = 'STD-GRP-SAL-PAY'`)).rows[0].id;
async function mkLedger(code, name) {
  const id = (await sql(
    `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
     VALUES ($1,'liability',$2,'balance_sheet',$3,false,false,'disposable test fixture') RETURNING id`,
    [name, code, salParent])).rows[0].id;
  F.ledgerIds.push(id);
  return id;
}
const salPayA = await mkLedger(`SAL-PAY-${empA}`, `${TAG} Salary Payable A`);
const salPayB = await mkLedger(`SAL-PAY-${empB}`, `${TAG} Salary Payable B`);
const salPayHO = await mkLedger(`SAL-PAY-${empHO}`, `${TAG} Salary Payable HO`);
const salPayOff = await mkLedger(`SAL-PAY-${empOff}`, `${TAG} Salary Payable Off`);
const advA = await mkLedger(`ADV-EMP-${empA}`, `${TAG} Advance A`);

const payBody = (paidTo, extra = {}) => ({
  paymentDate: today, paidFromLedgerId: tillA, paidToLedgerId: paidTo, amount: 100,
  narration: `${TAG} test voucher`, locationType: 'warehouse', locationId: whA, ...extra,
});
const rcptBody = (from, extra = {}) => ({
  receiptDate: today, receivedInLedgerId: tillA, receivedFromLedgerId: from, amount: 100,
  narration: `${TAG} test voucher`, locationType: 'warehouse', locationId: whA, ...extra,
});

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[A] Voucher employee directory');
{
  let res = await get('/accounts/voucher-employees', clerkTok);
  assert('Refused without any voucher page view right (403)', res.status === 403, `status=${res.status}`);

  await post('/company/permissions', { hierarchyId: F.hierId, module: 'page:/accounts/vouchers', canView: true, canAdd: true, canEdit: true, canDelete: true, canDownload: true });
  res = await get('/accounts/voucher-employees', clerkTok);
  assert('Allowed with the vouchers page view right', res.status === 200 && Array.isArray(res.data), `status=${res.status}`);
  const rowA = (res.data || []).find(r => r.id === empA);
  assert('Fixture employee present with branch stamp', rowA && rowA.branchType === 'warehouse' && rowA.branchId === whA && rowA.isActive === true, JSON.stringify(rowA));
  const rowOff = (res.data || []).find(r => r.id === empOff);
  assert('Inactive employee listed as inactive (client filters)', rowOff && rowOff.isActive === false, JSON.stringify(rowOff));
  assert('No salary or contact data leaks', rowA && !('salary' in rowA) && !('phone' in rowA) && !('username' in rowA), JSON.stringify(rowA));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[B] Employee party legs on payments/receipts');
let keepPaymentId = 0, keepReceiptId = 0;
{
  let res = await post('/accounts/payments', payBody(advA));
  assert('Payment to an ADV-EMP ledger refused (400)', res.status === 400 && /payroll/i.test(res.data?.error ?? ''), `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);

  res = await post('/accounts/payments', payBody(salPayB));
  assert('Payment to another branch\'s employee refused (400)', res.status === 400 && /location/i.test(res.data?.error ?? ''), `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);

  res = await post('/accounts/payments', payBody(salPayOff));
  assert('Payment to an inactive employee refused (400)', res.status === 400 && /inactive/i.test(res.data?.error ?? ''), `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);

  res = await post('/accounts/payments', payBody(salPayA));
  assert('Payment to own-location active employee accepted (201)', res.status === 201 && res.data?.id, `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  keepPaymentId = res.data?.id;
  if (keepPaymentId) F.paymentIds.push(keepPaymentId);

  res = await post('/accounts/payments', payBody(salPayHO));
  assert('Head-office employee allowed on a branch voucher (201)', res.status === 201 && res.data?.id, `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  const hoPayId = res.data?.id;
  if (hoPayId) F.paymentIds.push(hoPayId);

  // PATCH guards the EFFECTIVE value: repointing the party leg re-runs the rules.
  res = await patch(`/accounts/payments/${keepPaymentId}`, { paidToLedgerId: advA });
  assert('PATCH repointing a leg at ADV-EMP refused (400)', res.status === 400 && /payroll/i.test(res.data?.error ?? ''), `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  res = await patch(`/accounts/payments/${keepPaymentId}`, { paidToLedgerId: salPayB });
  assert('PATCH repointing at another branch\'s employee refused (400)', res.status === 400, `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  res = await patch(`/accounts/payments/${keepPaymentId}`, { amount: 120 });
  assert('PATCH of amount alone (leg unchanged) still allowed', res.status === 200, `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);

  // Receipts share the same guard.
  res = await post('/accounts/receipts', rcptBody(advA));
  assert('Receipt from an ADV-EMP ledger refused (400)', res.status === 400 && /payroll/i.test(res.data?.error ?? ''), `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  res = await post('/accounts/receipts', rcptBody(salPayB));
  assert('Receipt from another branch\'s employee refused (400)', res.status === 400, `status=${res.status}`);
  res = await post('/accounts/receipts', rcptBody(salPayA));
  assert('Receipt from own-location employee accepted (201)', res.status === 201 && res.data?.id, `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  keepReceiptId = res.data?.id;
  if (keepReceiptId) F.receiptIds.push(keepReceiptId);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[C] Admin-only voucher delete');
let jvId = 0;
{
  // A balanced journal fixture to delete (also exercises [E]'s happy path).
  const jvRes = await post('/accounts/journal-vouchers', {
    voucherType: 'journal', voucherDate: today, narration: `${TAG} journal fixture`,
    locationType: 'headoffice',
    lines: [
      { ledgerId: salPayA, debit: 50, credit: 0 },
      { ledgerId: salPayHO, debit: 0, credit: 50 },
    ],
  });
  assert('Balanced journal voucher accepted (201)', jvRes.status === 201 && jvRes.data?.id, `status=${jvRes.status} ${JSON.stringify(jvRes.data).slice(0, 150)}`);
  jvId = jvRes.data?.id;
  if (jvId) F.jvIds.push(jvId);

  // The clerk HOLDS the page delete right — the refusal must come from the
  // hierarchy level, with the row intact afterwards.
  let res = await del(`/accounts/payments/${keepPaymentId}`, clerkTok);
  assert('Non-admin payment delete refused (403)', res.status === 403 && /administrator/i.test(res.data?.error ?? ''), `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  assert('Payment row survives the refused delete', (await sql(`SELECT 1 FROM payments WHERE id = $1`, [keepPaymentId])).rows.length === 1);

  res = await del(`/accounts/receipts/${keepReceiptId}`, clerkTok);
  assert('Non-admin receipt delete refused (403)', res.status === 403, `status=${res.status}`);
  res = await del(`/accounts/journal-vouchers/${jvId}`, clerkTok);
  assert('Non-admin journal delete refused (403)', res.status === 403, `status=${res.status}`);

  // Admin deletes still work (unwind path unchanged).
  res = await del(`/accounts/payments/${keepPaymentId}`);
  assert('Admin payment delete succeeds', res.status === 200 || res.status === 204, `status=${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  res = await del(`/accounts/receipts/${keepReceiptId}`);
  assert('Admin receipt delete succeeds', res.status === 200 || res.status === 204, `status=${res.status}`);
  res = await del(`/accounts/journal-vouchers/${jvId}`);
  assert('Admin journal delete succeeds', res.status === 200 || res.status === 204, `status=${res.status}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[D] Provenance on list rows');
{
  const res = await post('/accounts/payments', payBody(salPayA, { narration: `${TAG} provenance probe` }));
  assert('Probe payment created', res.status === 201 && res.data?.id, `status=${res.status}`);
  const pid = res.data?.id;
  if (pid) F.paymentIds.push(pid);
  const list = await get('/accounts/payments');
  const row = (Array.isArray(list.data) ? list.data : []).find(p => p.id === pid);
  assert('List row carries origin=manual for a user-created voucher', row?.origin === 'manual', JSON.stringify(row).slice(0, 150));
  assert('List row is editable (manual provenance)', row?.editable === true, JSON.stringify(row).slice(0, 150));
  const dres = await del(`/accounts/payments/${pid}`);
  assert('Probe payment cleaned up via admin delete', dres.status === 200 || dres.status === 204, `status=${dres.status}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[E] Journal balance validation');
{
  const res = await post('/accounts/journal-vouchers', {
    voucherType: 'journal', voucherDate: today, narration: `${TAG} unbalanced probe`,
    locationType: 'headoffice',
    lines: [
      { ledgerId: salPayA, debit: 80, credit: 0 },
      { ledgerId: salPayHO, debit: 0, credit: 50 },
    ],
  });
  assert('Unbalanced journal refused (400)', res.status === 400 && /balance/i.test(res.data?.error ?? ''), `status=${res.status} ${JSON.stringify(res.data).slice(0, 150)}`);
}

} catch (e) {
  console.error('\nUNCAUGHT ERROR:', e);
  failed++;
  failures.push(`uncaught: ${e?.message}`);
} finally {
  try { await cleanup(); } catch (e) { console.error('cleanup failed:', e?.message); }
  await pool.end();
}

console.log(`\n${'─'.repeat(60)}\n${passed} passed, ${failed} failed${failures.length ? '\nFailures:\n  - ' + failures.join('\n  - ') : ''}`);
process.exit(failed ? 1 : 0);
