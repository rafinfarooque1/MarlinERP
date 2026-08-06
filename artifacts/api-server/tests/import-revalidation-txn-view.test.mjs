/**
 * Wizard revalidation — transactional-view regression test.
 * Run: node artifacts/api-server/tests/import-revalidation-txn-view.test.mjs
 * Requires DATABASE_URL (dev). No API server needed — exercises
 * revalidateDemoBatch directly, exactly as the approve endpoint does.
 *
 * The approve endpoint restamps every batch to the chosen location and
 * re-validates it INSIDE its all-or-nothing transaction. That is only
 * meaningful if the validators read through the same client: a validator
 * reading via the shared pool sees a different connection's view and can
 * disagree with the transaction it is gating.
 *
 * Guards under test:
 *   1. revalidateDemoBatch(..., client) observes VALIDATION-RELEVANT data
 *      that exists only inside the transaction (a customer + import mapping
 *      created in-txn flip a needs_mapping row to valid);
 *   2. the rewritten row status is invisible outside the client pre-commit;
 *   3. ROLLBACK leaves the persisted batch state byte-identical — row status,
 *      reason and batch counts exactly as before the revalidation ran.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "..");
const require = createRequire(path.join(apiDir, "package.json"));

let passed = 0, failed = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
};

// ── Bundle the route module (TS) so this .mjs test can import the helper ───
const tmpDir = path.join(here, ".tmp");
mkdirSync(tmpDir, { recursive: true });
const entry = path.join(tmpDir, "revalidation-entry.ts");
writeFileSync(entry, `
export { revalidateDemoBatch } from "${path.join(apiDir, "src/routes/imports").replace(/\\/g, "/")}";
export { pool } from "@workspace/db";
`);
const bundle = path.join(tmpDir, "revalidation-bundle.mjs");
const { build } = require("esbuild");
await build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "node",
  outfile: bundle, logLevel: "silent", external: ["*.node"],
  banner: { js: `import { createRequire as __cr } from 'node:module';\nglobalThis.require = __cr(import.meta.url);` },
});
const { revalidateDemoBatch, pool } = await import(bundle);

const TAG = `REVALTXN${Date.now()}`;
const custName = `${TAG} CUSTOMER`;
const norm = custName.toLowerCase().trim().replace(/\s+/g, " ");

// ── Committed fixture: a validated receipts batch with ONE unmapped row ────
// (exactly what approve revalidates — the mapping arrives later).
const values = { voucherNo: `${TAG}-RV1`, date: "2025-04-01", party: custName, amount: "500" };
const { rows: [mig] } = await pool.query(
  `INSERT INTO import_migrations (status, created_by) VALUES ('draft', 'reval-txn-test') RETURNING id`);
const { rows: [batch] } = await pool.query(
  `INSERT INTO import_batches (migration_id, module, filename, status, location_type, location_id,
                               total_rows, valid_rows, warning_rows, error_rows, created_by)
   VALUES ($1, 'receipts', 'reval-txn-test.xlsx', 'validated', 'headoffice', 1, 1, 0, 0, 1, 'reval-txn-test') RETURNING id`,
  [mig.id]);
const { rows: [row] } = await pool.query(
  `INSERT INTO import_rows (batch_id, row_number, status, reason, raw)
   VALUES ($1, 1, 'needs_mapping', 'Unmapped name', $2::jsonb) RETURNING id`,
  [batch.id, JSON.stringify({ values })]);

const persistedState = async () => {
  const { rows: [r] } = await pool.query(
    `SELECT r.status AS row_status, COALESCE(r.reason,'') AS reason,
            b.valid_rows, b.error_rows, b.status AS batch_status, b.location_type
       FROM import_rows r JOIN import_batches b ON b.id = r.batch_id WHERE r.id = $1`, [row.id]);
  return JSON.stringify(r);
};
const before = await persistedState();

const client = await pool.connect();
try {
  await client.query("BEGIN");

  // Transaction-local, validation-relevant data: the customer AND the mapping
  // that resolves the row's party name exist ONLY inside this transaction.
  const { rows: [cust] } = await client.query(
    `INSERT INTO customers (name) VALUES ($1) RETURNING id`, [custName]);
  await client.query(
    `INSERT INTO import_mappings (kind, source_name, source_norm, target_id, target_kind, created_by)
     VALUES ('customer', $1, $2, $3, 'customer', 'reval-txn-test')`, [custName, norm, cust.id]);

  // Premise: the pool cannot see either row.
  const { rows: [ghost] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM import_mappings WHERE kind = 'customer' AND source_norm = $1`, [norm]);
  ok("txn-local mapping is invisible to the pool (test premise)", ghost.n === 0);

  // ── Revalidation on the caller's transaction — the approve scenario ──────
  const { counts, outRows } = await revalidateDemoBatch(
    Number(batch.id), "receipts", { type: "headoffice", id: 1 }, client);
  // The row leaves needs_mapping and its verdict TEXT names the resolved
  // customer (a new customer has no open invoices, so the amount parks as an
  // advance — a warning). Resolution is only possible through the txn-local
  // mapping + customer, which the pool provably cannot see.
  ok("revalidation OBSERVES the txn-local mapping + customer (row resolves, no longer needs_mapping)",
    counts.needsMapping === 0 && counts.error === 0 && (counts.valid + counts.warning) === 1
      && outRows[0]?.status !== "needs_mapping" && String(outRows[0]?.reason ?? "").includes(custName),
    JSON.stringify({ counts, rowStatus: outRows[0]?.status, reason: outRows[0]?.reason }));

  // The rewritten status must be uncommitted — invisible outside the client.
  const { rows: [outside] } = await pool.query(`SELECT status FROM import_rows WHERE id = $1`, [row.id]);
  ok("rewritten row status invisible to the pool before COMMIT", outside.status === "needs_mapping",
    `pool sees '${outside.status}'`);

  await client.query("ROLLBACK");

  const after = await persistedState();
  ok("ROLLBACK leaves the persisted batch state byte-identical", after === before,
    `before=${before} after=${after}`);
  const { rows: [leak] } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM customers WHERE name = $1)::int
          + (SELECT COUNT(*) FROM import_mappings WHERE source_norm = $2)::int AS n`, [custName, norm]);
  ok("no txn-local customer or mapping persisted", leak.n === 0);
} finally {
  await client.query("ROLLBACK").catch(() => {});
  client.release();
  // Remove the committed fixture.
  await pool.query(`DELETE FROM import_rows WHERE batch_id = $1`, [batch.id]);
  await pool.query(`DELETE FROM import_batches WHERE id = $1`, [batch.id]);
  await pool.query(`DELETE FROM import_migrations WHERE id = $1`, [mig.id]);
  rmSync(tmpDir, { recursive: true, force: true });
  await pool.end().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
