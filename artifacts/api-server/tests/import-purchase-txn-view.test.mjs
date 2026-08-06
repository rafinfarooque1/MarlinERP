/**
 * Purchase import — transactional-view regression test.
 * Run: node artifacts/api-server/tests/import-purchase-txn-view.test.mjs
 * Requires DATABASE_URL (dev). No API server needed — exercises the library
 * directly, exactly as the wizard demo/approve endpoints do (ext = client).
 *
 * The wizard's demo and approve endpoints run every document inside ONE
 * caller-owned transaction. That guarantee is only real if EVERY read the
 * import performs goes through the same client: a helper that reads via the
 * shared pool uses a different connection and CANNOT see transaction-local
 * state, silently pricing the bill against a different database view.
 *
 * Guards under test (importPurchaseDoc):
 *   1. buildNameMaps(q) — the product master map must see a material that
 *      exists only inside the transaction (gstRate snapshots from it);
 *   2. resolveSupplyTaxType(vendorId, loc, q) — the intra/inter decision must
 *      see vendor + company state set only inside the transaction;
 *   3. nothing the import wrote survives ROLLBACK — no purchase, stock,
 *      lot, ledger or stock-ledger row persists.
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

// ── Bundle the library entry (TS) so this .mjs test can import it ──────────
const tmpDir = path.join(here, ".tmp");
mkdirSync(tmpDir, { recursive: true });
const entry = path.join(tmpDir, "txn-view-entry.ts");
writeFileSync(entry, `
export { importPurchaseDoc } from "${path.join(apiDir, "src/lib/importTransactions").replace(/\\/g, "/")}";
export { pool } from "@workspace/db";
`);
const bundle = path.join(tmpDir, "txn-view-bundle.mjs");
const { build } = require("esbuild");
await build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "node",
  outfile: bundle, logLevel: "silent", external: ["*.node"],
  banner: { js: `import { createRequire as __cr } from 'node:module';\nglobalThis.require = __cr(import.meta.url);` },
});
const { importPurchaseDoc, pool } = await import(bundle);

const TAG = `TXNVIEW${Date.now()}`;
const client = await pool.connect();
try {
  await client.query("BEGIN");

  // Transaction-local masters — INVISIBLE to any pool connection until COMMIT
  // (which never comes). Company state is blank in this dev DB, so setting it
  // here is also transaction-local.
  await client.query(`UPDATE company_settings SET state = 'Kerala'`);
  const { rows: [vend] } = await client.query(
    `INSERT INTO vendors (name, state) VALUES ($1, 'Maharashtra') RETURNING id`, [`${TAG} VENDOR`]);
  const { rows: [mat] } = await client.query(
    `INSERT INTO raw_materials (name, unit, hsn_code, tax_rate, cost, avg_cost)
     VALUES ($1, 'KG', '0810', 5, 0, 0) RETURNING id`, [`${TAG} MATERIAL`]);

  // Sanity: a separate pool connection must NOT see these rows.
  const { rows: [ghost] } = await pool.query(`SELECT COUNT(*)::int AS n FROM vendors WHERE name = $1`, [`${TAG} VENDOR`]);
  ok("txn-local vendor is invisible to the pool (test premise)", ghost.n === 0);

  // ── The import itself, on the caller's transaction (ext = client) ────────
  // qty 10 × rate 100 (GST-exclusive) at the master's 5% = tax 50, total 1050.
  // Interstate (Kerala ↔ Maharashtra) ⇒ the whole 50 must land in IGST.
  let res = null, err = null;
  try {
    res = await importPurchaseDoc({
      invoiceNumber: `${TAG}-INV1`, purchaseDate: "2025-04-01",
      vendorId: Number(vend.id),
      lines: [{ kind: "raw_material", id: Number(mat.id), quantity: 10, rate: 100, discountPct: 0 }],
      paidAmount: 0, narration: "txn-view regression", reference: null,
      loc: { type: "headoffice", id: 1 }, user: "txn-view-test",
    }, client);
  } catch (e) { err = e; }
  ok("import succeeds against transaction-local masters", !!res && !err, String(err));

  if (res) {
    const { rows: [p] } = await client.query(
      `SELECT total_amount::float8 AS total, tax_total::float8 AS tax, line_items FROM purchases WHERE id = $1`, [res.purchaseId]);
    const li = (typeof p.line_items === "string" ? JSON.parse(p.line_items) : p.line_items)[0];
    ok("line gstRate snapshots the TXN-LOCAL master's 5% (buildNameMaps saw the client's view)",
      Number(li.gstRate) === 5, `gstRate=${li.gstRate}`);
    ok("tax computed from that rate (tax_total = 50)", p.tax === 50, `tax=${p.tax}`);
    ok("interstate resolved from TXN-LOCAL states — full tax in IGST (resolveSupplyTaxType saw the client's view)",
      Number(li.igst) === 50 && Number(li.cgst) === 0 && Number(li.sgst) === 0,
      `igst=${li.igst} cgst=${li.cgst} sgst=${li.sgst}`);
    ok("bill total 1050", p.total === 1050, `total=${p.total}`);

    // Still uncommitted: the purchase must be invisible outside the client.
    const { rows: [seen] } = await pool.query(`SELECT COUNT(*)::int AS n FROM purchases WHERE id = $1`, [res.purchaseId]);
    ok("purchase invisible to the pool before COMMIT (all writes on the client)", seen.n === 0);
  }

  await client.query("ROLLBACK");

  // ── Nothing survives the rollback ─────────────────────────────────────────
  const counts = {};
  for (const [label, sql, params] of [
    ["purchases", `SELECT COUNT(*)::int AS n FROM purchases WHERE invoice_number LIKE $1`, [`${TAG}%`]],
    ["vendors", `SELECT COUNT(*)::int AS n FROM vendors WHERE name LIKE $1`, [`${TAG}%`]],
    ["raw_materials", `SELECT COUNT(*)::int AS n FROM raw_materials WHERE name LIKE $1`, [`${TAG}%`]],
    ["stock_ledger", `SELECT COUNT(*)::int AS n FROM stock_ledger WHERE item_name LIKE $1`, [`${TAG}%`]],
    ["stock_batches", `SELECT COUNT(*)::int AS n FROM stock_batches WHERE source = 'purchase' AND item_id NOT IN (SELECT id FROM raw_materials) AND material_type = 'raw_material' AND created_at > now() - interval '10 minutes'`, []],
    ["account_ledgers", `SELECT COUNT(*)::int AS n FROM account_ledgers WHERE name LIKE $1`, [`${TAG}%`]],
    ["company state", `SELECT COUNT(*)::int AS n FROM company_settings WHERE COALESCE(state,'') <> ''`, []],
  ]) {
    const { rows: [r] } = await pool.query(sql, params);
    counts[label] = r.n;
  }
  ok("rollback left zero persistent side effects",
    Object.values(counts).every((n) => n === 0), JSON.stringify(counts));
} finally {
  await client.query("ROLLBACK").catch(() => {});
  client.release();
  rmSync(tmpDir, { recursive: true, force: true });
  await pool.end().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
