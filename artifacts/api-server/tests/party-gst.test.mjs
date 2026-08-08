/**
 * Customer & Vendor GST number persistence — regression tests
 * Run: node artifacts/api-server/tests/party-gst.test.mjs
 *
 * Guards the full persistence chain: create with/without GST, list vs detail
 * casing (the customers LIST used to return only snake_case gst_number, so
 * the edit dialog loaded blank and saved the blank back — wiping the GST),
 * edit/replace, clear-to-NULL, normalisation (trim/uppercase, '' → NULL) and
 * GSTIN format validation with grandfathering of stored legacy values.
 *
 * Runs against the DEVELOPMENT database the dev API server is using. Creates
 * clearly-marked ZZPGST fixtures and deletes every one of them at the end.
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZPGST';
const USER = 'zzpgst_admin';
const PASS = 'ZzPgst#1786';

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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sql = (text, params) => pool.query(text, params);

const VALID_A = '29ABCDE1234F1Z5';
const VALID_B = '32AAICM1234A1Z5';
const LEGACY_BAD = '29XYZ1234A1Z9'; // 13 chars — like real legacy typos in the DB

async function cleanup() {
  const ids = (await sql(`SELECT id FROM customers WHERE name LIKE $1`, [`${TAG}%`])).rows.map(r => r.id);
  for (const id of ids) await del(`/customers/${id}`).catch(() => {});
  const vids = (await sql(`SELECT id FROM vendors WHERE name LIKE $1`, [`${TAG}%`])).rows.map(r => r.id);
  for (const id of vids) await del(`/vendors/${id}`).catch(() => {});
  // Anything the API refused to delete (or ledgers it left behind) goes by SQL.
  for (const id of ids) await sql(`DELETE FROM account_ledgers WHERE code = $1`, [`CUST-${id}`]);
  for (const id of vids) await sql(`DELETE FROM account_ledgers WHERE code = $1`, [`VEND-${id}`]);
  await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);
  await sql(`DELETE FROM login_attempts WHERE username = $1`, [USER]);
  await sql(`DELETE FROM employees WHERE username = $1`, [USER]);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[0] Authentication (temp full-rights user cloned from admin)');

const { rows: [adm] } = await sql(`SELECT hierarchy_id FROM employees WHERE username = 'admin'`);
if (!adm) { console.error('FATAL: no admin row to clone'); process.exit(1); }
await sql(`DELETE FROM login_attempts WHERE username = $1`, [USER]);
await sql(`DELETE FROM employees WHERE username = $1`, [USER]);
await sql(
  `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id, is_active, must_change_password, join_date)
   VALUES ($1, $2, $3, $4, 'headoffice', 0, true, false, CURRENT_DATE)`,
  [`${TAG} Temp Admin`, USER, bcrypt.hashSync(PASS, 10), adm.hierarchy_id]);
const loginRes = await post('/auth/login', { username: USER, password: PASS });
authToken = loginRes.data?.token ?? '';
assert('Temp admin login returns a token', !!authToken, `status=${loginRes.status}`);
if (!authToken) { await cleanup(); process.exit(1); }

// Sweep party fixtures a dead previous run may have left (NOT cleanup() —
// that would delete the temp admin we just logged in as).
await sql(`DELETE FROM account_ledgers WHERE code IN (SELECT 'CUST-' || id FROM customers WHERE name LIKE $1)`, [`${TAG}%`]);
await sql(`DELETE FROM account_ledgers WHERE code IN (SELECT 'VEND-' || id FROM vendors WHERE name LIKE $1)`, [`${TAG}%`]);
await sql(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]);
await sql(`DELETE FROM vendors WHERE name LIKE $1`, [`${TAG}%`]);

const dbGst = async (table, id) =>
  (await sql(`SELECT gst_number FROM ${table} WHERE id = $1`, [id])).rows[0]?.gst_number;

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[1] Customer — create');

let r = await post('/customers', { name: `${TAG} NoGst`, phone: '9000000001' });
assert('Create without GST → 201', r.status === 201, `status=${r.status}`);
const custNoGst = r.data?.id;
assert('  … response gstNumber is null', r.data?.gstNumber == null);
assert('  … DB stores NULL (not "")', (await dbGst('customers', custNoGst)) === null);

r = await post('/customers', { name: `${TAG} WithGst`, gstNumber: `  ${VALID_A.toLowerCase()}  ` });
assert('Create with GST (lowercase + spaces) → 201', r.status === 201, `status=${r.status}`);
const custGst = r.data?.id;
assert('  … response echoes normalised GST', r.data?.gstNumber === VALID_A, `got=${r.data?.gstNumber}`);
assert('  … DB stores normalised GST', (await dbGst('customers', custGst)) === VALID_A);

r = await post('/customers', { name: `${TAG} BadGst`, gstNumber: 'NOT-A-GSTIN' });
assert('Create with invalid GST → 400', r.status === 400, `status=${r.status}`);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[2] Customer — list/detail casing (the wipe-bug regression)');

r = await get('/customers');
const listRow = Array.isArray(r.data) ? r.data.find(c => c.id === custGst) : null;
assert('List row present', !!listRow);
assert('List returns camelCase gstNumber', listRow?.gstNumber === VALID_A, `got=${listRow?.gstNumber}`);

r = await get(`/customers/${custGst}`);
assert('Detail returns camelCase gstNumber', r.data?.gstNumber === VALID_A, `got=${r.data?.gstNumber}`);

// Simulate the edit dialog round-trip: build the payload from the LIST row
// (exactly what CustomerFormDialog does) and change only the phone. Before
// the fix this wiped the GST because listRow.gstNumber was undefined.
r = await patch(`/customers/${custGst}`, {
  name: listRow.name, phone: '9000000002', email: '', address: '',
  gstNumber: listRow.gstNumber ?? '', state: listRow.state ?? '', notes: '',
});
assert('Edit-other-field round-trip → 200', r.status === 200, `status=${r.status}`);
assert('  … GST survives an unrelated edit', (await dbGst('customers', custGst)) === VALID_A);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[3] Customer — replace, reject, clear');

r = await patch(`/customers/${custGst}`, { gstNumber: VALID_B });
assert('Replace GST → 200', r.status === 200, `status=${r.status}`);
assert('  … response echoes new GST', r.data?.gstNumber === VALID_B, `got=${r.data?.gstNumber}`);
assert('  … DB updated', (await dbGst('customers', custGst)) === VALID_B);

r = await patch(`/customers/${custGst}`, { gstNumber: 'INVALID99' });
assert('Change to invalid GST → 400', r.status === 400, `status=${r.status}`);
assert('  … DB unchanged after rejection', (await dbGst('customers', custGst)) === VALID_B);

r = await patch(`/customers/${custGst}`, { gstNumber: '' });
assert('Clear GST → 200', r.status === 200, `status=${r.status}`);
assert('  … response gstNumber is null', r.data?.gstNumber == null, `got=${r.data?.gstNumber}`);
assert('  … DB stores NULL (not "")', (await dbGst('customers', custGst)) === null);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[4] Customer — legacy invalid GST is grandfathered');

const { rows: [legacy] } = await sql(
  `INSERT INTO customers (name, gst_number) VALUES ($1, $2) RETURNING id`,
  [`${TAG} Legacy`, LEGACY_BAD]);
r = await patch(`/customers/${legacy.id}`, { name: `${TAG} Legacy`, phone: '9000000003', gstNumber: LEGACY_BAD });
assert('Unrelated edit resubmitting stored legacy GST → 200', r.status === 200, `status=${r.status}`);
assert('  … legacy GST untouched', (await dbGst('customers', legacy.id)) === LEGACY_BAD);
r = await patch(`/customers/${legacy.id}`, { gstNumber: '32BADBAD' });
assert('Changing legacy GST to another invalid value → 400', r.status === 400, `status=${r.status}`);
r = await patch(`/customers/${legacy.id}`, { gstNumber: VALID_A });
assert('Correcting legacy GST to a valid value → 200', r.status === 200, `status=${r.status}`);
assert('  … DB updated', (await dbGst('customers', legacy.id)) === VALID_A);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[5] Vendor — same matrix');

r = await post('/vendors', { name: `${TAG} VendNoGst` });
assert('Create without GST → 201', r.status === 201, `status=${r.status}`);
const vendNoGst = r.data?.id;
assert('  … DB stores NULL', (await dbGst('vendors', vendNoGst)) === null);

r = await post('/vendors', { name: `${TAG} VendGst`, gstNumber: ` ${VALID_B.toLowerCase()} ` });
assert('Create with GST (lowercase + spaces) → 201', r.status === 201, `status=${r.status}`);
const vendGst = r.data?.id;
assert('  … response echoes normalised GST', r.data?.gstNumber === VALID_B, `got=${r.data?.gstNumber}`);
assert('  … DB stores normalised GST', (await dbGst('vendors', vendGst)) === VALID_B);

r = await post('/vendors', { name: `${TAG} VendBad`, gstNumber: 'BADBADBAD' });
assert('Create with invalid GST → 400', r.status === 400, `status=${r.status}`);

r = await get('/vendors');
const vRow = Array.isArray(r.data) ? r.data.find(v => v.id === vendGst) : null;
assert('List returns camelCase gstNumber', vRow?.gstNumber === VALID_B, `got=${vRow?.gstNumber}`);

r = await patch(`/vendors/${vendGst}`, { gstNumber: VALID_A });
assert('Replace GST → 200', r.status === 200, `status=${r.status}`);
assert('  … DB updated', (await dbGst('vendors', vendGst)) === VALID_A);

r = await patch(`/vendors/${vendGst}`, { gstNumber: 'NOPE' });
assert('Change to invalid GST → 400', r.status === 400, `status=${r.status}`);

r = await patch(`/vendors/${vendGst}`, { gstNumber: '' });
assert('Clear GST → 200', r.status === 200, `status=${r.status}`);
assert('  … DB stores NULL (not "")', (await dbGst('vendors', vendGst)) === null);

const { rows: [vLegacy] } = await sql(
  `INSERT INTO vendors (name, gst_number) VALUES ($1, $2) RETURNING id`,
  [`${TAG} VendLegacy`, LEGACY_BAD]);
r = await patch(`/vendors/${vLegacy.id}`, { name: `${TAG} VendLegacy`, phone: '9000000004', gstNumber: LEGACY_BAD });
assert('Unrelated vendor edit resubmitting legacy GST → 200', r.status === 200, `status=${r.status}`);
assert('  … legacy GST untouched', (await dbGst('vendors', vLegacy.id)) === LEGACY_BAD);

// ───────────────────────────────────────────────────────────────────────────
console.log('\n[6] Blank normalisation sweep ("" never survives in either table)');

const { rows: [ce] } = await sql(`SELECT COUNT(*) n FROM customers WHERE gst_number = ''`);
const { rows: [ve] } = await sql(`SELECT COUNT(*) n FROM vendors WHERE gst_number = ''`);
assert('No empty-string GST in customers', Number(ce.n) === 0, `n=${ce.n}`);
assert('No empty-string GST in vendors', Number(ve.n) === 0, `n=${ve.n}`);

// ───────────────────────────────────────────────────────────────────────────
await cleanup();
const { rows: [left] } = await sql(
  `SELECT (SELECT COUNT(*) FROM customers WHERE name LIKE $1)
        + (SELECT COUNT(*) FROM vendors WHERE name LIKE $1)
        + (SELECT COUNT(*) FROM employees WHERE username = $2) AS n`, [`${TAG}%`, USER]);
assert('Cleanup left no fixtures behind', Number(left.n) === 0, `n=${left.n}`);

console.log(`\n${passed} passed, ${failed} failed${failed ? ' — ' + failures.join('; ') : ''}`);
await pool.end();
process.exit(failed ? 1 : 0);
