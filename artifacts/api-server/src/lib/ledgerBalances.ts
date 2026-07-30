/**
 * The single source of truth for "what is the current balance of X".
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * This ERP had two parallel, contradictory definitions of a current balance:
 *
 *   1. The accounting posting stream (`buildDerivedPostings` + `opening_balances`),
 *      behind the Trial Balance, Balance Sheet, P&L, Cash Book and Bank Book.
 *   2. Ad-hoc document arithmetic — `SUM(purchases) - SUM(payments)` for vendors,
 *      `sales.total_amount - amount_paid` for customers — copied into the vendor
 *      list, the customer list, the ageing reports and the dashboard tiles.
 *
 * Definition 2 cannot see a journal voucher. So a vendor whose payable had been
 * settled by a journal (Dr Vendor / Cr something) still showed the full original
 * bill on the vendor list, while its own ledger correctly showed zero. Same bill,
 * two answers, on two screens of the same product.
 *
 * The rule this module encodes: **for a posted financial position, the ledger is
 * the answer.** Business tables remain the source documents — they are what the
 * postings are derived FROM, and they still drive invoice-level allocation and
 * ageing — but they must never independently produce a contradictory "current
 * balance".
 *
 * ── What is included ──────────────────────────────────────────────────────
 *
 * Everything the books see: purchases, sales, payments, receipts, expenses,
 * journal vouchers, contra vouchers, credit/debit notes, payroll, rent accruals
 * — plus `opening_balances`, which live outside the posting stream and are added
 * here exactly as `buildBooks` adds them. That is what makes a balance from this
 * module reconcile to the Trial Balance and the Balance Sheet by construction,
 * rather than by coincidence.
 *
 * ── Sign convention ───────────────────────────────────────────────────────
 *
 * `net()` is always raw **Dr − Cr**. Callers must convert to the account's
 * natural side rather than displaying the raw net, because "positive" means
 * opposite things for a debtor and a creditor:
 *
 *   payable    (creditor, credit-natural) = −net    → positive = we owe them
 *   receivable (debtor,   debit-natural)  = +net    → positive = they owe us
 *   cash/bank  (asset,    debit-natural)  = +net    → positive = funds held
 *
 * Abnormal balances are deliberately NOT clamped to zero. A vendor with a net
 * debit is an advance paid to that vendor, and hiding it behind `GREATEST(0, …)`
 * is how a real asset disappears from the screens that should show it.
 */
import { pool } from "@workspace/db";

export type BalancePosting = {
  ledgerId: number;
  debit: number;
  credit: number;
};
export type PostingsFn = (opts: { toDate?: string }) => Promise<
  Array<{ date: string; ledgerId: number; debit: number; credit: number }>
>;

export type PartyKind = "vendor" | "customer";

/** Ledger code prefix and control account for each kind of party. */
const PARTY: Record<PartyKind, { prefix: string; control: string; natural: 1 | -1 }> = {
  // Vendors are credit-natural: a credit balance is a payable, so payable = −net.
  vendor: { prefix: "VEND-", control: "SYS-CREDITORS", natural: -1 },
  // Customers are debit-natural: a debit balance is a receivable, so receivable = +net.
  customer: { prefix: "CUST-", control: "SYS-DEBTORS", natural: 1 },
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface PartyBalance {
  partyId: number;
  ledgerId: number;
  /** Signed to the party's natural side: vendor = payable, customer = receivable. */
  balance: number;
  /** Raw Dr − Cr, for callers that need to label Dr/Cr explicitly. */
  net: number;
  debit: number;
  credit: number;
}

export interface LedgerBalanceIndex {
  /** Raw Dr − Cr for one ledger, including its opening balance. Excludes children. */
  net(ledgerId: number): number;
  /** Gross debit and credit totals for one ledger. */
  totals(ledgerId: number): { debit: number; credit: number };
  /** Every ledger id in the subtree rooted at `code` (the root included). */
  subtreeIds(code: string): number[];
  /** Raw Dr − Cr summed over a whole subtree. */
  subtreeNet(code: string): number;
  /** The account ledger backing a party, or null when it was never provisioned. */
  partyLedgerId(kind: PartyKind, partyId: number): number | null;
  /** One party's balance, signed to its natural side. */
  partyBalance(kind: PartyKind, partyId: number): PartyBalance | null;
  /** Every party of a kind that has a ledger, keyed by party id. */
  partyBalances(kind: PartyKind): Map<number, PartyBalance>;
  /**
   * The control-account total, signed to its natural side — Accounts Payable for
   * vendors, Accounts Receivable for customers. This is the whole subtree, so it
   * also carries anything posted directly to the control account rather than to a
   * party, which is exactly why it is the figure the Balance Sheet agrees with.
   */
  controlTotal(kind: PartyKind): number;
  /**
   * The part of the control total that belongs to no individual party (posted
   * straight to Sundry Debtors/Creditors, usually because a document had no party
   * or the party ledger did not exist yet). Reported separately so a party list
   * that does not add up to the control total can explain the difference instead
   * of hiding it.
   */
  unattributed(kind: PartyKind): number;
  cashBalance(): number;
  bankBalance(): number;
}

/**
 * Aggregate the whole posting stream once and answer balance questions from it.
 *
 * Deriving the stream is the expensive part, so callers that need many balances
 * (a vendor list, the dashboard) must build ONE index and query it repeatedly
 * rather than calling the single-value helpers in a loop.
 *
 * `postings` may be injected by a caller that has already derived the stream for
 * another purpose, which keeps a page that needs both books and balances to a
 * single derivation.
 */
export async function buildLedgerBalanceIndex(
  postingsFn: PostingsFn,
  opts: { toDate?: string | null; postings?: Array<{ ledgerId: number; debit: number; credit: number }> } = {},
): Promise<LedgerBalanceIndex> {
  const toDate = opts.toDate || null;

  const [{ rows: ledgerRows }, postings, { rows: obRows }] = await Promise.all([
    pool.query(`SELECT id, code, parent_id FROM account_ledgers`),
    opts.postings
      ? Promise.resolve(opts.postings)
      : postingsFn(toDate ? { toDate } : {}),
    pool.query(
      `SELECT ledger_id, balance::numeric AS balance, balance_type FROM opening_balances${
        toDate ? ` WHERE as_of_date <= $1` : ""
      }`,
      toDate ? [toDate] : [],
    ),
  ]);

  const agg = new Map<number, { debit: number; credit: number }>();
  const bump = (id: number, debit: number, credit: number) => {
    const cur = agg.get(id);
    if (cur) { cur.debit += debit; cur.credit += credit; }
    else agg.set(id, { debit, credit });
  };

  for (const p of postings) bump(Number(p.ledgerId), Number(p.debit) || 0, Number(p.credit) || 0);

  // Opening balances sit outside the posting stream. `buildBooks` folds them into
  // its cumulative view the same way; omitting them here would make every party
  // and cash balance disagree with the Balance Sheet the moment one is entered.
  for (const ob of obRows as Array<Record<string, unknown>>) {
    const amt = Number(ob.balance) || 0;
    const isDebit = String(ob.balance_type ?? "debit").toLowerCase() === "debit";
    bump(Number(ob.ledger_id), isDebit ? amt : 0, isDebit ? 0 : amt);
  }

  const codeToId = new Map<string, number>();
  const childrenOf = new Map<number, number[]>();
  /** Party id keyed by kind, resolved from the ledger `code` naming convention. */
  const partyLedgers: Record<PartyKind, Map<number, number>> = {
    vendor: new Map(),
    customer: new Map(),
  };

  for (const row of ledgerRows as Array<Record<string, unknown>>) {
    const id = Number(row.id);
    if (!childrenOf.has(id)) childrenOf.set(id, []);
    if (row.parent_id != null) {
      const pid = Number(row.parent_id);
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)!.push(id);
    }
    const code = row.code == null ? "" : String(row.code);
    if (!code) continue;
    codeToId.set(code, id);
    for (const kind of ["vendor", "customer"] as PartyKind[]) {
      const { prefix } = PARTY[kind];
      if (!code.startsWith(prefix)) continue;
      // `VEND-` is also the prefix a human could type into a ledger name; only a
      // strictly numeric suffix identifies a real party ledger.
      const suffix = code.slice(prefix.length);
      if (!/^\d+$/.test(suffix)) continue;
      partyLedgers[kind].set(Number(suffix), id);
    }
  }

  const subtreeCache = new Map<string, number[]>();
  const subtreeIds = (code: string): number[] => {
    const hit = subtreeCache.get(code);
    if (hit) return hit;
    const root = codeToId.get(code);
    const ids: number[] = [];
    if (root !== undefined) {
      // A mis-parented ledger must not hang a balance query.
      const seen = new Set<number>();
      const visit = (id: number) => {
        if (seen.has(id)) return;
        seen.add(id);
        ids.push(id);
        for (const child of childrenOf.get(id) ?? []) visit(child);
      };
      visit(root);
    }
    subtreeCache.set(code, ids);
    return ids;
  };

  const totals = (ledgerId: number) => agg.get(ledgerId) ?? { debit: 0, credit: 0 };
  const net = (ledgerId: number) => {
    const t = totals(ledgerId);
    return r2(t.debit - t.credit);
  };
  const subtreeNet = (code: string) => {
    let sum = 0;
    for (const id of subtreeIds(code)) {
      const t = agg.get(id);
      if (t) sum += t.debit - t.credit;
    }
    return r2(sum);
  };

  const partyLedgerId = (kind: PartyKind, partyId: number) =>
    partyLedgers[kind].get(Number(partyId)) ?? null;

  const partyBalance = (kind: PartyKind, partyId: number): PartyBalance | null => {
    const ledgerId = partyLedgerId(kind, partyId);
    if (ledgerId == null) return null;
    const t = totals(ledgerId);
    const rawNet = r2(t.debit - t.credit);
    return {
      partyId: Number(partyId),
      ledgerId,
      balance: r2(rawNet * PARTY[kind].natural),
      net: rawNet,
      debit: r2(t.debit),
      credit: r2(t.credit),
    };
  };

  const partyBalances = (kind: PartyKind): Map<number, PartyBalance> => {
    const out = new Map<number, PartyBalance>();
    for (const partyId of partyLedgers[kind].keys()) {
      const b = partyBalance(kind, partyId);
      if (b) out.set(partyId, b);
    }
    return out;
  };

  const controlTotal = (kind: PartyKind) => r2(subtreeNet(PARTY[kind].control) * PARTY[kind].natural);

  const unattributed = (kind: PartyKind) => {
    let attributed = 0;
    for (const b of partyBalances(kind).values()) attributed += b.balance;
    return r2(controlTotal(kind) - attributed);
  };

  return {
    net,
    totals: (id: number) => ({ debit: r2(totals(id).debit), credit: r2(totals(id).credit) }),
    subtreeIds,
    subtreeNet,
    partyLedgerId,
    partyBalance,
    partyBalances,
    controlTotal,
    unattributed,
    cashBalance: () => subtreeNet("STD-CASH"),
    bankBalance: () => subtreeNet("STD-BANK"),
  };
}

export interface StatementEntry {
  date: string;
  description: string;
  entryType: string;
  voucherNumber: string | null;
  debit: number;
  credit: number;
  /** Running balance signed to the account's natural side. */
  balance: number;
}

export interface LedgerStatement {
  ledgerId: number;
  opening: number;
  closing: number;
  totalDebit: number;
  totalCredit: number;
  entries: StatementEntry[];
}

/**
 * A party's account statement, built from the same postings as its balance.
 *
 * The previous per-party statements stitched together three different queries —
 * source documents from one table, payment vouchers from another, journal lines
 * from a third — and then summarised with their own arithmetic. Any posting
 * source they did not know about (a receipt against the party, an opening
 * balance, a rent accrual) was simply absent, so the statement and the ledger
 * disagreed. Deriving both the lines and the total from one stream means the
 * entries always add up to the balance shown above them.
 *
 * `natural` is +1 for a debit-natural account (customer, cash, bank) and −1 for
 * a credit-natural one (vendor), so the running balance reads positive while the
 * account is in its normal state.
 */
export async function buildLedgerStatement(
  postingsFn: PostingsFn,
  ledgerId: number,
  opts: {
    fromDate?: string | null; toDate?: string | null; natural?: 1 | -1;
    /** An already-derived posting stream for the same `toDate`, to avoid rebuilding it. */
    postings?: Array<Record<string, any>>;
  } = {},
): Promise<LedgerStatement> {
  const natural = opts.natural ?? 1;
  const toDate = opts.toDate || null;
  const fromDate = opts.fromDate || null;

  const [all, { rows: obRows }] = await Promise.all([
    opts.postings ? Promise.resolve(opts.postings) : postingsFn(toDate ? { toDate } : {}),
    pool.query(
      `SELECT balance::numeric AS balance, balance_type, as_of_date
         FROM opening_balances WHERE ledger_id = $1${toDate ? ` AND as_of_date <= $2` : ""}`,
      toDate ? [ledgerId, toDate] : [ledgerId],
    ),
  ]);

  const mine = (all as Array<Record<string, any>>)
    .filter((p) => Number(p.ledgerId) === Number(ledgerId))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.entryId ?? "").localeCompare(String(b.entryId ?? "")));

  // An opening balance is the account's position before any posting, so it seeds
  // the running total rather than appearing as a dated line among the entries.
  let opening = 0;
  for (const ob of obRows as Array<Record<string, unknown>>) {
    const amt = Number(ob.balance) || 0;
    const isDebit = String(ob.balance_type ?? "debit").toLowerCase() === "debit";
    opening += (isDebit ? amt : -amt) * natural;
  }
  opening = r2(opening);

  let running = opening;
  let totalDebit = 0;
  let totalCredit = 0;
  const entries: StatementEntry[] = [];
  for (const p of mine) {
    const debit = Number(p.debit) || 0;
    const credit = Number(p.credit) || 0;
    totalDebit += debit;
    totalCredit += credit;
    running = r2(running + (debit - credit) * natural);
    if (fromDate && String(p.date).slice(0, 10) < fromDate) continue;
    entries.push({
      date: String(p.date).slice(0, 10),
      description: String(p.description ?? ""),
      entryType: String(p.source ?? "journal"),
      voucherNumber: p.voucherNumber == null ? null : String(p.voucherNumber),
      debit: r2(debit),
      credit: r2(credit),
      balance: running,
    });
  }

  return {
    ledgerId,
    opening,
    closing: running,
    totalDebit: r2(totalDebit),
    totalCredit: r2(totalCredit),
    entries,
  };
}

/**
 * Build an index over the application's standard posting stream.
 *
 * This is the entry point route handlers should use. `buildDerivedPostings`
 * lives in a route module that itself imports libs, so it is pulled in at call
 * time rather than at module load; a static import here would close an import
 * cycle. Everything downstream stays a plain function call.
 */
export async function currentBalanceIndex(
  opts: { toDate?: string | null } = {},
): Promise<LedgerBalanceIndex> {
  const { buildDerivedPostings } = await import("../routes/journal");
  return buildLedgerBalanceIndex(buildDerivedPostings as PostingsFn, opts);
}

/** A party's statement over the application's standard posting stream. */
export async function currentPartyStatement(
  kind: PartyKind,
  partyId: number,
  opts: { fromDate?: string | null; toDate?: string | null } = {},
): Promise<(LedgerStatement & { hasLedger: boolean }) | { hasLedger: false } & LedgerStatement> {
  const { buildDerivedPostings } = await import("../routes/journal");
  // Derive the posting stream ONCE and hand the same array to both the index
  // (which resolves the party's ledger) and the statement. Letting each build
  // its own doubles the cost of the most expensive part of this request.
  const toDate = opts.toDate ?? null;
  const postings = await (buildDerivedPostings as PostingsFn)(toDate ? { toDate } : {});
  const idx = await buildLedgerBalanceIndex(buildDerivedPostings as PostingsFn, { toDate, postings });
  const ledgerId = idx.partyLedgerId(kind, partyId);
  if (ledgerId == null) {
    return { hasLedger: false, ledgerId: 0, opening: 0, closing: 0, totalDebit: 0, totalCredit: 0, entries: [] };
  }
  const st = await buildLedgerStatement(buildDerivedPostings as PostingsFn, ledgerId, {
    ...opts,
    natural: PARTY[kind].natural,
    postings: postings as Array<Record<string, any>>,
  });
  return { ...st, hasLedger: true };
}

/* ── Thin single-value helpers ────────────────────────────────────────────
 * Convenience wrappers for callers that need exactly one figure. Each one
 * derives the whole posting stream, so never call them in a loop — build an
 * index instead.
 */

/** Raw Dr − Cr for one ledger (its own postings only, children excluded). */
export async function getLedgerBalance(
  postingsFn: PostingsFn,
  ledgerId: number,
  opts: { toDate?: string | null } = {},
): Promise<number> {
  return (await buildLedgerBalanceIndex(postingsFn, opts)).net(ledgerId);
}

/** Positive = we owe the vendor. Negative = advance paid to the vendor. */
export async function getVendorBalance(
  postingsFn: PostingsFn,
  vendorId: number,
  opts: { toDate?: string | null } = {},
): Promise<number> {
  const idx = await buildLedgerBalanceIndex(postingsFn, opts);
  return idx.partyBalance("vendor", vendorId)?.balance ?? 0;
}

/** Positive = the customer owes us. Negative = advance received / overpaid. */
export async function getCustomerBalance(
  postingsFn: PostingsFn,
  customerId: number,
  opts: { toDate?: string | null } = {},
): Promise<number> {
  const idx = await buildLedgerBalanceIndex(postingsFn, opts);
  return idx.partyBalance("customer", customerId)?.balance ?? 0;
}

/**
 * Balance of a single cash or bank ledger, from the posting stream.
 *
 * Use this instead of summing `receipts` and `payments`: those two tables carry
 * only voucher-entered money, so a contra, a journal or a till sale never
 * reaches them and the resulting figure silently disagrees with the Cash Book.
 */
export async function getLedgerCashBalance(
  postingsFn: PostingsFn,
  ledgerId: number,
  opts: { toDate?: string | null } = {},
): Promise<number> {
  return getLedgerBalance(postingsFn, ledgerId, opts);
}
