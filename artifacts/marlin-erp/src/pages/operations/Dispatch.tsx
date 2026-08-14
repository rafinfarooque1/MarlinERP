/**
 * Dispatch board (Operations) — billed sales awaiting physical dispatch.
 *
 * A pure fulfillment-status layer over existing sales: staff mark each bill
 * PENDING → READY → DISPATCHED with who/when stamps. Nothing here touches
 * amounts, stock or the books — the server writes only the additive
 * sale_dispatch_status table.
 *
 * Location scoping is server-side (LBAC + the global location selector's
 * headers); branch staff only ever see their own queue.
 */
import { useMemo, useState } from 'react';
import { useDispatchQueue, useSetDispatchStatus, type DispatchQueueEntry } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { FilterPanel } from '@/components/app/filter-panel';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { inr } from '@/lib/currency';
import { toast } from 'sonner';
import { Truck, Search, PackageCheck, PackageOpen, Clock, CheckCircle2 } from 'lucide-react';

type StatusFilter = 'all' | 'PENDING' | 'READY' | 'DISPATCHED';

/** "Time since billing" — coarse, human units; exact times stay in tooltips. */
function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

const fmtStamp = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';

export default function Dispatch() {
  const perm = usePermission('page:/operations/dispatch');

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Date window is server-side (default: last 30 days); status + search are
  // client-side so tab switches don't refetch.
  const queueQ = useDispatchQueue({
    from: fromDate || undefined,
    to: toDate || undefined,
  });
  const rows = queueQ.data ?? [];
  const setStatusM = useSetDispatchStatus();

  const counts = useMemo(() => {
    const c = { PENDING: 0, READY: 0, DISPATCHED: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (q && !(
        r.invoiceNumber?.toLowerCase().includes(q) ||
        (r.customerName ?? '').toLowerCase().includes(q) ||
        r.itemsSummary.toLowerCase().includes(q) ||
        r.locationName.toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [rows, statusFilter, search]);

  const { sorted, sort } = useTableSort(filtered, {
    invoice: r => r.invoiceNumber,
    date: r => r.createdAt,
    customer: r => r.customerName ?? '',
    location: r => r.locationName,
    items: r => r.itemCount,
    amount: r => r.totalAmount,
    status: r => r.status,
  });
  const { pageRows, pagerProps } = useClientPage(sorted, 50);

  const transition = (row: DispatchQueueEntry, status: 'READY' | 'DISPATCHED') => {
    if (setStatusM.isPending) return;
    setStatusM.mutate({ saleId: row.saleId, status }, {
      onSuccess: () => toast.success(`${row.invoiceNumber} marked ${status === 'READY' ? 'Ready' : 'Dispatched'}`),
      onError: (e: any) => toast.error(e?.data?.error || e?.message || 'Could not update status'),
    });
  };

  /** The one-click next action for a row, or null when the row is done. */
  const ActionButton = ({ row, className }: { row: DispatchQueueEntry; className?: string }) => {
    if (!perm.canEdit) return null;
    if (row.status === 'PENDING') {
      return (
        <Button size="sm" variant="outline" className={className}
          disabled={setStatusM.isPending}
          onClick={() => transition(row, 'READY')}>
          <PackageCheck className="w-3.5 h-3.5 mr-1.5" /> Mark Ready
        </Button>
      );
    }
    if (row.status === 'READY') {
      return (
        <Button size="sm" className={className}
          disabled={setStatusM.isPending}
          onClick={() => transition(row, 'DISPATCHED')}>
          <Truck className="w-3.5 h-3.5 mr-1.5" /> Dispatch
        </Button>
      );
    }
    return null;
  };

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <Truck className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
        </div>
      </AppLayout>
    );
  }

  const activeFilterCount = (fromDate ? 1 : 0) + (toDate ? 1 : 0);

  const STATUS_TABS: Array<{ value: StatusFilter; label: string; count?: number }> = [
    { value: 'all', label: 'All' },
    { value: 'PENDING', label: 'Pending', count: counts.PENDING },
    { value: 'READY', label: 'Ready', count: counts.READY },
    { value: 'DISPATCHED', label: 'Dispatched', count: counts.DISPATCHED },
  ];

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Dispatch"
          description="Billed sales awaiting physical dispatch — mark each bill Ready, then Dispatched. Statuses never touch amounts, stock or the books."
          icon={Truck}
        />

        <SummaryCardGrid>
          <SummaryCard label="Pending" value={String(counts.PENDING)} icon={Clock} tone="warning" loading={queueQ.isLoading} />
          <SummaryCard label="Ready" value={String(counts.READY)} icon={PackageOpen} tone="positive" loading={queueQ.isLoading} />
          <SummaryCard label="Dispatched" value={String(counts.DISPATCHED)} icon={CheckCircle2} tone="info" loading={queueQ.isLoading}
            sub={fromDate || toDate ? 'in selected dates' : 'in the last 30 days'} />
        </SummaryCardGrid>

        {/* Toolbar — search, status tabs, date filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search invoice, customer, items…" className="pl-8" />
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
            {STATUS_TABS.map(t => (
              <button key={t.value} type="button"
                onClick={() => setStatusFilter(t.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  statusFilter === t.value ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}>
                {t.label}{t.count !== undefined ? ` (${t.count})` : ''}
              </button>
            ))}
          </div>
          <FilterPanel className="ml-auto" activeCount={activeFilterCount}
            onClear={() => { setFromDate(''); setToDate(''); }}>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-40" aria-label="From date" />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-40" aria-label="To date" />
            </div>
          </FilterPanel>
        </div>

        {queueQ.isLoading ? (
          <TableSkeleton rows={8} cols={8} />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={Truck}
            title="No bills in this view"
            hint={search || statusFilter !== 'all' || activeFilterCount > 0
              ? 'Try clearing the search or filters.'
              : 'Sales billed in the last 30 days will appear here for dispatch.'}
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead k="invoice" sort={sort}>Invoice</SortableHead>
                    <SortableHead k="date" sort={sort}>Billed</SortableHead>
                    <SortableHead k="customer" sort={sort}>Customer</SortableHead>
                    <SortableHead k="location" sort={sort}>Location</SortableHead>
                    <SortableHead k="items" sort={sort}>Items</SortableHead>
                    <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
                    <SortableHead k="status" sort={sort}>Status</SortableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map(row => (
                    <TableRow key={row.saleId}>
                      <TableCell className="font-mono text-xs">{row.invoiceNumber}</TableCell>
                      <TableCell>
                        <div className="text-sm">{row.saleDate}</div>
                        <div className="text-xs text-muted-foreground">{timeSince(row.createdAt)} ago</div>
                      </TableCell>
                      <TableCell className="max-w-[180px]">
                        <span className="block truncate">{row.customerName ?? 'Walk-in'}</span>
                      </TableCell>
                      <TableCell className="text-sm">{row.locationName || '—'}</TableCell>
                      <TableCell className="max-w-[240px]">
                        <span className="block truncate text-sm" title={row.itemsSummary}>{row.itemsSummary || '—'}</span>
                        <span className="text-xs text-muted-foreground">{row.itemCount} line{row.itemCount === 1 ? '' : 's'}</span>
                      </TableCell>
                      <TableCell className="text-right font-medium">{inr(row.totalAmount)}</TableCell>
                      <TableCell>
                        <StatusBadge status={row.status.toLowerCase()} />
                        {row.status === 'READY' && row.readyBy && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">by {row.readyBy} · {fmtStamp(row.readyAt)}</div>
                        )}
                        {row.status === 'DISPATCHED' && row.dispatchedBy && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">by {row.dispatchedBy} · {fmtStamp(row.dispatchedAt)}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <ActionButton row={row} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <TablePager {...pagerProps} isFetching={queueQ.isFetching} />
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-3">
              {pageRows.map(row => (
                <div key={row.saleId} className="bg-card border border-border rounded-xl shadow-sm p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-xs">{row.invoiceNumber}</div>
                      <div className="font-medium truncate">{row.customerName ?? 'Walk-in'}</div>
                    </div>
                    <StatusBadge status={row.status.toLowerCase()} />
                  </div>
                  <div className="text-sm text-muted-foreground truncate">{row.itemsSummary || '—'}</div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{row.locationName || '—'}</span>
                    <span>{timeSince(row.createdAt)} ago · {inr(row.totalAmount)}</span>
                  </div>
                  {(row.readyBy || row.dispatchedBy) && (
                    <div className="text-[11px] text-muted-foreground">
                      {row.readyBy && <>Ready: {row.readyBy} · {fmtStamp(row.readyAt)}<br /></>}
                      {row.dispatchedBy && <>Dispatched: {row.dispatchedBy} · {fmtStamp(row.dispatchedAt)}</>}
                    </div>
                  )}
                  <ActionButton row={row} className="w-full" />
                </div>
              ))}
              <TablePager {...pagerProps} isFetching={queueQ.isFetching} />
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
