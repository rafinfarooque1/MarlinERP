import { nextVoucherNumber } from "./voucherNumber";
import { paymentModeLabel } from "./paymentModes";
import { scopeCashLedgerIds, locationOwnedLedgerMap, ledgerIdsUnderCodes } from "./moneyScope";

type Queryable = { query: (text: string, params?: any[]) => Promise<any> };

/**
 * The ONE sale-collection engine, shared by the two producers of sale money:
 *
 *   · POST /sales/:id/payments — collecting against an existing bill;
 *   · POST /sales — a creation-time payment ("Receive Into" at the counter).
 *
 * Both must resolve the destination account, derive the cash/bank/upi method
 * from it, and write the receipt the same way — a second engine would drift on
 * exactly the details that make the books reconcile (clearing vs direct-post,
 * reconciliation status, location stamping).
 */

export interface ReceiveIntoAccount {
  ledgerId: number;
  name: string;
  /** Derived from the ACCOUNT, never trusted from the client. */
  method: "cash" | "bank" | "upi";
  /** Electronic accounts only: route via STD-ELEC-CLR + pending when true. */
  requiresRecon: boolean;
}

/**
 * Validate an explicitly named "Receive Into" ledger against the SALE's
 * location and derive the collection method from the account itself:
 *  · must be an active ledger backed by (or acting as) a Cash & Bank account;
 *  · must belong to the sale's location — HO gets the company-wide cash+bank
 *    tree minus every branch-owned ledger, a branch gets its own assigned set;
 *  · method: cash account type (or membership of the STD-CASH subtree for
 *    tills) → cash, 'upi' → upi, anything else → bank.
 */
export async function resolveReceiveIntoAccount(
  q: Queryable,
  locType: string,
  locId: number,
  receivedInLedgerId: number,
): Promise<{ error: string } | ReceiveIntoAccount> {
  const { rows: [led] } = await q.query(
    `SELECT al.id, al.name, COALESCE(al.is_active, true) AS is_active,
            cb.account_type, cb.requires_reconciliation
       FROM account_ledgers al
       LEFT JOIN cash_bank_accounts cb ON cb.ledger_id = al.id
      WHERE al.id = $1
      LIMIT 1`,
    [receivedInLedgerId],
  );
  if (!led || led.is_active !== true) {
    return { error: "That Cash & Bank account is not available. Pick an active account." };
  }
  let allowed: Set<number>;
  if (locType === "headoffice") {
    // Head Office's set is the whole cash+bank tree minus every ledger a
    // branch owns (tills and branch-assigned accounts) — the same set the
    // voucher pickers offer for Head Office.
    const tree = await ledgerIdsUnderCodes(["STD-CASH", "STD-BANK"]);
    const owned = await locationOwnedLedgerMap();
    allowed = new Set([...tree].filter((id) => !owned.has(id)));
  } else {
    const scope = locType === "warehouse"
      ? { isHeadOffice: false, warehouseIds: [locId], outletIds: [] }
      : { isHeadOffice: false, warehouseIds: [], outletIds: [locId] };
    allowed = new Set(await scopeCashLedgerIds(scope));
  }
  if (!allowed.has(Number(led.id))) {
    return {
      error: `"${led.name}" does not belong to the location that made this sale. Pick one of that location's own Cash & Bank accounts.`,
    };
  }
  const cashTree = await ledgerIdsUnderCodes(["STD-CASH"]);
  const isCashDest = led.account_type != null
    ? led.account_type === "cash"
    : cashTree.has(Number(led.id));
  const method: "cash" | "bank" | "upi" =
    isCashDest ? "cash" : led.account_type === "upi" ? "upi" : "bank";
  return {
    ledgerId: Number(led.id),
    name: String(led.name),
    method,
    requiresRecon: !isCashDest && led.requires_reconciliation === true,
  };
}

export interface PostCollectionArgs {
  /** cash | bank | upi — derived from the account when one was picked. */
  method: string;
  /** The explicitly picked destination, or null for the legacy method-only path. */
  account: ReceiveIntoAccount | null;
  locType: string;
  locId: number;
  amount: number;
  pDate: string;
  invoiceNumber: string;
  referenceNumber?: string | null;
}

/**
 * Write the accounting receipt for one sale collection. Cash goes into the
 * picked cash account (or the location's own till); electronic money posts
 * straight into the account when reconciliation is off, otherwise into
 * Electronic Payment Clearing with status 'pending' for the reconciliation
 * screen to settle. Runs on the CALLER's transaction client — it commits (or
 * rolls back) with whatever business write it belongs to.
 */
export async function postSaleCollectionReceipt(
  q: Queryable,
  args: PostCollectionArgs,
): Promise<{ error: string } | { clearingReceiptId: number; reconciliationStatus: string | null }> {
  const { method, account, locType, locId, amount, pDate, invoiceNumber, referenceNumber } = args;
  const isElectronic = method !== "cash";

  const { rows: [salesLedger] } = await q.query(
    `SELECT id FROM account_ledgers WHERE code = 'STD-SALES'`,
  );
  if (!salesLedger) return { error: "Sales ledger not configured." };

  if (!isElectronic) {
    // ── CASH ────────────────────────────────────────────────────────────────
    // An explicitly picked cash account (a cash-type Cash & Bank account, or
    // the till itself) wins over the till convention — already validated
    // against the sale's location by resolveReceiveIntoAccount.
    const cashLedgerCode = locType === "warehouse"
      ? `WH-CASH-${locId}`
      : `OUTLET-CASH-${locId}`;
    let cashLedgerId: number | null = account ? account.ledgerId : null;
    if (cashLedgerId == null && locType !== "headoffice") {
      // The location's own cash_ledger_id is authoritative; the code convention
      // is only a fallback (mirror locations share one till whose code can only
      // name one half of the pair).
      const { rows: [locRow] } = await q.query(
        locType === "warehouse"
          ? `SELECT cash_ledger_id FROM warehouses WHERE id = $1`
          : `SELECT cash_ledger_id FROM outlets WHERE id = $1`,
        [locId],
      );
      if (locRow?.cash_ledger_id != null) {
        const { rows } = await q.query(
          `SELECT id FROM account_ledgers WHERE id = $1`, [Number(locRow.cash_ledger_id)],
        );
        if (rows[0]) cashLedgerId = Number(rows[0].id);
      }
      if (cashLedgerId == null) {
        const { rows } = await q.query(
          `SELECT id FROM account_ledgers WHERE code = $1`, [cashLedgerCode],
        );
        if (rows[0]) cashLedgerId = Number(rows[0].id);
      }
    }
    if (cashLedgerId == null && locType === "headoffice") {
      const { rows } = await q.query(`SELECT id FROM account_ledgers WHERE code = 'STD-CASH'`);
      if (rows[0]) cashLedgerId = Number(rows[0].id);
    }
    if (cashLedgerId == null) {
      return { error: `Cash ledger (${cashLedgerCode}) not found for this location. Go to Accounts → Warehouses/Outlets and provision ledgers first.` };
    }

    const voucherNum = await nextVoucherNumber(q as any, "receipt", pDate);
    const { rows: [receipt] } = await q.query(
      `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, location_type, location_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sale') RETURNING id`,
      [voucherNum, pDate, salesLedger.id, cashLedgerId, amount,
        `Cash payment for invoice ${invoiceNumber}`,
        locType, locId],
    );
    return { clearingReceiptId: Number(receipt.id), reconciliationStatus: null };
  }

  // ── ELECTRONIC ────────────────────────────────────────────────────────────
  // Route the money by the location's OWN account assignment (or the picked
  // account outright):
  //   · account, reconciliation OFF → post straight into that ledger;
  //   · account, reconciliation ON  → Electronic Clearing + pending;
  //   · no account at all → the legacy company-wide clearing flow, unchanged.
  // HO sales match HO-assigned accounts on TYPE alone: cash_bank_accounts
  // stores headoffice with a NULL id while sales use the placeholder id 1
  // (ho-location-convention).
  const wantType = method === "upi" ? "upi" : "bank";
  const { rows: [assigned] } = account
    ? { rows: [{ ledger_id: account.ledgerId, requires_reconciliation: account.requiresRecon, name: account.name }] }
    : await q.query(
        `SELECT cb.ledger_id, cb.requires_reconciliation, cb.name
           FROM cash_bank_accounts cb
           JOIN account_ledgers al ON al.id = cb.ledger_id AND COALESCE(al.is_active, true)
          WHERE cb.account_type = $1 AND cb.ledger_id IS NOT NULL
            AND cb.location_type = $2
            AND (cb.location_type = 'headoffice' OR cb.location_id = $3)
          ORDER BY cb.id LIMIT 1`,
        [wantType, locType, locId],
      );
  const directLedgerId = assigned && assigned.requires_reconciliation !== true
    ? Number(assigned.ledger_id) : null;

  let receiveInLedgerId: number;
  if (directLedgerId != null) {
    receiveInLedgerId = directLedgerId;
  } else {
    const { rows: [clearingLedger] } = await q.query(
      `SELECT id FROM account_ledgers WHERE code = 'STD-ELEC-CLR'`,
    );
    if (!clearingLedger) return { error: "Electronic payment clearing ledger not configured." };
    receiveInLedgerId = Number(clearingLedger.id);
  }

  const voucherNum = await nextVoucherNumber(q as any, "receipt", pDate);
  const { rows: [receipt] } = await q.query(
    `INSERT INTO receipts (voucher_number, receipt_date, received_from_ledger_id, received_in_ledger_id, amount, narration, location_type, location_id, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sale') RETURNING id`,
    [voucherNum, pDate, salesLedger.id, receiveInLedgerId, amount,
      `${paymentModeLabel(method)} payment for invoice ${invoiceNumber}${directLedgerId != null ? ` into ${assigned.name}` : ""}${referenceNumber ? ` — Ref: ${referenceNumber}` : ""}`,
      locType, locId],
  );
  // Direct-posted money is already in the bank — nothing left to reconcile,
  // so it must never appear on the pending list.
  return { clearingReceiptId: Number(receipt.id), reconciliationStatus: directLedgerId != null ? null : "pending" };
}
