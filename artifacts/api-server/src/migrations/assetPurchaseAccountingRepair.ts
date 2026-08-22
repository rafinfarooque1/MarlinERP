/**
 * Repairs the original fixed-asset posting rollout without inventing history.
 *
 * A purchase is repairable only when its source row gives us an unambiguous
 * location and payment leg, and an existing voucher is either fully correct or
 * has no lines at all. Partially populated or contradictory vouchers are
 * reported for manual review instead of being rewritten.
 */
import type { PgPool as Pool } from "@workspace/db";
import { nextVoucherNumber } from "../lib/voucherNumber";
import { FIXED_ASSET_LEDGER_CODE } from "./fixedAssets";

const MIGRATION_NAME = "asset_purchase_accounting_repair_v1";
const r2 = (n: number) => Math.round(n * 100) / 100;
const validTypes = new Set(["headoffice", "warehouse", "outlet"]);

type Report = { scanned: number; correct: number; repaired: number; skipped: number; review: number };

function locationFrom(row: any): { type: string; id: number } | null {
  const type = String(row.location_type ?? "");
  if (!validTypes.has(type)) return null;
  if (type === "headoffice") return { type, id: 0 };
  const id = Number(row.location_id);
  return Number.isInteger(id) && id > 0 ? { type, id } : null;
}

function expectedFundingCode(row: any): string | null {
  const mode = String(row.payment_mode ?? (row.vendor_id != null ? "credit" : "cash"));
  if (mode === "credit") {
    const vendorId = Number(row.vendor_id);
    return Number.isInteger(vendorId) && vendorId > 0 ? `VEND-${vendorId}` : null;
  }
  if (mode === "cash") return "STD-CASH";
  if (mode === "bank" || mode === "upi") return "STD-BANK";
  return null;
}

function linesMatch(lines: any[], fixedId: number, fundingId: number, amount: number): boolean {
  if (lines.length !== 2) return false;
  const debit = lines.find((l) => Number(l.ledger_id) === fixedId);
  const credit = lines.find((l) => Number(l.ledger_id) === fundingId);
  return !!debit && !!credit
    && Number(debit.debit) === amount && Number(debit.credit) === 0
    && Number(credit.debit) === 0 && Number(credit.credit) === amount;
}

/**
 * One-shot, marker-first repair. The marker and all changes share one
 * transaction, so a failed boot cannot leave a half-applied repair.
 */
export async function repairAssetPurchaseAccounting(pool: Pool): Promise<void> {
  const client = await pool.connect();
  const report: Report = { scanned: 0, correct: 0, repaired: 0, skipped: 0, review: 0 };
  try {
    await client.query("BEGIN");
    const { rowCount: claimed } = await client.query(
      `INSERT INTO migration_log (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [MIGRATION_NAME],
    );
    if (!claimed) {
      await client.query("ROLLBACK");
      return;
    }

    const { rows: purchases } = await client.query(`
      SELECT ap.*, jv.id AS voucher_id, jv.voucher_number, jv.voucher_date,
             jv.total_amount AS voucher_total, jv.origin, jv.source_module,
             jv.location_type AS voucher_location_type,
             jv.location_id AS voucher_location_id
        FROM asset_purchases ap
        LEFT JOIN journal_vouchers jv ON jv.id = ap.journal_voucher_id
       ORDER BY ap.id
       FOR UPDATE OF ap
    `);
    const { rows: fixedRows } = await client.query(
      `SELECT id FROM account_ledgers WHERE code = $1 LIMIT 1`, [FIXED_ASSET_LEDGER_CODE],
    );
    const fixedId = fixedRows[0] ? Number(fixedRows[0].id) : null;

    for (const purchase of purchases) {
      report.scanned++;
      const amount = r2(Number(purchase.total_cost ?? Number(purchase.quantity) * Number(purchase.acquisition_cost)));
      if (!(amount > 0.004)) {
        report.correct++;
        continue;
      }
      const loc = locationFrom(purchase);
      const fundingCode = expectedFundingCode(purchase);
      if (!loc || !fundingCode || fixedId == null) {
        report.review++;
        console.warn(`[migration] ${MIGRATION_NAME}: manual review purchase ${purchase.id} (ambiguous source or ledger)`);
        continue;
      }
      const { rows: fundingRows } = await client.query(
        `SELECT id, is_group, is_active FROM account_ledgers WHERE code = $1 LIMIT 1`, [fundingCode],
      );
      const fundingId = fundingRows[0] ? Number(fundingRows[0].id) : null;
      if (fundingId == null || fundingRows[0].is_group === true || fundingRows[0].is_active === false) {
        report.review++;
        console.warn(`[migration] ${MIGRATION_NAME}: manual review purchase ${purchase.id} (${fundingCode} unavailable)`);
        continue;
      }

      let voucher = purchase.voucher_id ? Number(purchase.voucher_id) : null;
      if (voucher != null) {
        await client.query(`SELECT id FROM journal_vouchers WHERE id = $1 FOR UPDATE`, [voucher]);
      }
      let lines: any[] = [];
      if (voucher != null) {
        const lineResult = await client.query(
          `SELECT ledger_id, debit::numeric AS debit, credit::numeric AS credit
             FROM journal_voucher_lines WHERE voucher_id = $1 ORDER BY id`, [voucher],
        );
        lines = lineResult.rows;
      }

      if (voucher == null) {
        const number = await nextVoucherNumber(client, "journal", String(purchase.purchase_date).slice(0, 10));
        const { rows: [created] } = await client.query(
          `INSERT INTO journal_vouchers
             (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, total_amount,
              created_by, origin, source_module, location_type, location_id)
           VALUES ('journal', $1, $2, $3, $4, $5, 'system', 'system', 'fixed_asset', $6, $7)
           RETURNING id`,
          [number, purchase.purchase_date,
           `Asset purchase repair — ${purchase.asset_code ?? `#${purchase.id}`}`,
           fundingCode.startsWith("VEND-") ? fundingId : null, amount, loc.type, loc.id],
        );
        voucher = Number(created.id);
        await client.query(
          `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
           VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
          [voucher, fixedId, amount, fundingId],
        );
        await client.query(`UPDATE asset_purchases SET journal_voucher_id = $1 WHERE id = $2`, [voucher, purchase.id]);
        report.repaired++;
        continue;
      }

      const currentLocation = purchase.voucher_location_type == null
        ? null
        : { type: String(purchase.voucher_location_type), id: Number(purchase.voucher_location_id ?? 0) };
      const noLines = lines.length === 0;
      if (noLines) {
        await client.query(
          `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit)
           VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
          [voucher, fixedId, amount, fundingId],
        );
        await client.query(
          `UPDATE journal_vouchers
              SET total_amount = $1, party_ledger_id = $2,
                  source_module = COALESCE(source_module, 'fixed_asset'),
                  origin = COALESCE(origin, 'system'),
                  location_type = $3, location_id = $4
            WHERE id = $5`,
          [amount, fundingCode.startsWith("VEND-") ? fundingId : null, loc.type, loc.id, voucher],
        );
        await client.query(`UPDATE asset_purchases SET journal_voucher_id = $1 WHERE id = $2`, [voucher, purchase.id]);
        report.repaired++;
      } else if (!linesMatch(lines, fixedId, fundingId, amount)) {
        report.review++;
        console.warn(`[migration] ${MIGRATION_NAME}: manual review purchase ${purchase.id} (voucher ${voucher} has contradictory lines)`);
      } else if (currentLocation == null) {
        await client.query(
          `UPDATE journal_vouchers SET location_type = $1, location_id = $2 WHERE id = $3`,
          [loc.type, loc.id, voucher],
        );
        report.repaired++;
      } else if (currentLocation.type !== loc.type || currentLocation.id !== loc.id) {
        report.review++;
        console.warn(`[migration] ${MIGRATION_NAME}: manual review purchase ${purchase.id} (voucher location differs)`);
      } else {
        report.correct++;
      }
    }

    await client.query("COMMIT");
    console.log(`[migration] ${MIGRATION_NAME}: ${JSON.stringify(report)}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[migration] ${MIGRATION_NAME} FAILED — rolled back; will retry next boot:`, error);
  } finally {
    client.release();
  }
}