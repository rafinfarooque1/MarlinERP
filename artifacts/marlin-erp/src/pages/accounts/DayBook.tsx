import { useState } from 'react';
import { useDayBook } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { BookOpenCheck, Download, AlertTriangle, ChevronLeft, ChevronRight, ListChecks, IndianRupee } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().split('T')[0];

const SOURCE_META: Record<string, { label: string; cls: string }> = {
  sale:        { label: 'Sale',        cls: 'bg-emerald-500/15 text-emerald-600' },
  purchase:    { label: 'Purchase',    cls: 'bg-orange-500/15 text-orange-600' },
  payment:     { label: 'Payment',     cls: 'bg-red-500/15 text-red-600' },
  receipt:     { label: 'Receipt',     cls: 'bg-sky-500/15 text-sky-600' },
  journal:     { label: 'Journal',     cls: 'bg-blue-500/15 text-blue-600' },
  contra:      { label: 'Contra',      cls: 'bg-violet-500/15 text-violet-600' },
  credit_note: { label: 'Credit Note', cls: 'bg-teal-500/15 text-teal-600' },
  debit_note:  { label: 'Debit Note',  cls: 'bg-amber-500/15 text-amber-600' },
  expense:     { label: 'Expense',     cls: 'bg-rose-500/15 text-rose-600' },
};

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export default function DayBook() {
  const perm = usePermission('page:/accounts/day-book');
  const [date, setDate] = useState(today());
  const { locationState } = useLocationContext();
  const loc = locationFilterParams(locationState);
  const { data, isLoading } = useDayBook(date, loc);

  const entries = data?.entries ?? [];
  const byType = data?.totals.byType ?? {};
  const companyLevel = (data as any)?.location ? (data as any)?.companyLevel : null;

  const { sorted, sort } = useTableSort(entries, {
    type: e => SOURCE_META[e.source]?.label ?? e.source,
    voucher: e => e.voucherNumber,
    particulars: e => e.particulars,
    narration: e => e.narration,
    amount: e => Number(e.amount),
  });

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Day Book"
          description="Every transaction recorded on a given day"
          icon={BookOpenCheck}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setDate(d => shiftDate(d, -1))}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} className="w-40" />
              <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setDate(d => shiftDate(d, 1))} disabled={date >= today()}>
                <ChevronRight className="w-4 h-4" />
              </Button>
              {date !== today() && (
                <Button variant="outline" size="sm" onClick={() => setDate(today())}>Today</Button>
              )}
              {perm.canDownload && entries.length > 0 && (
                <Button variant="outline" size="sm" onClick={() => downloadCSV(`day-book-${date}.csv`, entries.map(e => ({
                  Type: SOURCE_META[e.source]?.label ?? e.source, Voucher: e.voucherNumber || '', Particulars: e.particulars,
                  Narration: e.narration || '', Amount: e.amount,
                })))}>
                  <Download className="w-4 h-4 mr-2" /> Export
                </Button>
              )}
            </div>
          }
        />

        {entries.length > 0 && (
          <SummaryCardGrid>
            <SummaryCard label="Transactions" value={String(data?.totals.count ?? 0)} icon={ListChecks} tone="default" loading={isLoading} />
            <SummaryCard label="Total Amount" value={inr(data?.totals.amount ?? 0)} icon={IndianRupee} tone="info" loading={isLoading} />
          </SummaryCardGrid>
        )}

        {/* Company-level bucket note — entries with no location dimension are
            excluded from a location slice, never silently dropped. */}
        {!isLoading && (data as any)?.location && companyLevel && companyLevel.entries > 0 && (
          <div className="bg-muted/40 border border-border rounded-xl p-3 text-xs text-muted-foreground">
            Showing <span className="font-medium text-foreground">{locationState.locationName}</span> only.
            {' '}{companyLevel.entries} company-level {companyLevel.entries === 1 ? 'entry' : 'entries'} on this day
            {' '}carry no location and are excluded — switch to All Locations to include them.
          </div>
        )}

        {/* Totals by type */}
        {Object.keys(byType).length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {Object.entries(byType).map(([src, t]) => (
              <div key={src} className="bg-card border border-border rounded-xl p-3">
                <Badge className={`${SOURCE_META[src]?.cls ?? 'bg-muted text-muted-foreground'} border-0 hover:${SOURCE_META[src]?.cls ?? ''}`}>
                  {SOURCE_META[src]?.label ?? src}
                </Badge>
                <p className="font-mono font-bold mt-2">{inr(t.amount)}</p>
                <p className="text-xs text-muted-foreground">{t.count} {t.count === 1 ? 'entry' : 'entries'}</p>
              </div>
            ))}
          </div>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={4} cols={5} />
          ) : entries.length === 0 ? (
            <EmptyState icon={BookOpenCheck} title={`No transactions on ${new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`} />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="type" sort={sort}>Type</SortableHead>
                <SortableHead k="voucher" sort={sort}>Voucher / Invoice #</SortableHead>
                <SortableHead k="particulars" sort={sort}>Particulars</SortableHead>
                <SortableHead k="narration" sort={sort}>Narration</SortableHead>
                <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map(e => (
                <TableRow key={e.id} className="hover:bg-muted/10">
                  <TableCell>
                    <Badge className={`${SOURCE_META[e.source]?.cls ?? 'bg-muted text-muted-foreground'} border-0 hover:${SOURCE_META[e.source]?.cls ?? ''}`}>
                      {SOURCE_META[e.source]?.label ?? e.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-primary font-semibold text-sm">{e.voucherNumber || '—'}</TableCell>
                  <TableCell className="text-sm max-w-[320px] truncate">{e.particulars}</TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[220px] truncate">{e.narration || '—'}</TableCell>
                  <TableCell className="text-right font-mono font-bold">{inr(e.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
          {entries.length > 0 && (
            <div className="p-4 border-t border-border bg-muted/10 flex justify-between items-center">
              <span className="text-sm text-muted-foreground">{data?.totals.count} transactions</span>
              <span className="font-mono font-bold text-lg">{inr(data?.totals.amount ?? 0)}</span>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
