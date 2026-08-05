/**
 * Cash & Bank ↔ Chart of Accounts integration.
 *
 * Every Cash & Bank account is backed by exactly one postable ledger under the
 * system heads Cash (STD-CASH) or Bank Accounts (STD-BANK). The module is the
 * ONLY writer of ledgers inside those two subtrees (branch tills are created by
 * the Locations module and adopted read-only); manual chart edits there are
 * blocked route-side.
 *
 * Design constraints that shaped this file:
 *  · STD-CASH / STD-BANK are POSTABLE parents carrying direct history (legacy
 *    expenses, HO vouchers). They must NOT become `is_system_group = true` —
 *    books.ts zeroes a system group's own balance, which would erase that
 *    history from every statement. They are locked by code instead.
 *  · `cash_bank_accounts.ledger_id/location_type/location_id` are raw-migration
 *    columns — invisible to drizzle, read and written via raw SQL only.
 *  · Balances are NEVER stored. The stored `balance` column is legacy and no
 *    longer written; every reader derives from the posting stream + opening
 *    balances.
 */
import { upsertOpeningBalance, currentFinancialYear } from "./openingBalances";

/**
 * Structural types instead of `import type { Pool, PoolClient } from "pg"`:
 * the pg package ships no bundled declarations here, and only `query` (plus
 * `connect` on the pool) is ever used.
 */
type Queryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>;
};
type Pool = Queryable & { connect(): Promise<PoolClient> };
type PoolClient = Queryable & { release(): void };

/** Codes of the two locked heads. */
export const CASH_ROOT_CODE = "STD-CASH";
export const BANK_ROOT_CODE = "STD-BANK";

/** Which head a Cash & Bank account's ledger lives under. Cash in hand goes
 *  under Cash; everything that is a claim on an institution (bank, upi
 *  wallets, "other") goes under Bank Accounts. No exceptions. */
export function rootCodeForType(accountType: string): string {
  return String(accountType).toLowerCase() === "cash" ? CASH_ROOT_CODE : BANK_ROOT_CODE;
}

export async function rootIdForType(
  q: Pool | PoolClient,
  accountType: string,
): Promise<number> {
  const code = rootCodeForType(accountType);
  const { rows: [r] } = await q.query(
    `SELECT id FROM account_ledgers WHERE code = $1`, [code],
  );
  if (!r) throw new Error(`Chart head ${code} is missing — the chart seed did not run`);
  return Number(r.id);
}

/** Every ledger id inside the Cash/Bank subtrees, roots included. */
export async function cashBankSubtreeIds(q: Pool | PoolClient): Promise<Set<number>> {
  const { rows } = await q.query(`
    WITH RECURSIVE tree AS (
      SELECT id FROM account_ledgers WHERE code IN ($1, $2)
      UNION ALL
      SELECT al.id FROM account_ledgers al JOIN tree t ON al.parent_id = t.id
    )
    SELECT id FROM tree
  `, [CASH_ROOT_CODE, BANK_ROOT_CODE]);
  return new Set(rows.map((r: any) => Number(r.id)));
}

/**
 * Create the ledger backing one Cash & Bank account. Caller supplies the
 * transaction client; the CBA-<accountId> code is what makes the ledger
 * system-owned (rename/delete locked in the chart, managed from the module).
 */
export async function provisionCashBankLedger(
  client: PoolClient,
  opts: { accountId: number; name: string; accountType: string },
): Promise<number> {
  const parentId = await rootIdForType(client, opts.accountType);
  const code = `CBA-${opts.accountId}`;
  // Check-then-insert rather than ON CONFLICT: the live account_ledgers table
  // has no unique constraint on code (created via CREATE TABLE IF NOT EXISTS,
  // so later in-schema constraints never reached it). Safe here because the
  // code embeds the caller's just-inserted accountId — two racing creates can
  // never target the same code — and both callers run inside a transaction.
  const { rows: [existing] } = await client.query(
    `SELECT id FROM account_ledgers WHERE code = $1`, [code],
  );
  if (existing) {
    await client.query(`UPDATE account_ledgers SET name = $1 WHERE id = $2`, [opts.name, Number(existing.id)]);
    return Number(existing.id);
  }
  const { rows: [row] } = await client.query(
    `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
     VALUES ($1, 'asset', $2, 'balance_sheet', $3, false, false, 'Cash & Bank account — managed from Accounts → Cash & Bank')
     RETURNING id`,
    [opts.name, code, parentId],
  );
  return Number(row.id);
}

/**
 * One-time boot migration: link every legacy Cash & Bank row to a real ledger
 * and adopt hand-made ledgers already sitting under the two heads.
 *
 * Guarded by migration_log (never by data shape — a reset that empties the
 * table must not re-fire this against re-created rows).
 *
 * Balance preservation: the stored balance was maintained by ONE writer (the
 * HO expense flow decremented it), so the account's original opening figure is
 * exactly `stored balance + Σ expenses paid from it`. That figure becomes the
 * ledger's opening balance, and the derived posting stream repoints each
 * legacy expense's credit leg from the root head to the account's own ledger
 * (see journal.ts). Net effect per account: ledger balance = opening − its
 * expenses = the stored figure users saw — and the books' cash/bank subtrees
 * gain the declared opening money exactly once.
 */
/** Code of the equity ledger that counterweights module-seeded openings. */
export const OPENING_ADJ_CODE = "STD-OB-ADJ";

/**
 * Keep the books balanced against module-written opening balances.
 *
 * An opening balance row is one-sided; the manual screen expects an accountant
 * to enter every side so the set self-balances. This module writes only the
 * asset side (each account's opening money), so without a counterweight every
 * seeded rupee unbalances the trial balance and the balance sheet.
 *
 * The counterweight is ONE credit opening on "Opening Balance Adjustment"
 * under Capital Accounts, recomputed from scratch as the sum of all openings
 * sitting on CBA-coded ledgers. Recompute-from-scratch (never increment) makes
 * this idempotent: safe to run at every boot and after every create/edit/
 * delete, and self-healing if a row was edited by hand.
 */
export async function rebalanceCashBankOpeningEquity(pool: Pool): Promise<void> {
  const fy = await currentFinancialYear();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialise concurrent rebalances: without this, two writers can each sum
    // an intermediate set and the LAST one to write persists a stale figure.
    // The whole read-sum → rewrite runs under one transaction-scoped lock, so
    // whichever rebalance runs last sees every committed opening.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('cash_bank_opening_equity'))`);

    const { rows: [s] } = await client.query(`
      SELECT COALESCE(SUM(CASE WHEN ob.balance_type = 'credit' THEN -ob.balance::numeric ELSE ob.balance::numeric END), 0) AS total
      FROM opening_balances ob
      JOIN account_ledgers al ON al.id = ob.ledger_id
      WHERE al.code LIKE 'CBA-%'
    `);
    const total = Math.round(Number(s?.total ?? 0) * 100) / 100;

    const { rows: [adj] } = await client.query(
      `SELECT id FROM account_ledgers WHERE code = $1`, [OPENING_ADJ_CODE],
    );
    let adjId = adj ? Number(adj.id) : null;

    if (total === 0) {
      // Nothing to counterweight — remove the ledger too, not just its rows.
      // It only ever carries opening rows (never postings), so after a company
      // reset or the last account's deletion it would otherwise linger in the
      // chart as an empty equity head.
      if (adjId != null) {
        await client.query(`DELETE FROM opening_balances WHERE ledger_id = $1`, [adjId]);
        await client.query(`DELETE FROM account_ledgers WHERE id = $1`, [adjId]);
      }
      await client.query("COMMIT");
      return;
    }

    if (adjId == null) {
      const { rows: [row] } = await client.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_group, is_system_group, description)
         SELECT 'Opening Balance Adjustment', 'equity', $1, 'balance_sheet', id, false, false,
                'Counterweight to Cash & Bank opening balances — maintained automatically'
         FROM account_ledgers WHERE code = 'SYS-CAP'
         RETURNING id`,
        [OPENING_ADJ_CODE],
      );
      adjId = Number(row.id);
    }

    // Exactly one counterweight row ever: clearing first keeps it from
    // splintering across financial-year labels as years roll over. Plain
    // INSERT (not the shared upsert) so the write stays inside THIS
    // transaction and lock.
    await client.query(`DELETE FROM opening_balances WHERE ledger_id = $1`, [adjId]);
    await client.query(
      `INSERT INTO opening_balances (ledger_id, balance, balance_type, as_of_date, financial_year, notes, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'system', NOW())`,
      [adjId, Math.abs(total).toFixed(2), total > 0 ? "credit" : "debit", fy.startDate, fy.label,
       "Auto counterweight to Cash & Bank opening balances"],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function migrateCashBankLedgerLinks(pool: Pool): Promise<void> {
  const { rows: done } = await pool.query(
    `SELECT 1 FROM migration_log WHERE name = 'cash_bank_ledger_link_v1'`,
  );
  if (done.length > 0) return;

  const fy = await currentFinancialYear();
  const client = await pool.connect();
  const seeded: Array<{ ledgerId: number; amount: number; name: string; asOf: string }> = [];
  try {
    await client.query("BEGIN");

    // 1. The Bank head reads "Bank Accounts" from here on (display rename only —
    //    same id, same code, history untouched).
    await client.query(
      `UPDATE account_ledgers SET name = 'Bank Accounts' WHERE code = $1 AND name = 'Bank'`,
      [BANK_ROOT_CODE],
    );

    // 2. Adopt hand-made ledgers already under the heads (created before this
    //    module owned the subtree). Same ledger id is preserved; the ledger
    //    simply gains a CBA code and a module row, so it is managed from the
    //    Cash & Bank screen like every other account.
    const { rows: orphans } = await client.query(`
      SELECT al.id, al.name, root.code AS root_code
      FROM account_ledgers al
      JOIN account_ledgers root ON root.id = al.parent_id AND root.code IN ($1, $2)
      WHERE al.code IS NULL AND COALESCE(al.is_group, false) = false
        AND NOT EXISTS (SELECT 1 FROM cash_bank_accounts c WHERE c.ledger_id = al.id)
    `, [CASH_ROOT_CODE, BANK_ROOT_CODE]);
    for (const o of orphans) {
      const accountType = o.root_code === CASH_ROOT_CODE ? "cash" : "bank";
      const { rows: [acc] } = await client.query(
        `INSERT INTO cash_bank_accounts (name, account_type, balance, ledger_id, location_type, location_id)
         VALUES ($1, $2, 0, $3, 'headoffice', NULL) RETURNING id`,
        [o.name, accountType, Number(o.id)],
      );
      await client.query(
        `UPDATE account_ledgers SET code = $1 WHERE id = $2`,
        [`CBA-${acc.id}`, Number(o.id)],
      );
    }

    // 3. Give every unlinked legacy account a ledger and carry its balance over.
    const { rows: unlinked } = await client.query(`
      SELECT c.id, c.name, c.account_type, c.balance::numeric AS balance, c.created_at,
             COALESCE((SELECT SUM(e.amount::numeric) FROM expenses e WHERE e.payment_account_id = c.id), 0) AS spent
      FROM cash_bank_accounts c
      WHERE c.ledger_id IS NULL
      ORDER BY c.id
    `);
    for (const u of unlinked) {
      const ledgerId = await provisionCashBankLedger(client, {
        accountId: Number(u.id), name: u.name, accountType: u.account_type,
      });
      await client.query(
        `UPDATE cash_bank_accounts SET ledger_id = $1 WHERE id = $2`,
        [ledgerId, Number(u.id)],
      );
      const seed = Number(u.balance) + Number(u.spent);
      if (seed > 0.004) {
        // Recorded after commit through the ONE opening-balance write path, so
        // the upsert key and audit trail match a manually entered figure.
        const asOf = u.created_at instanceof Date
          ? u.created_at.toISOString().slice(0, 10)
          : String(u.created_at ?? fy.startDate).slice(0, 10);
        seeded.push({ ledgerId, amount: Math.round(seed * 100) / 100, name: u.name, asOf });
      }
    }

    await client.query(
      `INSERT INTO migration_log (name) VALUES ('cash_bank_ledger_link_v1') ON CONFLICT (name) DO NOTHING`,
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  for (const s of seeded) {
    await upsertOpeningBalance({
      ledgerId: s.ledgerId, balance: s.amount, balanceType: "debit",
      asOfDate: s.asOf, financialYear: fy.label,
      notes: "Migrated from Cash & Bank stored balance",
      user: "system", ledgerName: s.name,
    });
  }
}
