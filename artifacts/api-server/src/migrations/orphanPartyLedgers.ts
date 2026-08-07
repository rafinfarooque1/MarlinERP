import type { PgPool } from "@workspace/db";

/**
 * Self-healing sweep for orphaned party ledgers.
 *
 * Every customer/vendor master auto-provisions a ledger in account_ledgers
 * (code CUST-<id> / VEND-<id>), and paying a vendor beyond their bills
 * provisions a second one (VADV-<id>; customers keep ONE ledger — their
 * advance is its credit balance). The normal DELETE routes remove the
 * party ledger with the master (though NOT the vendor advance ledger — this
 * sweep is what reaps those), but a row deleted straight in the database leaves
 * its ledger behind — and because voucher entry, receipts and payments build
 * their party pickers from the chart of accounts (/accounts/chart/flat),
 * the "deleted" party keeps appearing in dropdowns. That is exactly what
 * happened in production on 2026-08-01: eleven parties were entered as
 * vendors, hand-deleted from the vendors table, and re-entered as customers;
 * their eleven VEND-* ledgers stayed visible in every ledger picker.
 *
 * Runs on EVERY boot (idempotent, cheap): future manual deletions heal on
 * the next restart instead of needing another one-off migration.
 *
 * Concurrency: safe against in-flight party creation. This runs before the
 * port opens (no in-process requests), and the creation routes commit the
 * MASTER first, then insert the ledger afterwards — so a ledger whose master
 * is invisible to this sweep's snapshot is genuinely orphaned, never a
 * half-created party from another instance during a rolling deploy. (The
 * reverse transient — master without ledger — is ignored here by design.)
 *
 * Disposition per orphan:
 *  - ZERO references anywhere → DELETE the ledger outright.
 *  - Referenced by any voucher/receipt/payment/expense/opening balance →
 *    NEVER delete (postings would lose their name and the books their
 *    classification); set is_active = false instead, which hides it from
 *    the dropdown feeds (they filter on COALESCE(is_active, true)) while
 *    history keeps resolving.
 *  - A ledger that somehow acquired children is skipped entirely.
 */
export async function sweepOrphanPartyLedgers(pool: PgPool): Promise<string> {
  // Columns that can point at a party ledger. Kept explicit: a new reference
  // column must be added here, and a missing one fails loudly at boot rather
  // than silently deleting a referenced ledger.
  const REFS: Array<[table: string, column: string]> = [
    ["journal_voucher_lines", "ledger_id"],
    ["journal_vouchers", "party_ledger_id"],
    ["receipts", "received_from_ledger_id"],
    ["receipts", "received_in_ledger_id"],
    ["payments", "paid_to_ledger_id"],
    ["payments", "paid_from_ledger_id"],
    ["expenses", "ledger_account_id"],
    ["opening_balances", "ledger_id"],
    ["cash_deposits", "source_cash_ledger_id"],
    ["cash_deposits", "destination_bank_ledger_id"],
    ["reconciliation_batches", "destination_bank_ledger_id"],
    ["warehouse_rent_agreements", "payable_ledger_id"],
    ["warehouse_rent_agreements", "expense_ledger_id"],
    ["warehouses", "purchase_ledger_id"],
    ["warehouses", "sales_ledger_id"],
    ["warehouses", "cash_ledger_id"],
    ["outlets", "sales_ledger_id"],
    ["outlets", "cash_ledger_id"],
  ];
  const referenced = REFS
    .map(([t, c]) => `EXISTS (SELECT 1 FROM ${t} WHERE ${c} = l.id)`)
    .join("\n         OR ");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: orphans } = await client.query<{
      id: number; code: string; name: string; is_referenced: boolean;
    }>(`
      SELECT l.id, l.code, l.name,
             (${referenced}) AS is_referenced
        FROM account_ledgers l
       WHERE l.is_group = false
         AND NOT EXISTS (SELECT 1 FROM account_ledgers ch WHERE ch.parent_id = l.id)
         AND (
              (l.code ~ '^VEND-[0-9]+$' AND NOT EXISTS
                 (SELECT 1 FROM vendors v WHERE v.id = substring(l.code, 6)::int))
           OR (l.code ~ '^CUST-[0-9]+$' AND NOT EXISTS
                 (SELECT 1 FROM customers c WHERE c.id = substring(l.code, 6)::int))
           OR (l.code ~ '^VADV-[0-9]+$' AND NOT EXISTS
                 (SELECT 1 FROM vendors v2 WHERE v2.id = substring(l.code, 6)::int))
         )
       FOR UPDATE`);

    if (orphans.length === 0) {
      await client.query("COMMIT");
      return "orphan_party_ledgers: none found";
    }

    const toDelete = orphans.filter((o) => !o.is_referenced).map((o) => o.id);
    const toRetire = orphans.filter((o) => o.is_referenced).map((o) => o.id);

    if (toDelete.length > 0) {
      await client.query(
        `DELETE FROM account_ledgers WHERE id = ANY($1::int[])`, [toDelete]);
    }
    if (toRetire.length > 0) {
      await client.query(
        `UPDATE account_ledgers SET is_active = false WHERE id = ANY($1::int[])`, [toRetire]);
    }
    await client.query("COMMIT");

    const label = (ids: number[]) =>
      orphans.filter((o) => ids.includes(o.id)).map((o) => `${o.code} "${o.name}"`).join(", ");
    return `orphan_party_ledgers: deleted ${toDelete.length} unreferenced` +
      (toDelete.length ? ` [${label(toDelete)}]` : "") +
      (toRetire.length ? `; deactivated ${toRetire.length} referenced [${label(toRetire)}]` : "");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
