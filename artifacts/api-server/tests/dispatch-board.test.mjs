// Warehouse dispatch board — permanent regression suite.
//
// Verifies, against live dev data. Dispatch status is real operational data
// here, so the suite is non-destructive by construction: the only sale it
// transitions is one selected to have NO dispatch row yet (cleanup = delete
// the probe-stamped rows, restoring exact original state even after a crash);
// refused-transition targets are snapshot-compared to prove they came out
// untouched. Other writes: three ZZ-prefixed probe employees and one
// throwaway role, all removed in finally.
//   [1] queue shape — recent billed sales, absent row = PENDING, cancelled
//       and branch-transfer sales excluded
//   [2] transition rules — PENDING→READY→DISPATCHED forward-only with
//       who/when stamps; skipping or repeating a step → 409
//   [3] cancelled sale — dropped from queue, transition refused (409)
//   [4] branch-transfer invoice — invisible (404 on transition)
//   [5] LBAC — warehouse user sees only own-location queue; foreign sale 404
//   [6] permissions — a fresh (default-deny) role gets 403 on view and edit
//   [7] books unchanged — sale row, stock aggregate and trial balance are
//       bitwise identical before and after transitions
//
// Run from artifacts/api-server:  node tests/dispatch-board.test.mjs
import pg from "pg";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";

const BASE = "http://localhost:8080/api";
const sql = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (t, p = []) => (await sql.query(t, p)).rows;
const md5 = (v) => createHash("md5").update(JSON.stringify(v)).digest("hex");

let passed = 0, failed = 0;
const assert = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const HO_USER = "zz_dsp_probe_ho", WH_USER = "zz_dsp_probe_wh", DENY_USER = "zz_dsp_probe_deny";
const PASS = "Probe#Dsp1";
const ROLE_TAG = "ZZDSP";
const fixtureSaleIds = [];

async function provision(username, branchType, branchId, hierarchyId = null) {
  await q(`DELETE FROM login_lockouts WHERE username=$1`, [username]);
  await q(`DELETE FROM login_attempts WHERE username=$1`, [username]);
  await q(`DELETE FROM employees WHERE username=$1`, [username]);
  await q(`INSERT INTO employees (name,username,password_hash,hierarchy_id,branch_type,branch_id,salary,join_date,is_active,must_change_password)
           SELECT 'ZZ Dispatch Probe',$1,$2,COALESCE($5,(SELECT MIN(id) FROM hierarchies)),$3,$4,1,CURRENT_DATE,true,false`,
    [username, bcrypt.hashSync(PASS, 10), branchType, branchId, hierarchyId]);
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: PASS }),
  });
  const j = await r.json();
  if (!j.token) throw new Error(`login failed for ${username}: ${JSON.stringify(j)}`);
  return { Authorization: `Bearer ${j.token}` };
}

async function cleanupUser(username) {
  await q(`DELETE FROM login_attempts WHERE username=$1`, [username]);
  await q(`DELETE FROM login_lockouts WHERE username=$1`, [username]);
  await q(`DELETE FROM employees WHERE username=$1`, [username]);
}

const get = async (path, hdr) => {
  const r = await fetch(`${BASE}${path}`, { headers: hdr });
  return { status: r.status, data: r.status !== 204 ? await r.json().catch(() => null) : null };
};
const post = async (path, body, hdr) => {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST", headers: { ...hdr, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

try {
  const ho = await provision(HO_USER, "headoffice", 1);

  // ── Fixture sales, derived from live data (never hardcoded ids) ──────────
  // Dispatch status is REAL operational data on this shared dev DB, so the
  // suite must never reset it. The only sale it transitions (saleA) is chosen
  // to provably have NO dispatch row yet — restoring the original state is
  // then exactly "delete the rows this suite's probe users stamped", which
  // the finally block does even when assertions or setup fail mid-way.
  // Cancelled / BT / foreign fixtures are only the TARGETS of refused
  // transitions; their pre-existing rows (if any) are snapshotted and must
  // come out bitwise identical.
  const [saleA] = await q(`
    SELECT s.id, s.invoice_number, to_char(s.sale_date,'YYYY-MM-DD') AS d, s.location_id
      FROM sales s
     WHERE s.cancelled_at IS NULL AND s.branch_transfer_id IS NULL
       AND s.location_type='warehouse' AND s.location_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM sale_dispatch_status ds WHERE ds.sale_id = s.id)
     ORDER BY s.created_at DESC LIMIT 1`);
  if (!saleA) throw new Error("dev DB has no live warehouse sale without dispatch history — refusing to touch existing dispatch state");
  fixtureSaleIds.push(saleA.id);
  const myWh = saleA.location_id;

  const [cancelled] = await q(`
    SELECT s.id, s.invoice_number, to_char(s.sale_date,'YYYY-MM-DD') AS d
      FROM sales s WHERE s.cancelled_at IS NOT NULL AND s.branch_transfer_id IS NULL
     ORDER BY s.created_at DESC LIMIT 1`);
  const [btSale] = await q(`
    SELECT s.id FROM sales s WHERE s.branch_transfer_id IS NOT NULL
     ORDER BY s.created_at DESC LIMIT 1`);
  const [foreign] = await q(`
    SELECT s.id FROM sales s
     WHERE s.cancelled_at IS NULL AND s.branch_transfer_id IS NULL
       AND NOT (s.location_type='warehouse' AND s.location_id=$1)
     ORDER BY s.created_at DESC LIMIT 1`, [myWh]);

  // Snapshot any pre-existing dispatch rows on the refused-transition targets;
  // the suite must leave them untouched.
  const dsRow = async (id) =>
    id == null ? null : (await q(`SELECT to_jsonb(ds) AS j FROM sale_dispatch_status ds WHERE sale_id=$1`, [id]))[0]?.j ?? null;
  const untouchedBefore = {
    cancelled: await dsRow(cancelled?.id),
    bt: await dsRow(btSale?.id),
    foreign: await dsRow(foreign?.id),
  };

  // ── Books snapshot BEFORE any transition ──────────────────────────────────
  const booksSnapshot = async () => {
    const [saleRow] = await q(`SELECT to_jsonb(s) - 'updated_at' AS j FROM sales s WHERE id=$1`, [saleA.id]);
    const [stock] = await q(`SELECT COALESCE(SUM(quantity),0)::text AS total, COUNT(*)::int AS n FROM stock_entries`);
    const tb = await get(`/accounts/trial-balance`, ho);
    if (tb.status !== 200) throw new Error(`trial balance fetch failed: ${tb.status}`);
    return md5({ sale: saleRow.j, stock, tb: tb.data });
  };
  const beforeHash = await booksSnapshot();

  console.log(`\n[1] Queue shape (fixture ${saleA.invoice_number})`);
  const q1 = await get(`/dispatch/queue?from=${saleA.d}&to=${saleA.d}`, ho);
  assert("GET queue → 200", q1.status === 200, `got ${q1.status}`);
  assert("queue is an array", Array.isArray(q1.data));
  const entryA = (q1.data ?? []).find(e => e.saleId === saleA.id);
  assert("fixture sale listed", !!entryA);
  assert("absent row derives PENDING", entryA?.status === "PENDING", entryA?.status);
  assert("row carries invoice/customer/items/amount/billing time",
    !!entryA && "invoiceNumber" in entryA && "customerName" in entryA &&
    typeof entryA.itemsSummary === "string" && typeof entryA.totalAmount === "number" &&
    typeof entryA.createdAt === "string");
  assert("no dispatch row was materialised by reads",
    (await q(`SELECT 1 FROM sale_dispatch_status WHERE sale_id=$1`, [saleA.id])).length === 0);
  assert("bad status filter → 400", (await get(`/dispatch/queue?status=nope`, ho)).status === 400);
  assert("bad date → 400", (await get(`/dispatch/queue?from=13-01-2026`, ho)).status === 400);

  console.log(`\n[2] Transition rules (forward-only, stamped)`);
  const skip = await post(`/dispatch/${saleA.id}/status`, { status: "DISPATCHED" }, ho);
  assert("PENDING → DISPATCHED refused (409)", skip.status === 409, `got ${skip.status}`);
  const mkReady = await post(`/dispatch/${saleA.id}/status`, { status: "READY" }, ho);
  assert("PENDING → READY → 200", mkReady.status === 200, `got ${mkReady.status} ${JSON.stringify(mkReady.data)}`);
  assert("READY stamped with user", mkReady.data?.readyBy === HO_USER, mkReady.data?.readyBy);
  assert("READY stamped with time", !!mkReady.data?.readyAt);
  const again = await post(`/dispatch/${saleA.id}/status`, { status: "READY" }, ho);
  assert("READY → READY refused (409)", again.status === 409, `got ${again.status}`);
  const mkDisp = await post(`/dispatch/${saleA.id}/status`, { status: "DISPATCHED" }, ho);
  assert("READY → DISPATCHED → 200", mkDisp.status === 200, `got ${mkDisp.status}`);
  assert("DISPATCHED stamped with user+time", mkDisp.data?.dispatchedBy === HO_USER && !!mkDisp.data?.dispatchedAt);
  assert("READY stamps preserved", mkDisp.data?.readyBy === HO_USER);
  const done = await post(`/dispatch/${saleA.id}/status`, { status: "DISPATCHED" }, ho);
  assert("DISPATCHED is terminal (409)", done.status === 409, `got ${done.status}`);
  assert("bad body → 400", (await post(`/dispatch/${saleA.id}/status`, { status: "PENDING" }, ho)).status === 400);
  const q2 = await get(`/dispatch/queue?from=${saleA.d}&to=${saleA.d}&status=DISPATCHED`, ho);
  assert("status filter returns transitioned sale",
    (q2.data ?? []).some(e => e.saleId === saleA.id && e.status === "DISPATCHED" && e.dispatchedBy === HO_USER));

  console.log(`\n[3] Cancelled sale exclusion`);
  if (cancelled) {
    const qc = await get(`/dispatch/queue?from=${cancelled.d}&to=${cancelled.d}`, ho);
    assert("cancelled sale not in queue", !(qc.data ?? []).some(e => e.saleId === cancelled.id));
    const tc = await post(`/dispatch/${cancelled.id}/status`, { status: "READY" }, ho);
    assert("transition on cancelled sale → 409", tc.status === 409, `got ${tc.status}`);
    assert("cancelled sale's dispatch state untouched",
      md5(await dsRow(cancelled.id)) === md5(untouchedBefore.cancelled));
  } else {
    console.log("  (no cancelled sales in dev DB — skipping)");
  }

  console.log(`\n[4] Branch-transfer invoice exclusion`);
  if (btSale) {
    const tb2 = await post(`/dispatch/${btSale.id}/status`, { status: "READY" }, ho);
    assert("transition on BT invoice → 404", tb2.status === 404, `got ${tb2.status}`);
    assert("BT invoice's dispatch state untouched",
      md5(await dsRow(btSale.id)) === md5(untouchedBefore.bt));
  } else {
    console.log("  (no branch-transfer sales in dev DB — skipping)");
  }

  console.log(`\n[5] LBAC — warehouse-scoped user (warehouse ${myWh})`);
  const wh = await provision(WH_USER, "warehouse", myWh);
  const qw = await get(`/dispatch/queue?from=${saleA.d}&to=${saleA.d}`, wh);
  assert("scoped queue → 200", qw.status === 200, `got ${qw.status}`);
  assert("own-location sale visible", (qw.data ?? []).some(e => e.saleId === saleA.id));
  // Scope = own warehouse + its child outlets; verify against the DB's own map.
  const childOutlets = (await q(`SELECT id FROM outlets WHERE warehouse_id=$1`, [myWh])).map(r => r.id);
  assert("every row within the user's scope",
    (qw.data ?? []).every(e =>
      (e.locationType === "warehouse" && e.locationId === myWh) ||
      (e.locationType === "outlet" && childOutlets.includes(e.locationId))),
    JSON.stringify([...new Set((qw.data ?? []).map(e => `${e.locationType}:${e.locationId}`))]));
  if (foreign) {
    const tf = await post(`/dispatch/${foreign.id}/status`, { status: "READY" }, wh);
    assert("transition on foreign-location sale → 404", tf.status === 404, `got ${tf.status}`);
    assert("foreign sale's dispatch state untouched",
      md5(await dsRow(foreign.id)) === md5(untouchedBefore.foreign));
  }

  console.log(`\n[6] Permissions — fresh role is default-deny`);
  await q(`DELETE FROM permissions WHERE hierarchy_id IN (SELECT id FROM hierarchies WHERE name LIKE $1)`, [`${ROLE_TAG}%`]);
  await q(`DELETE FROM hierarchies WHERE name LIKE $1`, [`${ROLE_TAG}%`]);
  const [root] = await q(`SELECT id FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`);
  const mkRole = await post(`/hr/hierarchies`, { name: `${ROLE_TAG} Clerk`, reportsToId: root.id, description: "disposable dispatch test fixture" }, ho);
  if (mkRole.status === 200 || mkRole.status === 201) {
    const roleId = mkRole.data?.id ?? mkRole.data?.hierarchy?.id;
    // A seeded grant (any boot backfill) would defeat the point — remove rows.
    await q(`DELETE FROM permissions WHERE hierarchy_id=$1 AND module='page:/operations/dispatch'`, [roleId]);
    const deny = await provision(DENY_USER, "warehouse", myWh, roleId);
    assert("queue without page right → 403", (await get(`/dispatch/queue`, deny)).status === 403);
    assert("transition without page right → 403",
      (await post(`/dispatch/${saleA.id}/status`, { status: "READY" }, deny)).status === 403);
  } else {
    failed++; console.log(`  ✗ could not create throwaway role — ${mkRole.status} ${JSON.stringify(mkRole.data)}`);
  }

  console.log(`\n[7] Books unchanged (reconciliation)`);
  const afterHash = await booksSnapshot();
  assert("sale row + stock aggregate + trial balance identical before/after", beforeHash === afterHash);

} catch (e) {
  failed++;
  console.error("SUITE ERROR:", e);
} finally {
  // Remove ONLY what this suite created. Every successful transition stamps a
  // probe username, and saleA was selected with NO pre-existing dispatch row,
  // so this restores the exact original state without ever touching real
  // dispatch history — even if the run died mid-way.
  await q(
    `DELETE FROM sale_dispatch_status
      WHERE ready_by = ANY($1::text[]) OR dispatched_by = ANY($1::text[])
         OR (sale_id = ANY($2::int[]) AND ready_by IS NULL AND dispatched_by IS NULL)`,
    [[HO_USER, WH_USER, DENY_USER], fixtureSaleIds],
  ).catch(() => {});
  await cleanupUser(HO_USER).catch(() => {});
  await cleanupUser(WH_USER).catch(() => {});
  await cleanupUser(DENY_USER).catch(() => {});
  await q(`DELETE FROM permissions WHERE hierarchy_id IN (SELECT id FROM hierarchies WHERE name LIKE $1)`, [`${ROLE_TAG}%`]).catch(() => {});
  await q(`DELETE FROM hierarchies WHERE name LIKE $1`, [`${ROLE_TAG}%`]).catch(() => {});
  await sql.end();
}

console.log(`\n══ Result: ${passed} passed, ${failed} failed ══`);
process.exit(failed > 0 ? 1 : 0);
