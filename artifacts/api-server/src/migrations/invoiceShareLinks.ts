import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

/**
 * Invoice share links: the stateful layer behind customer-facing invoice URLs.
 *
 * Replaces a stateless signed token that could not be revoked and could not be
 * counted. One row per link, so a link has a status, an expiry date and an
 * access trail.
 *
 * Note on `CREATE TABLE IF NOT EXISTS`: constraints written inside the CREATE
 * only apply the first time the table is made, so every uniqueness rule is a
 * separate `CREATE ... INDEX IF NOT EXISTS` below.
 */
export async function addInvoiceShareLinks(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_share_links (
      id             SERIAL PRIMARY KEY,
      public_id      TEXT        NOT NULL,
      sale_id        INTEGER     NOT NULL,
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

  // The pre-release shape stored only a SHA-256 of the token and re-derived the
  // token itself from SESSION_SECRET. That tied the life of every customer's link
  // to a secret rotated for unrelated reasons, so the token now lives on the row.
  // A hash cannot be converted back into its token, and those links only ever
  // existed in development, so the rows go rather than linger unopenable.
  await pool.query(`ALTER TABLE invoice_share_links ADD COLUMN IF NOT EXISTS token TEXT`);
  const { rowCount: preRelease } = await pool.query(
    `DELETE FROM invoice_share_links WHERE token IS NULL`,
  );
  if (preRelease) {
    console.log(
      `[migration] invoice_share_links: discarded ${preRelease} link(s) from the hash-only token scheme`,
    );
  }
  await pool.query(`ALTER TABLE invoice_share_links ALTER COLUMN token SET NOT NULL`);
  await pool.query(`ALTER TABLE invoice_share_links DROP COLUMN IF EXISTS token_hash`);

  // The public identifier is the lookup key for every unauthenticated request.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS invoice_share_links_public_id_uq
       ON invoice_share_links (public_id)`,
  );

  // At most ONE active link per invoice, enforced by the database rather than by
  // a read-then-insert in the route: two operators pressing Share at the same
  // moment would otherwise both find nothing and both mint a link, leaving one
  // of them un-revokable through the UI (which only ever shows the newest).
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS invoice_share_links_one_active_per_sale
       ON invoice_share_links (sale_id) WHERE status = 'active'`,
  );

  await pool.query(
    `CREATE INDEX IF NOT EXISTS invoice_share_links_sale_idx
       ON invoice_share_links (sale_id)`,
  );

  // ── Permission column ──────────────────────────────────────────────────────
  // Sharing an invoice publishes it outside the company, so it is its own right
  // rather than something inferred from Download/Print.
  //
  // Whether the column already exists is also the signal for whether to seed it.
  // Asking BEFORE the ALTER is what makes the backfill below run exactly once:
  // an admin who later unticks Share must stay unticked, and a backfill with no
  // memory would silently re-grant it on the next restart.
  const { rows: [pre] } = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'permissions'
          AND column_name = 'can_share'
     ) AS present`,
  );

  await pool.query(
    `ALTER TABLE permissions ADD COLUMN IF NOT EXISTS can_share BOOLEAN NOT NULL DEFAULT FALSE`,
  );

  if (!pre?.present) {
    // Seed from the rights that used to gate sharing, so introducing the
    // permission does not take invoice sharing away from roles that can already
    // release a copy of an invoice. Admins can tighten it afterwards.
    const { rowCount } = await pool.query(
      `UPDATE permissions
          SET can_share = TRUE
        WHERE can_download = TRUE OR can_print = TRUE`,
    );
    console.log(
      `[migration] invoice_share_links: Share granted to ${rowCount ?? 0} role/page row(s) that could already download or print`,
    );
  }
}
