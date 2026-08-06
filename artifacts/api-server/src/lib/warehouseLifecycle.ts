import { pool as dbPool } from "@workspace/db";
import { rentLedgerIdsFor } from "./rentLedgers";
import { sweepOrphanPartyLedgers } from "../migrations/orphanPartyLedgers";
import { stockValuation } from "./valuation";

export type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const WAREHOUSE_DISABLED_CODE = "WAREHOUSE_DISABLED";

type LocRef = { type?: string | null | undefined; id?: number | string | null | undefined };

/**
 * Central lifecycle gate for every transaction producer. Returns a
 * user-facing error message when any of the given locations is (or belongs
 * to) a disabled warehouse, else null.
 *
 * Guard the EFFECTIVE location — callers must pass the resolved stamp, not
 * the raw request body. Outlets inherit their parent warehouse's state: a
 * disabled warehouse takes its children out of service with it.
 */
export async function disabledWarehouseError(c: Queryable, locs: LocRef[]): Promise<string | null> {
  const whIds: number[] = [];
  const outletIds: number[] = [];
  for (const l of locs) {
    const id = Number(l?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (l?.type === "warehouse") whIds.push(id);
    else if (l?.type === "outlet") outletIds.push(id);
  }
  if (whIds.length === 0 && outletIds.length === 0) return null;
  const { rows } = await c.query(
    `SELECT w.name FROM warehouses w
      WHERE w.disabled_at IS NOT NULL
        AND (w.id = ANY($1::int[])
         OR w.id IN (SELECT warehouse_id FROM outlets WHERE id = ANY($2::int[])))`,
    [whIds, outletIds],
  );
  if (rows.length === 0) return null;
  const names = rows.map((r: { name: string }) => `"${r.name}"`).join(", ");
  return `${names} is disabled. New transactions are blocked; historical data stays available. Re-enable the warehouse under Head Office → Warehouses to record new entries.`;
}

/** The exact confirmation phrase the administrator must type. */
export function deleteConfirmationPhrase(warehouseName: string): string {
  return `DELETE ${warehouseName}`;
}

// ── Blockers ────────────────────────────────────────────────────────────────
// Data whose removal would corrupt OTHER locations' books or someone else's
// history can never be cascaded away. These force "Disable" instead.

export async function warehouseDeleteBlockers(c: Queryable, id: number): Promise<string[]> {
  const blockers: string[] = [];
  const one = async (sql: string, params: unknown[] = [id]): Promise<number> => {
    const { rows: [r] } = await c.query(sql, params);
    return Number(r?.count ?? 0);
  };

  const outlets = await one(`SELECT COUNT(*) AS count FROM outlets WHERE warehouse_id = $1`);
  if (outlets > 0) blockers.push(`${outlets} outlet(s) are attached to this warehouse. Their records depend on it.`);

  // A transfer always has a second location on the other end — deleting this
  // side would corrupt the counterparty's stock and books.
  const transfers = await one(
    `SELECT COUNT(*) AS count FROM stock_transfers
      WHERE (from_type = 'warehouse' AND from_id = $1) OR (to_type = 'warehouse' AND to_id = $1)`);
  if (transfers > 0) blockers.push(`${transfers} stock transfer(s) connect this warehouse with other locations. Deleting them would corrupt the other location's records.`);

  const employees = await one(
    `SELECT COUNT(*) AS count FROM employees WHERE branch_type = 'warehouse' AND branch_id = $1`);
  if (employees > 0) blockers.push(`${employees} employee(s) are assigned to this warehouse. Reassign them under HR → Employees first.`);

  const assets = await one(
    `SELECT COUNT(*) AS count FROM asset_purchases
      WHERE (location_type = 'warehouse' AND location_id = $1)
         OR (current_location_type = 'warehouse' AND current_location_id = $1)`);
  if (assets > 0) blockers.push(`${assets} asset record(s) were purchased at or are located at this warehouse. Transfer or dispose of them first.`);

  const deposits = await one(
    `SELECT COUNT(*) AS count FROM cash_deposits WHERE warehouse_id = $1`);
  if (deposits > 0) blockers.push(`${deposits} cash deposit(s) moved money from this warehouse's till to the bank. Deleting them would misstate the company bank book.`);

  const imports = await one(
    `SELECT (SELECT COUNT(*) FROM import_batches WHERE location_type = 'warehouse' AND location_id = $1)
          + (SELECT COUNT(*) FROM import_migrations WHERE location_type = 'warehouse' AND location_id = $1) AS count`);
  if (imports > 0) blockers.push(`Imported data targets this warehouse. Remove those imports from Company → Import Data → History first — that also cleans up their records safely.`);

  // A warehouse converted from an outlet may share ledgers with a still-live
  // outlet row (mirror locations). Never cascade a shared ledger away.
  const shared = await one(
    `SELECT COUNT(*) AS count FROM outlets o
      WHERE o.cash_ledger_id IN (SELECT cash_ledger_id FROM warehouses WHERE id = $1 AND cash_ledger_id IS NOT NULL)
         OR o.sales_ledger_id IN (SELECT sales_ledger_id FROM warehouses WHERE id = $1 AND sales_ledger_id IS NOT NULL)`);
  if (shared > 0) blockers.push(`This warehouse shares its cash/sales ledgers with an outlet (it was converted from one). Deleting it would break that outlet's books.`);

  return blockers;
}

// ── Delete summary ──────────────────────────────────────────────────────────

export interface WarehouseDeleteSummary {
  warehouse: { id: number; name: string; disabledAt: string | null };
  confirmationPhrase: string;
  counts: {
    sales: number; purchases: number; quotations: number; productions: number;
    receipts: number; payments: number; journalVouchers: number; expenses: number;
    salesReturns: number; purchaseReturns: number;
    customers: number; vendors: number;
    ledgerEntries: number;
    inventoryItems: number; stockValue: number;
    cashAccounts: number; bankAccounts: number;
    rentRecords: number;
  };
  blockers: string[];
  hasTransactions: boolean;
}

export async function warehouseDeleteSummary(c: Queryable, id: number): Promise<WarehouseDeleteSummary | null> {
  const { rows: [wh] } = await c.query(
    `SELECT id, name, disabled_at FROM warehouses WHERE id = $1`, [id]);
  if (!wh) return null;

  const one = async (sql: string): Promise<number> => {
    const { rows: [r] } = await c.query(sql, [id]);
    return Number(r?.count ?? 0);
  };
  const atLoc = (table: string) =>
    one(`SELECT COUNT(*) AS count FROM ${table} WHERE location_type = 'warehouse' AND location_id = $1`);

  const [sales, purchases, quotations, productions, receipts, payments, journalVouchers, expenses, salesReturns] =
    await Promise.all([
      atLoc("sales"), atLoc("purchases"), atLoc("quotations"), atLoc("productions"),
      atLoc("receipts"), atLoc("payments"), atLoc("journal_vouchers"), atLoc("expenses"), atLoc("sales_returns"),
    ]);
  const [purchaseReturns, customers, vendors, jvLines, inventoryItems, cba, rentRecords] = await Promise.all([
    one(`SELECT COUNT(*) AS count FROM purchase_returns pr
          WHERE pr.purchase_id IN (SELECT id FROM purchases WHERE location_type = 'warehouse' AND location_id = $1)`),
    atLoc("customers"), atLoc("vendors"),
    one(`SELECT COUNT(*) AS count FROM journal_voucher_lines l
          WHERE l.voucher_id IN (SELECT id FROM journal_vouchers WHERE location_type = 'warehouse' AND location_id = $1)`),
    one(`SELECT COUNT(*) AS count FROM stock_entries WHERE branch_type = 'warehouse' AND branch_id = $1 AND quantity::numeric <> 0`),
    one(`SELECT COUNT(*) FILTER (WHERE account_type = 'cash') AS count FROM cash_bank_accounts WHERE location_type = 'warehouse' AND location_id = $1`),
    one(`SELECT (SELECT COUNT(*) FROM rent_accruals WHERE warehouse_id = $1)
             + (SELECT COUNT(*) FROM rent_payments WHERE warehouse_id = $1) AS count`),
  ]);
  const bankAccounts = await one(
    `SELECT COUNT(*) FILTER (WHERE account_type <> 'cash') AS count FROM cash_bank_accounts WHERE location_type = 'warehouse' AND location_id = $1`);

  // Money documents derive two postings each; JV lines are stored directly.
  const ledgerEntries = jvLines + 2 * (sales + purchases + receipts + payments + expenses);

  let stockValue = 0;
  try {
    const val = await stockValuation(c as any, { branchType: "warehouse", branchId: id });
    stockValue = Math.round((val.onHandValue ?? 0) * 100) / 100;
  } catch { /* valuation is informational — never block the summary on it */ }

  const blockers = await warehouseDeleteBlockers(c, id);
  const counts = {
    sales, purchases, quotations, productions, receipts, payments, journalVouchers,
    expenses, salesReturns, purchaseReturns, customers, vendors, ledgerEntries,
    inventoryItems, stockValue,
    cashAccounts: cba + 1 /* the warehouse's own cash ledger */,
    bankAccounts, rentRecords,
  };
  const hasTransactions =
    sales + purchases + quotations + productions + receipts + payments +
    journalVouchers + expenses + salesReturns + purchaseReturns + inventoryItems + rentRecords > 0;

  return {
    warehouse: { id: wh.id, name: wh.name, disabledAt: wh.disabled_at ? new Date(wh.disabled_at).toISOString() : null },
    confirmationPhrase: deleteConfirmationPhrase(wh.name),
    counts, blockers, hasTransactions,
  };
}

// ── Permanent delete ────────────────────────────────────────────────────────

const LOCATION_STAMPED_TABLES = [
  "sales", "purchases", "quotations", "productions", "receipts", "payments",
  "journal_vouchers", "expenses", "sales_returns", "customers", "vendors",
  "cash_bank_accounts",
] as const;

type DeleteResult =
  | { ok: true; deleted: Record<string, number> }
  | { ok: false; status: number; error: string; failures?: string[] };

/**
 * All-or-nothing removal of a warehouse and every record in its books.
 * Runs in ONE transaction; after deleting, it re-verifies that nothing
 * scoped to the warehouse survived and that the books still balance.
 * Any failed check rolls the whole thing back — nothing is deleted.
 */
export async function permanentlyDeleteWarehouse(
  pool: typeof dbPool,
  args: { id: number; confirmation: string },
): Promise<DeleteResult> {
  const { id } = args;
  const client = await pool.connect();
  const deleted: Record<string, number> = {};
  const del = async (label: string, sql: string, params: unknown[]): Promise<void> => {
    const r = await client.query(sql, params);
    deleted[label] = (deleted[label] ?? 0) + (r.rowCount ?? 0);
  };
  try {
    await client.query("BEGIN");
    // One warehouse delete at a time, and serialized against importers.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('warehouse-permanent-delete'))`);

    const { rows: [wh] } = await client.query<{
      id: number; name: string;
      cash_ledger_id: number | null; sales_ledger_id: number | null; purchase_ledger_id: number | null;
    }>(`SELECT id, name, cash_ledger_id, sales_ledger_id, purchase_ledger_id
          FROM warehouses WHERE id = $1 FOR UPDATE`, [id]);
    if (!wh) { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "Warehouse not found" }; }

    if (String(args.confirmation ?? "") !== deleteConfirmationPhrase(wh.name)) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, error: `Confirmation text does not match. Type exactly: ${deleteConfirmationPhrase(wh.name)}` };
    }

    // Blockers re-checked INSIDE the transaction — the pre-flight summary the
    // client saw may be stale by the time the administrator confirms.
    const blockers = await warehouseDeleteBlockers(client, id);
    if (blockers.length > 0) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, error: "This warehouse cannot be permanently deleted. The recommended action is to disable it instead.", failures: blockers };
    }

    // ── Collect id sets ────────────────────────────────────────────────────
    const idsOf = async (sql: string): Promise<number[]> =>
      (await client.query<{ id: number }>(sql, [id])).rows.map((r: { id: number }) => Number(r.id));
    const saleIds = await idsOf(`SELECT id FROM sales WHERE location_type = 'warehouse' AND location_id = $1`);
    const purchIds = await idsOf(`SELECT id FROM purchases WHERE location_type = 'warehouse' AND location_id = $1`);
    const payIds = await idsOf(`SELECT id FROM payments WHERE location_type = 'warehouse' AND location_id = $1`);
    const receiptIds = (await client.query<{ id: number }>(
      `SELECT id FROM receipts WHERE location_type = 'warehouse' AND location_id = $1
       UNION
       SELECT sp.clearing_receipt_id AS id FROM sale_payments sp
        WHERE sp.clearing_receipt_id IS NOT NULL AND sp.sale_id = ANY($2::int[])`,
      [id, saleIds],
    )).rows.map((r: { id: number }) => Number(r.id));

    // Ledgers owned by this warehouse: its own three, rent ledgers, and any
    // cash/bank account ledgers stamped here.
    const rentLedgers = await rentLedgerIdsFor(client as any, id);
    const cbaLedgers = (await client.query<{ ledger_id: number | null }>(
      `SELECT ledger_id FROM cash_bank_accounts WHERE location_type = 'warehouse' AND location_id = $1`, [id],
    )).rows.map((r: { ledger_id: number | null }) => r.ledger_id).filter((x: number | null): x is number => x != null);
    const ownLedgerIds = [wh.cash_ledger_id, wh.sales_ledger_id, wh.purchase_ledger_id, ...rentLedgers, ...cbaLedgers]
      .filter((x): x is number => x != null);

    // ── Cascade, children first ────────────────────────────────────────────
    await del("quotationShareLinks",
      `DELETE FROM quotation_share_links WHERE quotation_id IN
         (SELECT id FROM quotations WHERE location_type = 'warehouse' AND location_id = $1)`, [id]);
    // A quotation elsewhere may point at a sale being removed — unlink, don't strand.
    await client.query(
      `UPDATE quotations SET converted_sale_id = NULL, converted_invoice_number = NULL
        WHERE converted_sale_id = ANY($1::int[])`, [saleIds]);
    await del("quotations",
      `DELETE FROM quotations WHERE location_type = 'warehouse' AND location_id = $1`, [id]);

    await del("salesReturns",
      `DELETE FROM sales_returns WHERE (location_type = 'warehouse' AND location_id = $1) OR sale_id = ANY($2::int[])`,
      [id, saleIds]);
    await del("advanceConsumptions",
      `DELETE FROM advance_consumptions
        WHERE consumer_sale_id = ANY($1::int[]) OR consumer_purchase_id = ANY($2::int[])
           OR source_receipt_id = ANY($3::int[]) OR source_payment_id = ANY($4::int[])`,
      [saleIds, purchIds, receiptIds, payIds]);
    await del("invoiceShareLinks",
      `DELETE FROM invoice_share_links WHERE sale_id = ANY($1::int[])`, [saleIds]);
    await del("salePayments",
      `DELETE FROM sale_payments WHERE sale_id = ANY($1::int[]) OR clearing_receipt_id = ANY($2::int[])`,
      [saleIds, receiptIds]);
    await del("paymentBillAllocations",
      `DELETE FROM payment_bill_allocations WHERE payment_id = ANY($1::int[]) OR purchase_id = ANY($2::int[])`,
      [payIds, purchIds]);
    await del("purchaseAdvanceApplications",
      `DELETE FROM purchase_advance_applications WHERE purchase_id = ANY($1::int[])`, [purchIds]);
    await del("purchaseReturns",
      `DELETE FROM purchase_returns WHERE purchase_id = ANY($1::int[])`, [purchIds]);
    await del("reconciliationItems",
      `DELETE FROM reconciliation_batch_items WHERE sale_payment_id NOT IN (SELECT id FROM sale_payments)`, []);
    await del("receipts", `DELETE FROM receipts WHERE id = ANY($1::int[])`, [receiptIds]);
    await del("payments", `DELETE FROM payments WHERE id = ANY($1::int[])`, [payIds]);
    await del("sales", `DELETE FROM sales WHERE id = ANY($1::int[])`, [saleIds]);
    await del("purchases", `DELETE FROM purchases WHERE id = ANY($1::int[])`, [purchIds]);
    await del("productions",
      `DELETE FROM productions WHERE location_type = 'warehouse' AND location_id = $1`, [id]);
    await del("expenses",
      `DELETE FROM expenses WHERE location_type = 'warehouse' AND location_id = $1`, [id]);

    await del("journalVoucherLines",
      `DELETE FROM journal_voucher_lines WHERE voucher_id IN
         (SELECT id FROM journal_vouchers WHERE location_type = 'warehouse' AND location_id = $1)`, [id]);
    await del("journalVouchers",
      `DELETE FROM journal_vouchers WHERE location_type = 'warehouse' AND location_id = $1`, [id]);

    for (const t of ["rent_payments", "rent_accruals", "rent_periods", "warehouse_rent_agreements"]) {
      await del(t, `DELETE FROM ${t} WHERE warehouse_id = $1`, [id]);
    }
    await del("itemPrices",
      `DELETE FROM item_prices WHERE location_type = 'warehouse' AND outlet_id = $1`, [id]);

    for (const t of ["stock_ledger", "stock_batches", "stock_reservations", "stock_verifications", "stock_entries"]) {
      await del(t, `DELETE FROM ${t} WHERE branch_type = 'warehouse' AND branch_id = $1`, [id]);
    }

    await del("cashBankAccounts",
      `DELETE FROM cash_bank_accounts WHERE location_type = 'warehouse' AND location_id = $1`, [id]);
    await del("locationMigrationMap",
      `DELETE FROM location_migration_map WHERE new_type = 'warehouse' AND new_id = $1`, [id]);

    // ── Parties stamped to this warehouse ──────────────────────────────────
    // Unused anywhere else → deleted; still referenced by other locations'
    // documents or ledger legs → kept, moved to the unassigned (Head Office)
    // pool so no invisible location keeps them.
    await del("customers",
      `DELETE FROM customers c
        WHERE c.location_type = 'warehouse' AND c.location_id = $1
          AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM quotations q WHERE q.customer_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.customer_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM advance_consumptions ac WHERE ac.party_kind = 'customer' AND ac.party_id = c.id)
          AND NOT EXISTS (
            SELECT 1 FROM account_ledgers al
             WHERE al.code IN ('CUST-' || c.id, 'CADV-' || c.id)
               AND (EXISTS (SELECT 1 FROM journal_voucher_lines l WHERE l.ledger_id = al.id)
                 OR EXISTS (SELECT 1 FROM receipts r2 WHERE r2.received_from_ledger_id = al.id OR r2.received_in_ledger_id = al.id OR r2.advance_ledger_id = al.id)
                 OR EXISTS (SELECT 1 FROM payments p2 WHERE p2.paid_from_ledger_id = al.id OR p2.paid_to_ledger_id = al.id OR p2.advance_ledger_id = al.id)
                 OR EXISTS (SELECT 1 FROM expenses e2 WHERE e2.ledger_account_id = al.id)))`,
      [id]);
    await del("customersMovedToHeadOffice",
      `UPDATE customers SET location_type = NULL, location_id = NULL
        WHERE location_type = 'warehouse' AND location_id = $1`, [id]);
    await del("vendors",
      `DELETE FROM vendors v
        WHERE v.location_type = 'warehouse' AND v.location_id = $1
          AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.vendor_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM purchase_returns pr WHERE pr.vendor_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM purchase_advance_applications pa WHERE pa.vendor_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM asset_purchases ap WHERE ap.vendor_id = v.id)
          AND NOT EXISTS (SELECT 1 FROM advance_consumptions ac WHERE ac.party_kind = 'vendor' AND ac.party_id = v.id)
          AND NOT EXISTS (
            SELECT 1 FROM account_ledgers al
             WHERE al.code IN ('VEND-' || v.id, 'VADV-' || v.id)
               AND (EXISTS (SELECT 1 FROM journal_voucher_lines l WHERE l.ledger_id = al.id)
                 OR EXISTS (SELECT 1 FROM receipts r2 WHERE r2.received_from_ledger_id = al.id OR r2.received_in_ledger_id = al.id OR r2.advance_ledger_id = al.id)
                 OR EXISTS (SELECT 1 FROM payments p2 WHERE p2.paid_from_ledger_id = al.id OR p2.paid_to_ledger_id = al.id OR p2.advance_ledger_id = al.id)
                 OR EXISTS (SELECT 1 FROM expenses e2 WHERE e2.ledger_account_id = al.id)))`,
      [id]);
    await del("vendorsMovedToHeadOffice",
      `UPDATE vendors SET location_type = NULL, location_id = NULL
        WHERE location_type = 'warehouse' AND location_id = $1`, [id]);

    // Party ledgers whose masters just went away — same sweep the boot runs.
    try { await sweepOrphanPartyLedgers(client as any); } catch { /* boot sweep re-heals */ }

    // ── The warehouse's own ledgers ────────────────────────────────────────
    await del("openingBalances",
      `DELETE FROM opening_balances WHERE ledger_id = ANY($1::int[])`, [ownLedgerIds]);
    // Only ledgers nothing references any more may go; survivors fail validation.
    await del("accountLedgers",
      `DELETE FROM account_ledgers al WHERE al.id = ANY($1::int[])
        AND NOT EXISTS (SELECT 1 FROM journal_voucher_lines l WHERE l.ledger_id = al.id)
        AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.received_from_ledger_id = al.id OR r.received_in_ledger_id = al.id OR r.advance_ledger_id = al.id)
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.paid_from_ledger_id = al.id OR p.paid_to_ledger_id = al.id OR p.advance_ledger_id = al.id)
        AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.ledger_account_id = al.id)
        AND NOT EXISTS (SELECT 1 FROM account_ledgers ch WHERE ch.parent_id = al.id)`,
      [ownLedgerIds]);

    await del("warehouse", `DELETE FROM warehouses WHERE id = $1`, [id]);

    // ── Post-delete validation — every check must pass or NOTHING happened ──
    const failures: string[] = [];
    for (const t of LOCATION_STAMPED_TABLES) {
      const { rows: [r] } = await client.query(
        `SELECT COUNT(*) AS count FROM ${t} WHERE location_type = 'warehouse' AND location_id = $1`, [id]);
      if (Number(r.count) > 0) failures.push(`${r.count} record(s) in ${t} still reference the warehouse`);
    }
    for (const t of ["stock_entries", "stock_ledger", "stock_batches", "stock_reservations", "stock_verifications"]) {
      const { rows: [r] } = await client.query(
        `SELECT COUNT(*) AS count FROM ${t} WHERE branch_type = 'warehouse' AND branch_id = $1`, [id]);
      if (Number(r.count) > 0) failures.push(`${r.count} stock record(s) in ${t} still reference the warehouse`);
    }
    const { rows: [lref] } = await client.query(
      `SELECT COUNT(*) AS count FROM account_ledgers WHERE id = ANY($1::int[])`, [ownLedgerIds]);
    if (Number(lref.count) > 0) failures.push(`${lref.count} of the warehouse's ledgers still carry postings from other locations`);
    const { rows: [tb] } = await client.query(
      `SELECT COALESCE(SUM(debit), 0) AS d, COALESCE(SUM(credit), 0) AS c FROM journal_voucher_lines`);
    if (Math.abs(Number(tb.d) - Number(tb.c)) > 0.005) failures.push(`Trial balance no longer balances (Dr ${tb.d} vs Cr ${tb.c})`);
    const { rows: [orphanJvl] } = await client.query(
      `SELECT COUNT(*) AS count FROM journal_voucher_lines l
        WHERE NOT EXISTS (SELECT 1 FROM account_ledgers al WHERE al.id = l.ledger_id)`);
    if (Number(orphanJvl.count) > 0) failures.push(`${orphanJvl.count} ledger posting(s) would be orphaned`);

    if (failures.length > 0) {
      await client.query("ROLLBACK");
      return {
        ok: false, status: 409,
        error: "Integrity validation failed after the trial deletion, so NOTHING was deleted. The recommended action is to disable the warehouse instead.",
        failures,
      };
    }

    await client.query("COMMIT");
    return { ok: true, deleted };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  } finally {
    client.release();
  }
}
