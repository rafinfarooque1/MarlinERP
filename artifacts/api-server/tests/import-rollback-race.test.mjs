/**
 * Import commit vs rollback mutual exclusion — regression tests (Task #224 review)
 * Run: node artifacts/api-server/tests/import-rollback-race.test.mjs
 * Requires the API server running on 127.0.0.1:80 and DATABASE_URL.
 *
 * The commit endpoint creates records row-by-row (not one transaction — each
 * row goes through the same code path as manual creation). A rollback arriving
 * mid-commit could therefore delete the rows created so far while the loop
 * keeps creating more, leaving untracked records and a lying batch status.
 * The guards under test:
 *   1. commit holds the batch's advisory lock for its whole row loop, and
 *      rollback try-locks the same key → rollback during a live commit = 409;
 *   2. rollback refuses any batch that is not fully 'committed' (including a
 *      stuck 'committing' batch whose committer died);
 *   3. commit's final status update is conditional on the state it claimed.
 */
import pg from "pg";
import ExcelJS from "exceljs";

const API = "http://127.0.0.1:80/api";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let passed = 0, failed = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
};

// ── Setup: login + build a batch big enough that its commit takes a while ───
const loginRes = await fetch(`${API}/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: process.env.TEST_USERNAME || "admin",
    password: process.env.TEST_PASSWORD || "marlin1458",
  }),
});
const { token } = await loginRes.json();
const auth = { Authorization: `Bearer ${token}` };

const TAG = `RACE${Date.now()}`;
const N = 40;
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Data");
ws.addRow(["Name *", "Phone", "Location"]);
for (let i = 1; i <= N; i++) ws.addRow([`${TAG} Customer ${String(i).padStart(3, "0")}`, "", "Head Office"]);
const fileBuf = Buffer.from(await wb.xlsx.writeBuffer());

const parseRes = await fetch(`${API}/imports/parse?module=customers&filename=race.xlsx`, {
  method: "POST", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: fileBuf,
});
const parsed = await parseRes.json();
const batchId = parsed.batch?.id;
ok(`parse created a validated batch of ${N} rows`, parseRes.status === 201 && parsed.batch?.validRows === N,
  `status ${parseRes.status}, body ${JSON.stringify(parsed).slice(0, 200)}`);

const lockKeySql = `SELECT pg_advisory_lock(hashtext($1))`;
const unlockKeySql = `SELECT pg_advisory_unlock(hashtext($1))`;
const lockKey = `import_batch_${batchId}`;

const rollback = () => fetch(`${API}/imports/batches/${batchId}/rollback`, { method: "POST", headers: auth });
const commit = () => fetch(`${API}/imports/batches/${batchId}/commit`, {
  method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}",
});
const batchRow = async () =>
  (await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [batchId])).rows[0];
const customerCount = async () =>
  Number((await pool.query(`SELECT COUNT(*)::int AS n FROM customers WHERE name LIKE $1`, [`${TAG}%`])).rows[0].n);

try {
  // ── 1. Rollback while another session holds the commit lock → 409 ─────────
  console.log("Rollback vs held commit lock:");
  const holder = await pool.connect();
  await holder.query(lockKeySql, [lockKey]);
  try {
    const r = await rollback();
    const body = await r.json();
    ok("rollback is refused while the commit lock is held", r.status === 409, `status ${r.status}`);
    ok("refusal names the in-flight commit", /being committed/i.test(body.error ?? ""), body.error);
  } finally {
    await holder.query(unlockKeySql, [lockKey]);
    holder.release();
  }

  // ── 2. Rollback of a stuck 'committing' batch (lock free) → 409 ───────────
  console.log("Rollback of a non-committed batch:");
  await pool.query(`UPDATE import_batches SET status = 'committing' WHERE id = $1`, [batchId]);
  {
    const r = await rollback();
    const body = await r.json();
    ok("a 'committing' batch is refused even when the lock is free", r.status === 409, `status ${r.status}`);
    ok("refusal says only committed batches roll back", /committed/i.test(body.error ?? ""), body.error);
  }
  await pool.query(`UPDATE import_batches SET status = 'validated', committed_at = NULL, committed_by = NULL WHERE id = $1`, [batchId]);

  // ── 3. Live overlap: rollback fired mid-commit ─────────────────────────────
  console.log("Live commit/rollback overlap:");
  const commitPromise = commit();
  await new Promise((r) => setTimeout(r, 150)); // let the commit claim the lock and start its loop
  const raceRes = await rollback();
  const raceBody = await raceRes.json();

  const commitRes = await commitPromise;
  const commitBody = await commitRes.json();

  if (raceRes.status === 409) {
    // The expected path: the rollback hit the lock (or the 'committing' state).
    ok("mid-commit rollback is refused (409)", true);
    ok("commit still completed normally", commitRes.status === 200 && commitBody.batch?.status === "committed",
      `status ${commitRes.status}, batch ${commitBody.batch?.status}`);
    ok(`commit imported all ${N} rows`, commitBody.summary?.imported === N, JSON.stringify(commitBody.summary));
    ok(`all ${N} customers exist after the interleaving`, (await customerCount()) === N);
    const b = await batchRow();
    ok("batch row says committed with correct counts", b.status === "committed" && Number(b.imported_rows) === N,
      `status ${b.status}, imported_rows ${b.imported_rows}`);
    // Clean rollback afterwards must succeed and remove everything.
    const clean = await rollback();
    const cleanBody = await clean.json();
    ok("post-commit rollback succeeds", clean.status === 200 && cleanBody.removed === N,
      `status ${clean.status}, removed ${cleanBody.removed}`);
    ok("no test customers remain", (await customerCount()) === 0);
  } else {
    // Timing fallback: commit finished before the rollback fired. Whatever the
    // ordering, the end state must be internally consistent.
    ok("rollback after full commit returned 200", raceRes.status === 200, `status ${raceRes.status}: ${JSON.stringify(raceBody).slice(0, 200)}`);
    ok("no test customers remain", (await customerCount()) === 0);
    const b = await batchRow();
    ok("batch is rolled_back and commit did not overwrite it",
      b.status === "rolled_back", `status ${b.status}`);
  }

  const finalBatch = await batchRow();
  const { rows: rowStates } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM import_rows WHERE batch_id = $1 GROUP BY status`, [batchId],
  );
  ok("final batch state is terminal (rolled_back)", finalBatch.status === "rolled_back", finalBatch.status);
  ok("every imported row is marked rolled_back",
    rowStates.every((r) => r.status !== "imported"), JSON.stringify(rowStates));
} finally {
  // Cleanup: the batch itself and any stragglers.
  await pool.query(`DELETE FROM customers WHERE name LIKE $1`, [`${TAG}%`]).catch(() => {});
  await pool.query(`DELETE FROM import_rows WHERE batch_id = $1`, [batchId]).catch(() => {});
  await pool.query(`DELETE FROM import_batches WHERE id = $1`, [batchId]).catch(() => {});
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
