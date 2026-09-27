import type { PgPool } from "@workspace/db";

const MIGRATION_NAME = "historical_electronic_clearing_backfill_v1";
const LOCK_NAME = "historical-electronic-clearing-backfill";
const ELECTRONIC_MODES = ["bank", "upi", "online"];
const ELECTRONIC_ACCOUNT_TYPES = ["bank", "upi", "online"];

export interface HistoricalElectronicClearingResult {
  alreadyApplied: boolean;
  clearingLedgerId: number | null;
  paymentVouchersMoved: number;
  receiptsMoved: number;
  salePaymentsMarkedPending: number;
}

/**
 * Re-route eligible historical electronic transactions from directly assigned
 * bank/online ledgers into Electronic Clearing.
 *
 * This is deliberately not registered in the API boot migration list. Run it
 * explicitly against the development database after reviewing the dry-run.
 * Every changed source row is snapshotted in an additive audit table in the
 * same transaction as the changes and migration marker.
 */
export async function backfillHistoricalElectronicClearing(
  pool: PgPool,
): Promise<HistoricalElectronicClearingResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_NAME]);

    const { rows: [existing] } = await client.query(
      `SELECT 1 FROM migration_log WHERE name = $1`,
      [MIGRATION_NAME],
    );
    if (existing) {
      await client.query("COMMIT");
      return {
        alreadyApplied: true,
        clearingLedgerId: null,
        paymentVouchersMoved: 0,
        receiptsMoved: 0,
        salePaymentsMarkedPending: 0,
      };
    }

    const { rows: clearingRows } = await client.query(
      `SELECT id
         FROM account_ledgers
        WHERE code = $1 AND COALESCE(is_active, true)
        FOR SHARE`,
      ["STD-ELEC-CLR"],
    );
    if (clearingRows.length !== 1) {
      throw new Error(`Expected one active STD-ELEC-CLR ledger; found ${clearingRows.length}.`);
    }
    const clearingLedgerId = Number(clearingRows[0].id);

    await client.query(`
      CREATE TABLE IF NOT EXISTS historical_electronic_clearing_audit (
        migration_name text NOT NULL,
        source_table text NOT NULL,
        source_id integer NOT NULL,
        before_state jsonb NOT NULL,
        after_state jsonb NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (migration_name, source_table, source_id)
      )
    `);

    // Manual and bill-allocation payment vouchers. Only an explicit electronic
    // mode or the linked Cash & Bank account type qualifies; cash and unknown
    // ledgers are never inferred as electronic.
    const paymentAudit = await client.query(
      `WITH eligible_accounts AS (
         SELECT ledger_id, MIN(account_type) AS account_type
           FROM cash_bank_accounts
          WHERE account_type = ANY($3::text[])
          GROUP BY ledger_id
         HAVING COUNT(DISTINCT account_type) = 1
       ), candidates AS MATERIALIZED (
         SELECT p.id, p.paid_from_ledger_id AS old_ledger_id,
                p.payment_mode AS old_payment_mode, p.source, p.voucher_number,
                p.amount::numeric AS amount,
                COALESCE(bre.status, '<none>') AS old_bank_reconciliation_status,
                COALESCE(
                  NULLIF(LOWER(BTRIM(p.payment_mode)), ''),
                  ea.account_type
                ) AS new_payment_mode
           FROM payments p
           JOIN eligible_accounts ea ON ea.ledger_id = p.paid_from_ledger_id
           LEFT JOIN bank_reconciliation_entries bre
             ON bre.ledger_id = p.paid_from_ledger_id
            AND bre.entry_id = 'payment:' || p.id::text
          WHERE p.source IN ('manual', 'allocation')
            AND p.paid_from_ledger_id <> $1
            AND (
              p.payment_mode IS NULL OR BTRIM(p.payment_mode) = ''
              OR LOWER(BTRIM(p.payment_mode)) = ANY($2::text[])
            )
            AND COALESCE(bre.status, '') <> 'reconciled'
            AND NOT EXISTS (
              SELECT 1
                FROM bank_reconciliation_batch_items bi
                JOIN bank_reconciliation_batches b ON b.id = bi.batch_id
               WHERE bi.ledger_id = p.paid_from_ledger_id
                 AND bi.entry_id = 'payment:' || p.id::text
                 AND b.status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM bank_reconciliation_batches b
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(b.source_items) = 'array'
                       THEN b.source_items ELSE '[]'::jsonb END
                ) item
               WHERE b.status = 'active'
                 AND item->>'kind' = 'manual_voucher'
                 AND item->>'voucherKind' = 'payment'
                 AND item->>'id' = p.id::text
            )
          FOR UPDATE OF p
       )
       INSERT INTO historical_electronic_clearing_audit
         (migration_name, source_table, source_id, before_state, after_state)
       SELECT $4, 'payments', id,
              jsonb_build_object(
                'paid_from_ledger_id', old_ledger_id,
                'payment_mode', old_payment_mode,
                'source', source,
                'voucher_number', voucher_number,
                'amount', amount,
                'bank_reconciliation_status', old_bank_reconciliation_status
              ),
              jsonb_build_object(
                'paid_from_ledger_id', $1,
                'payment_mode', new_payment_mode
              )
         FROM candidates
       ON CONFLICT (migration_name, source_table, source_id) DO NOTHING`,
      [clearingLedgerId, ELECTRONIC_MODES, ELECTRONIC_ACCOUNT_TYPES, MIGRATION_NAME],
    );

    const { rowCount: paymentVouchersMoved } = await client.query(
      `UPDATE payments p
          SET paid_from_ledger_id = $1,
              payment_mode = a.after_state->>'payment_mode'
         FROM historical_electronic_clearing_audit a
        WHERE a.migration_name = $2
          AND a.source_table = 'payments'
          AND a.source_id = p.id
          AND p.paid_from_ledger_id IS DISTINCT FROM $1`,
      [clearingLedgerId, MIGRATION_NAME],
    );

    // Manual, allocation, and POS receipts. Allocation-linked rows are only
    // moved when every linked collection is still eligible; settled, cancelled,
    // unknown-method, and already-batched groups are left untouched.
    const receiptAudit = await client.query(
      `WITH eligible_accounts AS (
         SELECT ledger_id, MIN(account_type) AS account_type
           FROM cash_bank_accounts
          WHERE account_type = ANY($3::text[])
          GROUP BY ledger_id
         HAVING COUNT(DISTINCT account_type) = 1
       ), candidates AS MATERIALIZED (
         SELECT r.id, r.received_in_ledger_id AS old_ledger_id,
                r.payment_mode AS old_payment_mode, r.source, r.voucher_number,
                r.amount::numeric AS amount,
                COALESCE(bre.status, '<none>') AS old_bank_reconciliation_status,
                COALESCE(
                  NULLIF(LOWER(BTRIM(r.payment_mode)), ''),
                  linked_mode.inferred_mode,
                  ea.account_type
                ) AS new_payment_mode
           FROM receipts r
           JOIN eligible_accounts ea ON ea.ledger_id = r.received_in_ledger_id
           LEFT JOIN bank_reconciliation_entries bre
             ON bre.ledger_id = r.received_in_ledger_id
            AND bre.entry_id = 'receipt:' || r.id::text
           LEFT JOIN LATERAL (
             SELECT CASE
                      WHEN COUNT(DISTINCT LOWER(BTRIM(sp.method))) = 1
                       AND BOOL_AND(LOWER(BTRIM(sp.method)) = ANY($2::text[]))
                      THEN MIN(LOWER(BTRIM(sp.method)))
                    END AS inferred_mode,
                    COUNT(sp.id)::int AS payment_count,
                    COALESCE(SUM(sp.amount::numeric), 0) AS linked_amount,
                    BOOL_OR(sp.reconciliation_status = 'pending') AS has_pending
               FROM sale_payments sp
              WHERE sp.clearing_receipt_id = r.id
           ) linked_mode ON true
          WHERE r.source IN ('manual', 'allocation', 'sale')
            AND r.received_in_ledger_id <> $1
            AND (
              r.payment_mode IS NULL OR BTRIM(r.payment_mode) = ''
              OR LOWER(BTRIM(r.payment_mode)) = ANY($2::text[])
            )
            AND COALESCE(bre.status, '') <> 'reconciled'
            AND NOT EXISTS (
              SELECT 1
                FROM bank_reconciliation_batch_items bi
                JOIN bank_reconciliation_batches b ON b.id = bi.batch_id
               WHERE bi.ledger_id = r.received_in_ledger_id
                 AND bi.entry_id = 'receipt:' || r.id::text
                 AND b.status = 'active'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM bank_reconciliation_batches b
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE WHEN jsonb_typeof(b.source_items) = 'array'
                       THEN b.source_items ELSE '[]'::jsonb END
                ) item
               WHERE b.status = 'active'
                 AND item->>'kind' = 'manual_voucher'
                 AND item->>'voucherKind' = 'receipt'
                 AND item->>'id' = r.id::text
            )
            AND (r.source <> 'sale' OR EXISTS (
              SELECT 1 FROM sale_payments sp
               WHERE sp.clearing_receipt_id = r.id
            ))
            AND (
              r.source <> 'sale'
              OR ROUND(r.amount::numeric * 100) = ROUND(linked_mode.linked_amount * 100)
            )
            AND (
              NOT COALESCE(linked_mode.has_pending, false)
              OR ROUND(r.amount::numeric * 100) = ROUND(linked_mode.linked_amount * 100)
            )
            AND (r.source <> 'manual' OR NOT EXISTS (
              SELECT 1 FROM sale_payments sp
               WHERE sp.clearing_receipt_id = r.id
            ))
            AND NOT EXISTS (
              SELECT 1
                FROM sale_payments sp
                LEFT JOIN sales s ON s.id = sp.sale_id
               WHERE sp.clearing_receipt_id = r.id
                 AND (
                   NOT (LOWER(BTRIM(COALESCE(sp.method, ''))) = ANY($2::text[]))
                   OR COALESCE(sp.reconciliation_status, '') NOT IN ('', 'pending')
                   OR s.id IS NULL
                   OR s.cancelled_at IS NOT NULL
                   OR s.branch_transfer_id IS NOT NULL
                   OR EXISTS (
                     SELECT 1
                       FROM reconciliation_batch_items rbi
                       JOIN reconciliation_batches rb ON rb.id = rbi.batch_id
                      WHERE rbi.sale_payment_id = sp.id
                        AND rb.status = 'active'
                   )
                   OR EXISTS (
                     SELECT 1
                       FROM bank_reconciliation_batches b
                       CROSS JOIN LATERAL jsonb_array_elements(
                         CASE WHEN jsonb_typeof(b.source_items) = 'array'
                              THEN b.source_items ELSE '[]'::jsonb END
                       ) item
                      WHERE b.status = 'active'
                        AND item->>'kind' = 'sale_payment'
                        AND item->>'id' = sp.id::text
                   )
                    OR EXISTS (
                      SELECT 1
                        FROM bank_reconciliation_batch_items bi
                        JOIN bank_reconciliation_batches b ON b.id = bi.batch_id
                       WHERE bi.ledger_id = r.received_in_ledger_id
                         AND bi.entry_id IN (
                           'receipt:' || r.id::text,
                           'sale_payment:' || sp.id::text
                         )
                         AND b.status = 'active'
                    )
                    OR EXISTS (
                      SELECT 1
                        FROM bank_reconciliation_entries bre
                       WHERE bre.ledger_id = r.received_in_ledger_id
                         AND bre.entry_id = 'sale_payment:' || sp.id::text
                         AND bre.status = 'reconciled'
                    )
                 )
            )
          FOR UPDATE OF r
       )
       INSERT INTO historical_electronic_clearing_audit
         (migration_name, source_table, source_id, before_state, after_state)
       SELECT $4, 'receipts', id,
              jsonb_build_object(
                'received_in_ledger_id', old_ledger_id,
                'payment_mode', old_payment_mode,
                'source', source,
                'voucher_number', voucher_number,
                'amount', amount,
                'bank_reconciliation_status', old_bank_reconciliation_status
              ),
              jsonb_build_object(
                'received_in_ledger_id', $1,
                'payment_mode', new_payment_mode
              )
         FROM candidates
       ON CONFLICT (migration_name, source_table, source_id) DO NOTHING`,
      [clearingLedgerId, ELECTRONIC_MODES, ELECTRONIC_ACCOUNT_TYPES, MIGRATION_NAME],
    );

    const { rowCount: receiptsMoved } = await client.query(
      `UPDATE receipts r
          SET received_in_ledger_id = $1,
              payment_mode = a.after_state->>'payment_mode'
         FROM historical_electronic_clearing_audit a
        WHERE a.migration_name = $2
          AND a.source_table = 'receipts'
          AND a.source_id = r.id
          AND r.received_in_ledger_id IS DISTINCT FROM $1`,
      [clearingLedgerId, MIGRATION_NAME],
    );

    // Put allocation collections in the sale-payment queue only when the
    // receipt amount is fully represented by eligible linked rows. Incomplete
    // allocation sets remain visible as one manual receipt item, avoiding a
    // settlement that the queue would reject or that could be selected twice.
    const salePaymentAudit = await client.query(
      `WITH changed_receipts AS (
         SELECT r.id, r.amount::numeric AS amount, r.source,
                (a.before_state->>'received_in_ledger_id')::int AS old_ledger_id
           FROM receipts r
           JOIN historical_electronic_clearing_audit a
             ON a.migration_name = $3
            AND a.source_table = 'receipts'
            AND a.source_id = r.id
          WHERE r.source IN ('sale', 'allocation')
            AND r.received_in_ledger_id = $1
       ), exact_receipts AS (
         SELECT r.id
           FROM changed_receipts r
           JOIN sale_payments sp ON sp.clearing_receipt_id = r.id
           JOIN sales s ON s.id = sp.sale_id
          GROUP BY r.id, r.amount
         HAVING COUNT(*) > 0
            AND ROUND(r.amount * 100) = ROUND(SUM(sp.amount::numeric) * 100)
            AND BOOL_AND(
              LOWER(BTRIM(sp.method)) = ANY($2::text[])
              AND (sp.reconciliation_status IS NULL OR sp.reconciliation_status = 'pending')
              AND s.cancelled_at IS NULL
              AND s.branch_transfer_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM reconciliation_batch_items rbi
                  JOIN reconciliation_batches rb ON rb.id = rbi.batch_id
                 WHERE rbi.sale_payment_id = sp.id
                   AND rb.status = 'active'
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM bank_reconciliation_entries bre
                 WHERE bre.ledger_id = r.old_ledger_id
                   AND bre.entry_id IN (
                     'receipt:' || r.id::text,
                     'sale_payment:' || sp.id::text
                   )
                   AND bre.status = 'reconciled'
              )
            )
       ), candidates AS MATERIALIZED (
         SELECT sp.id, sp.clearing_receipt_id, sp.method, sp.amount::numeric AS amount,
                sp.reconciliation_status
           FROM sale_payments sp
           JOIN exact_receipts er ON er.id = sp.clearing_receipt_id
          WHERE sp.reconciliation_status IS NULL
          FOR UPDATE OF sp
       )
       INSERT INTO historical_electronic_clearing_audit
         (migration_name, source_table, source_id, before_state, after_state)
       SELECT $3, 'sale_payments', id,
              jsonb_build_object(
                'clearing_receipt_id', clearing_receipt_id,
                'method', method,
                'amount', amount,
                'reconciliation_status', reconciliation_status
              ),
              jsonb_build_object(
                'clearing_receipt_id', clearing_receipt_id,
                'reconciliation_status', 'pending'
              )
         FROM candidates
       ON CONFLICT (migration_name, source_table, source_id) DO NOTHING`,
      [clearingLedgerId, ELECTRONIC_MODES, MIGRATION_NAME],
    );

    const { rowCount: salePaymentsMarkedPending } = await client.query(
      `UPDATE sale_payments sp
          SET reconciliation_status = 'pending'
         FROM historical_electronic_clearing_audit a
        WHERE a.migration_name = $1
          AND a.source_table = 'sale_payments'
          AND a.source_id = sp.id
          AND sp.reconciliation_status IS NULL`,
      [MIGRATION_NAME],
    );

    const expectedAuditRows =
      Number(paymentAudit.rowCount ?? 0)
      + Number(receiptAudit.rowCount ?? 0)
      + Number(salePaymentAudit.rowCount ?? 0);
    const actualAuditRows = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM historical_electronic_clearing_audit
        WHERE migration_name = $1`,
      [MIGRATION_NAME],
    );
    if (Number(actualAuditRows.rows[0]?.count ?? 0) !== expectedAuditRows) {
      throw new Error(
        `Audit count mismatch: inserted ${expectedAuditRows}, found ${actualAuditRows.rows[0]?.count ?? 0}.`,
      );
    }

    const invalidRows = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM (
           SELECT p.id
             FROM payments p
             JOIN historical_electronic_clearing_audit a
               ON a.migration_name = $2 AND a.source_table = 'payments' AND a.source_id = p.id
            WHERE p.paid_from_ledger_id <> $1
               OR p.payment_mode IS DISTINCT FROM a.after_state->>'payment_mode'
           UNION ALL
           SELECT r.id
             FROM receipts r
             JOIN historical_electronic_clearing_audit a
               ON a.migration_name = $2 AND a.source_table = 'receipts' AND a.source_id = r.id
            WHERE r.received_in_ledger_id <> $1
               OR r.payment_mode IS DISTINCT FROM a.after_state->>'payment_mode'
           UNION ALL
           SELECT sp.id
             FROM sale_payments sp
             JOIN historical_electronic_clearing_audit a
               ON a.migration_name = $2 AND a.source_table = 'sale_payments' AND a.source_id = sp.id
            WHERE sp.reconciliation_status IS DISTINCT FROM 'pending'
         ) mismatches`,
      [clearingLedgerId, MIGRATION_NAME],
    );
    if (Number(invalidRows.rows[0]?.count ?? 0) !== 0) {
      throw new Error(`Post-migration verification found ${invalidRows.rows[0]?.count} invalid row(s).`);
    }

    await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [MIGRATION_NAME],
    );
    await client.query("COMMIT");

    const result = {
      alreadyApplied: false,
      clearingLedgerId,
      paymentVouchersMoved: Number(paymentVouchersMoved ?? 0),
      receiptsMoved: Number(receiptsMoved ?? 0),
      salePaymentsMarkedPending: Number(salePaymentsMarkedPending ?? 0),
    };
    console.log("[migration] historical electronic clearing backfill", result);
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}