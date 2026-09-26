import { useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { useOutletsEnabled, useClearOutletSelection } from '@/lib/useFeatureFlags';
import { useLocationContext } from '@/lib/locationContext';
import { formatGstDocumentDisplayNumber } from '@/lib/invoiceNumber';
import { formatDateOrDash } from '@/lib/date';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  useGetBankLedgers, useGetBankTransactions, useCreateBankReconciliationBatch,
  useGetBankReconciliationAudit, useGetBankReconciliationBatches,
  useGetBankReconciliationBatch, useUpdateBankReconciliationBatch,
  useResetBankReconciliation,
  useGetReconciliationPendingQueue, useSettlePendingReconciliationQueue,
  useListOutlets, useListWarehouses,
} from '@workspace/api-client-react';
import { paymentModeLabel } from '@/lib/paymentModes';
import { toast } from 'sonner';
import { trackEvent } from '@/lib/analytics';
import { CheckSquare, Landmark, Wallet, AlertTriangle, Pencil, RotateCcw } from 'lucide-react';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { ExportButtons, type ReportDoc, pdfMoney } from '@/pages/reports/shared';

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

function localDateValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function Reconciliation() {
  const perm = usePermission('page:/accounts/reconciliation');
  const { outletsEnabled } = useOutletsEnabled();
  const { locationState } = useLocationContext();
  const [locationFilter, setLocationFilter] = useState('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'reconciled' | 'unreconciled'>('all');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [editBatchId, setEditBatchId] = useState<number | null>(null);
  const [reconciliationDate, setReconciliationDate] = useState(localDateValue);
  const [processingCharge, setProcessingCharge] = useState('0');
  const [pendingSelected, setPendingSelected] = useState<Set<string>>(new Set());
  const [pendingOpen, setPendingOpen] = useState(false);
  const [pendingBankAccountId, setPendingBankAccountId] = useState('');
  const [pendingDate, setPendingDate] = useState(localDateValue);
  const [pendingMethod, setPendingMethod] = useState('all');
  const [pendingPlatform, setPendingPlatform] = useState('all');

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
  const { data: transactionResult, isLoading: transactionsLoading } = useGetBankTransactions({
    locationType: filterType,
    locationId,
    bankAccountId: accountFilter !== 'all' ? Number(accountFilter) : undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    search: search.trim() || undefined,
  });
  const { data: pendingQueue = [], isLoading: pendingQueueLoading } = useGetReconciliationPendingQueue({
    locationType: filterType,
    locationId,
    method: pendingMethod !== 'all' ? pendingMethod : undefined,
    platformLedgerId: pendingMethod === 'online' && pendingPlatform !== 'all' ? pendingPlatform : undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    search: search.trim() || undefined,
  });
  const transactions = transactionResult?.transactions ?? [];
  const createBatchMutation = useCreateBankReconciliationBatch();
  const updateBatchMutation = useUpdateBankReconciliationBatch();
  const { data: audit } = useGetBankReconciliationAudit();
  const { data: batches = [] } = useGetBankReconciliationBatches();
  const { data: editingBatch } = useGetBankReconciliationBatch(editBatchId ?? 0, {
    enabled: editBatchId != null,
  });
  const resetMutation = useResetBankReconciliation();
  const settlePendingMutation = useSettlePendingReconciliationQueue();
  const selectedPendingRows = pendingQueue.filter(v => pendingSelected.has(v.key));
  const pendingLocation = selectedPendingRows.length > 0
    ? { type: selectedPendingRows[0].locationType, id: selectedPendingRows[0].locationId }
    : { type: undefined, id: undefined };
  const { data: pendingBankLedgers = [] } = useGetBankLedgers({
    locationType: pendingLocation.type,
    locationId: pendingLocation.id,
  });
  const settlementBankLedgers = pendingBankLedgers.filter(account => account.accountType === 'bank');
  const pendingPlatforms = bankLedgers
    .filter(account => account.accountType === 'online')
    .reduce((map, account) => map.set(String(account.ledgerId), account.name), new Map<string, string>());
  const selectedPendingGross = selectedPendingRows.reduce(
    (sum, item) => sum + Math.abs(Math.round(Number(item.amount) * 100)),
    0,
  ) / 100;
  const selectedPendingNet = selectedPendingRows.reduce(
    (sum, item) => sum + (item.direction === 'out' ? -1 : 1) * Math.round(Number(item.amount) * 100),
    0,
  ) / 100;

  useEffect(() => {
    if (!editingBatch || editBatchId == null) return;
    setSelectedKeys(new Set(editingBatch.items.map(item => `${item.ledgerId}:${item.entryId}`)));
    setReconciliationDate(editingBatch.reconciliationDate);
    setProcessingCharge(String(editingBatch.processingCharge));
    setLocationFilter(
      editingBatch.locationType === 'headoffice'
        ? 'headoffice'
        : `${editingBatch.locationType}:${editingBatch.locationId}`,
    );
    setAccountFilter(String(editingBatch.bankAccountId));
    setStatusFilter('all');
    setFromDate('');
    setToDate('');
    setSearch('');
  }, [editingBatch, editBatchId]);

  useEffect(() => {
    setPendingSelected(new Set());
  }, [filterType, locationId, fromDate, toDate, search, pendingMethod, pendingPlatform]);

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

  const authoritativeTotals = transactionResult?.totals;
  const unreconciledAmount = authoritativeTotals?.unreconciledAmount ?? 0;
  const reconciledAmount = authoritativeTotals?.reconciledAmount ?? 0;

  const editingItemKeys = new Set(
    editingBatch?.items.map(item => `${item.ledgerId}:${item.entryId}`) ?? [],
  );
  const isEditableBatchItem = (t: typeof transactions[number]) =>
    editBatchId != null && editingItemKeys.has(t.id);
  const selectableVisible = visibleTransactions.filter(t =>
    t.reconciliationEligible
      && (t.reconciliationStatus !== 'reconciled' || isEditableBatchItem(t)),
  );
  const selectedTransactions = transactions.filter(t => selectedKeys.has(t.id));
  const selectedGross = selectedTransactions.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const selectedAccountId = selectedTransactions[0]?.accountId ?? null;
  const selectedMixedAccounts = selectedTransactions.some(t => t.accountId !== selectedAccountId);
  const reconciliationDoc = (): ReportDoc => ({
    title: 'Bank Reconciliation',
    subtitle: `${fromDate ? formatDateOrDash(fromDate) : 'All dates'} to ${toDate ? formatDateOrDash(toDate) : 'All dates'}`,
    orientation: 'landscape',
    metaRows: [
      ['Transactions', String(visibleTransactions.length)],
      ['Unreconciled', pdfMoney(unreconciledAmount)],
      ['Reconciled', pdfMoney(reconciledAmount)],
    ],
    sections: [{
      columns: [
        { label: 'Date' }, { label: 'Account', width: 1.5 }, { label: 'Source' },
        { label: 'Voucher', width: 1.2 }, { label: 'Description', width: 2.2 },
        { label: 'Location', width: 1.3 }, { label: 'Debit', align: 'right' },
        { label: 'Credit', align: 'right' }, { label: 'Amount', align: 'right' }, { label: 'Status' },
      ],
      rows: visibleTransactions.map((t) => [
        formatDateOrDash(t.date), t.accountName, SOURCE_LABEL[t.source] ?? t.source, formatGstDocumentDisplayNumber(t.voucherNumber ?? '-'),
        t.description || t.counterpartyName || '-', t.accountLocationName,
        Number(t.debit), Number(t.credit), Number(t.amount), t.reconciliationStatus,
      ]),
      totalsRow: ['', '', '', '', '', 'TOTAL', '', '', Number(visibleTransactions.reduce((s, t) => s + Number(t.amount || 0), 0)), ''],
    }],
  });

  function toggleSelected(entry: typeof transactions[number], checked: boolean) {
    if (!entry.reconciliationEligible
      || (entry.reconciliationStatus === 'reconciled' && !isEditableBatchItem(entry))) return;
    if (checked && selectedAccountId != null && entry.accountId !== selectedAccountId) {
      toast.error('A reconciliation batch can contain only one bank account.');
      return;
    }
    setSelectedKeys(previous => {
      const next = new Set(previous);
      if (checked) next.add(entry.id); else next.delete(entry.id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    if (!checked) {
      setSelectedKeys(previous => {
        const next = new Set(previous);
        selectableVisible.forEach(t => next.delete(t.id));
        return next;
      });
      return;
    }
    const first = selectedTransactions[0] ?? selectableVisible[0];
    if (!first?.accountId) return;
    const sameAccount = selectableVisible.filter(t => t.accountId === first.accountId);
    setSelectedKeys(previous => {
      const next = new Set(previous);
      sameAccount.forEach(t => next.add(t.id));
      return next;
    });
  }

  async function submitBatch() {
    if (!selectedTransactions.length || !selectedAccountId || selectedMixedAccounts) return;
    try {
      const transactionsPayload = selectedTransactions.map(t => ({ entryId: t.entryId, ledgerId: t.ledgerId }));
      if (editBatchId != null) {
        await updateBatchMutation.mutateAsync({
          id: editBatchId,
          data: { transactions: transactionsPayload, reconciliationDate, processingCharge },
        });
      } else {
        await createBatchMutation.mutateAsync({
          bankAccountId: selectedAccountId,
          transactions: transactionsPayload,
          reconciliationDate,
          processingCharge,
        });
      }
      setSelectedKeys(new Set());
      setBatchOpen(false);
      setEditBatchId(null);
      setProcessingCharge('0');
      trackEvent('bank_reconciliation_saved', {
        operation: editBatchId != null ? 'edit' : 'create',
        transaction_count: transactionsPayload.length,
        has_processing_charge: Number(processingCharge) > 0,
      });
      toast.success(editBatchId != null ? 'Bank reconciliation batch updated.' : 'Bank reconciliation batch created.');
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Unable to reconcile selected transactions.');
    }
  }

  function openCreateBatch() {
    setEditBatchId(null);
    setSelectedKeys(new Set());
    setReconciliationDate(localDateValue());
    setProcessingCharge('0');
    setBatchOpen(true);
  }

  function openEditBatch(batchId: number) {
    setSelectedKeys(new Set());
    setEditBatchId(batchId);
    setBatchOpen(true);
  }

  function changeLocation(value: string) {
    setLocationFilter(value);
    // Account ids are location-specific. Never leave a hidden account selected
    // after changing the location.
    setAccountFilter('all');
  }

  function togglePending(voucher: typeof pendingQueue[number], checked: boolean) {
    const key = voucher.key;
    if (checked && selectedPendingRows.length > 0) {
      const first = selectedPendingRows[0];
      if (first.locationType !== voucher.locationType || first.locationId !== voucher.locationId) {
        toast.error('Reconcile vouchers from one warehouse or outlet at a time.');
        return;
      }
    }
    setPendingSelected(previous => {
      const next = new Set(previous);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  function openPendingReconciliation() {
    setPendingDate(localDateValue());
    setPendingBankAccountId('');
    setPendingOpen(true);
  }

  async function submitPendingReconciliation() {
    if (!selectedPendingRows.length || !pendingBankAccountId || !pendingDate) return;
    try {
      await settlePendingMutation.mutateAsync({
        bankAccountId: Number(pendingBankAccountId),
        reconciliationDate: pendingDate,
        items: selectedPendingRows.map(v => ({
          kind: v.kind,
          id: v.id,
          voucherKind: v.voucherKind,
        })),
      });
      setPendingSelected(new Set());
      setPendingOpen(false);
      toast.success('Selected pending items were settled in one bank batch.');
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Unable to settle pending items.');
    }
  }

  async function resetReconciliation() {
    const confirmed = window.confirm(
      'Reset reconciliation? This reverses reconciliation-created postings, unlinks reconciled records, restores originals to pending review, and preserves the originals and audit trail.',
    );
    if (!confirmed) return;
    try {
      const result = await resetMutation.mutateAsync({ reversalDate: localDateValue() }) as { reconciledEntriesReset: number };
      setSelectedKeys(new Set());
      setEditBatchId(null);
      setBatchOpen(false);
      toast.success(
        'Reset complete: reconciliation postings were reversed, links were cleared, and the original documents were preserved.',
      );
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Unable to reset reconciliation state.');
    }
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

        <div className="rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-amber-500/20">
            <div>
              <h2 className="font-semibold">Pending reconciliation queue</h2>
              <p className="text-xs text-muted-foreground">
                Bank vouchers and electronic collections can be selected together and settled as one bank entry.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={pendingMethod} onValueChange={setPendingMethod}>
                <SelectTrigger className="h-9 w-40"><SelectValue placeholder="Payment mode" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All modes</SelectItem><SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="upi">UPI</SelectItem><SelectItem value="bank">Bank</SelectItem><SelectItem value="online">Online</SelectItem>
                </SelectContent>
              </Select>
              {pendingMethod === 'online' ? (
                <Select value={pendingPlatform} onValueChange={setPendingPlatform}>
                  <SelectTrigger className="h-9 w-48"><SelectValue placeholder="Online platform" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All platforms</SelectItem><SelectItem value="unassigned">Unassigned / legacy</SelectItem>
                    {[...pendingPlatforms.entries()].map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : null}
              <Button
                size="sm"
                disabled={!perm.canEdit || selectedPendingRows.length === 0}
                onClick={openPendingReconciliation}
              >
                <Wallet className="w-4 h-4 mr-2" />
                Settle selected{selectedPendingRows.length ? ` (${selectedPendingRows.length})` : ''}
              </Button>
            </div>
          </div>
          {pendingQueueLoading ? (
            <div className="px-4 py-5 text-sm text-muted-foreground">Loading pending items…</div>
          ) : pendingQueue.length === 0 ? (
            <div className="px-4 py-5 text-sm text-muted-foreground">No pending reconciliation items.</div>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead className="w-12"></TableHead>
                <TableHead>Date</TableHead><TableHead>Mode</TableHead><TableHead>Document</TableHead>
                <TableHead>Party</TableHead><TableHead>Location</TableHead>
                <TableHead>Reference</TableHead><TableHead className="text-right">Amount</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {pendingQueue.map(payment => (
                  <TableRow key={payment.key}>
                    <TableCell>
                      <Checkbox
                        checked={pendingSelected.has(payment.key)}
                        onCheckedChange={checked => togglePending(payment, checked === true)}
                        disabled={!perm.canEdit}
                        aria-label={`Select ${payment.voucherNumber || payment.invoiceNumber || payment.key}`}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateOrDash(payment.transactionDate)}</TableCell>
                    <TableCell className="text-sm font-medium">{paymentModeLabel(payment.method)}</TableCell>
                    <TableCell className="font-mono text-xs">{formatGstDocumentDisplayNumber(payment.voucherNumber || payment.invoiceNumber || `${payment.kind} #${payment.id}`)}</TableCell>
                    <TableCell className="text-sm">{payment.partyName ?? payment.customerName ?? '—'}</TableCell>
                    <TableCell className="text-sm">{payment.locationType === 'headoffice' ? 'Head Office' : `${payment.locationType} #${payment.locationId}`}</TableCell>
                    <TableCell className="font-mono text-xs">{payment.referenceNumber ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(payment.direction === 'out' ? -Number(payment.amount) : Number(payment.amount))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <SummaryCardGrid>
          <SummaryCard label="Eligible transactions" value={String(authoritativeTotals?.eligibleCount ?? 0)} icon={Landmark} loading={transactionsLoading} />
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
          <Button
            size="sm"
            className="h-9"
            disabled={!perm.canEdit || selectedTransactions.length === 0 || selectedMixedAccounts}
            onClick={openCreateBatch}
          >
            <CheckSquare className="w-4 h-4 mr-2" />
            Reconcile Selected{selectedTransactions.length ? ` (${selectedTransactions.length})` : ''}
          </Button>
          {perm.canDelete ? (
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              disabled={resetMutation.isPending}
              onClick={resetReconciliation}
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              {resetMutation.isPending ? 'Resetting…' : 'Reset reconciliation'}
            </Button>
          ) : null}
          <ExportButtons
            canDownload={perm.canDownload}
            disabled={transactionsLoading || visibleTransactions.length === 0}
            doc={reconciliationDoc}
          />
        </div>

        {audit?.undetermined?.length ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{audit.undetermined.length} historical bank posting(s) have no Cash &amp; Bank account assignment and are excluded from selectable totals.</span>
          </div>
        ) : null}

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
                    <TableHead className="w-20">
                      <Checkbox
                        checked={selectableVisible.length > 0 && selectableVisible.every(t => selectedKeys.has(t.id))}
                        onCheckedChange={value => toggleAll(value === true)}
                        disabled={!perm.canEdit || selectableVisible.length === 0}
                        aria-label="Select all visible unreconciled transactions"
                      />
                    </TableHead>
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
                          checked={selectedKeys.has(t.id)}
                          disabled={!perm.canEdit
                            || !t.reconciliationEligible
                            || (t.reconciliationStatus === 'reconciled' && !isEditableBatchItem(t))}
                          onCheckedChange={value => toggleSelected(t, value === true)}
                          aria-label={`Select ${t.voucherNumber || t.entryId}`}
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDateOrDash(t.date)}</TableCell>
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

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="font-semibold">Recent reconciliation batches</h2>
            <p className="text-xs text-muted-foreground">Standard batches are metadata-only; deferred and unified settlements post to the selected bank account.</p>
          </div>
          {batches.length === 0 ? (
            <p className="px-4 py-5 text-sm text-muted-foreground">No bank reconciliation batches yet.</p>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Batch</TableHead><TableHead>Date</TableHead><TableHead>Bank account</TableHead><TableHead className="text-right">Gross</TableHead><TableHead className="text-right">Charge</TableHead><TableHead className="text-right">Net</TableHead><TableHead>Items</TableHead><TableHead className="w-24">Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {batches.slice(0, 10).map(batch => (
                  <TableRow key={batch.id}>
                    <TableCell className="font-mono text-xs">{batch.batchReference}</TableCell>
                    <TableCell className="text-xs">{formatDateOrDash(batch.reconciliationDate)}</TableCell>
                    <TableCell className="text-sm">{batch.bankAccountName} · {batch.locationName}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(batch.grossAmount)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(batch.processingCharge)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(batch.netAmount)}</TableCell>
                    <TableCell className="text-sm">{batch.itemCount}</TableCell>
                    <TableCell>
                      {perm.canEdit && batch.status === 'active' && batch.accountingImpact === 'none' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8"
                          onClick={() => openEditBatch(batch.id)}
                        >
                          <Pencil className="w-3.5 h-3.5 mr-1" />
                          Edit
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
            <DialogTitle>{editBatchId != null ? 'Edit reconciliation batch' : 'Reconcile selected transactions'}</DialogTitle>
              <DialogDescription>
              {editBatchId != null
                ? 'Replace the reviewed transactions or update the batch metadata. Removed transactions become unreconciled. Accounting postings are not changed.'
                : 'This creates one review batch and updates reconciliation status. It does not create or alter accounting postings.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted-foreground">Transactions</span><div className="font-semibold">{selectedTransactions.length}</div></div>
                <div><span className="text-muted-foreground">Bank account</span><div className="font-semibold">{selectedTransactions[0]?.accountName ?? '—'}</div></div>
                <div><span className="text-muted-foreground">Gross amount</span><div className="font-semibold">{fmt(selectedGross)}</div></div>
                <div><span className="text-muted-foreground">Net amount</span><div className="font-semibold">{fmt(Math.max(0, selectedGross - Number(processingCharge || 0)))}</div></div>
              </div>
              <label className="space-y-1 block text-sm">
                <span className="font-medium">Reconciliation date</span>
                <Input type="date" value={reconciliationDate} onChange={e => setReconciliationDate(e.target.value)} />
              </label>
              <label className="space-y-1 block text-sm">
                <span className="font-medium">Processing charge</span>
                <Input inputMode="decimal" value={processingCharge} onChange={e => setProcessingCharge(e.target.value)} placeholder="0.00" />
                <span className="text-xs text-muted-foreground">Stored as batch metadata; it does not reduce the original transactions.</span>
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBatchOpen(false)}>Cancel</Button>
              <Button onClick={submitBatch} disabled={createBatchMutation.isPending || updateBatchMutation.isPending || !reconciliationDate || selectedMixedAccounts}>
                {createBatchMutation.isPending || updateBatchMutation.isPending
                  ? 'Saving…'
                  : editBatchId != null ? 'Save batch changes' : 'Confirm reconciliation'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={pendingOpen} onOpenChange={setPendingOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Settle pending reconciliation items</DialogTitle>
              <DialogDescription>
                This posts one bank settlement entry for the selected vouchers and collections.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted-foreground">Items</span><div className="font-semibold">{selectedPendingRows.length}</div></div>
                <div><span className="text-muted-foreground">Gross selected</span><div className="font-semibold">{fmt(selectedPendingGross)}</div></div>
                <div><span className="text-muted-foreground">Net bank entry</span><div className="font-semibold">{fmt(selectedPendingNet)}</div></div>
              </div>
              <label className="space-y-1 block text-sm">
                <span className="font-medium">Permitted bank account</span>
                <Select value={pendingBankAccountId} onValueChange={setPendingBankAccountId}>
                  <SelectTrigger><SelectValue placeholder="Select the warehouse bank account" /></SelectTrigger>
                  <SelectContent>
                    {settlementBankLedgers.map(account => (
                      <SelectItem key={account.accountId} value={String(account.accountId)}>
                        {account.name} · {account.locationName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!settlementBankLedgers.length ? <span className="text-xs text-destructive">No permitted bank account is assigned to this location.</span> : null}
              </label>
              <label className="space-y-1 block text-sm">
                <span className="font-medium">Reconciliation date</span>
                <Input type="date" value={pendingDate} onChange={e => setPendingDate(e.target.value)} />
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingOpen(false)}>Cancel</Button>
              <Button
                onClick={submitPendingReconciliation}
                disabled={settlePendingMutation.isPending || !pendingBankAccountId || !pendingDate || !selectedPendingRows.length}
              >
                {settlePendingMutation.isPending ? 'Posting…' : 'Confirm settlement'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

      </div>
    </AppLayout>
  );
}