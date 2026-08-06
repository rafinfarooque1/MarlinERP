/**
 * The core INSERT(s) for a manual journal-family voucher, extracted from the
 * POST /accounts/journal-vouchers route so callers that already hold a pg
 * client inside an open transaction can create a voucher with the SAME SQL the
 * route runs.
 *
 * This performs only the database writes: allocating a voucher number when the
 * caller supplies none (from the normal sequence allocator, never COUNT(*)),
 * the journal_vouchers row and its journal_voucher_lines rows. Pre-validation
 * (buildVoucherLines, resolveVoucherLocation, permission checks) stays with the
 * caller — this function trusts the lines and location it is handed.
 */
import { nextVoucherNumber } from "./voucherNumber";

/** A queryable/transactional pg handle (pool or PoolClient). */
type Q = { query: Function };

export interface JournalVoucherLineInput {
  ledgerId: number;
  debit: number;
  credit: number;
}

export interface JournalVoucherCoreInput {
  voucherType: string;
  /** When omitted, a number is drawn from the sequence allocator for `voucherType`. */
  voucherNumber?: string | null;
  voucherDate: string;
  narration: string | null;
  partyLedgerId: number | null;
  reason: string | null;
  totalAmount: number;
  createdBy: string;
  locationType: string;
  locationId: number;
  lines: JournalVoucherLineInput[];
}

/**
 * Insert a journal-family voucher and its lines on the given client/queryable.
 * Returns the new voucher's id and the voucher number that was used (whether
 * supplied or allocated). Runs no BEGIN/COMMIT of its own — the caller owns the
 * transaction.
 */
export async function createJournalVoucherCore(
  client: Q,
  input: JournalVoucherCoreInput,
): Promise<{ id: number; voucherNumber: string }> {
  const voucherNumber = input.voucherNumber
    ? input.voucherNumber
    : await nextVoucherNumber(client as any, input.voucherType, input.voucherDate);

  const { rows: [v] } = await client.query(
    `INSERT INTO journal_vouchers
       (voucher_type, voucher_number, voucher_date, narration, party_ledger_id, reason, total_amount, created_by,
        origin, source_module, location_type, location_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', 'accounts', $9, $10) RETURNING id`,
    [input.voucherType, voucherNumber, input.voucherDate, input.narration, input.partyLedgerId, input.reason, input.totalAmount, input.createdBy, input.locationType, input.locationId]
  );
  for (const l of input.lines) {
    await client.query(
      `INSERT INTO journal_voucher_lines (voucher_id, ledger_id, debit, credit) VALUES ($1, $2, $3, $4)`,
      [v.id, l.ledgerId, l.debit, l.credit]
    );
  }
  return { id: v.id, voucherNumber };
}
