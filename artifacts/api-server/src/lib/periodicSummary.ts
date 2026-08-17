/**
 * Month-wise / Day-wise period bucket enumeration.
 *
 * The Month Wise / Day Wise views on the Chart of Accounts show the COMPLETE
 * financial statements for every period: each expanded bucket fetches
 * /accounts/financial-statements for its exact [from..to]. Because every
 * figure comes from that one engine (lib/books.ts), reconciliation between
 * the buckets and the Summary view is by construction — this module never
 * computes money. It answers exactly one question: WHICH month/day buckets
 * does the selected range contain?
 *
 * The only data-dependent part is deriving the range START when the filter
 * is "All": the buckets begin where the books begin (first posting in scope,
 * orphans excluded exactly as buildBooks excludes them), mirroring how the
 * undated statements read from inception.
 */
import { pool } from "@workspace/db";
import { loadChart, todayISO, type Chart } from "./books";
import { filterPostingsByLocation, type PostingLocationFilter } from "./postingLocation";

type Q = { query: Function };

export type Granularity = "month" | "day";

export interface PeriodBucket {
  /** 'YYYY-MM' for months, 'YYYY-MM-DD' for days. */
  key: string;
  /** First and last date the bucket actually covers (clipped to the range). */
  from: string;
  to: string;
}

export interface PeriodicBuckets {
  granularity: Granularity;
  /** Effective range the buckets cover (from may be derived when omitted). */
  fromDate: string | null;
  toDate: string | null;
  page: number;
  pageSize: number;
  totalBuckets: number;
  buckets: PeriodBucket[];
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

const addDaysUTC = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Whole days from a to b (both ISO dates, UTC — no DST in this calendar). */
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const monthIndex = (ym: string): number => {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
};
const ymOfIndex = (i: number): string =>
  `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;

/** Bucket count for [from..to] — pure arithmetic, never materialises buckets. */
function countBuckets(granularity: Granularity, from: string, to: string): number {
  if (from > to) return 0;
  if (granularity === "day") return daysBetween(from, to) + 1;
  return monthIndex(to.slice(0, 7)) - monthIndex(from.slice(0, 7)) + 1;
}

/**
 * Materialise ONLY the requested page window of buckets (ascending, clipped
 * to [from..to] at both ends). A caller may legitimately ask for a decades-
 * long day range — building every skeleton just to slice one page would make
 * the endpoint's cost proportional to the range instead of the page.
 */
function bucketWindow(granularity: Granularity, from: string, to: string, start: number, count: number): PeriodBucket[] {
  const out: PeriodBucket[] = [];
  const total = countBuckets(granularity, from, to);
  if (granularity === "day") {
    for (let i = start; i < Math.min(start + count, total); i++) {
      const d = addDaysUTC(from, i);
      out.push({ key: d, from: d, to: d });
    }
    return out;
  }
  const first = monthIndex(from.slice(0, 7));
  for (let i = start; i < Math.min(start + count, total); i++) {
    const ym = ymOfIndex(first + i);
    const mFrom = `${ym}-01`;
    const mTo = lastDayOfMonth(ym);
    out.push({ key: ym, from: mFrom < from ? from : mFrom, to: mTo > to ? to : mTo });
  }
  return out;
}

export interface PeriodicBucketsOptions {
  granularity: Granularity;
  fromDate?: string | null;
  toDate?: string | null;
  location?: PostingLocationFilter | null;
  page?: number;
  pageSize?: number;
  q?: Q;
}

export async function buildPeriodicBuckets(
  buildDerivedPostings: PostingsFn,
  opts: PeriodicBucketsOptions,
): Promise<PeriodicBuckets> {
  const q = opts.q ?? pool;
  const granularity = opts.granularity;
  const today = todayISO();
  // Future dates hold no transactions — clamp so the view never lists days
  // that have not happened yet.
  const effTo = opts.toDate && opts.toDate < today ? opts.toDate : today;

  // Range start: explicit, or derived from the first posting in scope so
  // "All" begins where the books begin instead of at an arbitrary date.
  // With an explicit fromDate no posting pass is needed at all.
  let effFrom = opts.fromDate ?? null;
  if (!effFrom) {
    const chart: Chart = await loadChart(q);
    const allPostings = await buildDerivedPostings({ toDate: effTo, q });
    const postings = opts.location
      ? filterPostingsByLocation(
          allPostings.map((p) => ({ ...p, locationType: p.locationType ?? null, locationId: p.locationId ?? null })) as never[],
          opts.location,
        ) as unknown as Posting[]
      : allPostings;
    for (const p of postings) {
      if (!chart.byId.has(Number(p.ledgerId))) continue; // orphans: excluded, as in buildBooks
      const d = dstr(p.date);
      if (!effFrom || d < effFrom) effFrom = d;
    }
  }

  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? (granularity === "day" ? 31 : 24)) || 1, 1), 62);
  const page = Math.max(Math.trunc(opts.page ?? 1) || 1, 1);

  if (!effFrom || effFrom > effTo) {
    return { granularity, fromDate: effFrom, toDate: effTo, page, pageSize, totalBuckets: 0, buckets: [] };
  }

  return {
    granularity,
    fromDate: effFrom,
    toDate: effTo,
    page,
    pageSize,
    totalBuckets: countBuckets(granularity, effFrom, effTo),
    buckets: bucketWindow(granularity, effFrom, effTo, (page - 1) * pageSize, pageSize),
  };
}
