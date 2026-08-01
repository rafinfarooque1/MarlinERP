import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Quotations — offers to customers that touch NOTHING else.
 *
 * A quotation stores the full sale-like payload (lines, discounts, tax fields,
 * addresses, validity) but is deliberately invisible to stock, the stock
 * ledger, reservations, receivables, the accounting books, GST and the
 * dashboard. The only bridge to the real world is conversion: the existing
 * sale-creation transaction stamps `converted_sale_id` here and
 * `quotation_id` on the sale, and the partial unique indexes below make that
 * bridge one-to-one in BOTH directions no matter how many requests race.
 *
 * All columns live outside schema.ts on purpose (raw-migration path): every
 * read and write of them goes through raw SQL.
 */
export async function addQuotations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotations (
      id                       SERIAL PRIMARY KEY,
      quotation_number         TEXT        NOT NULL,
      location_type            TEXT        NOT NULL,
      location_id              INTEGER     NOT NULL,
      customer_id              INTEGER,
      quote_date               DATE        NOT NULL,
      valid_till               DATE,
      status                   TEXT        NOT NULL DEFAULT 'draft',
      line_items               JSONB       NOT NULL DEFAULT '[]'::jsonb,
      subtotal                 NUMERIC(14,2) NOT NULL DEFAULT 0,
      tax_total                NUMERIC(14,2) NOT NULL DEFAULT 0,
      discount_total           NUMERIC(14,2) NOT NULL DEFAULT 0,
      bill_discount            NUMERIC(14,2) NOT NULL DEFAULT 0,
      total_amount             NUMERIC(14,2) NOT NULL DEFAULT 0,
      coupon_code              TEXT,
      billing_address          TEXT,
      shipping_address         TEXT,
      payment_terms            TEXT,
      place_of_supply          TEXT,
      salesperson              TEXT,
      notes                    TEXT,
      terms_conditions         TEXT,
      converted_sale_id        INTEGER,
      converted_invoice_number TEXT,
      created_by               INTEGER,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Constraints OUTSIDE the CREATE — constraints written inside CREATE TABLE
  // IF NOT EXISTS never reach a database where the table already exists.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS quotations_number_uq
       ON quotations (quotation_number)`,
  );
  // Exactly one quotation per resulting sale, enforced by the database: even
  // if two conversion requests race past the row lock somehow, the second
  // stamp fails here instead of quietly double-linking.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS quotations_one_sale_uq
       ON quotations (converted_sale_id) WHERE converted_sale_id IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS quotations_customer_idx ON quotations (customer_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS quotations_date_idx ON quotations (quote_date)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS quotations_status_idx ON quotations (status)`,
  );

  // Quotation numbering: its own sequence in company settings, fully separate
  // from invoice_sequence, allocated atomically inside the create transaction.
  await pool.query(
    `ALTER TABLE company_settings
       ADD COLUMN IF NOT EXISTS quotation_sequence INTEGER NOT NULL DEFAULT 0`,
  );

  // The sale side of the two-way trace. A sale remembers which quotation it
  // came from; the partial unique index makes "exactly one sale per quotation"
  // hold from this side too.
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS quotation_id INTEGER`);
  await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS quotation_number TEXT`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS sales_quotation_uq
       ON sales (quotation_id) WHERE quotation_id IS NOT NULL`,
  );

  // ── Share links — same shape and rules as invoice_share_links ─────────────
  // A separate table rather than a doc_type column: invoice_share_links has a
  // partial unique index on sale_id alone, and every one of its readers joins
  // straight to sales. Mixing document kinds into it would silently break both.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quotation_share_links (
      id             SERIAL PRIMARY KEY,
      public_id      TEXT        NOT NULL,
      quotation_id   INTEGER     NOT NULL,
      token          TEXT        NOT NULL,
      status         TEXT        NOT NULL DEFAULT 'active',
      created_by     INTEGER,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at     TIMESTAMPTZ NOT NULL,
      access_count   INTEGER     NOT NULL DEFAULT 0,
      last_access_at TIMESTAMPTZ,
      revoked_by     INTEGER,
      revoked_at     TIMESTAMPTZ
    )
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS quotation_share_links_public_id_uq
       ON quotation_share_links (public_id)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS quotation_share_links_one_active
       ON quotation_share_links (quotation_id) WHERE status = 'active'`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS quotation_share_links_quotation_idx
       ON quotation_share_links (quotation_id)`,
  );

  // ── Permission seeding (ONE TIME) ──────────────────────────────────────────
  // page:/sales/quotations is a NEW key under default-deny: without seeding,
  // every pre-existing role above level 1 would silently lose the module.
  // Same direction as assets_page_perms_v1: GRANT to roles that already
  // existed and let an admin take rights away on the Permissions page.
  const { rows: seeded } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'quotations_page_perms_v1'`,
  );
  if (seeded.length === 0) {
    const { rows: hRows } = await pool.query<{ id: number }>(
      `SELECT id FROM hierarchies WHERE level != 1`,
    );
    for (const h of hRows) {
      await pool.query(
        `INSERT INTO permissions (hierarchy_id, module, can_view, can_add, can_edit, can_delete, can_download, can_print, can_approve, can_share)
         VALUES ($1, 'page:/sales/quotations', true, true, true, true, true, true, true, true)
         ON CONFLICT (hierarchy_id, module) DO NOTHING`,
        [h.id],
      );
    }
    await pool.query(
      `INSERT INTO migration_log (name) VALUES ('quotations_page_perms_v1') ON CONFLICT (name) DO NOTHING`,
    );
    console.log(
      `[migration] quotations_page_perms_v1 — granted Quotations page to ${hRows.length} pre-existing roles`,
    );
  }
}
