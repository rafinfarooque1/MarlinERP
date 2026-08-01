/**
 * Five-action permission model regression suite:
 *   [A] POST /company/permissions accepts the 5 flags and MIRRORS the legacy
 *       print/approve/share columns from download/edit on every write.
 *   [B] Per-action enforcement: a restricted role is refused each action it
 *       lacks (403 from the server, not just a hidden button), and allowed
 *       once the single covering right is granted.
 *   [C] Download covers every output channel: the same endpoint honours a
 *       "print"-intent request on the download right alone.
 *   [D] The one-time fold migration left no widened rows behind (download and
 *       edit hold everything print/share/approve used to grant — and the
 *       mirrors agree exactly).
 *
 * Runs against the DEVELOPMENT database. Creates clearly-marked ZZPRM fixtures
 * and deletes every one of them at the end.
 */

import pg from 'pg';
import bcrypt from 'bcryptjs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZPRM';
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
const get = (p, t) => apiReq('GET', p, undefined, t);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

const fixtures = { hierId: 0, empId: 0, rootId: 0 };

async function cleanup() {
  await sql(`DELETE FROM employees WHERE username LIKE $1`, [`${TAG.toLowerCase()}%`]);
  await sql(`DELETE FROM permissions WHERE hierarchy_id IN (SELECT id FROM hierarchies WHERE name LIKE $1)`, [`${TAG}%`]);
  await sql(`DELETE FROM hierarchies WHERE name LIKE $1`, [`${TAG}%`]);
}

try {

console.log('\n[0] Authentication and fixtures');
const loginRes = await post('/auth/login', {
  username: process.env.TEST_ADMIN_USER || 'admin',
  password: process.env.TEST_ADMIN_PASSWORD || 'marlin1458',
});
authToken = loginRes.data?.token ?? '';
assert('Admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { console.error('FATAL: no token'); process.exit(1); }
await cleanup(); // recover any previous crashed run

fixtures.rootId = (await sql(`SELECT id FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`)).rows[0].id;
const createRole = await post('/hr/hierarchies', { name: `${TAG} Clerk`, reportsToId: fixtures.rootId, description: 'disposable test fixture' });
assert('Fixture role created via API', createRole.status === 201 && createRole.data?.id, JSON.stringify(createRole.data).slice(0, 150));
fixtures.hierId = createRole.data?.id;

const hash = bcrypt.hashSync('marlin1458', 10);
fixtures.empId = (await sql(
  `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, salary, join_date, must_change_password, is_active)
   VALUES ($1,$2,$3,$4,'warehouse',$5,10000,CURRENT_DATE,false,true) RETURNING id`,
  [`${TAG} Clerk`, `${TAG.toLowerCase()}_clerk`, hash, fixtures.hierId, WH])).rows[0].id;
const clerkTok = (await post('/auth/login', { username: `${TAG.toLowerCase()}_clerk`, password: 'marlin1458' })).data?.token ?? '';
assert('Fixture employee can log in', !!clerkTok);

const setPerm = (module, flags) => post('/company/permissions', { hierarchyId: fixtures.hierId, module, ...flags });
const permRow = async (module) => (await sql(
  `SELECT can_view, can_add, can_edit, can_delete, can_download, can_print, can_approve, can_share
   FROM permissions WHERE hierarchy_id = $1 AND module = $2`, [fixtures.hierId, module])).rows[0];

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[A] setPermission writes 5 flags and mirrors the legacy columns');
{
  let res = await setPerm('page:/reports/sales', { canView: true, canAdd: false, canEdit: false, canDelete: false, canDownload: true });
  assert('Write with download=true accepted', res.status === 200 || res.status === 201, `status=${res.status}`);
  let row = await permRow('page:/reports/sales');
  assert('can_print mirrors can_download (true)', row.can_print === true && row.can_share === true, JSON.stringify(row));
  assert('can_approve mirrors can_edit (false)', row.can_approve === false, JSON.stringify(row));

  res = await setPerm('page:/reports/sales', { canView: true, canAdd: false, canEdit: true, canDelete: false, canDownload: false });
  assert('Second write (edit=true, download=false) accepted', res.status === 200 || res.status === 201, `status=${res.status}`);
  row = await permRow('page:/reports/sales');
  assert('Mirrors follow the NEW values on update', row.can_print === false && row.can_share === false && row.can_approve === true, JSON.stringify(row));
  assert('Only one row per (hierarchy, module) after both writes',
    (await sql(`SELECT COUNT(*)::int AS n FROM permissions WHERE hierarchy_id = $1 AND module = 'page:/reports/sales'`, [fixtures.hierId])).rows[0].n === 1);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[B] Per-action enforcement on the server');
const reportBody = { title: `${TAG} smoke report`, sections: [{ columns: [{ key: 'a', label: 'A' }], rows: [{ a: '1' }] }] };
{
  // Current state: view+edit on page:/reports/sales, download=false.
  let res = await post('/pdf/report', reportBody, clerkTok);
  assert('PDF export refused without the download right (403)', res.status === 403, `status=${res.status}`);

  // add on the hierarchy page is not granted at all.
  res = await post('/hr/hierarchies', { name: `${TAG} Sneak`, reportsToId: fixtures.rootId }, clerkTok);
  assert('Role creation refused without the add right (403)', res.status === 403, `status=${res.status}`);

  // Grant download, retry — the SAME call must now pass the guard.
  await setPerm('page:/reports/sales', { canView: true, canAdd: false, canEdit: false, canDelete: false, canDownload: true });
  res = await post('/pdf/report', reportBody, clerkTok);
  assert('PDF export allowed once download is granted', res.status === 200, `status=${res.status} ${JSON.stringify(res.data).slice(0, 100)}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[C] Download covers every output channel (print intent included)');
{
  let res = await post('/pdf/report', { ...reportBody, intent: 'print' }, clerkTok);
  assert('Print-intent request satisfied by the download right', res.status === 200, `status=${res.status}`);

  await setPerm('page:/reports/sales', { canView: true, canAdd: false, canEdit: false, canDelete: false, canDownload: false });
  res = await post('/pdf/report', { ...reportBody, intent: 'print' }, clerkTok);
  assert('Print-intent request refused without download — no legacy print bypass', res.status === 403, `status=${res.status}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[D] No row grants a folded right beyond its covering right');
{
  const { rows: [bad] } = await sql(`
    SELECT COUNT(*)::int AS n FROM permissions
    WHERE can_print <> can_download OR can_share <> can_download OR can_approve <> can_edit`);
  assert('Every legacy column mirrors its covering right across the whole table', bad.n === 0, `${bad.n} mismatched row(s)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failures:', failures.join(' | '));

} catch (e) {
  console.error('\nSUITE ERROR:', e);
  failed++;
} finally {
  console.log('\n[cleanup]');
  try { await cleanup(); console.log('  ✓ fixtures removed'); }
  catch (e) { console.error('  ✗ cleanup failed:', e?.message ?? e); }
  await pool.end();
}
process.exit(failed ? 1 : 0);
