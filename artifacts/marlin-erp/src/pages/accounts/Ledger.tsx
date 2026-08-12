import { useState } from 'react';
import { useGetLedgerStatement, useListAccountsFlat } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { FileText, Download, Calendar, ShieldOff, ArrowDownCircle, ArrowUpCircle, ListChecks } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

export default function Ledger() {
  const perm = usePermission('page:/accounts/ledger');
  const { data: accounts = [] } = useListAccountsFlat();
  const [accountId, setAccountId] = useState<string>('');
  const now = new Date();
  const [fromDate, setFromDate] = useState(`${now.getFullYear()}-01-01`);
  const [toDate, setToDate] = useState(now.toISOString().split('T')[0]);
  // Global location selector narrows the statement to that location's slice of
  // the books. The generated hook serialises every key of its params object
  // into the query string AND the cache key, so spreading the extra params is
  // both transport and cache-correct (the generated type just doesn't know
  // about them — hence the cast).
  const { locationState } = useLocationContext();
  const locParams = locationFilterParams(locationState);

  const { data: statement, isLoading } = useGetLedgerStatement(
    {
      ...(accountId && fromDate && toDate ? { accountId: Number(accountId), fromDate, toDate } : { accountId: 0, fromDate, toDate }),
      ...locParams,
    } as any,
    { query: { enabled: !!accountId } as any }
  );

  const entries = (statement as any)?.entries || (statement as any)?.transactions || [];

  const { sorted, sort } = useTableSort(entries as any[], {
    date: (e: any) => e.date,
    description: (e: any) => e.description,
    type: (e: any) => e.entryType,
    debit: (e: any) => Number(e.debit) || null,
    credit: (e: any) => Number(e.credit) || null,
  });

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view this page.<br />
              Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Ledger Statement"
          description="Account-wise debit / credit statement"
          icon={FileText}
          actions={perm.canDownload && (
            <Button variant="outline" size="sm" disabled={!entries.length} onClick={() => downloadCSV('ledger.csv', entries.map((e: any) => ({ Date: e.date, Description: e.description, Debit: e.debit || 0, Credit: e.credit || 0, Balance: e.balance || 0 })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
          )}
        />

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <AccountCombobox
            className="w-60"
            placeholder="Select account"
            options={(accounts as any[])
              .filter((a: any) => !a.isGroup)
              // Fold the code into the display name so the search box matches
              // on either — "[STD-SALES] Sales" is findable by code or name.
              .map((a: any) => ({ id: a.id, name: `${a.code ? `[${a.code}] ` : ''}${a.name}` }))}
            value={Number(accountId) || 0}
            onChange={id => setAccountId(String(id))}
          />
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
            <span className="text-muted-foreground">to</span>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
          </div>
        </div>

        {statement && (
          <SummaryCardGrid>
            <SummaryCard label="Opening Balance" value={`₹${Number(statement.openingBalance || 0).toLocaleString('en-IN')}`} icon={ArrowDownCircle} tone="info" loading={isLoading} />
            <SummaryCard label="Closing Balance" value={`₹${Number(statement.closingBalance || 0).toLocaleString('en-IN')}`} icon={ArrowUpCircle} tone="info" loading={isLoading} />
            <SummaryCard label="Entries" value={String(entries.length)} icon={ListChecks} tone="default" loading={isLoading} />
          </SummaryCardGrid>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {!accountId ? (
            <EmptyState icon={FileText} title="Select an account to view statement" />
          ) : isLoading ? (
            <TableSkeleton rows={5} cols={6} />
          ) : entries.length === 0 ? (
            <EmptyState icon={FileText} title="No entries for this period" />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="description" sort={sort}>Description</SortableHead>
                <SortableHead k="type" sort={sort}>Type</SortableHead>
                <SortableHead k="debit" sort={sort} className="text-right">Debit</SortableHead>
                <SortableHead k="credit" sort={sort} className="text-right">Credit</SortableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((e: any, i: number) => (
                <TableRow key={i} className="hover:bg-muted/10">
                  <TableCell className="text-sm">{new Date(e.date).toLocaleDateString('en-IN')}</TableCell>
                  <TableCell className="text-sm">{e.description}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs capitalize">{e.entryType}</Badge></TableCell>
                  <TableCell className="text-right font-mono text-red-500">{e.debit ? `₹${Number(e.debit).toLocaleString('en-IN')}` : '—'}</TableCell>
                  <TableCell className="text-right font-mono text-emerald-500">{e.credit ? `₹${Number(e.credit).toLocaleString('en-IN')}` : '—'}</TableCell>
                  <TableCell className="text-right font-mono font-bold">₹{Number(e.balance || 0).toLocaleString('en-IN')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
