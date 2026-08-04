import { useState, useEffect } from 'react';
import { useCashBankBook, useCashBankBookLedgers } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Wallet, Landmark, Download, AlertTriangle } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';

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
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Icon className={`w-6 h-6 ${isCash ? 'text-emerald-500' : 'text-blue-500'}`} /> {title}
            </h1>
            <p className="text-muted-foreground mt-1">
              {isCash ? 'Cash movements with running balance' : 'Bank movements with running balance'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* '' keeps the select controlled while no ledger is chosen — undefined
                would flip it uncontrolled→controlled and trigger a React warning */}
            <Select value={ledgerId ? String(ledgerId) : ''} onValueChange={v => setLedgerId(Number(v))}>
              <SelectTrigger className="w-56"><SelectValue placeholder="Select ledger" /></SelectTrigger>
              <SelectContent>
                {ledgers.map(l => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.name}{l.code === (isCash ? 'STD-CASH' : 'STD-BANK') ? ' (all)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-38" />
            <span className="text-muted-foreground text-sm">to</span>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-38" />
            {perm.canDownload && entries.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV(`${kind}-book-${fromDate}-to-${toDate}.csv`, [
                { Date: '', Type: '', Voucher: 'Opening Balance', Description: '', Debit: '', Credit: '', Balance: data?.openingBalance ?? 0 },
                ...entries.map(e => ({
                  Date: e.date, Type: SOURCE_LABEL[e.source] ?? e.source, Voucher: e.voucherNumber || '',
                  Description: e.description, Debit: e.debit || '', Credit: e.credit || '', Balance: e.balance,
                })),
              ])}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
          </div>
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Opening Balance</p>
            <p className="font-mono font-bold text-lg mt-1">{inr(data?.openingBalance ?? 0)}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Total In (Dr)</p>
            <p className="font-mono font-bold text-lg mt-1 text-emerald-500">{inr(data?.totalDebit ?? 0)}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Out (Cr)</p>
            <p className="font-mono font-bold text-lg mt-1 text-red-500">{inr(data?.totalCredit ?? 0)}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Closing Balance</p>
            <p className={`font-mono font-bold text-lg mt-1 ${(data?.closingBalance ?? 0) < 0 ? 'text-destructive' : ''}`}>{inr(data?.closingBalance ?? 0)}</p>
          </div>
        </div>

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
              {isLoading ? [...Array(4)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : entries.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <Icon className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No movements in this period</p>
                </TableCell></TableRow>
              ) : (
                <>
                  <TableRow className="bg-muted/5 hover:bg-muted/5">
                    <TableCell colSpan={6} className="text-sm font-medium text-muted-foreground">Opening Balance</TableCell>
                    <TableCell className="text-right font-mono font-semibold">{inr(data?.openingBalance ?? 0)}</TableCell>
                  </TableRow>
                  {sorted.map((e, i) => (
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
