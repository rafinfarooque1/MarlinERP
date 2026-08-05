/**
 * Opening balances — the ONE write path into the opening_balances store.
 *
 * Used by the manual POST /accounts/opening-balances route AND by the Data
 * Import commit, so the upsert key (ledger_id, financial_year), the audit trail
 * and the paise-exact storage behave identically for both.
 *
 * The caller is responsible for validating that the ledger exists and is
 * postable (not a group) — both callers do, with caller-appropriate wording.
 */
import { pool } from "@workspace/db";
import { logActivity } from "./audit";

export interface OpeningBalanceInput {
  ledgerId: number;
  /** Non-negative rupee amount. */
  balance: number;
  balanceType: "debit" | "credit";
  /** ISO YYYY-MM-DD. */
  asOfDate: string;
  financialYear: string;
  notes?: string | null;
  user?: string;
  /** For the audit line only. */
  ledgerName?: string;
}

export async function upsertOpeningBalance(input: OpeningBalanceInput): Promise<{ id: number }> {
  const { rows: [row] } = await pool.query(`
    INSERT INTO opening_balances (ledger_id, balance, balance_type, as_of_date, financial_year, notes, created_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (ledger_id, financial_year)
    DO UPDATE SET balance = EXCLUDED.balance, balance_type = EXCLUDED.balance_type,
                  as_of_date = EXCLUDED.as_of_date, notes = EXCLUDED.notes,
                  updated_at = NOW()
    RETURNING id
  `, [input.ledgerId, input.balance.toFixed(2), input.balanceType, input.asOfDate,
      input.financialYear, input.notes ?? null, input.user ?? "system"]);

  logActivity({
    action: "CREATE", module: "accounts", entityType: "opening_balance", entityId: row.id,
    description: `Opening balance set for ${input.ledgerName ?? `ledger #${input.ledgerId}`} — ₹${input.balance.toFixed(2)} ${input.balanceType}`,
    user: input.user,
    metadata: { after: { ledgerId: input.ledgerId, balance: input.balance, balanceType: input.balanceType, asOfDate: input.asOfDate, financialYear: input.financialYear } },
  }).catch(() => {});

  return { id: Number(row.id) };
}

/**
 * Opening balances shaped as postings, so period-windowed statements (trial
 * balance, cash/bank books, ledger reports) can fold them with the SAME date
 * and location partition rules as real postings:
 *  · dated at as_of_date — a period that starts later treats them as
 *    brought-forward exactly like any earlier posting;
 *  · company-level (locationType null) — an opening balance predates the
 *    posting stream, so no location can honestly claim it. Location slices
 *    exclude it and the company bucket picks it up, keeping slices + bucket
 *    equal to the consolidated view.
 * books.ts keeps its own separate opening fold (cumulative-only); callers must
 * use one mechanism or the other, never both.
 */
export async function openingBalancePostings(opts: { toDate?: string } = {}): Promise<Array<{
  date: string; entryId: string; ledgerId: number; debit: number; credit: number;
  source: string; voucherNumber: string | null; description: string;
  locationType: string | null; locationId: number | null;
}>> {
  const params: unknown[] = [];
  let where = "";
  if (opts.toDate) { params.push(opts.toDate); where = `WHERE as_of_date <= $1`; }
  const { rows } = await pool.query(
    `SELECT id, ledger_id, balance::numeric AS balance, balance_type, as_of_date::text AS as_of_date
     FROM opening_balances ${where}`, params,
  );
  return rows
    .filter((r: any) => Number(r.balance) !== 0)
    .map((r: any) => {
      const debit = String(r.balance_type ?? "debit").toLowerCase() === "debit";
      const amt = Number(r.balance);
      return {
        date: String(r.as_of_date).slice(0, 10),
        entryId: `opening-balance-${r.id}`,
        ledgerId: Number(r.ledger_id),
        debit: debit ? amt : 0,
        credit: debit ? 0 : amt,
        source: "opening_balance",
        voucherNumber: null,
        description: "Opening balance",
        locationType: null,
        locationId: null,
      };
    });
}

/**
 * The financial year we are currently inside, derived from company settings'
 * fy_start_month (defaults to April). The stored financial_year TEXT column is
 * a display default that nobody rolls forward, so it is deliberately NOT
 * trusted here — a stale label would key every import's opening balance to a
 * year the books have moved past.
 */
export async function currentFinancialYear(): Promise<{ label: string; startDate: string }> {
  let fyStartMonth = 4;
  try {
    const { rows: [cs] } = await pool.query(`SELECT fy_start_month FROM company_settings LIMIT 1`);
    const m = Number(cs?.fy_start_month);
    if (Number.isInteger(m) && m >= 1 && m <= 12) fyStartMonth = m;
  } catch { /* default April */ }
  const now = new Date();
  const startYear = now.getMonth() + 1 >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1;
  const label = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
  const startDate = `${startYear}-${String(fyStartMonth).padStart(2, "0")}-01`;
  return { label, startDate };
}
