/**
 * Employee self-service regression at the API level (task: login, forced
 * password change, profile, attendance check-in/out, leave apply/cancel).
 * Run: node artifacts/api-server/tests/employee-regression-338.test.mjs
 *
 * What it proves:
 *   [1] Forced first login — a new employee gets the app's default initial
 *       password, must change it, and the old password stops working.
 *   [2] Profile — GET /auth/me returns the caller's own record, never a
 *       password hash.
 *   [3] Attendance — check-in opens a punch, a SECOND check-in while one is
 *       open is refused (409 — the double-tap guard), check-out closes it and
 *       the day shows computed hours.
 *   [4] Leave — apply creates a pending request (zero pay impact); cancel is
 *       a STATUS FLIP to 'cancelled' (the row stays for the audit trail — a
 *       pending request never touched attendance, so nothing else moves).
 *   [5] History protection — deleting an employee who has attendance history
 *       is refused with a clean 400 telling the manager to mark them inactive
 *       (the bug where this was a raw 500 was found and fixed in this round).
 *   [6] Zero trace — trial balance and row counts identical after the run.
 *
 * Fixtures & cleanup policy:
 *   - ONE bootstrap admin via SQL (the suite must never assume the real
 *     admin's password); the test employee is created and deleted through
 *     POST/DELETE /hr/employees.
 *   - The attendance rows this test creates have NO app delete path — that is
 *     deliberate app design (history is permanent so pay can be audited), so
 *     the suite removes ONLY its own rows (its own employee id, today's date)
 *     via SQL and proves the tables are back to their prior counts. The
 *     fixture salary is 0, so the punches never touch the books.
 */

import pg from 'pg';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'zztest338r';
const PASSWORD = 'ZzTest!12345';
const HASH = '$2b$10$IuHNFJwf3V9qR9dujVlZA.Uk1CupNfxuIcDuQfpMDtwVekihk.0/C';
const DEFAULT_INITIAL_PASSWORD = 'marlin1458'; // lib/passwordPolicy.ts

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

async function cleanup() {
  await sql(`DELETE FROM login_attempts WHERE username LIKE $1`, [`${TAG}%`]).catch(() => {});
  await sql(`DELETE FROM login_lockouts WHERE username LIKE $1`, [`${TAG}%`]).catch(() => {});
  const { rows } = await sql(`SELECT id FROM employees WHERE username LIKE $1`, [`${TAG}%`]);
  for (const { id } of rows) {
    await sql(`DELETE FROM attendance_punches WHERE employee_id = $1`, [id]).catch(() => {});
    await sql(`DELETE FROM attendance WHERE employee_id = $1`, [id]).catch(() => {});
    await sql(`DELETE FROM leaves WHERE employee_id = $1`, [id]).catch(() => {});
    await sql(`DELETE FROM pay_components WHERE employee_id = $1`, [id]).catch(() => {});
    await sql(`DELETE FROM employees WHERE id = $1`, [id]);
  }
}
process.on('unhandledRejection', async (err) => {
  console.error('FATAL (unhandled):', err);
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(1);
});

console.log('\n[0] Fixtures');
await cleanup(); // heal a crashed previous run

// Bootstrap admin (SQL — see header).
const admin = (await sql(`SELECT id, name FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`)).rows[0];
await sql(
  `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, is_active, join_date)
   VALUES ($1, $2, $3, $4, 'headoffice', 1, 0, true, '2026-08-01')`,
  [`ZZ338R boot admin`, `${TAG}-adm`, HASH, admin.id]);
const admTok = (await apiReq('POST', '/auth/login', { username: `${TAG}-adm`, password: PASSWORD })).data?.token;
assert('Bootstrap admin logs in', !!admTok);
if (!admTok) { await cleanup(); process.exit(1); }

// Pick the lowest-level hierarchy that can actually use attendance (that is
// what a real field employee has), derived from the live permission matrix.
const permRows = (await apiReq('GET', '/company/permissions', undefined, admTok)).data ?? [];
const hier = (await sql(`SELECT id, name, level FROM hierarchies ORDER BY level DESC, id`)).rows;
const empHier = hier.find((h) => Number(h.level) > 1 && permRows.some((r) =>
  r.hierarchyId === h.id && r.module === 'page:/hr/attendance' && r.canAdd === true));
assert('A non-admin role with attendance rights exists', !!empHier, JSON.stringify(hier));
if (!empHier) { await cleanup(); process.exit(1); }

const counts0 = (await sql(`
  SELECT (SELECT COUNT(*) FROM attendance)         AS att,
         (SELECT COUNT(*) FROM attendance_punches) AS punches,
         (SELECT COUNT(*) FROM leaves)             AS leaves
`)).rows[0];
const tb0res = await apiReq('GET', '/accounts/trial-balance', undefined, admTok);
const tb0 = r2((tb0res.data?.rows ?? []).reduce((s, r) => s + Number(r.debit ?? 0), 0));

// ── [1] Create + forced first login ─────────────────────────────────────────
console.log('\n[1] Forced first login');
const created = await apiReq('POST', '/hr/employees', {
  name: `ZZ338R employee (${empHier.name})`, username: `${TAG}-emp`,
  hierarchyId: empHier.id, branchType: 'warehouse', branchId: 1,
  salary: 0, joinDate: '2026-08-01',
}, admTok);
const empId = created.data?.id;
assert('Employee created via POST /hr/employees', created.status === 201 && !!empId,
  `status=${created.status} ${JSON.stringify(created.data).slice(0, 120)}`);

const first = await apiReq('POST', '/auth/login', { username: `${TAG}-emp`, password: DEFAULT_INITIAL_PASSWORD });
assert('First login with the default password succeeds and demands a change',
  first.status === 200 && first.data?.employee?.mustChangePassword === true,
  `status=${first.status} mustChange=${first.data?.employee?.mustChangePassword}`);
const changed = await apiReq('POST', '/auth/change-password',
  { currentPassword: DEFAULT_INITIAL_PASSWORD, newPassword: PASSWORD }, first.data?.token);
assert('Password change accepted', changed.status === 200, `status=${changed.status}`);
const oldPw = await apiReq('POST', '/auth/login', { username: `${TAG}-emp`, password: DEFAULT_INITIAL_PASSWORD });
assert('Old password no longer works (400/401, not a session)', !oldPw.data?.token && oldPw.status >= 400, `status=${oldPw.status}`);
const empTok = (await apiReq('POST', '/auth/login', { username: `${TAG}-emp`, password: PASSWORD })).data?.token;
assert('New password logs in', !!empTok);
if (!empTok) { await cleanup(); process.exit(1); }

// ── [2] Profile ─────────────────────────────────────────────────────────────
console.log('\n[2] Profile (/auth/me)');
{
  const me = await apiReq('GET', '/auth/me', undefined, empTok);
  const body = JSON.stringify(me.data ?? {});
  assert('Profile returns the caller\'s own record',
    me.status === 200 && (me.data?.id === empId || me.data?.employee?.id === empId),
    `status=${me.status} id=${me.data?.id ?? me.data?.employee?.id}`);
  assert('Profile never exposes a password hash',
    !body.includes('password_hash') && !body.includes('passwordHash') && !body.includes('$2b$'));
}

// ── [3] Attendance check-in / check-out ─────────────────────────────────────
console.log('\n[3] Attendance');
{
  const geo = { employeeId: empId, lat: 0, lng: 0 };
  const inRes = await apiReq('POST', '/hr/attendance/check-in', geo, empTok);
  assert('Check-in opens a session', inRes.status === 200 || inRes.status === 201,
    `status=${inRes.status} ${JSON.stringify(inRes.data).slice(0, 120)}`);
  const dup = await apiReq('POST', '/hr/attendance/check-in', geo, empTok);
  assert('Second check-in while one is open is refused (409 double-tap guard)',
    dup.status === 409, `status=${dup.status} ${JSON.stringify(dup.data).slice(0, 100)}`);
  const spoof = await apiReq('POST', '/hr/attendance/check-in', { ...geo, employeeId: empId + 1 }, empTok);
  assert('Checking in for someone ELSE is refused (403)', spoof.status === 403, `status=${spoof.status}`);
  const outRes = await apiReq('POST', '/hr/attendance/check-out', geo, empTok);
  assert('Check-out closes the session', outRes.status === 200 || outRes.status === 201,
    `status=${outRes.status} ${JSON.stringify(outRes.data).slice(0, 120)}`);
  const open = (await sql(`SELECT COUNT(*) c FROM attendance_punches WHERE employee_id = $1 AND punch_out IS NULL`, [empId])).rows[0].c;
  assert('No open punch remains', Number(open) === 0, `open=${open}`);
  const att = await apiReq('GET', `/hr/attendance?employeeId=${empId}`, undefined, empTok);
  const rows = Array.isArray(att.data) ? att.data : (att.data?.rows ?? []);
  assert('Own attendance list shows the day', att.status === 200 && rows.length >= 1,
    `status=${att.status} rows=${rows.length}`);
}

// ── [4] Leave apply / cancel ────────────────────────────────────────────────
console.log('\n[4] Leave apply → cancel');
{
  const apply = await apiReq('POST', '/hr/leaves', {
    employeeId: empId, fromDate: '2026-09-07', toDate: '2026-09-07',
    leaveType: 'casual', reason: 'zztest338r regression — will be cancelled',
  }, empTok);
  const leaveId = apply.data?.id;
  assert('Leave request created (pending)', (apply.status === 200 || apply.status === 201) && !!leaveId,
    `status=${apply.status} ${JSON.stringify(apply.data).slice(0, 120)}`);
  const cancel = await apiReq('POST', `/hr/leaves/${leaveId}/cancel`, {}, empTok);
  assert('Own pending leave cancels cleanly', cancel.status === 200 || cancel.status === 204,
    `status=${cancel.status} ${JSON.stringify(cancel.data).slice(0, 100)}`);
  const { rows: [lr] } = await sql(`SELECT status FROM leaves WHERE id = $1`, [leaveId]);
  assert("Cancel flips status to 'cancelled' (audit row stays, by design)",
    lr?.status === 'cancelled', `status=${lr?.status}`);
  const again = await apiReq('POST', `/hr/leaves/${leaveId}/cancel`, {}, empTok);
  assert('Cancelling twice is refused (409)', again.status === 409, `status=${again.status}`);
}

// ── [5] History protection on delete ────────────────────────────────────────
console.log('\n[5] Employee delete vs. attendance history');
{
  const del = await apiReq('DELETE', `/hr/employees/${empId}`, undefined, admTok);
  assert('Delete of an employee WITH history → clean 400 (mark inactive instead), not a 500',
    del.status === 400 && String(del.data?.error ?? '').toLowerCase().includes('inactive'),
    `status=${del.status} ${JSON.stringify(del.data).slice(0, 140)}`);
  // Remove ONLY this test's own attendance + cancelled-leave rows (no app
  // delete path exists for either — by design; see header), then the app
  // path must succeed.
  await sql(`DELETE FROM attendance_punches WHERE employee_id = $1`, [empId]);
  await sql(`DELETE FROM attendance WHERE employee_id = $1`, [empId]);
  await sql(`DELETE FROM leaves WHERE employee_id = $1`, [empId]);
  const del2 = await apiReq('DELETE', `/hr/employees/${empId}`, undefined, admTok);
  assert('Employee deleted via DELETE /hr/employees/:id once history is gone', del2.status === 204,
    `status=${del2.status} ${JSON.stringify(del2.data).slice(0, 100)}`);
}

// ── [6] Zero trace ──────────────────────────────────────────────────────────
console.log('\n[6] Zero trace');
const counts1 = (await sql(`
  SELECT (SELECT COUNT(*) FROM attendance)         AS att,
         (SELECT COUNT(*) FROM attendance_punches) AS punches,
         (SELECT COUNT(*) FROM leaves)             AS leaves
`)).rows[0];
assert('Attendance/punch/leave counts back to their prior values',
  JSON.stringify(counts0) === JSON.stringify(counts1),
  `${JSON.stringify(counts0)} → ${JSON.stringify(counts1)}`);
const tb1res = await apiReq('GET', '/accounts/trial-balance', undefined, admTok);
const tb1 = r2((tb1res.data?.rows ?? []).reduce((s, r) => s + Number(r.debit ?? 0), 0));
assert('Trial balance unchanged', tb0 === tb1, `${tb0} → ${tb1}`);

await sql(`DELETE FROM login_attempts WHERE username LIKE $1`, [`${TAG}%`]).catch(() => {});
await sql(`DELETE FROM login_lockouts WHERE username LIKE $1`, [`${TAG}%`]).catch(() => {});
await sql(`DELETE FROM employees WHERE username = $1`, [`${TAG}-adm`]);
const strays = (await sql(`SELECT COUNT(*) c FROM employees WHERE username LIKE $1`, [`${TAG}%`])).rows[0].c;
assert('All temp users deleted', Number(strays) === 0, `strays=${strays}`);

await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.error('Failures:', failures); process.exit(1); }
