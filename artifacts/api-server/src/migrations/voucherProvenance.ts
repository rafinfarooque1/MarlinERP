/**
 * Voucher provenance — which vouchers a human actually typed.
 *
 * `journal_vouchers` is a shared table. The Accounts → Vouchers screen writes to
 * it, but so do payroll, production costing, warehouse rent, fixed-asset
 * purchases, sales/purchase returns and inter-branch transfers. Nothing in the
 * row said which. That distinction is what decides whether a voucher may be
 * edited by hand: a manually entered journal is the user's own correction to
 * make, while a payroll or production voucher is owned by its source document
 * and must only ever change when that document changes.
 *
 * None of the obvious signals can carry that decision:
 *
 *   • `created_by` is the logged-in user for BOTH kinds. Approving a payroll run
 *     as `admin` writes a salary voucher stamped `admin`, and recording an
 *     employee advance does the same. It records who triggered the write, not
 *     whether a human composed the entry.
 *   • `voucher_type` is shared. 'journal' covers manual journals, payroll,
 *     production and fixed assets alike.
 *   • narration / reference / voucher-number prefix are free text a user can
 *     reproduce, so they are guessable rather than authoritative.
 *
 * So this migration adds explicit provenance and every writer stamps it going
 * forward.
 *
 * ── Backfilling history ──────────────────────────────────────────────────────
 * Existing rows cannot be marked manual just because they look manual. There is
 * exactly one authoritative trace: `logActivity` is called with
 * entity_type='journal_voucher' by the manual Accounts → Vouchers route and by
 * NOTHING else — no system creator writes that audit row. The presence of a
 * CREATE row for a voucher id is therefore positive proof a human created it
 * through that screen.
 *
 * The classification is deliberately three-valued:
 *
 *   'manual'  → an audit CREATE row proves a human entered it     → editable
 *   'system'  → written by a path that only ever runs unattended  → locked
 *   NULL      → provenance unknown                                → locked
 *
 * NULL is the safe default and is left in place on purpose. Marking an
 * ambiguous historical voucher 'manual' would hand out an edit button over an
 * accounting entry owned by a source document; leaving it locked costs nothing
 * but a re-key. Audit rows can also be pruned, so an old genuine manual voucher
 * may legitimately land in NULL — locked, not lost.
 *
 * Re-runnable by design: it only ever fills rows where origin IS NULL and never
 * overwrites an existing value, so it heals rows written before the stamping
 * code shipped without disturbing anything already classified.
 */
import type { PgPool as Pool } from "@workspace/db";

/** Voucher types that the manual Accounts → Vouchers screen can produce. */
export const MANUAL_VOUCHER_TYPES = ["journal", "contra", "credit_note", "debit_note"] as const;

/**
 * Voucher types only ever written by the inter-branch transfer engine
 * (`lib/gstTransfer.ts`). They have no manual creation path at all, so they can
 * be classified system with certainty rather than left unknown.
 */
const SYSTEM_ONLY_VOUCHER_TYPES = ["branch_transfer_sale", "branch_transfer_purchase"] as const;

export async function addVoucherProvenance(pool: Pool): Promise<string> {
  await pool.query(`
    ALTER TABLE journal_vouchers ADD COLUMN IF NOT EXISTS origin        text;
    ALTER TABLE journal_vouchers ADD COLUMN IF NOT EXISTS source_module text;
    ALTER TABLE journal_vouchers ADD COLUMN IF NOT EXISTS updated_at    timestamptz;
    ALTER TABLE journal_vouchers ADD COLUMN IF NOT EXISTS updated_by    text;
  `);

  // Partial index: the Vouchers list filters on origin to decide which rows
  // offer an Edit action, and manual vouchers are a small minority of the table.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS journal_vouchers_origin_idx
       ON journal_vouchers (origin) WHERE origin IS NOT NULL`,
  );

  // 1. Types with no manual creation path are system with certainty.
  const { rowCount: sysTyped } = await pool.query(
    `UPDATE journal_vouchers
        SET origin = 'system', source_module = COALESCE(source_module, 'branch_transfer')
      WHERE origin IS NULL AND voucher_type = ANY($1::text[])`,
    [SYSTEM_ONLY_VOUCHER_TYPES],
  );

  // 2. Positive proof of a human: the manual route's own audit row. Guarded on
  //    the table existing so a brand-new database boots cleanly.
  const { rows: [{ has_log }] } = await pool.query<{ has_log: boolean }>(
    `SELECT to_regclass('public.activity_log') IS NOT NULL AS has_log`,
  );

  let manual = 0;
  if (has_log) {
    const { rowCount } = await pool.query(
      `UPDATE journal_vouchers v
          SET origin = 'manual', source_module = COALESCE(v.source_module, 'accounts')
        WHERE v.origin IS NULL
          AND v.voucher_type = ANY($1::text[])
          AND EXISTS (
            SELECT 1 FROM activity_log a
             WHERE a.entity_type = 'journal_voucher'
               AND a.action      = 'CREATE'
               AND a.module      = 'accounts'
               AND a.entity_id   = v.id
          )`,
      [MANUAL_VOUCHER_TYPES],
    );
    manual = rowCount ?? 0;
  }

  const { rows: [counts] } = await pool.query<{ manual: string; system: string; unknown: string }>(
    `SELECT count(*) FILTER (WHERE origin = 'manual') AS manual,
            count(*) FILTER (WHERE origin = 'system') AS system,
            count(*) FILTER (WHERE origin IS NULL)    AS unknown
       FROM journal_vouchers`,
  );

  const outcome =
    `newly classified ${manual} manual / ${sysTyped ?? 0} system; ` +
    `table now ${counts.manual} manual, ${counts.system} system, ${counts.unknown} unknown (edit locked)`;
  console.error(`[migration] voucher_provenance_v1: ${outcome}`);
  return outcome;
}
