import { useState, useEffect } from 'react';
import { useCashBankBook, useCashBankBookLedgers } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EntityCombobox } from '@/components/ui/entity-combobox';
import { Wallet, Landmark, AlertTriangle } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { ExportButtons, pdfMoney, periodLabel, type ReportDoc } from '@/pages/reports/shared';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().split('T')[0];
const monthStart = () => `${new Date().toISOString().slice(0, 8)}01`;

const SOURCE_LABEL: Record<string, string> = {
  payment: 'Payment', receipt: 'Receipt', journal: 'Journal', contra: 'Contra',
  credit_note: 'Credit Note', debit_note: 'Debit Note', expense: 'Expense',
  sale: 'Sale', purchase: 'Purchase',
};

export default function CashBankBook({ kind }: { kind: 'cash' | 'bank' }) {
  const isCash = kind === 'cash';
  const perm = usePermission(isCash ? 'page:/accounts/cash-book' : 'page:/accounts/bank-book');
  const { data: ledgers = [] } = useCashBankBookLedgers(kind);
  const [ledgerId, setLedgerId] = useState(0);
  const [fromDate, setFromDate] = useState(monthStart());
  const [toDate, setToDate] = useState(today());

  // Default to the root ledger (Cash / Bank) which consolidates the whole subtree
  useEffect(() => {
    if (ledgerId === 0 && ledgers.length > 0) {
      const root = ledgers.find(l => l.code === (isCash ? 'STD-CASH' : 'STD-BANK'));
      setLedgerId(root?.id ?? ledgers[0].id);
    }
  }, [ledgers, ledgerId, isCash]);

  const { locationState } = useLocationContext();
  const loc = locationFilterParams(locationState);
  const { data, isLoading } = useCashBankBook(ledgerId, fromDate || undefined, toDate || undefined, loc);
  const entries = data?.entries ?? [];
  const companyLevel = (data as any)?.location ? (data as any)?.companyLevel : null;

  const { sorted, sort } = useTableSort(entries, {
    date: e => e.date,
    type: e => SOURCE_LABEL[e.source] ?? e.source,
    voucher: e => e.voucherNumber,
    description: e => e.description,
    debit: e => Number(e.debit) || null,
    credit: e => Number(e.credit) || null,
    balance: e => Number(e.balance),
  });

  const { pageRows, pagerProps } = useClientPage(sorted);

  // Server-rendered Excel/PDF — always the FULL filtered range, never the
  // visible client page.
  const bookTitle = isCash ? 'Cash Book' : 'Bank Book';
  const ledgerName = ledgers.find(l => l.id === ledgerId)?.name ?? '';
  const doc = (): ReportDoc => ({
    title: bookTitle,
    subtitle: `${ledgerName} · ${periodLabel(fromDate, toDate)}${(data as any)?.location && locationState.locationName ? ` · ${locationState.locationName}` : ''}`,
    filename: `${kind}-book-${fromDate}-to-${toDate}`,
    metaRows: [
      ['Ledger', ledgerName],
      ['Period', periodLabel(fromDate, toDate)],
      ['Opening Balance', pdfMoney(data?.openingBalance ?? 0)],
      ['Total In (Dr)', pdfMoney(data?.totalDebit ?? 0)],
      ['Total Out (Cr)', pdfMoney(data?.totalCredit ?? 0)],
      ['Closing Balance', pdfMoney(data?.closingBalance ?? 0)],
    ],
    orientation: 'landscape',
    sections: [{
      columns: [
        { label: 'Date' },
        { label: 'Type' },
        { label: 'Voucher #' },
        { label: 'Description', width: 3 },
        { label: 'In (Dr)', align: 'right', width: 1.4 },
        { label: 'Out (Cr)', align: 'right', width: 1.4 },
        { label: 'Balance', align: 'right', width: 1.4 },
      ],
      rows: [
        ['', '', 'Opening Balance', '', '', '', pdfMoney(data?.openingBalance ?? 0)] as (string | number)[],
        ...entries.map(e => [
          new Date(`${e.date}T00:00:00`).toLocaleDateString('en-IN'),
          SOURCE_LABEL[e.source] ?? e.source,
          e.voucherNumber || '',
          e.description,
          e.debit > 0 ? pdfMoney(e.debit) : '',
          e.credit > 0 ? pdfMoney(e.credit) : '',
          pdfMoney(e.balance),
        ] as (string | number)[]),
      ],
      totalsRow: ['', '', 'Total', '', pdfMoney(data?.totalDebit ?? 0), pdfMoney(data?.totalCredit ?? 0), pdfMoney(data?.closingBalance ?? 0)],
    }],
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

  const Icon = isCash ? Wallet : Landmark;
  const title = isCash ? 'Cash Book' : 'Bank Book';

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title={title}
          description={isCash ? 'Cash movements with running balance' : 'Bank movements with running balance'}
          icon={Icon}
          actions={
            <ExportButtons
              canDownload={perm.canDownload}
              disabled={entries.length === 0}
              doc={doc}
              onCSV={() => downloadCSV(`${kind}-book-${fromDate}-to-${toDate}.csv`, [
                { Date: '', Type: '', Voucher: 'Opening Balance', Description: '', Debit: '', Credit: '', Balance: data?.openingBalance ?? 0 },
                ...entries.map(e => ({
                  Date: e.date, Type: SOURCE_LABEL[e.source] ?? e.source, Voucher: e.voucherNumber || '',
                  Description: e.description, Debit: e.debit || '', Credit: e.credit || '', Balance: e.balance,
                })),
              ])}
            />
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <EntityCombobox
            className="w-56"
            options={ledgers.map(l => ({ id: l.id, label: `${l.name}${l.code === (isCash ? 'STD-CASH' : 'STD-BANK') ? ' (all)' : ''}` }))}
            value={ledgerId || null}
            onChange={v => setLedgerId(Number(v ?? 0))}
            placeholder="Select ledger"
            searchPlaceholder="Search ledgers…"
          />
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-38" />
          <span className="text-muted-foreground text-sm">to</span>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-38" />
        </div>

        {/* Company-level bucket note */}
        {!isLoading && (data as any)?.location && companyLevel && companyLevel.entries > 0 && (
          <div className="bg-muted/40 border border-border rounded-xl p-3 text-xs text-muted-foreground">
            Showing <span className="font-medium text-foreground">{locationState.locationName}</span> only.
            {' '}{companyLevel.entries} company-level {companyLevel.entries === 1 ? 'entry' : 'entries'} in this period
            {' '}carry no location and are excluded — switch to All Locations to include them.
          </div>
        )}

        {/* Summary cards */}
        <SummaryCardGrid>
          <SummaryCard label="Opening Balance" value={inr(data?.openingBalance ?? 0)} icon={Icon} loading={isLoading} />
          <SummaryCard label="Total In (Dr)" value={inr(data?.totalDebit ?? 0)} tone="positive" loading={isLoading} />
          <SummaryCard label="Total Out (Cr)" value={inr(data?.totalCredit ?? 0)} tone="negative" loading={isLoading} />
          <SummaryCard
            label="Closing Balance"
            value={<span className={(data?.closingBalance ?? 0) < 0 ? 'text-destructive' : ''}>{inr(data?.closingBalance ?? 0)}</span>}
            loading={isLoading}
          />
        </SummaryCardGrid>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="type" sort={sort}>Type</SortableHead>
                <SortableHead k="voucher" sort={sort}>Voucher #</SortableHead>
                <SortableHead k="description" sort={sort}>Description</SortableHead>
                <SortableHead k="debit" sort={sort} className="text-right">In (Dr)</SortableHead>
                <SortableHead k="credit" sort={sort} className="text-right">Out (Cr)</SortableHead>
                <SortableHead k="balance" sort={sort} className="text-right">Balance</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="p-0"><TableSkeleton rows={4} cols={7} /></TableCell></TableRow>
              ) : entries.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="p-0">
                  <EmptyState icon={Icon} title="No movements in this period" compact />
                </TableCell></TableRow>
              ) : (
                <>
                  <TableRow className="bg-muted/5 hover:bg-muted/5">
                    <TableCell colSpan={6} className="text-sm font-medium text-muted-foreground">Opening Balance</TableCell>
                    <TableCell className="text-right font-mono font-semibold">{inr(data?.openingBalance ?? 0)}</TableCell>
                  </TableRow>
                  {pageRows.map((e, i) => (
                    <TableRow key={i} className="hover:bg-muted/10">
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{new Date(`${e.date}T00:00:00`).toLocaleDateString('en-IN')}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{SOURCE_LABEL[e.source] ?? e.source}</Badge></TableCell>
                      <TableCell className="font-mono text-primary text-xs font-semibold">{e.voucherNumber || '—'}</TableCell>
                      <TableCell className="text-sm max-w-[280px] truncate">{e.description}</TableCell>
                      <TableCell className="text-right font-mono text-emerald-600">{e.debit > 0 ? inr(e.debit) : ''}</TableCell>
                      <TableCell className="text-right font-mono text-red-500">{e.credit > 0 ? inr(e.credit) : ''}</TableCell>
                      <TableCell className={`text-right font-mono font-semibold ${e.balance < 0 ? 'text-destructive' : ''}`}>{inr(e.balance)}</TableCell>
                    </TableRow>
                  ))}
                </>
              )}
            </TableBody>
          </Table>
          {entries.length > 0 && (
            <div className="px-4 border-t border-border">
              <TablePager {...pagerProps} />
            </div>
          )}
          {entries.length > 0 && (
            <div className="p-4 border-t border-border bg-muted/10 flex flex-wrap justify-end gap-6 text-sm">
              <span>In: <span className="font-mono font-bold text-emerald-500">{inr(data?.totalDebit ?? 0)}</span></span>
              <span>Out: <span className="font-mono font-bold text-red-500">{inr(data?.totalCredit ?? 0)}</span></span>
              <span>Closing: <span className="font-mono font-bold">{inr(data?.closingBalance ?? 0)}</span></span>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
