/**
 * Tally-style Month-wise / Day-wise financial summary.
 *
 * One rule shaped this file: NEVER recompute what `buildBooks` already owns.
 * Every figure here is derived from the SAME posting stream and the SAME
 * classification the Profit & Loss statement uses (lib/books.ts), bucketed by
 * month or day. Reconciliation is by construction, not by testing alone:
 *
 *  - Flows (sales, purchases, expenses, receipts, payments) are single-pass
 *    sums over the identical ledger subtrees `buildBooks` aggregates, so the
 *    buckets add up to the range total exactly.
 *  - GP/NP per bucket uses the periodic-inventory formula off stock valuations
 *    at the bucket BOUNDARIES (the same `stockAsOf`/`closingStockAt` the P&L
 *    calls). Interior boundaries telescope — April's closing stock IS May's
 *    opening stock — so Σ bucket NP = range NP identically.
 *
 * Valuing stock at a past date is the expensive part (a `stock_ledger` rewind
 * per boundary), so valuations are computed only for the requested page of
 * buckets plus the overall range, deduped and run with bounded concurrency.
 * Flow totals cost one in-memory pass regardless of page.
 */
import { pool } from "@workspace/db";
import {
  loadChart, previousDay, todayISO, stockAsOf, closingStockAt,
  CAPITALISATION_LEDGERS,
  type Chart, type StockAtDate, type StockBranchScope,
} from "./books";
import { filterPostingsByLocation, type PostingLocationFilter } from "./postingLocation";

type Q = { query: Function };
const r2 = (n: number) => Math.round(n * 100) / 100;

export type Granularity = "month" | "day";

export interface PeriodBucket {
  /** 'YYYY-MM' for months, 'YYYY-MM-DD' for days. */
  key: string;
  /** First and last date the bucket actually covers (clipped to the range). */
  from: string;
  to: string;
  sales: number;
  purchases: number;
  expenses: number;
  otherIncome: number;
  receipts: number;
  payments: number;
  grossProfit: number;
  netProfit: number;
  closingStock: number;
}

export interface PeriodicSummary {
  granularity: Granularity;
  /** Effective range the buckets cover (from may be derived when omitted). */
  fromDate: string | null;
  toDate: string | null;
  page: number;
  pageSize: number;
  totalBuckets: number;
  buckets: PeriodBucket[];
  /** Whole-range figures — same formulas, overall boundaries. */
  totals: Omit<PeriodBucket, "key" | "from" | "to" | "closingStock"> & {
    openingStock: number; closingStock: number;
  };
}

type Posting = {
  date: string | Date; ledgerId: number; debit: number; credit: number;
  source?: string; locationType?: string | null; locationId?: number | null;
};
type PostingsFn = (opts: { toDate?: string; q?: Q }) => Promise<Posting[]>;

/** pg DATE columns come back as JS Dates; derived rows are strings. */
const dstr = (d: string | Date): string =>
  d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

const lastDayOfMonth = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // day 0 of next month
  return last.toISOString().slice(0, 10);
};

const nextDay = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Bucket skeletons covering [from..to], ascending, clipped at both ends. */
function makeBuckets(granularity: Granularity, from: string, to: string): Array<{ key: string; from: string; to: string }> {
  const out: Array<{ key: string; from: string; to: string }> = [];
  if (from > to) return out;
  if (granularity === "day") {
    // Day count guard: the loop is bounded by the range itself; a pathological
    // range (decades) still only builds skeletons, never per-day queries.
    for (let d = from; d <= to; d = nextDay(d)) out.push({ key: d, from: d, to: d });
    return out;
  }
  let cursor = from;
  while (cursor <= to) {
    const ym = cursor.slice(0, 7);
    const end = lastDayOfMonth(ym);
    out.push({ key: ym, from: cursor, to: end < to ? end : to });
    cursor = nextDay(end < to ? end : to);
  }
  return out;
}

/** Bounded-concurrency map — boundary valuations each cost several queries. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface PeriodicSummaryOptions {
  granularity: Granularity;
  fromDate?: string | null;
  toDate?: string | null;
  location?: PostingLocationFilter | null;
  page?: number;
  pageSize?: number;
  q?: Q;
}

export async function buildPeriodicSummary(
  buildDerivedPostings: PostingsFn,
  opts: PeriodicSummaryOptions,
): Promise<PeriodicSummary> {
  const q = opts.q ?? pool;
  const location = opts.location ?? null;
  const granularity = opts.granularity;
  const today = todayISO();
  // Future dates hold no flows and would misread current stock as "that day's
  // closing" — clamp instead of valuing days that have not happened.
  const effTo = opts.toDate && opts.toDate < today ? opts.toDate : today;

  const chart: Chart = await loadChart(q);
  const allPostings = await buildDerivedPostings({ toDate: effTo, q });
  const postings = location
    ? filterPostingsByLocation(
        allPostings.map((p) => ({ ...p, locationType: p.locationType ?? null, locationId: p.locationId ?? null })) as never[],
        location,
      ) as unknown as Posting[]
    : allPostings;

  // Range start: explicit, or derived from the first posting in scope so "All"
  // begins where the books begin instead of at an arbitrary date.
  let effFrom = opts.fromDate ?? null;
  if (!effFrom) {
    for (const p of postings) {
      const d = dstr(p.date);
      if (!effFrom || d < effFrom) effFrom = d;
    }
  }

  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? (granularity === "day" ? 31 : 24)) || 1, 1), 62);
  const page = Math.max(Math.trunc(opts.page ?? 1) || 1, 1);

  const emptyTotals = {
    sales: 0, purchases: 0, expenses: 0, otherIncome: 0, receipts: 0, payments: 0,
    grossProfit: 0, netProfit: 0, openingStock: 0, closingStock: 0,
  };
  if (!effFrom || effFrom > effTo) {
    return { granularity, fromDate: effFrom, toDate: effTo, page, pageSize, totalBuckets: 0, buckets: [], totals: emptyTotals };
  }

  const skeletons = makeBuckets(granularity, effFrom, effTo);

  // ── Ledger classification — the SAME subtrees buildBooks aggregates ──────
  const idsUnder = (code: string) => chart.idsUnder([code]);
  const salesIds = idsUnder("SYS-SAL");
  const purchaseIds = idsUnder("SYS-PUR");
  const directExpIds = idsUnder("SYS-DIREXP");
  const indirectExpIds = idsUnder("SYS-INDEXP");
  const directIncIds = idsUnder("SYS-DIRINC");
  const indirectIncIds = idsUnder("SYS-INDINC");
  const cashBankIds = new Set<number>([...idsUnder("STD-CASH"), ...idsUnder("STD-BANK")]);
  const overlayIds = new Set<number>();
  for (const code of CAPITALISATION_LEDGERS) {
    const node = chart.byCode.get(code);
    if (node) overlayIds.add(node.id);
  }

  // ── One pass: flow sums per bucket key (every bucket, not just the page) ──
  type Flows = { sales: number; purchases: number; direxp: number; indexp: number; dirinc: number; indinc: number; moneyIn: number; moneyOut: number };
  const flows = new Map<string, Flows>();
  const keyOf = granularity === "day" ? (d: string) => d : (d: string) => d.slice(0, 7);
  for (const p of postings) {
    const d = dstr(p.date);
    if (d < effFrom || d > effTo) continue;
    const id = Number(p.ledgerId);
    if (!chart.byId.has(id)) continue;          // orphan postings: excluded, as in buildBooks
    if (overlayIds.has(id)) continue;           // production-costing overlay: excluded, as in buildBooks
    const k = keyOf(d);
    let f = flows.get(k);
    if (!f) { f = { sales: 0, purchases: 0, direxp: 0, indexp: 0, dirinc: 0, indinc: 0, moneyIn: 0, moneyOut: 0 }; flows.set(k, f); }
    const net = p.debit - p.credit;
    if (salesIds.has(id)) f.sales -= net;             // income: credit-positive
    else if (purchaseIds.has(id)) f.purchases += net; // expense: debit-positive
    else if (directExpIds.has(id)) f.direxp += net;
    else if (indirectExpIds.has(id)) f.indexp += net;
    else if (directIncIds.has(id)) f.dirinc -= net;
    else if (indirectIncIds.has(id)) f.indinc -= net;
    // Receipts/payments = money into / out of Cash+Bank, the Cash Book's own
    // definition (a cash→bank deposit counts on both sides, as the book shows).
    if (cashBankIds.has(id)) { f.moneyIn += p.debit; f.moneyOut += p.credit; }
  }
  const flowsOf = (k: string): Flows =>
    flows.get(k) ?? { sales: 0, purchases: 0, direxp: 0, indexp: 0, dirinc: 0, indinc: 0, moneyIn: 0, moneyOut: 0 };

  // ── Stock valuations at bucket boundaries (page + overall range only) ────
  const stockScope: StockBranchScope | null =
    location && location.type !== "company"
      ? { branchType: location.type, branchId: location.id, ...(location.identities?.length ? { branchPairs: location.identities } : {}) }
      : null;
  const skipStock = location?.type === "company";
  const emptyStock: StockAtDate = { total: 0, inTransit: 0, items: [], reliable: true, note: null };

  const valuationCache = new Map<string, Promise<StockAtDate>>();
  const valueAt = (date: string | null): Promise<StockAtDate> => {
    const k = date ?? "__inception__";
    let hit = valuationCache.get(k);
    if (!hit) {
      hit = skipStock ? Promise.resolve(emptyStock)
        // No fromDate = statement from inception; buildBooks reads that
        // opening as stockAsOf(null) unscoped, and we mirror it exactly.
        : date === null ? stockAsOf(null, undefined, q)
        : date < today ? stockAsOf(date, stockScope, q)
        : closingStockAt(stockScope, q);
      valuationCache.set(k, hit);
    }
    return hit;
  };

  // Opening boundary of the whole range — buildBooks semantics: an explicit
  // fromDate opens at the previous day's close; no fromDate opens at inception.
  //
  // CONTRACT (deliberate, reviewed): the inception opening keys off whether
  // the REQUEST supplied fromDate, not off the derived effFrom. This mirrors
  // the undated financial-statements exactly, so an unbounded breakdown always
  // reconciles with the "All" Summary view shown beside it on the same page
  // (verified against live data). The trade-off: on edge data where stock
  // exists BEFORE the first posting (e.g. opening-stock imports that never
  // posted), drilling into the FIRST bucket opens a dated P&L whose opening
  // is stockAsOf(prevDay(effFrom)) ≠ inception — but that same divergence
  // already exists in the statements themselves between "All" and an explicit
  // from-first-posting range; it is an engine semantic, not introduced here.
  // Do NOT "fix" this by switching to previousDay(effFrom): that would break
  // the bucket-sum == undated-statement identity, which users see side-by-side.
  const rangeOpeningDate: string | null = opts.fromDate ? previousDay(effFrom) : null;

  const start = (page - 1) * pageSize;
  const pageSkeletons = skeletons.slice(start, start + pageSize);

  // Boundary dates for the page: opening of the first page bucket, then each
  // page bucket's end. Contiguous buckets share boundaries, so this is
  // pageSize+1 valuations, plus (at most) the two overall-range boundaries.
  const boundaryDates: Array<string | null> = [];
  if (pageSkeletons.length > 0) {
    boundaryDates.push(start === 0 ? rangeOpeningDate : previousDay(pageSkeletons[0].from));
    for (const b of pageSkeletons) boundaryDates.push(b.to);
  }
  boundaryDates.push(rangeOpeningDate, effTo);
  const uniqueBoundaries = [...new Set(boundaryDates.map((d) => d ?? "__inception__"))]
    .map((k) => (k === "__inception__" ? null : k));
  await mapLimit(uniqueBoundaries, 4, valueAt);

  // ── Assemble page buckets — the P&L's own periodic-inventory formulas ────
  const metricsFor = async (
    f: Flows, openDate: string | null, closeDate: string,
  ): Promise<Omit<PeriodBucket, "key" | "from" | "to"> & { openingStock: number }> => {
    const [opening, closing] = await Promise.all([valueAt(openDate), valueAt(closeDate)]);
    const sales = r2(f.sales);
    const purchases = r2(f.purchases);
    const direxp = r2(f.direxp);
    const indexp = r2(f.indexp);
    const otherIncome = r2(f.dirinc + f.indinc);
    const totalExpenses = r2(opening.total + purchases + direxp + indexp);
    const totalIncomes = r2(sales + closing.total + f.dirinc + f.indinc);
    const revenue = r2(sales + f.dirinc);
    const cogs = r2(opening.total + purchases + direxp - closing.total);
    return {
      sales, purchases,
      expenses: r2(direxp + indexp),
      otherIncome,
      receipts: r2(f.moneyIn),
      payments: r2(f.moneyOut),
      grossProfit: r2(revenue - cogs),
      netProfit: r2(totalIncomes - totalExpenses),
      openingStock: r2(opening.total),
      closingStock: r2(closing.total),
    };
  };

  const buckets: PeriodBucket[] = [];
  for (let i = 0; i < pageSkeletons.length; i++) {
    const sk = pageSkeletons[i];
    const openDate = start + i === 0 ? rangeOpeningDate : previousDay(sk.from);
    const { openingStock: _o, ...m } = await metricsFor(flowsOf(sk.key), openDate, sk.to);
    buckets.push({ key: sk.key, from: sk.from, to: sk.to, ...m });
  }

  // Whole-range totals: flows summed over EVERY bucket, boundaries at the
  // range edges. Interior stock boundaries telescope out, so these equal the
  // sum of all bucket figures AND the P&L for the same range and location.
  const totalFlows: Flows = { sales: 0, purchases: 0, direxp: 0, indexp: 0, dirinc: 0, indinc: 0, moneyIn: 0, moneyOut: 0 };
  for (const f of flows.values()) {
    totalFlows.sales += f.sales; totalFlows.purchases += f.purchases;
    totalFlows.direxp += f.direxp; totalFlows.indexp += f.indexp;
    totalFlows.dirinc += f.dirinc; totalFlows.indinc += f.indinc;
    totalFlows.moneyIn += f.moneyIn; totalFlows.moneyOut += f.moneyOut;
  }
  const totals = await metricsFor(totalFlows, rangeOpeningDate, effTo);

  return {
    granularity,
    fromDate: effFrom,
    toDate: effTo,
    page,
    pageSize,
    totalBuckets: skeletons.length,
    buckets,
    totals,
  };
}
