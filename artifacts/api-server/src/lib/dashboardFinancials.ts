/**
 * Company-level accounting figures for the dashboard tiles.
 *
 * Two rules shaped this file.
 *
 * 1. One posting stream. Both dashboard endpoints used to walk the chart of
 *    accounts inline, so there were two copies of the same subtree logic that
 *    could drift. The tiles have to agree with the Trial Balance, the Cash Book
 *    and the Balance Sheet, so they are derived from `buildDerivedPostings`,
 *    the same stream that produces all of those.
 *
 * 2. Do not re-classify. The expense figure is NOT computed by summing the
 *    expense subtrees here — that was tried and it disagreed with the P&L on
 *    the very first run (direct expenses read -3,351.70 against the P&L's 0).
 *    The gap is the production-costing overlay (STD-FG-INV / STD-PROD-ABS),
 *    which `buildBooks` deliberately excludes because closing stock already
 *    carries the manufactured value. Any second implementation of "what counts
 *    as an expense" will drift like that again, so the expense number is read
 *    from `buildBooks` — the same function behind the Profit & Loss statement.
 *
 * Scope note: a derived posting carries a ledger, a date and an amount — it has
 * no location. These figures are company-level by construction, and callers
 * must not present them as one branch's numbers.
 */
import { pool } from "@workspace/db";

import { buildBooks } from "./books";

export interface CompanyFinancials {
  /** Period figures (respect `fromDate`), straight off the P&L. */
  expenses: { direct: number; indirect: number; total: number };
  /** Cumulative to `toDate` — a balance is a position, not a period flow. */
  bankBalance: number;
  cashBalance: number;
  /** Control-account totals, signed to their natural side. */
  accountsReceivable: number;
  accountsPayable: number;
}

type Posting = { date: string; ledgerId: number; debit: number; credit: number };
type PostingsFn = (opts: { toDate?: string }) => Promise<Posting[]>;

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Returns a lookup from a system/standard ledger code to every ledger id in its
 * subtree, so a group total picks up ledgers nested at any depth beneath it.
 */
export async function ledgerSubtreeLookup(): Promise<(code: string) => number[]> {
  const { rows } = await pool.query(`SELECT id, parent_id, code FROM account_ledgers`);
  const childrenOf = new Map<number, number[]>();
  const codeToId = new Map<string, number>();
  for (const r of rows as Array<{ id: unknown; parent_id: unknown; code: unknown }>) {
    const id = Number(r.id);
    if (r.code) codeToId.set(String(r.code), id);
    if (!childrenOf.has(id)) childrenOf.set(id, []);
    if (r.parent_id != null) {
      const pid = Number(r.parent_id);
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)!.push(id);
    }
  }
  return (code: string): number[] => {
    const root = codeToId.get(code);
    if (root === undefined) return [];
    const ids: number[] = [];
    // A malformed parent chain would otherwise recurse forever; the dashboard
    // must not be the thing that hangs because someone mis-parented a ledger.
    const seen = new Set<number>();
    const visit = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
      for (const child of childrenOf.get(id) ?? []) visit(child);
    };
    visit(root);
    return ids;
  };
}

export interface ControlBalances {
  bankBalance: number;
  cashBalance: number;
  accountsReceivable: number;
  accountsPayable: number;
}

/**
 * Balance-sheet control positions from an already-fetched posting stream.
 *
 * Delegated to the shared balance index rather than summing the subtrees here.
 * The inline version this replaces walked the postings only, so it silently
 * ignored `opening_balances` — which live outside the posting stream and are
 * folded in by `buildBooks`. That made the dashboard's cash and bank tiles read
 * lower than the Balance Sheet's by exactly the opening balances, on a screen
 * whose whole purpose is to agree with it.
 */
async function balancesFrom(
  postings: Posting[],
  opts: { toDate?: string | null } = {},
): Promise<ControlBalances> {
  const { buildLedgerBalanceIndex } = await import("./ledgerBalances");
  const idx = await buildLedgerBalanceIndex(
    (async () => postings) as unknown as PostingsFn,
    { toDate: opts.toDate ?? null, postings },
  );
  return {
    bankBalance: idx.bankBalance(),
    cashBalance: idx.cashBalance(),
    accountsReceivable: idx.controlTotal("customer"),
    accountsPayable: idx.controlTotal("vendor"),
  };
}

/** Control balances only — for callers that do not need the expense figure. */
export async function companyBalances(
  buildDerivedPostings: PostingsFn,
  opts: { toDate?: string | null } = {},
): Promise<ControlBalances> {
  const toDate = opts.toDate || null;
  return balancesFrom(await buildDerivedPostings(toDate ? { toDate } : {}), { toDate });
}

/**
 * Expense total, bank balance and cash balance for the dashboard.
 *
 * `expenses` covers Direct + Indirect expenses only, not the P&L's full expense
 * side. The P&L adds purchases and opening stock to reach cost of goods sold;
 * the dashboard already shows Purchases as its own tile, so including them here
 * would show the same money twice on one screen.
 */
export async function companyFinancials(
  buildDerivedPostings: PostingsFn,
  opts: { fromDate?: string | null; toDate?: string | null } = {},
): Promise<CompanyFinancials> {
  const fromDate = opts.fromDate || null;
  const toDate = opts.toDate || null;

  // Derived once and handed to buildBooks, which would otherwise re-derive the
  // whole stream. The postings are already capped at `toDate`, which is the
  // only argument buildBooks would have passed.
  const postings = await buildDerivedPostings(toDate ? { toDate } : {});

  const [controls, books] = await Promise.all([
    balancesFrom(postings, { toDate }),
    buildBooks(async () => postings, {
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {}),
    }),
  ]);

  const direct = books.profitAndLoss.expenses.directExpenses.total;
  const indirect = books.profitAndLoss.expenses.indirectExpenses.total;

  return {
    expenses: { direct: r2(direct), indirect: r2(indirect), total: r2(direct + indirect) },
    ...controls,
  };
}
