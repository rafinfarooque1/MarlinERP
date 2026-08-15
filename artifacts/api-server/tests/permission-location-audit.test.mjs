/**
 * Permission & location access health check — regression suite (Task: audit).
 *
 * Verifies the two orthogonal gates on the surfaces added by the modernization
 * program (dispatch board, purchases page, operations voucher pages) plus the
 * classic ones (sales, journal vouchers, payroll):
 *
 *   [A] DEFAULT-DENY — a fresh role with NO permission rows is refused every
 *       page read and write with 403 (server-side, not a hidden button), and
 *       the page-right gate (403) fires BEFORE the location-scope gate (404):
 *       a foreign resource without page rights is 403, never 404.
 *   [B] UNGUARDED-BY-DESIGN — the hierarchy/permission GETs stay open so a
 *       client can resolve its own rights (architecture invariant).
 *   [C] PER-PAGE ISOLATION — granting view on one page opens exactly that
 *       page: sibling pages stay 403, and view alone never grants a write.
 *   [D] NO STALE GRANTS — revoking a right takes effect on the very next
 *       request with the SAME token (no server-side grant caching).
 *   [E] LOCATION ISOLATION — with full page rights granted, a warehouse-pinned
 *       user still cannot read or write another location's sale / dispatch
 *       queue entry (404 per convention: scoped resource, indistinguishable
 *       from missing); list endpoints (sales, dispatch queue, journal
 *       vouchers, payroll) return only own-scope rows.
 *   [F] SELECTOR NEVER GRANTS — the x-location-type/-id view headers and the
 *       persisted location preference are display-only: pointing them at a
 *       foreign location must not leak a single foreign row.
 *
 * Runs against the DEVELOPMENT server + database. Creates clearly-marked
 * ZZPLA fixtures (one role, one employee) and removes them in finally.
 *
 * Run from artifacts/api-server:  node tests/permission-location-audit.test.mjs
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const BASE = process.env.API_URL || 'http://localhost:8080/api';
const TAG = 'ZZPLA';
const USERNAME = 'zzpla_probe';
const ADMIN_USERNAME = 'zzpla_admin';
const PASS = 'Probe#Pla1';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (t, p = []) => (await pool.query(t, p)).rows;

let passed = 0, failed = 0;
const failures = [];
const assert = (label, cond, detail = '') => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; failures.push(label); }
};

async function apiReq(method, path, body, token, headers = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const rows = (d) => Array.isArray(d) ? d : (d?.rows ?? d?.items ?? d?.sales ?? []);
const locOf = (s) => ({
  type: s.locationType ?? s.location_type ?? 'outlet',
  id: Number(s.locationId ?? s.location_id ?? s.outletId ?? s.outlet_id ?? 0),
});

const fx = { hierId: 0, empId: 0 };
let adminTok = '';

async function cleanup() {
  for (const u of [USERNAME, ADMIN_USERNAME]) {
    await q(`DELETE FROM login_attempts WHERE username = $1`, [u]).catch(() => {});
    await q(`DELETE FROM login_lockouts WHERE username = $1`, [u]).catch(() => {});
    await q(`DELETE FROM employees WHERE username = $1`, [u]);
  }
  await q(`DELETE FROM permissions WHERE hierarchy_id IN (SELECT id FROM hierarchies WHERE name LIKE $1)`, [`${TAG}%`]);
  await q(`DELETE FROM hierarchies WHERE name LIKE $1`, [`${TAG}%`]);
}

try {
  // ── Setup ─────────────────────────────────────────────────────────────────
  await cleanup(); // stale fixtures from a crashed prior run

  // Level-1 probe admin, cloned rather than assuming the real admin password
  // (convention: never touch or guess the admin credentials in dev tests).
  const [{ id: rootId }] = await q(`SELECT id FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`);
  await q(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id,
                            salary, join_date, must_change_password, is_active)
     VALUES ($1,$2,$3,$4,'headoffice',1,1,CURRENT_DATE,false,true)`,
    [`${TAG} Admin`, ADMIN_USERNAME, bcrypt.hashSync(PASS, 10), rootId]);
  adminTok = (await apiReq('POST', '/auth/login', { username: ADMIN_USERNAME, password: PASS })).data?.token ?? '';
  if (!adminTok) throw new Error('probe admin login failed');
  const mk = await apiReq('POST', '/hr/hierarchies', { name: `${TAG} Role`, reportsToId: rootId }, adminTok);
  fx.hierId = mk.data?.id;
  if (!fx.hierId) throw new Error(`role creation failed: ${JSON.stringify(mk.data)}`);

  // Foreign sale: a real, uncancelled customer sale. Own warehouse: any
  // warehouse that is NOT that sale's location and NOT the parent of its
  // outlet — so the sale is provably outside the probe user's LBAC scope.
  const [foreignSale] = await q(`
    SELECT s.id,
           COALESCE(s.location_type, 'outlet') AS ltype,
           COALESCE(s.location_id, s.outlet_id) AS lid
      FROM sales s
     WHERE s.cancelled_at IS NULL AND s.branch_transfer_id IS NULL
     ORDER BY s.id DESC LIMIT 1`);
  if (!foreignSale) throw new Error('dev DB has no usable sale to probe with');
  const [ownWh] = await q(`
    SELECT w.id FROM warehouses w
     WHERE NOT (($1 = 'warehouse' AND w.id = $2::int)
             OR ($1 = 'outlet' AND w.id = (SELECT warehouse_id FROM outlets WHERE id = $2::int)))
     ORDER BY w.id LIMIT 1`, [foreignSale.ltype, foreignSale.lid]);
  if (!ownWh) throw new Error('need a second warehouse to prove isolation');
  const childOutlets = (await q(`SELECT id FROM outlets WHERE warehouse_id = $1`, [ownWh.id])).map(r => Number(r.id));
  const inScope = (l) => l.type === 'warehouse' ? Number(l.id) === Number(ownWh.id)
                       : l.type === 'outlet' ? childOutlets.includes(Number(l.id))
                       : false;

  fx.empId = (await q(
    `INSERT INTO employees (name, username, password_hash, hierarchy_id, branch_type, branch_id,
                            salary, join_date, must_change_password, is_active)
     VALUES ($1,$2,$3,$4,'warehouse',$5,1,CURRENT_DATE,false,true) RETURNING id`,
    [`${TAG} Probe`, USERNAME, bcrypt.hashSync(PASS, 10), fx.hierId, ownWh.id]))[0].id;
  const tok = (await apiReq('POST', '/auth/login', { username: USERNAME, password: PASS })).data?.token ?? '';
  assert('probe user (warehouse-pinned, zero permission rows) can log in', !!tok);

  const setPerm = (module, flags) => apiReq('POST', '/company/permissions', { hierarchyId: fx.hierId, module, ...flags }, adminTok);
  const NONE = { canView: false, canAdd: false, canEdit: false, canDelete: false, canDownload: false };

  // ── [A] Default-deny, and 403 before 404 ─────────────────────────────────
  console.log('\n[A] Default-deny: fresh role is refused every surface with 403');
  for (const [m, p] of [
    ['GET', '/purchases'], ['POST', '/purchases'],
    ['GET', '/dispatch/queue'], ['GET', '/sales'],
    ['GET', '/accounts/journal-vouchers'], ['GET', '/hr/payroll'],
    ['GET', '/quotations'],
  ]) {
    const r = await apiReq(m, p, m === 'POST' ? {} : undefined, tok);
    assert(`${m} ${p} → 403`, r.status === 403, `status=${r.status}`);
  }
  {
    // Kind-bound dynamic guard: the page key is derived from the body, so a
    // valid kind must reach the SAME requireModuleAction path and be refused.
    const r = await apiReq('POST', '/pdf/money-voucher', { kind: 'payment', id: 1 }, tok);
    assert('POST /pdf/money-voucher (valid kind) → 403', r.status === 403, `status=${r.status}`);
  }
  {
    const r = await apiReq('POST', `/dispatch/${foreignSale.id}/status`, { status: 'READY' }, tok);
    assert('write on a FOREIGN resource without page rights → 403 (page gate before scope gate)',
      r.status === 403, `status=${r.status}`);
  }

  // ── [B] Unguarded-by-design GETs ──────────────────────────────────────────
  console.log('\n[B] Hierarchy/permission GETs stay open (client resolves its own rights)');
  {
    const h = await apiReq('GET', '/hr/hierarchies', undefined, tok);
    assert('GET /hr/hierarchies → 200 for a zero-permission user', h.status === 200, `status=${h.status}`);
    const p = await apiReq('GET', `/company/permissions?hierarchyId=${fx.hierId}`, undefined, tok);
    assert('GET /company/permissions → 200 for a zero-permission user', p.status === 200, `status=${p.status}`);
  }

  // ── [C] Per-page isolation ────────────────────────────────────────────────
  console.log('\n[C] Granting one page opens exactly that page');
  await setPerm('page:/operations/dispatch', { ...NONE, canView: true });
  {
    const r = await apiReq('GET', '/dispatch/queue', undefined, tok);
    assert('dispatch queue readable once its view is granted', r.status === 200, `status=${r.status}`);
    const w = await apiReq('POST', `/dispatch/${foreignSale.id}/status`, { status: 'READY' }, tok);
    assert('view alone never grants the write (403)', w.status === 403, `status=${w.status}`);
    const s = await apiReq('GET', '/purchases', undefined, tok);
    assert('sibling page (purchases) still 403', s.status === 403, `status=${s.status}`);
  }

  // ── [D] No stale grants ───────────────────────────────────────────────────
  console.log('\n[D] Revocation takes effect on the next request, same token');
  await setPerm('page:/operations/dispatch', NONE);
  {
    const r = await apiReq('GET', '/dispatch/queue', undefined, tok);
    assert('revoked view refused immediately (no server-side grant cache)', r.status === 403, `status=${r.status}`);
  }

  // ── [E] Location isolation with full page rights ──────────────────────────
  console.log('\n[E] Full page rights, foreign location: 404 + scoped lists');
  await setPerm('page:/sales/pos', { ...NONE, canView: true });
  await setPerm('page:/operations/dispatch', { ...NONE, canView: true, canEdit: true });
  await setPerm('page:/accounts/vouchers', { ...NONE, canView: true });
  await setPerm('page:/hr/payroll', { ...NONE, canView: true });
  {
    const r = await apiReq('GET', `/sales/${foreignSale.id}`, undefined, tok);
    assert("another location's sale reads as 404 (indistinguishable from missing)", r.status === 404, `status=${r.status}`);

    const before = await q(`SELECT status FROM sale_dispatch_status WHERE sale_id = $1`, [foreignSale.id]);
    const w = await apiReq('POST', `/dispatch/${foreignSale.id}/status`, { status: 'READY' }, tok);
    assert("another location's dispatch entry refuses the write with 404", w.status === 404, `status=${w.status}`);
    const after = await q(`SELECT status FROM sale_dispatch_status WHERE sale_id = $1`, [foreignSale.id]);
    assert('refused transition left no dispatch row behind', JSON.stringify(before) === JSON.stringify(after));

    const list = await apiReq('GET', '/sales', undefined, tok);
    const leaked = rows(list.data).filter(s => !inScope(locOf(s)));
    assert(`sales list confined to own scope (${rows(list.data).length} rows)`, list.status === 200 && leaked.length === 0,
      `status=${list.status} leaked=${leaked.length}`);

    const queue = await apiReq('GET', '/dispatch/queue', undefined, tok);
    const qLeaked = rows(queue.data).filter(s => !inScope(locOf(s)));
    assert(`dispatch queue confined to own scope (${rows(queue.data).length} rows)`, queue.status === 200 && qLeaked.length === 0,
      `status=${queue.status} leaked=${qLeaked.length}`);

    const jv = await apiReq('GET', '/accounts/journal-vouchers', undefined, tok);
    const jvLeaked = rows(jv.data).filter(v =>
      !((v.locationType ?? v.location_type) === 'warehouse' && Number(v.locationId ?? v.location_id) === Number(ownWh.id)));
    assert(`journal vouchers confined to own location stamp (${rows(jv.data).length} rows)`,
      jv.status === 200 && jvLeaked.length === 0, `status=${jv.status} leaked=${jvLeaked.length}`);

    const now = new Date();
    const pr = await apiReq('GET', `/hr/payroll?year=${now.getFullYear()}&month=${now.getMonth() + 1}`, undefined, tok);
    const prRows = rows(pr.data);
    const prLeaked = prRows.filter(p => Number(p.employeeId ?? p.employee_id) !== Number(fx.empId));
    assert('branch user self-scopes on payroll (only their own rows, if any)',
      pr.status === 200 && prLeaked.length === 0, `status=${pr.status} leaked=${prLeaked.length}`);
  }

  // ── [F] Selector/preference never grants ──────────────────────────────────
  console.log('\n[F] View headers and stored location preference are display-only');
  {
    const hdrs = { 'x-location-type': foreignSale.ltype, 'x-location-id': String(foreignSale.lid) };
    const list = await apiReq('GET', '/sales', undefined, tok, hdrs);
    const leaked = rows(list.data).filter(s => !inScope(locOf(s)));
    assert('foreign location headers leak zero foreign sales', list.status === 200 && leaked.length === 0,
      `status=${list.status} leaked=${leaked.length}`);
    const queue = await apiReq('GET', '/dispatch/queue', undefined, tok, hdrs);
    const qLeaked = rows(queue.data).filter(s => !inScope(locOf(s)));
    assert('foreign location headers leak zero foreign dispatch entries', queue.status === 200 && qLeaked.length === 0,
      `status=${queue.status} leaked=${qLeaked.length}`);

    const pref = await apiReq('PUT', '/auth/location-pref',
      { locationType: foreignSale.ltype, locationId: Number(foreignSale.lid) }, tok);
    assert('storing a foreign display preference is accepted (display-only)', pref.status === 200, `status=${pref.status}`);
    const again = await apiReq('GET', `/sales/${foreignSale.id}`, undefined, tok);
    assert('the stored preference still does not open the foreign sale (404)', again.status === 404, `status=${again.status}`);
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
