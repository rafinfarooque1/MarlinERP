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
  canonicalTransferLocationPair,
  interBranchTransferLedgerCode,
  legacyInterBranchTransferLedgerCode,
  transferLocationCodePart,
  transferPairPostingTargets,
  TRANSFER_IN_LEDGER_CODE,
  TRANSFER_OUT_LEDGER_CODE,
} from "../lib/transferAccounting";

const MIGRATION_NAME = "transfer_accounting_pnl_v1";
const INTERNAL_MIGRATION_NAME = "internal_transfer_accounting_v1";
const INTERNAL_PARENT_REPAIR_NAME = "internal_transfer_ledger_parents_v1";
const INTERNAL_PAIR_LEDGER_PROVISION_NAME = "internal_transfer_pair_ledgers_v1";
const INTERNAL_PAIR_LEDGER_RECLASS_NAME = "internal_transfer_pair_reclass_v1";
const INTERNAL_NET_PAIR_MIGRATION_NAME = "internal_transfer_single_net_pair_ledgers_v1";
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
        WHERE code = ANY($1::text[])
           OR code LIKE 'STD-BRANCH-DR-%'
           OR code LIKE 'STD-BRANCH-CR-%'`,
      [["STD-BRANCH-DEBTOR", "STD-BRANCH-CREDITOR", TRANSFER_IN_LEDGER_CODE, TRANSFER_OUT_LEDGER_CODE]],
    );
    const byCode = new Map<string, number>(
      ledgers.map((row: any) => [String(row.code), Number(row.id)]),
    );
    const transferIn = byCode.get(TRANSFER_IN_LEDGER_CODE);
    const transferOut = byCode.get(TRANSFER_OUT_LEDGER_CODE);
    if (!transferIn || !transferOut) {
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
      const debtor = byCode.get(legacyInterBranchTransferLedgerCode(
        "receivable",
        { locationType: String(transfer.from_type), locationId: locationId(String(transfer.from_type), transfer.from_id) },
        { locationType: String(transfer.to_type), locationId: locationId(String(transfer.to_type), transfer.to_id) },
      ));
      const creditor = byCode.get(legacyInterBranchTransferLedgerCode(
        "payable",
        { locationType: String(transfer.from_type), locationId: locationId(String(transfer.from_type), transfer.from_id) },
        { locationType: String(transfer.to_type), locationId: locationId(String(transfer.to_type), transfer.to_id) },
      ));
      if (!debtor || !creditor) {
        throw new Error(`pair-specific inter-branch ledgers are not available for transfer ${transfer.id}`);
      }

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

/**
 * Add one receivable/payable ledger for every directed location pair already
 * present in the transfer register. New transfers provision these ledgers in
 * gstTransfer.ts; this boot migration brings older transfer pairs into the same
 * chart without editing or deleting any existing ledger or posting.
 */
export async function provisionInternalTransferPairLedgers(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let created = 0;
  try {
    await client.query("BEGIN");
    const { rows: claimed } = await client.query(
      `INSERT INTO migration_log (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING name`,
      [INTERNAL_PAIR_LEDGER_PROVISION_NAME],
    );
    if (claimed.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: parents } = await client.query(
      `SELECT code, id FROM account_ledgers
        WHERE code = ANY($1::text[])`,
      [["SYS-CURA", "SYS-CURL"]],
    );
    const parentIdByCode = new Map<string, number>(
      parents.map((row: any) => [String(row.code), Number(row.id)]),
    );
    const receivableParent = parentIdByCode.get("SYS-CURA");
    const payableParent = parentIdByCode.get("SYS-CURL");
    if (!receivableParent || !payableParent) {
      throw new Error("Current Assets or Current Liabilities parent ledger is unavailable");
    }

    const { rows: pairs } = await client.query(`
      SELECT DISTINCT
             t.from_type, t.from_id, t.to_type, t.to_id,
             COALESCE(
               from_wh.name, from_out.name,
               CASE WHEN t.from_type = 'headoffice'
                    THEN (SELECT company_name FROM company_settings ORDER BY id LIMIT 1)
                    ELSE t.from_type || ' #' || t.from_id::text END
             ) AS from_name,
             COALESCE(
               to_wh.name, to_out.name,
               CASE WHEN t.to_type = 'headoffice'
                    THEN (SELECT company_name FROM company_settings ORDER BY id LIMIT 1)
                    ELSE t.to_type || ' #' || t.to_id::text END
             ) AS to_name
        FROM stock_transfers t
        LEFT JOIN warehouses from_wh
          ON t.from_type = 'warehouse' AND from_wh.id = t.from_id
        LEFT JOIN outlets from_out
          ON t.from_type = 'outlet' AND from_out.id = t.from_id
        LEFT JOIN warehouses to_wh
          ON t.to_type = 'warehouse' AND to_wh.id = t.to_id
        LEFT JOIN outlets to_out
          ON t.to_type = 'outlet' AND to_out.id = t.to_id
       WHERE t.from_type IS NOT NULL AND t.from_id IS NOT NULL
         AND t.to_type IS NOT NULL AND t.to_id IS NOT NULL
       ORDER BY t.from_type, t.from_id, t.to_type, t.to_id
    `);

    for (const pair of pairs) {
      const fromLocation = {
        locationType: String(pair.from_type),
        locationId: locationId(String(pair.from_type), pair.from_id),
      };
      const toLocation = {
        locationType: String(pair.to_type),
        locationId: locationId(String(pair.to_type), pair.to_id),
      };
      const fromName = String(pair.from_name ?? `${fromLocation.locationType} #${fromLocation.locationId}`);
      const toName = String(pair.to_name ?? `${toLocation.locationType} #${toLocation.locationId}`);
      const ledgers = [
        {
          side: "receivable" as const,
          name: `Inter-Branch Receivable — ${fromName} → ${toName}`,
          parentId: receivableParent,
          type: "asset",
          code: legacyInterBranchTransferLedgerCode("receivable", fromLocation, toLocation),
          description: `Owed by ${toName} to ${fromName} for inter-branch stock transfers`,
        },
        {
          side: "payable" as const,
          name: `Inter-Branch Payable — ${fromName} → ${toName}`,
          parentId: payableParent,
          type: "liability",
          code: legacyInterBranchTransferLedgerCode("payable", fromLocation, toLocation),
          description: `Owed to ${fromName} by ${toName} for inter-branch stock transfers`,
        },
      ];
      for (const ledger of ledgers) {
        const result = await client.query(
          `INSERT INTO account_ledgers
             (name, type, code, section, parent_id, is_system_group, description)
           SELECT $1, $2, $3, 'balance_sheet', $4, false, $5
            WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $3)`,
          [ledger.name, ledger.type, ledger.code, ledger.parentId, ledger.description],
        );
        created += Number(result.rowCount ?? 0);
      }
    }

    await client.query("COMMIT");
    console.error(
      `[migration] ${INTERNAL_PAIR_LEDGER_PROVISION_NAME}: provisioned ${created} pair ledgers across ${pairs.length} transfer pairs`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(
      `[migration] ${INTERNAL_PAIR_LEDGER_PROVISION_NAME} FAILED — rolled back; will retry next boot:`,
      error,
    );
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Move any old voucher-mode branch-transfer balance off the two generic
 * control ledgers using balanced system vouchers. Original transfer vouchers
 * and lines remain immutable audit history; invoice-derived entries are moved
 * by buildDerivedPostings and do not need stored-row edits.
 */
export async function reclassifyInternalTransferPairLedgerBalances(pool: Pool): Promise<void> {
  const client = await pool.connect();
  const report = { scanned: 0, dispatchAdjusted: 0, receiveAdjusted: 0 };
  try {
    await client.query("BEGIN");
    const { rows: claimed } = await client.query(
      `INSERT INTO migration_log (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING name`,
      [INTERNAL_PAIR_LEDGER_RECLASS_NAME],
    );
    if (claimed.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: baseLedgers } = await client.query(
      `SELECT code, id FROM account_ledgers
        WHERE code = ANY($1::text[])`,
      [["STD-BRANCH-DEBTOR", "STD-BRANCH-CREDITOR"]],
    );
    const baseLedgerIdByCode = new Map<string, number>(
      baseLedgers.map((row: any) => [String(row.code), Number(row.id)]),
    );
    const baseReceivable = baseLedgerIdByCode.get("STD-BRANCH-DEBTOR");
    const basePayable = baseLedgerIdByCode.get("STD-BRANCH-CREDITOR");
    if (!baseReceivable || !basePayable) {
      throw new Error("legacy inter-branch control ledgers are unavailable");
    }

    const { rows: transfers } = await client.query(`
      SELECT t.id, t.challan_number, t.from_type, t.from_id, t.to_type, t.to_id,
             t.transfer_date, t.received_date,
             t.dispatch_voucher_id, t.receive_voucher_id,
             COALESCE(dispatch.voucher_date, t.transfer_date) AS dispatch_voucher_date,
             COALESCE(receive.voucher_date, t.received_date, t.transfer_date) AS receive_voucher_date
        FROM stock_transfers t
        LEFT JOIN journal_vouchers dispatch ON dispatch.id = t.dispatch_voucher_id
        LEFT JOIN journal_vouchers receive ON receive.id = t.receive_voucher_id
       WHERE t.dispatch_voucher_id IS NOT NULL
          OR t.receive_voucher_id IS NOT NULL
       ORDER BY t.id
    `);

    for (const transfer of transfers) {
      report.scanned++;
      const fromLocation = {
        locationType: String(transfer.from_type),
        locationId: locationId(String(transfer.from_type), transfer.from_id),
      };
      const toLocation = {
        locationType: String(transfer.to_type),
        locationId: locationId(String(transfer.to_type), transfer.to_id),
      };
      const receivableCode = legacyInterBranchTransferLedgerCode("receivable", fromLocation, toLocation);
      const payableCode = legacyInterBranchTransferLedgerCode("payable", fromLocation, toLocation);
      const { rows: pairLedgers } = await client.query(
        `SELECT code, id FROM account_ledgers WHERE code = ANY($1::text[])`,
        [[receivableCode, payableCode]],
      );
      const pairLedgerIdByCode = new Map<string, number>(
        pairLedgers.map((row: any) => [String(row.code), Number(row.id)]),
      );
      const pairReceivable = pairLedgerIdByCode.get(receivableCode);
      const pairPayable = pairLedgerIdByCode.get(payableCode);
      if (!pairReceivable || !pairPayable) {
        throw new Error(`pair-specific ledgers are not available for transfer ${transfer.id}`);
      }

      if (transfer.dispatch_voucher_id != null) {
        const totals = await voucherLedgerTotals(
          client, Number(transfer.dispatch_voucher_id), baseReceivable,
        );
        const net = r2(totals.debit - totals.credit);
        if (Math.abs(net) > 0.004) {
          const debitLedger = net > 0 ? pairReceivable : baseReceivable;
          const creditLedger = net > 0 ? baseReceivable : pairReceivable;
          await createAdjustmentVoucher({
            client,
            date: dateOnly(transfer.dispatch_voucher_date),
            locationType: fromLocation.locationType,
            locationId: fromLocation.locationId,
            amount: Math.abs(net),
            debitLedger,
            creditLedger,
            narration: `Reclassify inter-branch receivable — ${transfer.challan_number}`,
          });
          report.dispatchAdjusted++;
        }
      }

      if (transfer.receive_voucher_id != null) {
        const totals = await voucherLedgerTotals(
          client, Number(transfer.receive_voucher_id), basePayable,
        );
        const net = r2(totals.debit - totals.credit);
        if (Math.abs(net) > 0.004) {
          const debitLedger = net > 0 ? pairPayable : basePayable;
          const creditLedger = net > 0 ? basePayable : pairPayable;
          await createAdjustmentVoucher({
            client,
            date: dateOnly(transfer.receive_voucher_date),
            locationType: toLocation.locationType,
            locationId: toLocation.locationId,
            amount: Math.abs(net),
            debitLedger,
            creditLedger,
            narration: `Reclassify inter-branch payable — ${transfer.challan_number}`,
          });
          report.receiveAdjusted++;
        }
      }
    }

    await client.query("COMMIT");
    console.error(`[migration] ${INTERNAL_PAIR_LEDGER_RECLASS_NAME}: ${JSON.stringify(report)}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(
      `[migration] ${INTERNAL_PAIR_LEDGER_RECLASS_NAME} FAILED — rolled back; will retry next boot:`,
      error,
    );
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Consolidate directed receivable/payable ledgers into one net payable per
 * undirected location pair. Historic journal rows remain untouched; balanced
 * adjustment vouchers move their current balances to the pair ledger or the
 * shared liability clearing ledger according to transfer direction.
 */
export async function consolidateInternalTransferPairLedgers(pool: Pool): Promise<void> {
  const client = await pool.connect();
  const report = { pairs: 0, balancesMoved: 0, legacyLedgersRetired: 0 };
  try {
    await client.query("BEGIN");
    const { rows: claimed } = await client.query(
      `INSERT INTO migration_log (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING name`,
      [INTERNAL_NET_PAIR_MIGRATION_NAME],
    );
    if (claimed.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: [liabilities] } = await client.query(
      `SELECT id FROM account_ledgers WHERE code = 'SYS-CURL'`,
    );
    if (!liabilities?.id) throw new Error("Current Liabilities group is unavailable");

    await client.query(
      `INSERT INTO account_ledgers
         (name, type, code, section, parent_id, is_system_group, is_group, is_active, description)
       SELECT 'Inter-Branch Payable', 'liability', 'STD-BRANCH-PAYABLE-GROUP',
              'balance_sheet', $1, true, true, true,
              'Net inter-branch balances by undirected warehouse pair'
        WHERE NOT EXISTS (
          SELECT 1 FROM account_ledgers WHERE code = 'STD-BRANCH-PAYABLE-GROUP'
        )`,
      [liabilities.id],
    );
    const { rows: [payableGroup] } = await client.query(
      `SELECT id, is_group FROM account_ledgers WHERE code = 'STD-BRANCH-PAYABLE-GROUP'`,
    );
    if (!payableGroup?.id || payableGroup.is_group !== true) {
      throw new Error("Inter-Branch Payable chart group is unavailable or has the wrong shape");
    }
    const groupId = Number(payableGroup.id);

    await client.query(
      `INSERT INTO account_ledgers
         (name, type, code, section, parent_id, is_system_group, is_group, is_active, description)
       SELECT 'Inter-Branch Payable Clearing', 'liability', 'STD-BRANCH-TRF',
              'balance_sheet', $1, false, false, true,
              'Shared liability counterpart used to keep each inter-branch document balanced'
        WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = 'STD-BRANCH-TRF')`,
      [groupId],
    );
    const { rows: [clearingRow] } = await client.query(
      `SELECT id, is_group FROM account_ledgers WHERE code = 'STD-BRANCH-TRF'`,
    );
    if (!clearingRow?.id || clearingRow.is_group === true) {
      throw new Error("Inter-Branch Payable Clearing ledger is unavailable or has the wrong shape");
    }
    const clearingLedgerId = Number(clearingRow.id);
    await client.query(
      `UPDATE account_ledgers
          SET name = 'Inter-Branch Payable Clearing',
              type = 'liability',
              section = 'balance_sheet',
              parent_id = $1,
              is_group = false,
              is_system_group = false,
              is_active = true,
              description = 'Shared liability counterpart used to keep each inter-branch document balanced'
        WHERE id = $2`,
      [groupId, clearingLedgerId],
    );

    const { rows: pairs } = await client.query(`
      SELECT DISTINCT
             t.from_type, t.from_id, t.to_type, t.to_id,
             COALESCE(
               from_wh.name, from_out.name,
               CASE WHEN t.from_type = 'headoffice'
                    THEN (SELECT company_name FROM company_settings ORDER BY id LIMIT 1)
                    ELSE t.from_type || ' #' || t.from_id::text END
             ) AS from_name,
             COALESCE(
               to_wh.name, to_out.name,
               CASE WHEN t.to_type = 'headoffice'
                    THEN (SELECT company_name FROM company_settings ORDER BY id LIMIT 1)
                    ELSE t.to_type || ' #' || t.to_id::text END
             ) AS to_name
        FROM stock_transfers t
        LEFT JOIN warehouses from_wh
          ON t.from_type = 'warehouse' AND from_wh.id = t.from_id
        LEFT JOIN outlets from_out
          ON t.from_type = 'outlet' AND from_out.id = t.from_id
        LEFT JOIN warehouses to_wh
          ON t.to_type = 'warehouse' AND to_wh.id = t.to_id
        LEFT JOIN outlets to_out
          ON t.to_type = 'outlet' AND to_out.id = t.to_id
       WHERE t.from_type IS NOT NULL AND t.from_id IS NOT NULL
         AND t.to_type IS NOT NULL AND t.to_id IS NOT NULL
       ORDER BY t.from_type, t.from_id, t.to_type, t.to_id
    `);

    const { rows: legacyRows } = await client.query(
      `SELECT id, code FROM account_ledgers
        WHERE code = ANY($1::text[])
           OR code LIKE 'STD-BRANCH-DR-%'
           OR code LIKE 'STD-BRANCH-CR-%'`,
      [["STD-BRANCH-DEBTOR", "STD-BRANCH-CREDITOR"]],
    );
    const legacyIdByCode = new Map<string, number>(
      legacyRows.map((row: any) => [String(row.code), Number(row.id)]),
    );
    const movedCodes = new Set<string>();

    const moveLedgerBalance = async (
      code: string,
      targetLedgerId: number,
      locationType: string,
      targetLocationId: number,
    ) => {
      const oldLedgerId = legacyIdByCode.get(code);
      if (!oldLedgerId || movedCodes.has(code)) return;
      movedCodes.add(code);
      const { rows: balances } = await client.query(
        `SELECT voucher.voucher_date::text AS date,
                COALESCE(voucher.location_type, 'headoffice') AS location_type,
                COALESCE(voucher.location_id, 0)::int AS location_id,
                COALESCE(SUM(line.debit), 0)::numeric AS debit,
                COALESCE(SUM(line.credit), 0)::numeric AS credit
           FROM journal_voucher_lines AS line
           JOIN journal_vouchers AS voucher ON voucher.id = line.voucher_id
          WHERE line.ledger_id = $1
          GROUP BY voucher.voucher_date, voucher.location_type, voucher.location_id
         HAVING ABS(SUM(line.debit - line.credit)) > 0.004
          ORDER BY voucher.voucher_date, voucher.location_type, voucher.location_id`,
        [oldLedgerId],
      );
      for (const balance of balances) {
        const net = r2(Number(balance.debit ?? 0) - Number(balance.credit ?? 0));
        if (Math.abs(net) <= 0.004) continue;
        await createAdjustmentVoucher({
          client,
          date: dateOnly(balance.date),
          locationType: String(balance.location_type || locationType),
          locationId: Number(balance.location_id ?? targetLocationId),
          amount: Math.abs(net),
          debitLedger: net > 0 ? targetLedgerId : oldLedgerId,
          creditLedger: net > 0 ? oldLedgerId : targetLedgerId,
          narration: `Move legacy inter-branch balance from ${code}`,
        });
        report.balancesMoved++;
      }
    };

    for (const row of pairs) {
      const fromLocation = {
        locationType: String(row.from_type),
        locationId: locationId(String(row.from_type), row.from_id),
      };
      const toLocation = {
        locationType: String(row.to_type),
        locationId: locationId(String(row.to_type), row.to_id),
      };
      if (transferLocationCodePart(fromLocation) === transferLocationCodePart(toLocation)) continue;

      const code = interBranchTransferLedgerCode(fromLocation, toLocation);
      const canonical = canonicalTransferLocationPair(fromLocation, toLocation);
      const firstName = canonical.first === fromLocation ? String(row.from_name) : String(row.to_name);
      const secondName = canonical.second === toLocation ? String(row.to_name) : String(row.from_name);
      await client.query(
        `INSERT INTO account_ledgers
           (name, type, code, section, parent_id, is_system_group, is_group, is_active, description)
         SELECT $1, 'liability', $2, 'balance_sheet', $3, false, false, true, $4
          WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
        [
          `Inter-Branch Payable — ${firstName} ↔ ${secondName}`,
          code,
          groupId,
          `Net bilateral transfer position between ${firstName} and ${secondName}`,
        ],
      );
      const { rows: [pairLedger] } = await client.query(
        `SELECT id, is_group FROM account_ledgers WHERE code = $1`,
        [code],
      );
      if (!pairLedger?.id || pairLedger.is_group === true) {
        throw new Error(`Inter-Branch Payable ledger is unavailable for ${code}`);
      }
      const pairLedgerId = Number(pairLedger.id);
      await client.query(
        `UPDATE account_ledgers
            SET name = $1, type = 'liability', section = 'balance_sheet',
                parent_id = $2, is_group = false, is_system_group = false,
                is_active = true, description = $3
          WHERE id = $4`,
        [
          `Inter-Branch Payable — ${firstName} ↔ ${secondName}`,
          groupId,
          `Net bilateral transfer position between ${firstName} and ${secondName}`,
          pairLedgerId,
        ],
      );

      const roles = transferPairPostingTargets(fromLocation, toLocation);
      const dispatchTarget = roles.dispatch === "pair" ? pairLedgerId : clearingLedgerId;
      const receiveTarget = roles.receive === "pair" ? pairLedgerId : clearingLedgerId;
      await moveLedgerBalance(
        legacyInterBranchTransferLedgerCode("receivable", fromLocation, toLocation),
        dispatchTarget,
        fromLocation.locationType,
        fromLocation.locationId,
      );
      await moveLedgerBalance(
        legacyInterBranchTransferLedgerCode("payable", fromLocation, toLocation),
        receiveTarget,
        toLocation.locationType,
        toLocation.locationId,
      );
      report.pairs++;
    }

    // Generic historical control ledgers and orphaned directed pair ledgers
    // cannot be attributed safely to one pair. Preserve them in the shared
    // liability clearing account before retiring their old chart entries.
    for (const code of ["STD-BRANCH-DEBTOR", "STD-BRANCH-CREDITOR"]) {
      await moveLedgerBalance(code, clearingLedgerId, "headoffice", 0);
    }
    for (const row of legacyRows) {
      const code = String(row.code);
      if (movedCodes.has(code)) continue;
      await moveLedgerBalance(code, clearingLedgerId, "headoffice", 0);
    }

    const { rowCount } = await client.query(
      `UPDATE account_ledgers
          SET name = 'Legacy Inter-Branch Payable — ' || code,
              type = 'liability',
              section = 'balance_sheet',
              parent_id = $1,
              is_group = false,
              is_system_group = false,
              is_active = false,
              description = 'Retired directed or unallocated inter-branch ledger; retained for historical voucher references'
        WHERE code = 'STD-BRANCH-DEBTOR'
           OR code = 'STD-BRANCH-CREDITOR'
           OR code LIKE 'STD-BRANCH-DR-%'
           OR code LIKE 'STD-BRANCH-CR-%'`,
      [groupId],
    );
    report.legacyLedgersRetired = Number(rowCount ?? 0);

    await client.query("COMMIT");
    console.error(`[migration] ${INTERNAL_NET_PAIR_MIGRATION_NAME}: ${JSON.stringify(report)}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(
      `[migration] ${INTERNAL_NET_PAIR_MIGRATION_NAME} FAILED — rolled back; will retry next boot:`,
      error,
    );
    throw error;
  } finally {
    client.release();
  }
}
