import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/** Name of the global allocator behind auto-generated purchase batch numbers. */
export const PURCHASE_BATCH_SEQUENCE = "purchase_batch_seq";

/**
 * Manual Purchase Bill: rate mode, auto batch numbers and duplicate protection.
 *
 * Three separate concerns, all of which have to exist before the route can rely
 * on them:
 *
 * 1. `purchases.price_mode` — whether the rates on the bill were keyed GST
 *    *inclusive* or *exclusive*. This has to be STORED, never inferred from the
 *    amounts: 105 at 5% is a valid inclusive line (100 + 5) and an equally valid
 *    exclusive line (105 + 5.25), and no amount of arithmetic can tell them
 *    apart after the fact. Every bill written before this column existed was
 *    computed exclusively, so that is the default and the backfill value —
 *    historical totals are reproduced exactly.
 *
 * 2. `purchase_batch_seq` — a real Postgres SEQUENCE behind the generated batch
 *    numbers. `nextval` is non-transactional, so two bills committing at the
 *    same instant cannot draw the same number, and a rolled-back bill burns its
 *    number instead of handing it to the next writer. A `SELECT max(...) + 1`
 *    or a `COUNT(*)`-based scheme has neither property.
 *
 * 3. A partial unique index on (vendor_id, invoice_number) — the same vendor
 *    invoice cannot be recorded twice, which is what a double-clicked Save, a
 *    retried request or a re-opened tab actually looks like. Partial because
 *    an invoice reference is optional, and because inward branch-transfer
 *    invoices are not vendor bills at all.
 *
 * DDL is `IF NOT EXISTS` throughout: this runs on every boot, against databases
 * that may or may not already have been through it.
 */
export async function addPurchaseBillFields(pool: Pool): Promise<void> {
  // ── 1. Rate mode ───────────────────────────────────────────────────────────
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS price_mode text NOT NULL DEFAULT 'exclusive'`,
  );

  // ── 1b. Other Purchase Charges ─────────────────────────────────────────────
  // Incidental expenses on the bill (freight, hamali, courier…): an array of
  // { ledgerId, amount } posted Dr <expense ledger> / Cr vendor by the derived
  // postings. NEVER part of inventory cost — line costing ignores this column
  // by construction. Historical bills backfill to the empty array.
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS other_charges jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
  // Constraints declared inside a CREATE TABLE never reach a live database, so
  // the check is added separately and tolerated if it is already there.
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_purchases_price_mode'
        ) THEN
          ALTER TABLE purchases
            ADD CONSTRAINT chk_purchases_price_mode
            CHECK (price_mode IN ('exclusive', 'inclusive'));
        END IF;
      END $$;
    `);
  } catch (e) {
    console.error("[migration] purchase_price_mode_v1: could not add price_mode check:", e);
  }

  // ── 1c. Vendor Invoice Date ────────────────────────────────────────────────
  // The date printed on the VENDOR's invoice, distinct from purchase_date (the
  // business date the goods were booked in OUR books — month locks, stock
  // dating and postings all follow purchase_date, never this). Required on new
  // manual bills; historical rows stay NULL — absent means "not recorded",
  // never a fake backfill. NOTE: some databases already carry this column from
  // an earlier hotfix that shipped without a migration; IF NOT EXISTS makes
  // this the canonical, idempotent home for the DDL.
  await pool.query(
    `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS vendor_invoice_date date`,
  );

  // ── 2. Batch-number allocator ──────────────────────────────────────────────
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${PURCHASE_BATCH_SEQUENCE} AS bigint START 1`);

  // ── 3. Duplicate-bill guard ────────────────────────────────────────────────
  // Built only when the data can actually satisfy it. Creating it blind would
  // throw mid-migration on a database that already holds duplicates and skip
  // every migration queued behind this one.
  // Grouped on the SAME expression the index uses. Grouping on the raw column
  // would clear "INV-1" against " INV-1 " as distinct, then hand the index a
  // pair it considers equal — the index creation throws and the guard is
  // silently never built.
  const { rows: dupes } = await pool.query(`
    SELECT vendor_id, btrim(invoice_number) AS invoice_number, COUNT(*)::int AS n
      FROM purchases
     WHERE invoice_number IS NOT NULL AND btrim(invoice_number) <> ''
       AND branch_transfer_id IS NULL
     GROUP BY vendor_id, btrim(invoice_number)
    HAVING COUNT(*) > 1
     LIMIT 5
  `);
  if (dupes.length > 0) {
    console.error(
      "[migration] purchase_invoice_unique_v1 SKIPPED — duplicate vendor invoice references already exist. " +
      "The duplicate-submission guard is NOT active until these are merged or renumbered: " +
      dupes.map((d: any) => `vendor ${d.vendor_id} ref "${d.invoice_number}" x${d.n}`).join("; "),
    );
    return;
  }
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_purchases_vendor_invoice
        ON purchases (vendor_id, btrim(invoice_number))
       WHERE invoice_number IS NOT NULL
         AND btrim(invoice_number) <> ''
         AND branch_transfer_id IS NULL
    `);
  } catch (e) {
    console.error("[migration] purchase_invoice_unique_v1 FAILED — duplicate bills are not blocked:", e);
  }
}
