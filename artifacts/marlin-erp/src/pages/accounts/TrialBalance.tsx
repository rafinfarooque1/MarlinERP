import { useState } from 'react';
import { useTrialBalance } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Link } from 'wouter';
import { Scale, AlertTriangle, CheckCircle2, XCircle, Wallet, TrendingUp, ArrowRight } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { ExportButtons, pdfMoney, periodLabel, type ReportDoc } from '@/pages/reports/shared';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const TYPE_LABEL: Record<string, string> = {
  asset: 'Asset', liability: 'Liability', income: 'Income', expense: 'Expense', equity: 'Equity',
};

export default function TrialBalance() {
  const perm = usePermission('page:/accounts/trial-balance');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const { locationState } = useLocationContext();
  const loc = locationFilterParams(locationState);
  const { data, isLoading } = useTrialBalance(fromDate || undefined, toDate || undefined, loc);

  const rows = data?.rows ?? [];
  const companyLevel = data?.location ? data?.companyLevel : null;
  const { sorted, sort } = useTableSort(rows, {
    ledger: r => r.name,
    group: r => r.groupName,
    type: r => TYPE_LABEL[r.type ?? ''] ?? r.type,
    debit: r => Number(r.debit) || null,
    credit: r => Number(r.credit) || null,
  });

  // Server-rendered Excel/PDF over every ledger row (the page never paginates).
  const period = fromDate || toDate ? periodLabel(fromDate || undefined, toDate || undefined) : 'All time';
  const doc = (): ReportDoc => ({
    title: 'Trial Balance',
    subtitle: `${period}${data?.location && locationState.locationName ? ` · ${locationState.locationName}` : ''}`,
    filename: 'trial-balance',
    metaRows: [
      ['Period', period],
      ['Total Debit', pdfMoney(data?.totalDebit ?? 0)],
      ['Total Credit', pdfMoney(data?.totalCredit ?? 0)],
      ['Status', data?.balanced ? 'Balanced' : `OUT OF BALANCE by ${pdfMoney(Math.abs(data?.difference ?? 0))}`],
    ],
    sections: [{
      columns: [
        { label: 'Ledger', width: 2.2 },
        { label: 'Group', width: 1.6 },
        { label: 'Type' },
        { label: 'Debit', align: 'right', width: 1.4 },
        { label: 'Credit', align: 'right', width: 1.4 },
      ],
      rows: rows.map(r => [
        r.name,
        r.groupName || '',
        TYPE_LABEL[r.type ?? ''] ?? r.type ?? '',
        r.debit > 0 ? pdfMoney(r.debit) : '',
        r.credit > 0 ? pdfMoney(r.credit) : '',
      ] as (string | number)[]),
      totalsRow: ['Total', '', '', pdfMoney(data?.totalDebit ?? 0), pdfMoney(data?.totalCredit ?? 0)],
    }],
    footerNote: data?.balanced
      ? 'Total debits equal total credits — the books are balanced.'
      : `WARNING: the books are OUT OF BALANCE by ${pdfMoney(Math.abs(data?.difference ?? 0))}. Investigate via Accounts → Reconciliation.`,
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
          title="Trial Balance"
          description="Net debit / credit position of every ledger"
          icon={Scale}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-38" placeholder="From" />
              <span className="text-muted-foreground text-sm">to</span>
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-38" />
              {(fromDate || toDate) && (
                <Button variant="outline" size="sm" onClick={() => { setFromDate(''); setToDate(''); }}>All time</Button>
              )}
              <ExportButtons
                canDownload={perm.canDownload}
                disabled={rows.length === 0}
                doc={doc}
                onCSV={() => downloadCSV('trial-balance.csv', [
                  ...rows.map(r => ({
                    Ledger: r.name, Group: r.groupName || '', Type: TYPE_LABEL[r.type ?? ''] ?? r.type ?? '',
                    Debit: r.debit || '', Credit: r.credit || '',
                  })),
                  { Ledger: 'TOTAL', Group: '', Type: '', Debit: data?.totalDebit ?? 0, Credit: data?.totalCredit ?? 0 },
                ])}
              />
            </div>
          }
        />

        {rows.length > 0 && (
          <SummaryCardGrid>
            <SummaryCard label="Total Debit" value={inr(data?.totalDebit ?? 0)} icon={TrendingUp} tone="info" loading={isLoading} />
            <SummaryCard label="Total Credit" value={inr(data?.totalCredit ?? 0)} icon={Wallet} tone="info" loading={isLoading} />
          </SummaryCardGrid>
        )}

        {/* Company-level bucket note — postings with no location dimension
            (journal vouchers, opening balances) sit outside every location
            slice, so a filtered view says what it is not showing. */}
        {!isLoading && data?.location && companyLevel && companyLevel.entries > 0 && (
          <div className="bg-muted/40 border border-border rounded-xl p-3 text-xs text-muted-foreground">
            Showing <span className="font-medium text-foreground">{locationState.locationName}</span> only.
            {' '}{companyLevel.entries} company-level {companyLevel.entries === 1 ? 'entry' : 'entries'} (₹{companyLevel.debit.toLocaleString('en-IN', { minimumFractionDigits: 2 })} Dr)
            {' '}carry no location and are excluded — switch to All Locations to include them.
          </div>
        )}

        {/* Balance status banner */}
        {!isLoading && rows.length > 0 && (
          data?.balanced ? (
            <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-400 rounded-xl p-4 flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <p className="text-sm font-medium">Books are balanced — total debits equal total credits ({inr(data.totalDebit)})</p>
            </div>
          ) : (
            <div className="bg-destructive/10 border-2 border-destructive/50 rounded-xl p-5 space-y-3">
              <div className="flex items-start gap-3">
                <XCircle className="w-6 h-6 shrink-0 text-destructive" />
                <div className="space-y-1">
                  <p className="text-base font-bold text-destructive">
                    Books are OUT OF BALANCE by {inr(Math.abs(data?.difference ?? 0))}
                  </p>
                  <p className="text-sm text-destructive/90">
                    Total debits {inr(data?.totalDebit ?? 0)} ≠ total credits {inr(data?.totalCredit ?? 0)}.
                    This should never happen — it usually means a ledger-mapping gap (e.g. a location
                    without a sales or cash ledger) or a posting that lost one of its legs.
                  </p>
                </div>
              </div>
              <Link
                href="/accounts/reconciliation"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-destructive underline underline-offset-4 hover:no-underline ml-9"
              >
                Investigate in Reconciliation <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          )
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={6} cols={5} />
          ) : rows.length === 0 ? (
            <EmptyState icon={Scale} title="No postings in this period" />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="ledger" sort={sort}>Ledger</SortableHead>
                <SortableHead k="group" sort={sort}>Group</SortableHead>
                <SortableHead k="type" sort={sort}>Type</SortableHead>
                <SortableHead k="debit" sort={sort} className="text-right">Debit</SortableHead>
                <SortableHead k="credit" sort={sort} className="text-right">Credit</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map(r => (
                <TableRow key={r.ledgerId} className="hover:bg-muted/10">
                  <TableCell className="font-medium text-sm">{r.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{r.groupName || '—'}</TableCell>
                  <TableCell>
                    {r.type ? <Badge variant="outline" className="text-xs capitalize">{TYPE_LABEL[r.type] ?? r.type}</Badge> : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono">{r.debit > 0 ? inr(r.debit) : ''}</TableCell>
                  <TableCell className="text-right font-mono">{r.credit > 0 ? inr(r.credit) : ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <tfoot>
              <TableRow className="bg-muted/20 border-t-2 border-border hover:bg-muted/20">
                <TableCell colSpan={3} className="font-bold">Total</TableCell>
                <TableCell className="text-right font-mono font-bold">{inr(data?.totalDebit ?? 0)}</TableCell>
                <TableCell className="text-right font-mono font-bold">{inr(data?.totalCredit ?? 0)}</TableCell>
              </TableRow>
            </tfoot>
          </Table>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
