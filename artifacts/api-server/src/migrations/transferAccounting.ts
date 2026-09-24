/**
 * Moves legacy voucher-mode taxable transfers from the old balance-sheet
 * clearing presentation to the Transfer-In / Transfer-Out P&L presentation.
 *
 * Invoice-mode transfers are not rewritten: buildDerivedPostings reads their
 * source documents and now emits the new legs directly. Voucher-mode history
 * needs additive adjustment vouchers because the original journal rows are
 * immutable audit history.
 */
import type { PgPool as Pool } from "@workspace/db";
import { nextVoucherNumber } from "../lib/voucherNumber";
import {
  TRANSFER_IN_LEDGER_CODE,
  TRANSFER_OUT_LEDGER_CODE,
} from "../lib/transferAccounting";

const MIGRATION_NAME = "transfer_accounting_pnl_v1";
const INTERNAL_MIGRATION_NAME = "internal_transfer_accounting_v1";
const INTERNAL_PARENT_REPAIR_NAME = "internal_transfer_ledger_parents_v1";
const r2 = (n: number) => Math.round(n * 100) / 100;

function dateOnly(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value ?? "").slice(0, 10);
}

function locationId(type: string, id: unknown): number {
  return type === "headoffice" ? 0 : Number(id ?? 0);
}

type AdjustmentArgs = {
  client: { query: Function };
  date: string;
  locationType: string;
  locationId: number;
  amount: number;
  debitLedger: number;
  creditLedger: number;
  narration: string;
};

async function createAdjustmentVoucher(args: AdjustmentArgs): Promise<number> {
  const voucherNumber = await nextVoucherNumber(args.client as any, "journal", args.date);
  const { rows: [voucher] } = await args.client.query(
    `INSERT INTO journal_vouchers
       (voucher_type, voucher_number, voucher_date, narration, party_ledger_id,
        total_amount, created_by, origin, source_module, location_type, location_id)
     VALUES ('journal', $1, $2, $3, NULL, $4, 'system', 'system',
             'branch_transfer_accounting', $5, $6)
     RETURNING id`,
    [
      voucherNumber,
      args.date,
      args.narration,
      args.amount,
      args.locationType,
      args.locationId,
    ],
  );
  if (!voucher?.id) throw new Error(`could not create transfer adjustment voucher for ${args.narration}`);

  await args.client.query(
    `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
     VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [voucher.id, args.debitLedger, args.amount, args.creditLedger],
  );
  return Number(voucher.id);
}

async function voucherLedgerTotals(
  client: { query: Function },
  voucherId: number,
  ledgerId: number,
): Promise<{ debit: number; credit: number }> {
  const { rows: [row] } = await client.query(
    `SELECT COALESCE(SUM(debit), 0)::numeric AS debit,
            COALESCE(SUM(credit), 0)::numeric AS credit
       FROM journal_voucher_lines
      WHERE voucher_id = $1 AND ledger_id = $2`,
    [voucherId, ledgerId],
  );
  return { debit: Number(row?.debit ?? 0), credit: Number(row?.credit ?? 0) };
}

/**
 * One-shot, marker-and-vouchers-in-one-transaction backfill.
 *
 * It deliberately does not update the old voucher lines. Each adjustment is
 * itself balanced and cancels exactly the old taxable clearing leg while
 * introducing the new P&L leg.
 */
export async function backfillTransferAccounting(pool: Pool): Promise<void> {
  const client = await pool.connect();
  const report = {
    scanned: 0,
    invoiceMode: 0,
    alreadyModern: 0,
    dispatchAdjusted: 0,
    receiveAdjusted: 0,
  };

  try {
    await client.query("BEGIN");
    const { rows: claimed } = await client.query(
      `INSERT INTO migration_log (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING name`,
      [MIGRATION_NAME],
    );
    if (claimed.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: ledgers } = await client.query(
      `SELECT code, id FROM account_ledgers
        WHERE code = ANY($1::text[])`,
      [[TRANSFER_IN_LEDGER_CODE, TRANSFER_OUT_LEDGER_CODE, "STD-BRANCH-TRF"]],
    );
    const byCode = new Map<string, number>(
      ledgers.map((row: any) => [String(row.code), Number(row.id)]),
    );
    const transferIn = byCode.get(TRANSFER_IN_LEDGER_CODE);
    const transferOut = byCode.get(TRANSFER_OUT_LEDGER_CODE);
    const transferClearing = byCode.get("STD-BRANCH-TRF");
    if (!transferIn || !transferOut || !transferClearing) {
      throw new Error("transfer accounting ledgers are not available");
    }

    const { rows: transfers } = await client.query(`
      SELECT t.id, t.challan_number, t.from_type, t.from_id, t.to_type, t.to_id,
             t.transfer_date, t.received_date, t.transfer_value, t.document_mode,
             COALESCE(
               t.dispatch_voucher_id,
               (SELECT id FROM journal_vouchers
                 WHERE voucher_number = 'TRF-' || t.challan_number
                 ORDER BY id LIMIT 1)
             ) AS dispatch_voucher_id,
             COALESCE(
               t.receive_voucher_id,
               (SELECT id FROM journal_vouchers
                 WHERE voucher_number = 'TRF-RCV-' || t.challan_number
                 ORDER BY id LIMIT 1)
             ) AS receive_voucher_id
        FROM stock_transfers t
       WHERE t.status = 'completed'
         AND COALESCE(t.transfer_type, 'internal') <> 'internal'
         AND COALESCE(t.transfer_value, 0)::numeric > 0
       ORDER BY t.id
       FOR UPDATE OF t
    `);

    for (const transfer of transfers) {
      report.scanned++;
      const taxable = r2(Number(transfer.transfer_value));
      const mode = String(transfer.document_mode ?? "voucher");
      if (mode === "invoice") {
        // Invoice rows are projected by buildDerivedPostings, so adding a JV
        // here would double-post the same statutory document.
        report.invoiceMode++;
        continue;
      }

      const dispatchVoucherId = Number(transfer.dispatch_voucher_id ?? 0);
      const receiveVoucherId = Number(transfer.receive_voucher_id ?? 0);
      if (!dispatchVoucherId || !receiveVoucherId) {
        throw new Error(
          `completed voucher transfer ${transfer.id} is missing dispatch or receive voucher`,
        );
      }

      const dispatchOld = await voucherLedgerTotals(
        client, dispatchVoucherId, transferClearing,
      );
      const dispatchNew = await voucherLedgerTotals(
        client, dispatchVoucherId, transferOut,
      );
      if (dispatchNew.credit >= taxable - 0.005) {
        report.alreadyModern++;
      } else {
        if (Math.abs(dispatchOld.credit - taxable) > 0.01) {
          throw new Error(
            `transfer ${transfer.id} dispatch clearing is ${dispatchOld.credit.toFixed(2)}, expected ${taxable.toFixed(2)}`,
          );
        }
        await createAdjustmentVoucher({
          client,
          date: dateOnly(transfer.received_date ?? transfer.transfer_date),
          locationType: String(transfer.from_type),
          locationId: locationId(String(transfer.from_type), transfer.from_id),
          amount: taxable,
          debitLedger: transferClearing,
          creditLedger: transferOut,
          narration: `Transfer-Out accounting adjustment — ${transfer.challan_number}`,
        });
        report.dispatchAdjusted++;
      }

      const receiveOld = await voucherLedgerTotals(
        client, receiveVoucherId, transferClearing,
      );
      const receiveNew = await voucherLedgerTotals(
        client, receiveVoucherId, transferIn,
      );
      if (receiveNew.debit >= taxable - 0.005) {
        report.alreadyModern++;
      } else {
        if (Math.abs(receiveOld.debit - taxable) > 0.01) {
          throw new Error(
            `transfer ${transfer.id} receive clearing is ${receiveOld.debit.toFixed(2)}, expected ${taxable.toFixed(2)}`,
          );
        }
        await createAdjustmentVoucher({
          client,
          date: dateOnly(transfer.transfer_date),
          locationType: String(transfer.to_type),
          locationId: locationId(String(transfer.to_type), transfer.to_id),
          amount: taxable,
          debitLedger: transferIn,
          creditLedger: transferClearing,
          narration: `Transfer-In accounting adjustment — ${transfer.challan_number}`,
        });
        report.receiveAdjusted++;
      }
    }

    await client.query("COMMIT");
    const summary = JSON.stringify(report);
    console.error(`[migration] ${MIGRATION_NAME}: ${summary}`);
    await pool.query(
      `INSERT INTO boot_status (node_env, migrations_ok, notes)
       VALUES ($1, TRUE, $2)`,
      [process.env.NODE_ENV ?? "development", `${MIGRATION_NAME}: ${summary}`],
    ).catch(() => {});
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(
      `[migration] ${MIGRATION_NAME} FAILED — rolled back; will retry next boot:`,
      error,
    );
  } finally {
    client.release();
  }
}

/**
 * Give completed same-GSTIN transfers the same internal branch accounting as
 * newly dispatched transfers. Older internal rows were delivery-challan-only,
 * so this adds balanced source and destination vouchers without changing stock
 * or rewriting any existing journal lines.
 */
export async function backfillInternalTransferAccounting(pool: Pool): Promise<void> {
  const client = await pool.connect();
  const report = { scanned: 0, backfilled: 0 };
  try {
    await client.query("BEGIN");
    const { rows: claimed } = await client.query(
      `INSERT INTO migration_log (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING name`,
      [INTERNAL_MIGRATION_NAME],
    );
    if (claimed.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: ledgers } = await client.query(
      `SELECT code, id FROM account_ledgers
        WHERE code = ANY($1::text[])`,
      [["STD-BRANCH-DEBTOR", "STD-BRANCH-CREDITOR", TRANSFER_IN_LEDGER_CODE, TRANSFER_OUT_LEDGER_CODE]],
    );
    const byCode = new Map<string, number>(
      ledgers.map((row: any) => [String(row.code), Number(row.id)]),
    );
    const debtor = byCode.get("STD-BRANCH-DEBTOR");
    const creditor = byCode.get("STD-BRANCH-CREDITOR");
    const transferIn = byCode.get(TRANSFER_IN_LEDGER_CODE);
    const transferOut = byCode.get(TRANSFER_OUT_LEDGER_CODE);
    if (!debtor || !creditor || !transferIn || !transferOut) {
      throw new Error("internal transfer accounting ledgers are not available");
    }

    const { rows: transfers } = await client.query(`
      SELECT id, challan_number, from_type, from_id, to_type, to_id,
             transfer_date, received_date, line_items
        FROM stock_transfers
       WHERE status = 'completed'
         AND COALESCE(transfer_type, 'internal') = 'internal'
         AND COALESCE(transfer_value, 0)::numeric = 0
       ORDER BY id
       FOR UPDATE
    `);
    for (const transfer of transfers) {
      report.scanned++;
      const lines = Array.isArray(transfer.line_items) ? transfer.line_items : [];
      const value = r2(lines.reduce(
        (sum: number, line: any) =>
          sum + Number(line?.quantity ?? 0) * Number(line?.costPrice ?? 0),
        0,
      ));
      if (!(value > 0.004)) continue;

      const dispatchId = await createAdjustmentVoucher({
        client,
        date: dateOnly(transfer.transfer_date),
        locationType: String(transfer.from_type),
        locationId: locationId(String(transfer.from_type), transfer.from_id),
        amount: value,
        debitLedger: debtor,
        creditLedger: transferOut,
        narration: `Internal transfer dispatch — ${transfer.challan_number}`,
      });
      const receiveId = await createAdjustmentVoucher({
        client,
        date: dateOnly(transfer.received_date ?? transfer.transfer_date),
        locationType: String(transfer.to_type),
        locationId: locationId(String(transfer.to_type), transfer.to_id),
        amount: value,
        debitLedger: transferIn,
        creditLedger: creditor,
        narration: `Internal transfer receipt — ${transfer.challan_number}`,
      });
      await client.query(
        `UPDATE stock_transfers
            SET transfer_value = $1, gst_amount = 0, document_mode = 'voucher',
                dispatch_voucher_id = $2, receive_voucher_id = $3
          WHERE id = $4`,
        [value, dispatchId, receiveId, transfer.id],
      );
      report.backfilled++;
    }

    await client.query("COMMIT");
    const summary = JSON.stringify(report);
    console.error(`[migration] ${INTERNAL_MIGRATION_NAME}: ${summary}`);
    await pool.query(
      `INSERT INTO boot_status (node_env, migrations_ok, notes)
       VALUES ($1, TRUE, $2)`,
      [process.env.NODE_ENV ?? "development", `${INTERNAL_MIGRATION_NAME}: ${summary}`],
    ).catch(() => {});
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(
      `[migration] ${INTERNAL_MIGRATION_NAME} FAILED — rolled back; will retry next boot:`,
      error,
    );
  } finally {
    client.release();
  }
}

/**
 * Repair the hierarchy of system-generated inter-branch ledgers without
 * touching their postings. These codes are module-owned, so their parent is
 * part of their accounting contract: receivables belong under Current Assets
 * and payables under Current Liabilities.
 */
export async function repairInternalTransferLedgerParents(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: claimed } = await client.query(
      `INSERT INTO migration_log (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING name`,
      [INTERNAL_PARENT_REPAIR_NAME],
    );
    if (claimed.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `UPDATE account_ledgers AS child
          SET parent_id = parent.id
         FROM account_ledgers AS parent
        WHERE (
          (child.code LIKE 'STD-BRANCH-DR-%' AND parent.code = 'SYS-CURA')
          OR (child.code LIKE 'STD-BRANCH-CR-%' AND parent.code = 'SYS-CURL')
          OR (child.code = 'STD-BRANCH-DEBTOR' AND parent.code = 'SYS-CURA')
          OR (child.code = 'STD-BRANCH-CREDITOR' AND parent.code = 'SYS-CURL')
        )
          AND child.parent_id IS DISTINCT FROM parent.id`,
    );

    await client.query("COMMIT");
    console.error(`[migration] ${INTERNAL_PARENT_REPAIR_NAME}: applied`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(
      `[migration] ${INTERNAL_PARENT_REPAIR_NAME} FAILED — rolled back; will retry next boot:`,
      error,
    );
  } finally {
    client.release();
  }
}
