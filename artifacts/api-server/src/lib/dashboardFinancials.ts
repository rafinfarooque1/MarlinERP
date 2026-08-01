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
 * Scope note: derived postings carry the source document's location
 * (locationType/locationId; null = the company-level bucket). By default these
 * figures are company-wide; pass `location` to read one location's slice of
 * the SAME stream. Slices exclude opening balances (company-level by nature),
 * so location slices + the company bucket reconcile to the consolidated view.
 */
import { pool } from "@workspace/db";

import { buildBooks } from "./books";
import { filterPostingsByLocation, type PostingLocationFilter } from "./postingLocation";

export interface CompanyFinancials {
  /**
   * Period figures (respect `fromDate`), straight off the P&L.
   *
   * `salary` and `rent` are the STD-SALARY-EXP and STD-GRP-RENT-EXP subtree
   * totals read from the SAME buildBooks output that produces `total` — never
   * re-summed from postings here (the capitalisation overlay would make a
   * second implementation drift from the P&L). `other` is defined as
   * `total − salary − rent`, so total = salary + rent + other by construction.
   */
  expenses: {
    direct: number; indirect: number; total: number;
    salary: number; rent: number; other: number;
  };
  /** Cumulative to `toDate` — a balance is a position, not a period flow. */
  bankBalance: number;
  cashBalance: number;
  /** Control-account totals, signed to their natural side. */
  accountsReceivable: number;
  accountsPayable: number;
  /**
   * Net salary owed to employees, signed positive.
   *
   * Reported separately because it is NOT part of `accountsPayable`: that figure
   * is the Sundry Creditors subtree, and salary payable hangs off Current
   * Liabilities instead. Accrued salary was therefore money the company owed
   * that the payables tile could not see at all.
   *
   * It comes off the posting stream like every other balance here, so a salary
   * payment, a month-end true-up and a manual journal against the payable all
   * move it. Re-summing unpaid payroll rows would ignore the journal entirely.
   */
  salaryPayable: number;
  /**
   * Net rent owed to landlords, signed positive. Same reasoning as
   * `salaryPayable`: the daily rent accrual credits `RENT-PAY-<warehouseId>`
   * ledgers under `STD-GRP-RENT-PAY`, which also hangs off Current Liabilities
   * and is invisible to the Sundry Creditors control account.
   */
  rentPayable: number;
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
  /** Net salary owed to employees — see `CompanyFinancials.salaryPayable`. */
  salaryPayable: number;
  /** Net rent owed to landlords — see `CompanyFinancials.rentPayable`. */
  rentPayable: number;
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
  opts: { toDate?: string | null; location?: PostingLocationFilter | null } = {},
): Promise<ControlBalances> {
  const { buildLedgerBalanceIndex } = await import("./ledgerBalances");
  const location = opts.location ?? null;
  const sliced = location
    ? (filterPostingsByLocation(postings as never[], location) as unknown as Posting[])
    : postings;
  const idx = await buildLedgerBalanceIndex(
    (async () => sliced) as unknown as PostingsFn,
    {
      toDate: opts.toDate ?? null,
      postings: sliced,
      // Opening balances have no location attribution — only the company-wide
      // view (and the explicit 'company' bucket) may fold them in.
      includeOpeningBalances: !location || location.type === "company",
    },
  );
  return {
    bankBalance: idx.bankBalance(),
    cashBalance: idx.cashBalance(),
    accountsReceivable: idx.controlTotal("customer"),
    accountsPayable: idx.controlTotal("vendor"),
    // Negated because `subtreeNet` is debit-minus-credit and a liability sits on
    // the credit side — the same convention `controlTotal` applies to creditors.
    salaryPayable: r2(-idx.subtreeNet("STD-GRP-SAL-PAY")),
    rentPayable: r2(-idx.subtreeNet("STD-GRP-RENT-PAY")),
  };
}

/**
 * One day's money movement across the cash and bank subtrees, read from the
 * SAME derived posting stream as the balance tiles — so "cash in today" is by
 * construction the amount the Cash Book gained today. Debits into a cash/bank
 * ledger are money in; credits are money out. A cash→bank deposit counts on
 * both sides, exactly as a cash book shows it.
 */
export function dayMoneyFlows(
  postings: Posting[],
  opts: { date: string; location?: PostingLocationFilter | null; subtree: (code: string) => number[] },
): { cashIn: number; cashOut: number; bankIn: number; bankOut: number; totalIn: number; totalOut: number } {
  const location = opts.location ?? null;
  const sliced = location
    ? (filterPostingsByLocation(postings as never[], location) as unknown as Posting[])
    : postings;
  const cashIds = new Set(opts.subtree("STD-CASH"));
  const bankIds = new Set(opts.subtree("STD-BANK"));
  let cashIn = 0, cashOut = 0, bankIn = 0, bankOut = 0;
  for (const p of sliced) {
    // pg date columns come back as JS Dates (UTC midnight); derived rows may
    // already be strings. Normalise both to YYYY-MM-DD before comparing.
    const d = (p.date as unknown) instanceof Date
      ? (p.date as unknown as Date).toISOString().slice(0, 10)
      : String(p.date).slice(0, 10);
    if (d !== opts.date) continue;
    if (cashIds.has(p.ledgerId)) { cashIn += p.debit; cashOut += p.credit; }
    else if (bankIds.has(p.ledgerId)) { bankIn += p.debit; bankOut += p.credit; }
  }
  return {
    cashIn: r2(cashIn), cashOut: r2(cashOut),
    bankIn: r2(bankIn), bankOut: r2(bankOut),
    totalIn: r2(cashIn + bankIn), totalOut: r2(cashOut + bankOut),
  };
}

/** Control balances only — for callers that do not need the expense figure. */
export async function companyBalances(
  buildDerivedPostings: PostingsFn,
  opts: { toDate?: string | null; location?: PostingLocationFilter | null } = {},
): Promise<ControlBalances> {
  const toDate = opts.toDate || null;
  return balancesFrom(await buildDerivedPostings(toDate ? { toDate } : {}), {
    toDate,
    location: opts.location ?? null,
  });
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
  opts: {
    fromDate?: string | null;
    toDate?: string | null;
    location?: PostingLocationFilter | null;
  } = {},
): Promise<CompanyFinancials> {
  const fromDate = opts.fromDate || null;
  const toDate = opts.toDate || null;
  const location = opts.location ?? null;

  // Derived once and handed to buildBooks, which would otherwise re-derive the
  // whole stream. The postings are already capped at `toDate`, which is the
  // only argument buildBooks would have passed. buildBooks applies the location
  // slice itself (and handles opening-balance inclusion by the same rule as
  // balancesFrom), so it gets the UNfiltered stream plus the filter.
  const postings = await buildDerivedPostings(toDate ? { toDate } : {});

  const [controls, books] = await Promise.all([
    balancesFrom(postings, { toDate, location }),
    buildBooks(async () => postings, {
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {}),
      ...(location ? { location } : {}),
    }),
  ]);

  const direct = books.profitAndLoss.expenses.directExpenses.total;
  const indirect = books.profitAndLoss.expenses.indirectExpenses.total;

  // Subtree total for a code inside an already-built statement group. A node's
  // `balance` is its own postings plus all descendants, so the first match is
  // the whole subtree. Searched in both expense groups so a re-parented salary
  // or rent container keeps reporting instead of silently reading 0.
  type Node = { code: string | null; balance: number; children: Node[] };
  const findBalance = (nodes: Node[], code: string): number | null => {
    for (const n of nodes) {
      if (n.code === code) return n.balance;
      const hit = findBalance(n.children, code);
      if (hit !== null) return hit;
    }
    return null;
  };
  const groups = [
    ...books.profitAndLoss.expenses.indirectExpenses.children,
    ...books.profitAndLoss.expenses.directExpenses.children,
  ] as Node[];
  const salary = r2(findBalance(groups, "STD-SALARY-EXP") ?? 0);
  const rent = r2(findBalance(groups, "STD-GRP-RENT-EXP") ?? 0);
  const total = r2(direct + indirect);

  return {
    expenses: {
      direct: r2(direct), indirect: r2(indirect), total,
      salary, rent, other: r2(total - salary - rent),
    },
    ...controls,
  };
}
