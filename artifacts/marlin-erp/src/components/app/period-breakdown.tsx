/**
 * Tally-style Month-wise / Day-wise breakdown table.
 *
 * One shared component behind both mount points (Chart of Accounts and
 * Reports → Financial), so the columns, drill behaviour and reconciliation
 * semantics can never diverge between them. All figures come from
 * /api/accounts/periodic-summary — the SAME accounting engine the financial
 * statements run on, bucketed server-side; nothing here recomputes money.
 *
 * Buckets are clickable: clicking a month/day hands its exact date range to
 * the host page, which opens the existing detailed view for that range —
 * a navigation affordance over existing reports, never a duplicate report.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { inr as fmt } from '@/lib/currency';
import { RTable, type Col } from '@/pages/reports/shared';

export interface PeriodBucketRow {
  key: string;   // 'YYYY-MM' (month) or 'YYYY-MM-DD' (day)
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

interface PeriodicSummaryResp {
  granularity: 'month' | 'day';
  fromDate: string | null;
  toDate: string | null;
  page: number;
  pageSize: number;
  totalBuckets: number;
  buckets: PeriodBucketRow[];
  totals: Omit<PeriodBucketRow, 'key' | 'from' | 'to' | 'closingStock'> & {
    openingStock: number; closingStock: number;
  };
}

const monthLabel = (key: string) =>
  new Date(`${key}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const dayLabel = (key: string) =>
  new Date(`${key}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

/** Profit figures read green/red; everything else stays neutral. */
const pnlCell = (n: number) => (
  <span className={n > 0.005 ? 'text-emerald-500' : n < -0.005 ? 'text-red-400' : 'text-muted-foreground'}>
    {fmt(n)}
  </span>
);

export function PeriodBreakdown({ granularity, fromDate, toDate, locationType, locationId, onDrill }: {
  granularity: 'month' | 'day';
  /** '' / undefined = unbounded (server derives the range from the books). */
  fromDate?: string;
  toDate?: string;
  locationType?: string;
  locationId?: number;
  /** Called with a bucket's exact [from..to] — host opens its detailed view. */
  onDrill: (from: string, to: string) => void;
}) {
  // A new range/location/grain is a new breakdown — never show page 3 of it.
  // The reset must be synchronous: an effect would let one render fire the
  // query for the NEW range at the OLD page number before resetting. Keying
  // the stored page by the input tuple ignores stale entries in-render.
  const rangeKey = `${granularity}|${fromDate ?? ''}|${toDate ?? ''}|${locationType ?? ''}|${locationId ?? ''}`;
  const [pageState, setPageState] = useState({ key: rangeKey, page: 1 });
  const page = pageState.key === rangeKey ? pageState.page : 1;
  const setPage = (p: number) => setPageState({ key: rangeKey, page: p });

  const { data, isLoading, isError, error } = useQuery<PeriodicSummaryResp>({
    queryKey: ['periodic-summary', granularity, fromDate || '', toDate || '', locationType || '', locationId || 0, page],
    queryFn: () => {
      const p = new URLSearchParams({ granularity, page: String(page) });
      if (fromDate) p.set('fromDate', fromDate);
      if (toDate) p.set('toDate', toDate);
      if (locationType && locationType !== 'all') {
        p.set('locationType', locationType);
        if (locationId) p.set('locationId', String(locationId));
      }
      return customFetch(`/api/accounts/periodic-summary?${p.toString()}`, { method: 'GET' });
    },
    staleTime: 60_000,
  });

  const label = granularity === 'month' ? monthLabel : dayLabel;
  const rows = data?.buckets ?? [];
  const totals = data?.totals;
  const totalPages = data ? Math.max(Math.ceil(data.totalBuckets / data.pageSize), 1) : 1;
  const paged = totalPages > 1;

  const cols: Col<PeriodBucketRow>[] = [
    {
      key: 'key', label: granularity === 'month' ? 'Month' : 'Date',
      render: (r) => (
        <button
          onClick={() => onDrill(r.from, r.to)}
          className="text-primary hover:underline font-medium inline-flex items-center gap-1"
          title="Open the detailed report for this period"
        >
          {label(r.key)}
          <ChevronRight className="w-3 h-3 opacity-60" />
        </button>
      ),
    },
    { key: 'sales', label: 'Sales', align: 'right', render: (r) => fmt(r.sales) },
    { key: 'purchases', label: 'Purchase', align: 'right', render: (r) => fmt(r.purchases) },
    { key: 'expenses', label: 'Expense', align: 'right', render: (r) => fmt(r.expenses) },
    { key: 'payments', label: 'Payment', align: 'right', render: (r) => fmt(r.payments) },
    { key: 'receipts', label: 'Receipt', align: 'right', render: (r) => fmt(r.receipts) },
    { key: 'grossProfit', label: 'Gross Profit', align: 'right', render: (r) => pnlCell(r.grossProfit) },
    { key: 'netProfit', label: 'Net Profit', align: 'right', render: (r) => pnlCell(r.netProfit) },
  ];

  if (isError) {
    return (
      <div className="py-10 text-center space-y-1">
        <p className="text-red-400 text-sm font-medium">Failed to load the period breakdown</p>
        <p className="text-muted-foreground text-xs">{(error as any)?.data?.error ?? (error as any)?.message ?? 'Unknown error'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Desktop table — totals row covers the WHOLE range even when paged,
          so the figures always tie back to the statements for this range. */}
      <div className="hidden md:block">
        <RTable
          cols={cols}
          rows={rows}
          loading={isLoading}
          empty="No transactions in this period"
          rowKey={(r) => r.key}
          footer={totals ? [
            paged ? 'Total (entire period)' : 'Total',
            fmt(totals.sales), fmt(totals.purchases), fmt(totals.expenses),
            fmt(totals.payments), fmt(totals.receipts),
            pnlCell(totals.grossProfit), pnlCell(totals.netProfit),
          ] : undefined}
        />
      </div>

      {/* Mobile — card per bucket, same figures, no horizontal scrolling. */}
      <div className="md:hidden space-y-2">
        {isLoading ? (
          [...Array(4)].map((_, i) => <div key={i} className="h-24 bg-muted/30 rounded-xl animate-pulse" />)
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No transactions in this period</p>
        ) : (
          rows.map((r) => (
            <button
              key={r.key}
              onClick={() => onDrill(r.from, r.to)}
              className="w-full text-left bg-card border border-border rounded-xl p-3 hover:border-primary/40 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-primary">{label(r.key)}</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <span className="text-muted-foreground">Sales</span><span className="text-right font-mono">{fmt(r.sales)}</span>
                <span className="text-muted-foreground">Purchase</span><span className="text-right font-mono">{fmt(r.purchases)}</span>
                <span className="text-muted-foreground">Expense</span><span className="text-right font-mono">{fmt(r.expenses)}</span>
                <span className="text-muted-foreground">Payment</span><span className="text-right font-mono">{fmt(r.payments)}</span>
                <span className="text-muted-foreground">Receipt</span><span className="text-right font-mono">{fmt(r.receipts)}</span>
                <span className="text-muted-foreground">Gross Profit</span><span className="text-right font-mono">{pnlCell(r.grossProfit)}</span>
                <span className="text-muted-foreground">Net Profit</span><span className="text-right font-mono">{pnlCell(r.netProfit)}</span>
              </div>
            </button>
          ))
        )}
        {!isLoading && totals && rows.length > 0 && (
          <div className="bg-muted/20 border border-border rounded-xl p-3">
            <p className="text-sm font-bold mb-2">{paged ? 'Total (entire period)' : 'Total'}</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-semibold">
              <span className="text-muted-foreground">Sales</span><span className="text-right font-mono">{fmt(totals.sales)}</span>
              <span className="text-muted-foreground">Purchase</span><span className="text-right font-mono">{fmt(totals.purchases)}</span>
              <span className="text-muted-foreground">Expense</span><span className="text-right font-mono">{fmt(totals.expenses)}</span>
              <span className="text-muted-foreground">Payment</span><span className="text-right font-mono">{fmt(totals.payments)}</span>
              <span className="text-muted-foreground">Receipt</span><span className="text-right font-mono">{fmt(totals.receipts)}</span>
              <span className="text-muted-foreground">Gross Profit</span><span className="text-right font-mono">{pnlCell(totals.grossProfit)}</span>
              <span className="text-muted-foreground">Net Profit</span><span className="text-right font-mono">{pnlCell(totals.netProfit)}</span>
            </div>
          </div>
        )}
      </div>

      {paged && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {data?.page ?? page} of {totalPages} · {data?.totalBuckets} {granularity === 'month' ? 'months' : 'days'}
          </p>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page <= 1 || isLoading} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="w-3.5 h-3.5" /> Prev
            </Button>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page >= totalPages || isLoading} onClick={() => setPage(page + 1)}>
              Next <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
