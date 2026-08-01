/**
 * Company resets must cover quotations — regression tests (Task #202 review)
 * Run: node artifacts/api-server/tests/quotations-reset.test.mjs
 *
 * Both reset endpoints share ONE table list (TXN_RESET_TABLES). The list once
 * drifted from reality in production (ghost-row incident); this suite pins the
 * quotations module into it so a future table addition that forgets the list
 * fails here instead of stranding documents after a factory reset.
 *
 * The endpoints themselves are NOT invoked — they would wipe the shared dev
 * database. Instead:
 *   1. list invariants are asserted on the imported source-of-truth constant;
 *   2. the exact wipe semantics (clear-transactions' ordered DELETEs and the
 *      factory reset's TRUNCATE … RESTART IDENTITY CASCADE + sequence reset)
 *      are replayed against a scratch schema in the same database, seeded
 *      with one CONVERTED quotation (share link + stamped sale) and one
 *      unconverted one, then verified to leave no rows, no links, and QTN
 *      numbering restarting at 0001.
 */
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TXN_RESET_TABLES } from "../src/lib/resetTables.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`); failed++; }
};

// ── 1. List invariants ────────────────────────────────────────────────────────
console.log("TXN_RESET_TABLES invariants:");
const list = [...TXN_RESET_TABLES];
const iLinks = list.indexOf("quotation_share_links");
const iQuotes = list.indexOf("quotations");
const iSales = list.indexOf("sales");
ok("quotation_share_links is in the reset list", iLinks !== -1);
ok("quotations is in the reset list", iQuotes !== -1);
ok("share links are deleted before quotations (children first)", iLinks !== -1 && iLinks < iQuotes);
ok("quotations are deleted before sales (converted_sale_id points at sales)", iQuotes !== -1 && iQuotes < iSales);
ok("no duplicate table entries", new Set(list).size === list.length);

// Both handlers must reset quotation_sequence wherever invoice_sequence is
// reset — assert on the source so a future edit that drops one side fails here.
const companySrc = readFileSync(join(__dir, "../src/routes/company.ts"), "utf8");
const seqResets = companySrc.match(/invoice_sequence\s*=\s*0[^`]*/g) ?? [];
ok("every invoice_sequence reset also resets quotation_sequence (found " + seqResets.length + ")",
  seqResets.length >= 2 && seqResets.every((s) => s.includes("quotation_sequence = 0")),
  seqResets.map((s) => s.slice(0, 60)).join(" | "));

// ── 2. Wipe semantics on a scratch schema ────────────────────────────────────
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const SCHEMA = "qtn_reset_test";
const client = await pool.connect();
try {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);

  // Minimal shape mirroring the raw migration: enough columns to represent a
  // converted and an unconverted quotation plus a share link and settings row.
  await client.query(`
    CREATE TABLE quotations (
      id SERIAL PRIMARY KEY,
      quotation_number TEXT NOT NULL,
      customer_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      converted_sale_id INTEGER,
      converted_invoice_number TEXT
    );
    CREATE TABLE quotation_share_links (
      id SERIAL PRIMARY KEY,
      quotation_id INTEGER NOT NULL REFERENCES quotations(id),
      public_id TEXT NOT NULL
    );
    CREATE TABLE company_settings (
      id SERIAL PRIMARY KEY,
      invoice_sequence INTEGER NOT NULL DEFAULT 0,
      quotation_sequence INTEGER NOT NULL DEFAULT 0
    );
  `);
  await client.query(`INSERT INTO company_settings (invoice_sequence, quotation_sequence) VALUES (37, 12)`);
  await client.query(`
    INSERT INTO quotations (quotation_number, customer_id, status, converted_sale_id, converted_invoice_number)
    VALUES ('QTN/2025-26/0011', 4, 'converted', 99, 'INV/2025-26/0037'),
           ('QTN/2025-26/0012', 5, 'sent', NULL, NULL)
  `);
  await client.query(`INSERT INTO quotation_share_links (quotation_id, public_id) VALUES (1, 'pub-abc')`);

  console.log("clear-transactions semantics (ordered DELETEs from the shared list):");
  for (const table of list) {
    // Same statement the endpoint runs, restricted to the tables that exist
    // in the scratch schema (the endpoint's list covers the full DB).
    const { rows: [t] } = await client.query(
      `SELECT to_regclass('${SCHEMA}.' || $1) AS reg`, [table]);
    if (t.reg) await client.query(`DELETE FROM ${table}`);
  }
  await client.query(`UPDATE company_settings SET invoice_sequence = 0, quotation_sequence = 0`);
  const { rows: [afterClear] } = await client.query(`
    SELECT (SELECT COUNT(*) FROM quotations)::int AS quotes,
           (SELECT COUNT(*) FROM quotation_share_links)::int AS links,
           (SELECT quotation_sequence FROM company_settings LIMIT 1) AS seq
  `);
  ok("no quotations survive (converted or not)", afterClear.quotes === 0, `quotes=${afterClear.quotes}`);
  ok("no share links survive", afterClear.links === 0, `links=${afterClear.links}`);
  ok("quotation_sequence reset to 0", Number(afterClear.seq) === 0, `seq=${afterClear.seq}`);
  const nextNum = `QTN/2025-26/${String(Number(afterClear.seq) + 1).padStart(4, "0")}`;
  ok("next allocation would be QTN/2025-26/0001", nextNum === "QTN/2025-26/0001", nextNum);

  console.log("factory-reset semantics (TRUNCATE … RESTART IDENTITY CASCADE):");
  await client.query(`
    INSERT INTO quotations (quotation_number, customer_id, status, converted_sale_id)
    VALUES ('QTN/2025-26/0013', 4, 'converted', 100), ('QTN/2025-26/0014', 5, 'draft', NULL)
  `);
  await client.query(`INSERT INTO quotation_share_links (quotation_id, public_id) VALUES (3, 'pub-def')`);
  await client.query(`UPDATE company_settings SET quotation_sequence = 14`);
  // Parent-only TRUNCATE: CASCADE must take the share links with it, exactly
  // as the endpoint's per-table loop relies on.
  await client.query(`TRUNCATE TABLE quotations RESTART IDENTITY CASCADE`);
  await client.query(`UPDATE company_settings SET invoice_sequence = 0, quotation_sequence = 0`);
  const { rows: [afterReset] } = await client.query(`
    SELECT (SELECT COUNT(*) FROM quotations)::int AS quotes,
           (SELECT COUNT(*) FROM quotation_share_links)::int AS links,
           (SELECT quotation_sequence FROM company_settings LIMIT 1) AS seq
  `);
  ok("truncate leaves no quotations", afterReset.quotes === 0);
  ok("CASCADE takes share links", afterReset.links === 0);
  ok("sequence reset with invoice_sequence", Number(afterReset.seq) === 0);
  const { rows: [idRow] } = await client.query(`
    INSERT INTO quotations (quotation_number, customer_id) VALUES ('QTN/2025-26/0001', 1) RETURNING id
  `);
  ok("RESTART IDENTITY reissues id 1 (why stale converted_sale_id refs must not survive)",
    Number(idRow.id) === 1, `id=${idRow.id}`);
} finally {
  await client.query(`RESET search_path`).catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  client.release();
  await pool.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
