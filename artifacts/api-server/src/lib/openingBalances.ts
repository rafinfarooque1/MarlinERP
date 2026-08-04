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
