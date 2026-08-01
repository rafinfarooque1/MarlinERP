import { useState } from 'react';
import { useTrialBalance } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Scale, Download, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';

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
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Scale className="w-6 h-6 text-primary" /> Trial Balance
            </h1>
            <p className="text-muted-foreground mt-1">Net debit / credit position of every ledger</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-38" placeholder="From" />
            <span className="text-muted-foreground text-sm">to</span>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-38" />
            {(fromDate || toDate) && (
              <Button variant="outline" size="sm" onClick={() => { setFromDate(''); setToDate(''); }}>All time</Button>
            )}
            {perm.canDownload && rows.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('trial-balance.csv', [
                ...rows.map(r => ({
                  Ledger: r.name, Group: r.groupName || '', Type: TYPE_LABEL[r.type ?? ''] ?? r.type ?? '',
                  Debit: r.debit || '', Credit: r.credit || '',
                })),
                { Ledger: 'TOTAL', Group: '', Type: '', Debit: data?.totalDebit ?? 0, Credit: data?.totalCredit ?? 0 },
              ])}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
          </div>
        </div>

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
            <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-xl p-4 flex items-center gap-3">
              <XCircle className="w-5 h-5 shrink-0" />
              <p className="text-sm font-medium">
                Out of balance by {inr(Math.abs(data?.difference ?? 0))} — usually a ledger-mapping gap (e.g. a location without a sales or cash ledger)
              </p>
            </div>
          )
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Ledger</TableHead>
                <TableHead>Group</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(6)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : rows.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                  <Scale className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No postings in this period</p>
                </TableCell></TableRow>
              ) : rows.map(r => (
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
            {rows.length > 0 && (
              <tfoot>
                <TableRow className="bg-muted/20 border-t-2 border-border hover:bg-muted/20">
                  <TableCell colSpan={3} className="font-bold">Total</TableCell>
                  <TableCell className="text-right font-mono font-bold">{inr(data?.totalDebit ?? 0)}</TableCell>
                  <TableCell className="text-right font-mono font-bold">{inr(data?.totalCredit ?? 0)}</TableCell>
                </TableRow>
              </tfoot>
            )}
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}
