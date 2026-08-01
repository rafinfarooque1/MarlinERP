import type { PgPool } from "@workspace/db";

/**
 * One-time surgical cleanup of "ghost" rows that survived the Company Reset
 * run against the production database on 2026-08-01 at 06:10:01 UTC (pinned
 * by the hierarchy reseed, first activity_log row and first admin login, all
 * within the same minute).
 *
 * Background: POST /company/reset truncated a stale table list. It cleared
 * documents and masters (with RESTART IDENTITY) but left stock_batches,
 * stock_ledger, journal vouchers, salary accruals, rent agreements/periods,
 * cash/bank accounts, login attempts and the voucher sequence in place.
 * Because master ids restarted at 1, every surviving old row silently
 * re-attached itself to the NEW company's records (e.g. a 77 kg batch of the
 * old item #2 now shows under the new item #2, "ALPHONSO SLICE").
 *
 * This pass deletes ONLY rows created before the cutoff — everything entered
 * after the reset is untouched. It never re-fires: the migration_log marker
 * is written in the same transaction as the deletes (a lesson from the
 * STD-ledgers cleanup incident: data-shape guards re-fire, log guards don't).
 *
 * Safety gates, all of which must pass or nothing is deleted:
 *  1. migration_log marker absent (one-shot).
 *  2. NODE_ENV === 'production' — the development database was never reset
 *     and holds real pre-cutoff history that must not be touched.
 *  3. The database carries the reset signature: ZERO business documents
 *     (purchases/sales/expenses/receipts/payments) created before the cutoff.
 *     A database with pre-cutoff documents is NOT the reset database, and
 *     deleting by cutoff there would destroy real history — refuse loudly.
 */
const GUARD = "prod_reset_ghost_cleanup_v1";

/** The reset ran at 06:10:01 UTC. The old company's last write in any table
 *  this cleanup touches is 05:18 UTC (a cash/bank account); the new company's
 *  first is 06:28 UTC (the salary sweep accruing for a freshly re-created
 *  employee). 06:00 UTC sits safely between the two — an earlier draft used
 *  08:00, which would have misclassified that legitimate 06:28 accrual. */
const CUTOFF = "2026-08-01T06:00:00Z";

export async function cleanupPreResetGhosts(pool: PgPool): Promise<string> {
  const { rows: [done] } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = $1`, [GUARD],
  );
  if (done) return `${GUARD}: already applied`;

  if (process.env.NODE_ENV !== "production") {
    return `${GUARD}: skipped (development database was never reset — nothing to clean)`;
  }

  // ── Gate 3: reset signature ────────────────────────────────────────────────
  const { rows: [fp] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM purchases WHERE created_at < $1::timestamptz)::int
      + (SELECT COUNT(*) FROM sales     WHERE created_at < $1::timestamptz)::int
      + (SELECT COUNT(*) FROM expenses  WHERE created_at < $1::timestamptz)::int
      + (SELECT COUNT(*) FROM receipts  WHERE created_at < $1::timestamptz)::int
      + (SELECT COUNT(*) FROM payments  WHERE created_at < $1::timestamptz)::int AS pre_docs,
      (SELECT COUNT(*) FROM stock_batches WHERE created_at < $1::timestamptz)::int AS ghost_batches,
      (SELECT COUNT(*) FROM stock_ledger  WHERE created_at < $1::timestamptz)::int AS ghost_ledger
  `, [CUTOFF]);

  if (Number(fp.pre_docs) > 0) {
    // Not the reset database. Refuse without writing the marker so the check
    // re-runs (and keeps refusing) on every boot — loud beats silent here.
    return `${GUARD}: REFUSED — ${fp.pre_docs} business document(s) predate the cutoff, this is not the reset database; nothing deleted`;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const del = async (label: string, sql: string): Promise<string> => {
      const r = await client.query(sql, [CUTOFF]);
      return `${label}=${r.rowCount ?? 0}`;
    };

    const removed: string[] = [];
    // Children before parents.
    removed.push(await del("journal_voucher_lines",
      `DELETE FROM journal_voucher_lines WHERE voucher_id IN
         (SELECT id FROM journal_vouchers WHERE created_at < $1::timestamptz)`));
    removed.push(await del("journal_vouchers",
      `DELETE FROM journal_vouchers WHERE created_at < $1::timestamptz`));
    removed.push(await del("stock_ledger",
      `DELETE FROM stock_ledger WHERE created_at < $1::timestamptz`));
    removed.push(await del("stock_batches",
      `DELETE FROM stock_batches WHERE created_at < $1::timestamptz`));
    removed.push(await del("stock_reservations",
      `DELETE FROM stock_reservations WHERE created_at < $1::timestamptz`));
    removed.push(await del("stock_verifications",
      `DELETE FROM stock_verifications WHERE created_at < $1::timestamptz`));
    removed.push(await del("sales_returns",
      `DELETE FROM sales_returns WHERE created_at < $1::timestamptz`));
    removed.push(await del("purchase_returns",
      `DELETE FROM purchase_returns WHERE created_at < $1::timestamptz`));
    removed.push(await del("asset_purchases",
      `DELETE FROM asset_purchases WHERE created_at < $1::timestamptz`));
    removed.push(await del("assets",
      `DELETE FROM assets WHERE created_at < $1::timestamptz`));
    removed.push(await del("employee_advances",
      `DELETE FROM employee_advances WHERE created_at < $1::timestamptz`));
    removed.push(await del("invoice_share_links",
      `DELETE FROM invoice_share_links WHERE created_at < $1::timestamptz`));
    removed.push(await del("salary_accruals",
      `DELETE FROM salary_accruals WHERE created_at < $1::timestamptz`));
    removed.push(await del("rent_payments",
      `DELETE FROM rent_payments WHERE created_at < $1::timestamptz`));
    removed.push(await del("rent_accruals",
      `DELETE FROM rent_accruals WHERE created_at < $1::timestamptz`));
    removed.push(await del("rent_periods",
      `DELETE FROM rent_periods WHERE created_at < $1::timestamptz`));
    const delAgreements = await client.query<{ warehouse_id: number }>(
      `DELETE FROM warehouse_rent_agreements WHERE created_at < $1::timestamptz
        RETURNING warehouse_id`, [CUTOFF]);
    removed.push(`warehouse_rent_agreements=${delAgreements.rowCount ?? 0}`);
    // The hourly rent sweep may have derived post-cutoff accruals/periods from
    // a ghost agreement before this cleanup ran. Scope strictly to warehouses
    // whose agreement was deleted JUST NOW and that have no surviving
    // agreement — never touch rent rows of any other warehouse, even if it
    // currently lacks an agreement for unrelated reasons.
    const ghostWarehouses = [...new Set(delAgreements.rows.map((r) => r.warehouse_id))];
    if (ghostWarehouses.length > 0) {
      const orphanAcc = await client.query(
        `DELETE FROM rent_accruals ra
          WHERE ra.warehouse_id = ANY($1::int[])
            AND NOT EXISTS (SELECT 1 FROM warehouse_rent_agreements a
                             WHERE a.warehouse_id = ra.warehouse_id)`, [ghostWarehouses]);
      removed.push(`rent_accruals_orphaned=${orphanAcc.rowCount ?? 0}`);
      const orphanPer = await client.query(
        `DELETE FROM rent_periods rp
          WHERE rp.warehouse_id = ANY($1::int[])
            AND NOT EXISTS (SELECT 1 FROM warehouse_rent_agreements a
                             WHERE a.warehouse_id = rp.warehouse_id)`, [ghostWarehouses]);
      removed.push(`rent_periods_orphaned=${orphanPer.rowCount ?? 0}`);
    }
    removed.push(await del("login_attempts",
      `DELETE FROM login_attempts WHERE created_at < $1::timestamptz`));
    // Old cash/bank accounts — but never one a post-reset expense points at.
    removed.push(await del("cash_bank_accounts",
      `DELETE FROM cash_bank_accounts cba WHERE cba.created_at < $1::timestamptz
         AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.payment_account_id = cba.id)`));

    // ── Accrual anchors ──────────────────────────────────────────────────────
    // The salary sweep backfills from these anchors; without advancing them a
    // backdated join_date would re-accrue salary for days before the company
    // existed (same treatment the "CLEAR ALL TRANSACTIONS" reset applies).
    await client.query(
      `UPDATE salary_accrual_config SET attendance_from = GREATEST(attendance_from, DATE '2026-08-01')`);
    await client.query(
      `UPDATE employees SET salary_accrual_resume_from = DATE '2026-08-01'
        WHERE salary_accrual_resume_from IS NULL OR salary_accrual_resume_from < DATE '2026-08-01'`);

    // ── In-transaction verification (throws → full rollback) ─────────────────
    // Batch-vs-entry comparison is bidirectional (FULL OUTER JOIN over the
    // key sets). The invariant that must HOLD is one-sided, though: batches
    // are an additive lot layer over stock_entries (the quantity truth), and
    // a shortfall is legitimate "untracked" stock — but batch coverage
    // EXCEEDING the entry quantity means a ghost batch survived, which is the
    // exact corruption this cleanup exists to remove. Over-coverage rolls
    // everything back; under-coverage is only reported.
    const { rows: [chk] } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM stock_batches WHERE created_at < $1::timestamptz)::int AS batches_left,
        (SELECT COUNT(*) FROM stock_ledger  WHERE created_at < $1::timestamptz)::int AS ledger_left,
        (SELECT COUNT(*) FROM journal_voucher_lines jvl
           WHERE NOT EXISTS (SELECT 1 FROM journal_vouchers v WHERE v.id = jvl.voucher_id))::int AS orphan_jvl,
        COUNT(*) FILTER (WHERE cmp.batch_qty > cmp.entry_qty)::int AS over_covered,
        COUNT(*) FILTER (WHERE cmp.batch_qty < cmp.entry_qty)::int AS under_covered
      FROM (
        SELECT COALESCE(e.entry_qty, 0) AS entry_qty, COALESCE(b.batch_qty, 0) AS batch_qty
          FROM (SELECT item_id, material_type, branch_type, branch_id,
                       SUM(quantity::numeric) AS entry_qty
                  FROM stock_entries GROUP BY 1, 2, 3, 4) e
          FULL OUTER JOIN
               (SELECT item_id, material_type, branch_type, branch_id,
                       SUM(quantity::numeric) AS batch_qty
                  FROM stock_batches GROUP BY 1, 2, 3, 4) b
          USING (item_id, material_type, branch_type, branch_id)
      ) cmp
    `, [CUTOFF]);

    if (
      Number(chk.batches_left) > 0 || Number(chk.ledger_left) > 0 ||
      Number(chk.orphan_jvl) > 0 || Number(chk.over_covered) > 0
    ) {
      throw new Error(
        `post-delete verification failed (batches_left=${chk.batches_left}, ` +
        `ledger_left=${chk.ledger_left}, orphan_jvl=${chk.orphan_jvl}, ` +
        `batch_over_coverage=${chk.over_covered}) — rolling back`,
      );
    }

    // Marker in the SAME transaction as the deletes — all-or-nothing.
    await client.query(`INSERT INTO public.migration_log (name) VALUES ($1)`, [GUARD]);
    await client.query("COMMIT");

    return `${GUARD} applied — removed { ${removed.join(", ")} }; ` +
      `batch coverage after cleanup: over=${chk.over_covered}, untracked-shortfall keys=${chk.under_covered}`;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
