import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { useOutletsEnabled, useClearOutletSelection } from '@/lib/useFeatureFlags';
import { useLocationContext } from '@/lib/locationContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  useGetBankLedgers, useGetBankTransactions, useReconcileCashBankEntry,
  useListOutlets, useListWarehouses,
} from '@workspace/api-client-react';
import { toast } from 'sonner';
import { CheckSquare, Landmark, Wallet } from 'lucide-react';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';

const SOURCE_LABEL: Record<string, string> = {
  payment: 'Payment',
  receipt: 'Receipt',
  sale: 'Sale',
  purchase: 'Purchase',
  expense: 'Expense',
  journal: 'Journal',
  contra: 'Contra',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
};

function fmt(n: number) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateValue(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export default function Reconciliation() {
  const perm = usePermission('page:/accounts/reconciliation');
  const { outletsEnabled } = useOutletsEnabled();
  const { locationState } = useLocationContext();
  const [locationFilter, setLocationFilter] = useState('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'reconciled' | 'unreconciled'>('all');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState(dateValue(30));
  const [toDate, setToDate] = useState(dateValue());
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // The page has its own location filter for explicit, auditable account
  // selection. The global selector is still sent by the client as a header.
  useClearOutletSelection(locationFilter.startsWith('outlet:'), () => setLocationFilter('all'));
  const { data: outlets = [] } = useListOutlets();
  const { data: warehouses = [] } = useListWarehouses();
  const [filterType, filterId] = locationFilter !== 'all' ? locationFilter.split(':') : [];
  const locationId = filterId ? Number(filterId) : undefined;
  const { data: bankLedgers = [], isLoading: accountsLoading } = useGetBankLedgers({
    locationType: filterType,
    locationId,
  });
  const { data: transactions = [], isLoading: transactionsLoading } = useGetBankTransactions({
    locationType: filterType,
    locationId,
    bankAccountId: accountFilter !== 'all' ? Number(accountFilter) : undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    search: search.trim() || undefined,
  });
  const reconcileMutation = useReconcileCashBankEntry();

  const visibleTransactions = transactions.filter((t) =>
    statusFilter === 'all' || t.reconciliationStatus === statusFilter,
  );
  const { sorted, sort } = useTableSort(visibleTransactions, {
    date: t => t.date,
    source: t => SOURCE_LABEL[t.source] ?? t.source,
    voucher: t => t.voucherNumber,
    counterparty: t => t.counterpartyName,
    account: t => t.accountName,
    location: t => t.accountLocationName,
    debit: t => Number(t.debit),
    credit: t => Number(t.credit),
    status: t => t.reconciliationStatus,
  });
  const { pageRows, pagerProps } = useClientPage(sorted);

  const unreconciledAmount = transactions
    .filter(t => t.reconciliationStatus !== 'reconciled')
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const reconciledAmount = transactions
    .filter(t => t.reconciliationStatus === 'reconciled')
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);

  async function handleReconcile(entry: typeof transactions[number], checked: boolean) {
    if (!entry.reconciliationEligible || busyKey === entry.id) return;
    if (!checked && !window.confirm('Unreconcile this transaction?')) return;
    setBusyKey(entry.id);
    try {
      await reconcileMutation.mutateAsync({
        entryId: entry.entryId,
        ledgerId: entry.ledgerId,
        reconciled: checked,
      });
      toast.success(checked ? 'Transaction reconciled.' : 'Transaction unreconciled.');
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Unable to update reconciliation status.');
    } finally {
      setBusyKey(null);
    }
  }

  function changeLocation(value: string) {
    setLocationFilter(value);
    // Account ids are location-specific. Never leave a hidden account selected
    // after changing the location.
    setAccountFilter('all');
  }

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <CheckSquare className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Reconciliation.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4">
        <PageHeader
          title="Bank Reconciliation"
          description="Reconcile the actual transactions in each Cash & Bank account"
          icon={CheckSquare}
        />

        <SummaryCardGrid>
          <SummaryCard label="Transactions" value={String(transactions.length)} icon={Landmark} loading={transactionsLoading} />
          <SummaryCard label="Unreconciled" value={fmt(unreconciledAmount)} icon={Wallet} tone="warning" loading={transactionsLoading} />
          <SummaryCard label="Reconciled" value={fmt(reconciledAmount)} icon={CheckSquare} tone="positive" loading={transactionsLoading} />
          <SummaryCard label="Bank Accounts" value={String(bankLedgers.length)} icon={Landmark} loading={accountsLoading} />
        </SummaryCardGrid>

        <div className="flex flex-wrap gap-2 items-center">
          <Input
            placeholder="Search voucher, customer, vendor…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 w-60 max-md:w-full"
          />
          <Select value={locationFilter} onValueChange={changeLocation}>
            <SelectTrigger className="h-9 w-48"><SelectValue placeholder="All locations" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              <SelectItem value="headoffice">Head Office</SelectItem>
              {warehouses.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Warehouses</SelectLabel>
                  {warehouses.map((w: any) => (
                    <SelectItem key={`warehouse:${w.id}`} value={`warehouse:${w.id}`}>{w.name}</SelectItem>
                  ))}
                </SelectGroup>
              )}
              {outletsEnabled && outlets.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Outlets</SelectLabel>
                  {outlets.map((o: any) => (
                    <SelectItem key={`outlet:${o.id}`} value={`outlet:${o.id}`}>{o.name}</SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          <Select value={accountFilter} onValueChange={setAccountFilter}>
            <SelectTrigger className="h-9 w-64"><SelectValue placeholder="All bank accounts" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All bank accounts</SelectItem>
              {bankLedgers.map(account => (
                <SelectItem key={account.accountId} value={String(account.accountId)}>
                  {account.name} · {account.locationName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-9 w-36" />
          <span className="text-sm text-muted-foreground">to</span>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-9 w-36" />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            aria-label="Reconciliation status"
          >
            <option value="all">All statuses</option>
            <option value="unreconciled">Unreconciled</option>
            <option value="reconciled">Reconciled</option>
          </select>
        </div>

        {locationState.locationName && locationFilter === 'all' && (
          <p className="text-xs text-muted-foreground">
            The account list is authorized by Cash &amp; Bank assignments. Use <span className="font-medium">All locations</span> to include Head Office and every assigned branch account.
          </p>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {transactionsLoading ? (
            <TableSkeleton rows={8} cols={10} />
          ) : visibleTransactions.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No bank transactions"
              hint="Transactions in assigned bank and UPI accounts will appear here. Cash accounts are excluded."
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Reconcile</TableHead>
                    <SortableHead k="date" sort={sort}>Date</SortableHead>
                    <SortableHead k="source" sort={sort}>Type</SortableHead>
                    <SortableHead k="voucher" sort={sort}>Voucher</SortableHead>
                    <SortableHead k="counterparty" sort={sort}>Customer / Vendor</SortableHead>
                    <SortableHead k="account" sort={sort}>Bank Account</SortableHead>
                    <SortableHead k="location" sort={sort}>Location</SortableHead>
                    <SortableHead k="debit" sort={sort} className="text-right">In</SortableHead>
                    <SortableHead k="credit" sort={sort} className="text-right">Out</SortableHead>
                    <SortableHead k="status" sort={sort}>Status</SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map(t => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Checkbox
                          checked={t.reconciliationStatus === 'reconciled'}
                          disabled={!perm.canEdit || busyKey === t.id}
                          onCheckedChange={value => handleReconcile(t, value === true)}
                          aria-label={`${t.reconciliationStatus === 'reconciled' ? 'Unreconcile' : 'Reconcile'} ${t.voucherNumber || t.entryId}`}
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{t.date}</TableCell>
                      <TableCell className="text-sm">{SOURCE_LABEL[t.source] ?? t.source}</TableCell>
                      <TableCell className="font-mono text-xs">{t.voucherNumber || t.entryId}</TableCell>
                      <TableCell className="text-sm">{t.counterpartyName ?? <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-sm">
                        <div className={t.reconciliationEligible ? undefined : 'text-amber-600'}>{t.accountName}</div>
                        <div className="text-[11px] text-muted-foreground">{t.description}</div>
                      </TableCell>
                      <TableCell className="text-sm">{t.accountLocationName}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-emerald-600">{t.debit > 0 ? fmt(t.debit) : '—'}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-red-500">{t.credit > 0 ? fmt(t.credit) : '—'}</TableCell>
                      <TableCell>
                        <span className={`text-xs px-2 py-0.5 rounded border font-medium ${
                          t.reconciliationStatus === 'reconciled'
                            ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                            : 'bg-amber-500/10 text-amber-600 border-amber-500/20'
                        }`}>
                          {t.reconciliationStatus === 'reconciled' ? 'Reconciled' : 'Unreconciled'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="px-4 border-t border-border">
                <TablePager {...pagerProps} />
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}