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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useGetBankLedgers, useGetBankTransactions, useCreateBankReconciliationBatch,
  useGetBankReconciliationAudit, useGetBankReconciliationBatches,
  useGetBankReconciliationBatch, useUpdateBankReconciliationBatch,
  useResetBankReconciliation,
  useGetReconciliationPendingQueue, useSettlePendingReconciliationQueue,
  useListOutlets, useListWarehouses,
} from '@workspace/api-client-react';
import {
  CREATE_SALE_PAYMENT_MODES, ONLINE_PAYMENT_MODES, paymentModeLabel,
} from '@/lib/paymentModes';
import { toast } from 'sonner';
import { trackEvent } from '@/lib/analytics';
import { CheckSquare, Landmark, Wallet, AlertTriangle, Pencil, RotateCcw, Search, ChevronDown } from 'lucide-react';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { ExportButtons, type ReportDoc, pdfMoney } from '@/pages/reports/shared';
import { FilterPanel } from '@/components/app/filter-panel';

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

const RECONCILIATION_CATEGORIES = CREATE_SALE_PAYMENT_MODES.map(value => ({
  value,
  label: paymentModeLabel(value),
}));

type ReconciliationCategory = typeof CREATE_SALE_PAYMENT_MODES[number];

function categoryForAccountType(accountType: string): ReconciliationCategory {
  const normalized = accountType.toLowerCase();
  if (normalized === 'cash') return 'cash';
  if (normalized === 'upi') return 'upi';
  if ((ONLINE_PAYMENT_MODES as readonly string[]).includes(normalized)) return 'online';
  return 'bank';
}

function categoryForPending(method: string): ReconciliationCategory {
  const normalized = method.toLowerCase();
  if (normalized === 'cash') return 'cash';
  if (normalized === 'upi') return 'upi';
  if ((ONLINE_PAYMENT_MODES as readonly string[]).includes(normalized)) return 'online';
  return 'bank';
}

function categoryLabel(category: ReconciliationCategory) {
  return RECONCILIATION_CATEGORIES.find(option => option.value === category)?.label ?? category;
}

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
  const [activeSection, setActiveSection] = useState<'to-reconcile' | 'reconciled'>('to-reconcile');
  const [selectedCategories, setSelectedCategories] = useState<Set<ReconciliationCategory>>(new Set());
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<number>>(new Set());
  const [selectedPlatformIds, setSelectedPlatformIds] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [editBatchId, setEditBatchId] = useState<number | null>(null);
  const [batchBankAccountId, setBatchBankAccountId] = useState('');
  const [reconciliationDate, setReconciliationDate] = useState(localDateValue);
  const [processingCharge, setProcessingCharge] = useState('0');
  const [pendingSelected, setPendingSelected] = useState<Set<string>>(new Set());
  const [pendingOpen, setPendingOpen] = useState(false);
  const [pendingBankAccountId, setPendingBankAccountId] = useState('');
  const [pendingDate, setPendingDate] = useState(localDateValue);

  // The page has its own location filter for explicit, auditable account
  // selection. The global selector is still sent by the client as a header.
  useClearOutletSelection(locationFilter.startsWith('outlet:'), () => setLocationFilter('all'));
  const { data: outlets = [] } = useListOutlets();
  const { data: warehouses = [] } = useListWarehouses();
  const [filterType, filterId] = locationFilter !== 'all' ? locationFilter.split(':') : [];
  const locationId = filterType === 'headoffice' ? 0 : filterId ? Number(filterId) : undefined;
  const { data: bankLedgers = [], isLoading: bankLedgersLoading } = useGetBankLedgers({
    locationType: filterType,
    locationId,
  });
  const { data: transactionResult, isLoading: transactionsLoading } = useGetBankTransactions({
    locationType: filterType,
    locationId,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    search: search.trim() || undefined,
  });
  const { data: pendingQueue = [], isLoading: pendingQueueLoading } = useGetReconciliationPendingQueue({
    locationType: filterType,
    locationId,
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
    setBatchBankAccountId(String(editingBatch.bankAccountId));
    setReconciliationDate(editingBatch.reconciliationDate);
    setProcessingCharge(String(editingBatch.processingCharge));
    setLocationFilter(
      editingBatch.locationType === 'headoffice'
        ? 'headoffice'
        : `${editingBatch.locationType}:${editingBatch.locationId}`,
    );
    setActiveSection('to-reconcile');
    setSelectedCategories(new Set());
    setSelectedAccountIds(new Set([Number(editingBatch.bankAccountId)]));
    setSelectedPlatformIds(new Set());
    setFromDate('');
    setToDate('');
    setSearch('');
  }, [editingBatch, editBatchId]);

  useEffect(() => {
    if (editBatchId == null) setSelectedKeys(new Set());
    setPendingSelected(new Set());
  }, [
    filterType, locationId, fromDate, toDate, search, activeSection,
    selectedCategories, selectedAccountIds, selectedPlatformIds, editBatchId,
  ]);

  const authoritativeTotals = transactionResult?.totals;
  const unreconciledAmount = authoritativeTotals?.unreconciledAmount ?? 0;
  const reconciledAmount = authoritativeTotals?.reconciledAmount ?? 0;

  const editingItemKeys = new Set(
    editingBatch?.items.map(item => `${item.ledgerId}:${item.entryId}`) ?? [],
  );
  const isEditableBatchItem = (t: typeof transactions[number]) =>
    editBatchId != null && editingItemKeys.has(t.id);
  const matchesCategory = (category: ReconciliationCategory) =>
    selectedCategories.size === 0 || selectedCategories.has(category);
  const onlineAccounts = bankLedgers.filter(account => account.accountType === 'online');
  const visibleTransactions = transactions.filter(t => {
    const category = categoryForAccountType(String(t.accountType));
    const statusMatches = editBatchId != null
      || (activeSection === 'reconciled'
        ? t.reconciliationStatus === 'reconciled'
        : t.reconciliationStatus !== 'reconciled');
    return statusMatches
      && matchesCategory(category)
      && (selectedAccountIds.size === 0 || selectedAccountIds.has(Number(t.accountId)))
      && (selectedPlatformIds.size === 0
        || (t.accountType === 'online' && selectedPlatformIds.has(Number(t.ledgerId))));
  });
  const visiblePendingQueue = activeSection === 'to-reconcile' && editBatchId == null
    ? pendingQueue.filter(item => {
      const category = categoryForPending(String(item.method));
      return matchesCategory(category)
        && (selectedPlatformIds.size === 0
          || (item.platformLedgerId != null && selectedPlatformIds.has(Number(item.platformLedgerId))));
    })
    : [];
  const selectableVisible = visibleTransactions.filter(t =>
    t.reconciliationEligible
      && (t.reconciliationStatus !== 'reconciled' || isEditableBatchItem(t)),
  );
  const selectedTransactions = transactions.filter(t => selectedKeys.has(t.id));
  const selectedGross = selectedTransactions.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const selectedAccountId = selectedTransactions[0]?.accountId ?? null;
  const selectedMixedAccounts = selectedTransactions.some(t => t.accountId !== selectedAccountId);
  // Batch creation must stay attached to the exact Cash & Bank account that
  // owns the selected ledger postings. Keep the selector's options consistent
  // with the server's ledger-identity validation.
  const reconciliationBankAccounts = selectedTransactions.length > 0
    ? bankLedgers.filter(account =>
        Number(account.accountId) === Number(selectedAccountId)
        && Number(account.ledgerId) === Number(selectedTransactions[0].ledgerId))
    : [];
  const selectedBatchAccountIsValid = reconciliationBankAccounts.some(
    account => String(account.accountId) === batchBankAccountId,
  );
  const reconciliationRows = [
    ...visibleTransactions.map(t => ({
      key: `ledger:${t.id}`,
      kind: 'ledger' as const,
      category: categoryForAccountType(String(t.accountType)),
      date: t.date,
      source: SOURCE_LABEL[t.source] ?? t.source,
      voucher: t.voucherNumber || t.entryId,
      counterparty: t.counterpartyName ?? '—',
      account: t.accountName,
      detail: t.description,
      location: t.accountLocationName,
      debit: Number(t.debit),
      credit: Number(t.credit),
      amount: Number(t.amount),
      status: t.reconciliationStatus === 'reconciled' ? 'Reconciled' : 'To reconcile',
      ledger: t,
      pending: null,
    })),
    ...visiblePendingQueue.map(item => ({
      key: `pending:${item.key}`,
      kind: 'pending' as const,
      category: categoryForPending(String(item.method)),
      date: item.transactionDate,
      source: paymentModeLabel(item.method),
      voucher: item.voucherNumber || item.invoiceNumber || `${item.kind} #${item.id}`,
      counterparty: item.partyName ?? item.customerName ?? '—',
      account: item.platformName ?? 'Electronic clearing',
      detail: item.referenceNumber ?? item.narration ?? '',
      location: item.locationType === 'headoffice'
        ? 'Head Office'
        : `${item.locationType} #${item.locationId}`,
      debit: item.direction === 'in' ? Number(item.amount) : 0,
      credit: item.direction === 'out' ? Number(item.amount) : 0,
      amount: Number(item.amount),
      status: 'Awaiting settlement',
      ledger: null,
      pending: item,
    })),
  ];
  const { sorted: sortedRows, sort } = useTableSort(reconciliationRows, {
    date: row => row.date,
    category: row => categoryLabel(row.category),
    source: row => row.source,
    voucher: row => row.voucher,
    counterparty: row => row.counterparty,
    account: row => row.account,
    location: row => row.location,
    debit: row => row.debit,
    credit: row => row.credit,
    status: row => row.status,
  });
  const { pageRows, pagerProps } = useClientPage(sortedRows);
  const visibleBatches = batches.filter(batch => {
    const locationMatches = locationFilter === 'all'
      || (locationFilter === 'headoffice'
        ? batch.locationType === 'headoffice'
        : `${batch.locationType}:${batch.locationId}` === locationFilter);
    const dateMatches = (!fromDate || batch.reconciliationDate >= fromDate)
      && (!toDate || batch.reconciliationDate <= toDate);
    const searchNeedle = search.trim().toLowerCase();
    const searchMatches = !searchNeedle || [
      batch.batchReference,
      batch.bankAccountName,
      batch.locationName,
    ].some(value => String(value ?? '').toLowerCase().includes(searchNeedle));
    return locationMatches
      && dateMatches
      && searchMatches
      && (selectedAccountIds.size === 0 || selectedAccountIds.has(Number(batch.bankAccountId)));
  });
  const { pageRows: batchPageRows, pagerProps: batchPagerProps } = useClientPage(visibleBatches);

  const reconciliationDoc = (): ReportDoc => ({
    title: 'Bank Reconciliation',
    subtitle: `${fromDate ? formatDateOrDash(fromDate) : 'All dates'} to ${toDate ? formatDateOrDash(toDate) : 'All dates'}`,
    orientation: 'landscape',
    metaRows: [
      ['Transactions', String(reconciliationRows.length)],
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
      rows: reconciliationRows.map(row => [
        formatDateOrDash(row.date), row.account, `${categoryLabel(row.category)} · ${row.source}`,
        formatGstDocumentDisplayNumber(row.voucher),
        row.counterparty, row.location, row.debit, row.credit, row.amount, row.status,
      ]),
      totalsRow: ['', '', '', '', '', 'TOTAL', '', '',
        Number(reconciliationRows.reduce((sum, row) => sum + row.amount, 0)), ''],
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
    if (!batchBankAccountId || !selectedBatchAccountIsValid) {
      toast.error('Select the Bank Account that contains the selected transactions.');
      return;
    }
    try {
      const transactionsPayload = selectedTransactions.map(t => ({ entryId: t.entryId, ledgerId: t.ledgerId }));
      if (editBatchId != null) {
        await updateBatchMutation.mutateAsync({
          id: editBatchId,
          data: { transactions: transactionsPayload, reconciliationDate, processingCharge },
        });
      } else {
        await createBatchMutation.mutateAsync({
          bankAccountId: Number(batchBankAccountId),
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
    setBatchBankAccountId('');
    setActiveSection('to-reconcile');
    setReconciliationDate(localDateValue());
    setProcessingCharge('0');
    setBatchOpen(true);
  }

  function openEditBatch(batchId: number) {
    setSelectedKeys(new Set());
    setBatchBankAccountId('');
    setEditBatchId(batchId);
    setActiveSection('to-reconcile');
    setBatchOpen(true);
  }

  function changeLocation(value: string) {
    setLocationFilter(value);
    // Account and platform ids are location-specific. Never leave hidden filters selected.
    setSelectedAccountIds(new Set());
    setSelectedPlatformIds(new Set());
  }

  function toggleCategoryFilter(category: ReconciliationCategory, checked: boolean) {
    setSelectedCategories(previous => {
      const next = previous.size === 0
        ? new Set(RECONCILIATION_CATEGORIES.map(option => option.value))
        : new Set(previous);
      if (checked) next.add(category); else next.delete(category);
      return next.size === RECONCILIATION_CATEGORIES.length ? new Set() : next;
    });
  }

  function toggleAccountFilter(accountId: number, checked: boolean) {
    setSelectedAccountIds(previous => {
      const next = previous.size === 0
        ? new Set(bankLedgers.map(account => Number(account.accountId)))
        : new Set(previous);
      if (checked) next.add(accountId); else next.delete(accountId);
      return next.size === bankLedgers.length ? new Set() : next;
    });
  }

  function togglePlatformFilter(ledgerId: number, checked: boolean) {
    setSelectedPlatformIds(previous => {
      const next = previous.size === 0
        ? new Set(onlineAccounts.map(account => Number(account.ledgerId)))
        : new Set(previous);
      if (checked) next.add(ledgerId); else next.delete(ledgerId);
      return next.size === onlineAccounts.length ? new Set() : next;
    });
  }

  function clearFilters() {
    setLocationFilter('all');
    setSelectedCategories(new Set());
    setSelectedAccountIds(new Set());
    setSelectedPlatformIds(new Set());
    setFromDate('');
    setToDate('');
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

        <SummaryCardGrid>
          <SummaryCard label="Eligible transactions" value={String(authoritativeTotals?.eligibleCount ?? 0)} icon={Landmark} loading={transactionsLoading} />
          <SummaryCard label="Unreconciled bank activity" value={fmt(unreconciledAmount)} icon={Wallet} tone="warning" loading={transactionsLoading} />
          <SummaryCard label="Reconciled bank activity" value={fmt(reconciledAmount)} icon={CheckSquare} tone="positive" loading={transactionsLoading} />
          <SummaryCard label="Pending collections" value={String(pendingQueue.length)} icon={Wallet} tone="info" loading={pendingQueueLoading} />
        </SummaryCardGrid>

        <div className="space-y-3">
          <div className="relative w-full">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search voucher, customer, vendor…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-9 pl-9"
              data-testid="input-reconciliation-search"
            />
          </div>
          <FilterPanel
            className="w-full"
            defaultOpen
            activeCount={
              Number(locationFilter !== 'all')
              + Number(selectedCategories.size > 0 && selectedCategories.size < RECONCILIATION_CATEGORIES.length)
              + Number(selectedAccountIds.size > 0 && selectedAccountIds.size < bankLedgers.length)
              + Number(selectedPlatformIds.size > 0 && selectedPlatformIds.size < onlineAccounts.length)
              + Number(Boolean(fromDate))
              + Number(Boolean(toDate))
            }
            onClear={clearFilters}
          >
            <label className="space-y-1 text-xs font-medium">
              <span>Location</span>
              <Select value={locationFilter} onValueChange={changeLocation}>
                <SelectTrigger className="h-9 w-full" data-testid="filter-reconciliation-location"><SelectValue placeholder="All locations" /></SelectTrigger>
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
            </label>

            <div className="space-y-1 text-xs font-medium">
              <span>Payment modes</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-9 w-full justify-between text-sm font-normal" data-testid="filter-reconciliation-categories">
                    {selectedCategories.size === 0 || selectedCategories.size === RECONCILIATION_CATEGORIES.length
                      ? 'All payment modes'
                      : `${selectedCategories.size} modes`}
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-2">
                  {RECONCILIATION_CATEGORIES.map(option => (
                    <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted">
                      <Checkbox
                        checked={selectedCategories.size === 0 || selectedCategories.has(option.value)}
                        onCheckedChange={checked => toggleCategoryFilter(option.value, checked === true)}
                        data-testid={`filter-category-${option.value}`}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-1 text-xs font-medium">
              <span>Bank accounts</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-9 w-full justify-between text-sm font-normal" data-testid="filter-reconciliation-accounts">
                    {selectedAccountIds.size === 0 || selectedAccountIds.size === bankLedgers.length
                      ? 'All accounts'
                      : `${selectedAccountIds.size} accounts`}
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 p-2">
                  <div className="max-h-64 space-y-1 overflow-y-auto">
                    {bankLedgers.map(account => (
                      <label key={account.accountId} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted">
                        <Checkbox
                          checked={selectedAccountIds.size === 0 || selectedAccountIds.has(Number(account.accountId))}
                          onCheckedChange={checked => toggleAccountFilter(Number(account.accountId), checked === true)}
                          data-testid={`filter-account-${account.accountId}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{account.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{account.locationName}</span>
                      </label>
                    ))}
                    {bankLedgers.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">No accounts available.</p> : null}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-1 text-xs font-medium">
              <span>Online platforms</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-9 w-full justify-between text-sm font-normal" data-testid="filter-reconciliation-platforms">
                    {selectedPlatformIds.size === 0 || selectedPlatformIds.size === onlineAccounts.length
                      ? 'All platforms'
                      : `${selectedPlatformIds.size} platforms`}
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 p-2">
                  <div className="max-h-64 space-y-1 overflow-y-auto">
                    {onlineAccounts.map(account => (
                      <label key={account.ledgerId} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm hover:bg-muted">
                        <Checkbox
                          checked={selectedPlatformIds.size === 0 || selectedPlatformIds.has(Number(account.ledgerId))}
                          onCheckedChange={checked => togglePlatformFilter(Number(account.ledgerId), checked === true)}
                          data-testid={`filter-platform-${account.ledgerId}`}
                        />
                        <span className="min-w-0 flex-1 truncate">{account.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{account.locationName}</span>
                      </label>
                    ))}
                    {onlineAccounts.length === 0 ? <p className="px-2 py-3 text-sm text-muted-foreground">No online platforms available.</p> : null}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <label className="space-y-1 text-xs font-medium">
              <span>From date</span>
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-9" data-testid="filter-reconciliation-from-date" />
            </label>
            <label className="space-y-1 text-xs font-medium">
              <span>To date</span>
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-9" data-testid="filter-reconciliation-to-date" />
            </label>
          </FilterPanel>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!perm.canEdit || selectedTransactions.length === 0 || selectedMixedAccounts}
              onClick={openCreateBatch}
              data-testid="button-reconcile-selected"
            >
              <CheckSquare className="mr-2 h-4 w-4" />
              Reconcile selected{selectedTransactions.length ? ` (${selectedTransactions.length})` : ''}
            </Button>
            {selectedPendingRows.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!perm.canEdit}
                onClick={openPendingReconciliation}
                data-testid="button-settle-selected"
              >
                <Wallet className="mr-2 h-4 w-4" />
                Settle selected ({selectedPendingRows.length})
              </Button>
            ) : null}
            {perm.canDelete ? (
              <Button
                size="sm"
                variant="outline"
                disabled={resetMutation.isPending}
                onClick={resetReconciliation}
                data-testid="button-reset-reconciliation"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                {resetMutation.isPending ? 'Resetting…' : 'Reset reconciliation'}
              </Button>
            ) : null}
            <ExportButtons
              canDownload={perm.canDownload}
              disabled={transactionsLoading || pendingQueueLoading || reconciliationRows.length === 0}
              doc={reconciliationDoc}
            />
          </div>
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

        <Tabs
          value={activeSection}
          onValueChange={value => setActiveSection(value as typeof activeSection)}
          data-testid="tabs-reconciliation-section"
        >
          <TabsList>
            <TabsTrigger value="to-reconcile" data-testid="tab-to-reconcile">To reconcile</TabsTrigger>
            <TabsTrigger value="reconciled" data-testid="tab-reconciled">Reconciled &amp; settled</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {transactionsLoading || (activeSection === 'to-reconcile' && pendingQueueLoading) ? (
            <TableSkeleton rows={8} cols={10} />
          ) : reconciliationRows.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title={activeSection === 'reconciled' ? 'No reconciled transactions' : 'No transactions to reconcile'}
              hint={activeSection === 'reconciled'
                ? 'Completed bank reconciliations will appear here.'
                : 'Eligible account activity and pending electronic collections will appear here.'}
            />
          ) : (
            <>
              <div className="space-y-2 p-3 md:hidden">
                {pageRows.map(row => {
                  const isLedgerRow = row.kind === 'ledger';
                  const ledger = row.ledger;
                  const pending = row.pending;
                  const checked = isLedgerRow
                    ? !!ledger && selectedKeys.has(ledger.id)
                    : !!pending && pendingSelected.has(pending.key);
                  const disabled = !perm.canEdit || (isLedgerRow
                    ? !ledger?.reconciliationEligible
                      || (ledger?.reconciliationStatus === 'reconciled' && !isEditableBatchItem(ledger))
                    : false);
                  return (
                    <article key={`mobile-${row.key}`} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          className="mt-1"
                          checked={checked}
                          disabled={disabled}
                          onCheckedChange={value => {
                            if (isLedgerRow && ledger) toggleSelected(ledger, value === true);
                            else if (!isLedgerRow && pending) togglePending(pending, value === true);
                          }}
                          aria-label={`Select ${row.voucher}`}
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted-foreground">{formatDateOrDash(row.date)}</span>
                            <span className="rounded border px-2 py-0.5 text-xs">{categoryLabel(row.category)}</span>
                            <StatusBadge status={row.status} />
                          </div>
                          <div className="font-mono text-xs">{formatGstDocumentDisplayNumber(row.voucher)}</div>
                          <div className="truncate text-sm">{row.counterparty}</div>
                        </div>
                      </div>
                      <div className="mt-3 border-t border-border pt-2 text-xs">
                        <div className="font-medium">{row.account}</div>
                        {row.detail ? <div className="text-muted-foreground">{row.detail}</div> : null}
                        <div className="text-muted-foreground">{row.location}</div>
                      </div>
                      <div className="mt-3 flex justify-between gap-3 text-sm">
                        <span className="text-emerald-600">In {row.debit > 0 ? fmt(row.debit) : '—'}</span>
                        <span className="text-red-500">Out {row.credit > 0 ? fmt(row.credit) : '—'}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">
                      <Checkbox
                        checked={selectableVisible.length > 0 && selectableVisible.every(t => selectedKeys.has(t.id))}
                        onCheckedChange={value => toggleAll(value === true)}
                        disabled={!perm.canEdit || selectableVisible.length === 0}
                        aria-label="Select visible eligible bank transactions"
                      />
                    </TableHead>
                    <SortableHead k="date" sort={sort}>Date</SortableHead>
                    <SortableHead k="category" sort={sort}>Category</SortableHead>
                    <SortableHead k="source" sort={sort}>Type</SortableHead>
                    <SortableHead k="voucher" sort={sort}>Document</SortableHead>
                    <SortableHead k="counterparty" sort={sort}>Party</SortableHead>
                    <SortableHead k="account" sort={sort}>Account / platform</SortableHead>
                    <SortableHead k="location" sort={sort}>Location</SortableHead>
                    <SortableHead k="debit" sort={sort} className="text-right">In</SortableHead>
                    <SortableHead k="credit" sort={sort} className="text-right">Out</SortableHead>
                    <SortableHead k="status" sort={sort}>Status</SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map(row => {
                    const isLedgerRow = row.kind === 'ledger';
                    const ledger = row.ledger;
                    const pending = row.pending;
                    const checked = isLedgerRow
                      ? !!ledger && selectedKeys.has(ledger.id)
                      : !!pending && pendingSelected.has(pending.key);
                    const disabled = !perm.canEdit || (isLedgerRow
                      ? !ledger?.reconciliationEligible
                        || (ledger?.reconciliationStatus === 'reconciled' && !isEditableBatchItem(ledger))
                      : false);
                    return (
                      <TableRow key={row.key}>
                        <TableCell>
                          <Checkbox
                            checked={checked}
                            disabled={disabled}
                            onCheckedChange={value => {
                              if (isLedgerRow && ledger) toggleSelected(ledger, value === true);
                              else if (!isLedgerRow && pending) togglePending(pending, value === true);
                            }}
                            aria-label={`Select ${row.voucher}`}
                          />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateOrDash(row.date)}</TableCell>
                        <TableCell>
                          <span className="rounded border px-2 py-0.5 text-xs font-medium">{categoryLabel(row.category)}</span>
                        </TableCell>
                        <TableCell className="text-sm">{row.source}</TableCell>
                        <TableCell className="font-mono text-xs">{formatGstDocumentDisplayNumber(row.voucher)}</TableCell>
                        <TableCell className="text-sm">{row.counterparty}</TableCell>
                        <TableCell className="text-sm">
                          <div>{row.account}</div>
                          {row.detail ? <div className="text-[11px] text-muted-foreground">{row.detail}</div> : null}
                        </TableCell>
                        <TableCell className="text-sm">{row.location}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-emerald-600">{row.debit > 0 ? fmt(row.debit) : '—'}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-red-500">{row.credit > 0 ? fmt(row.credit) : '—'}</TableCell>
                        <TableCell><StatusBadge status={row.status} /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </div>
              <div className="border-t border-border px-4">
                <TablePager {...pagerProps} />
              </div>
            </>
          )}
        </div>

        {activeSection === 'reconciled' ? (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="font-semibold">Settled batches</h2>
              <p className="text-xs text-muted-foreground">
                Account reconciliation batches are review-only. Pending clearing settlements are accounting postings.
              </p>
            </div>
            {visibleBatches.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted-foreground">No settled batches match the current location, account, date, and search filters.</p>
            ) : (
              <>
                <div className="space-y-2 p-3 md:hidden">
                  {batchPageRows.map(batch => (
                    <article key={`mobile-batch-${batch.id}`} className="rounded-lg border border-border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-mono text-xs">{batch.batchReference}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{formatDateOrDash(batch.reconciliationDate)}</div>
                        </div>
                        <StatusBadge status={batch.status} />
                      </div>
                      <div className="mt-3 text-sm font-medium">{batch.bankAccountName}</div>
                      <div className="text-xs text-muted-foreground">{batch.locationName}</div>
                      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-2 text-xs">
                        <div><span className="text-muted-foreground">Type</span><div>{batch.accountingImpact === 'none' ? 'Review-only' : 'Settlement posting'}</div></div>
                        <div><span className="text-muted-foreground">Items</span><div>{batch.itemCount}</div></div>
                        <div><span className="text-muted-foreground">Gross</span><div className="font-mono">{fmt(batch.grossAmount)}</div></div>
                        <div><span className="text-muted-foreground">Charge</span><div className="font-mono">{fmt(batch.processingCharge)}</div></div>
                        <div><span className="text-muted-foreground">Net</span><div className="font-mono">{fmt(batch.netAmount)}</div></div>
                      </div>
                      {perm.canEdit && batch.status === 'active' && batch.accountingImpact === 'none' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3 h-8 w-full"
                          onClick={() => openEditBatch(batch.id)}
                        >
                          <Pencil className="mr-1 h-3.5 w-3.5" />
                          Edit batch
                        </Button>
                      ) : null}
                    </article>
                  ))}
                </div>
                <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Batch</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Bank account</TableHead>
                      <TableHead>Settlement type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">Charge</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead className="w-24">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batchPageRows.map(batch => (
                      <TableRow key={batch.id}>
                        <TableCell className="font-mono text-xs">{batch.batchReference}</TableCell>
                        <TableCell className="text-xs">{formatDateOrDash(batch.reconciliationDate)}</TableCell>
                        <TableCell className="text-sm">{batch.bankAccountName} · {batch.locationName}</TableCell>
                        <TableCell className="text-sm">
                          {batch.accountingImpact === 'none' ? 'Review-only' : 'Settlement posting'}
                        </TableCell>
                        <TableCell className="text-sm capitalize">{batch.status}</TableCell>
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
                              <Pencil className="mr-1 h-3.5 w-3.5" />
                              Edit
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
                <div className="border-t border-border px-4">
                  <TablePager {...batchPagerProps} />
                </div>
              </>
            )}
          </div>
        ) : null}

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
                <div className="space-y-1.5">
                  <label htmlFor="reconciliation-bank-account" className="text-muted-foreground">
                    Bank Account <span className="text-destructive">*</span>
                  </label>
                  <Select
                    value={batchBankAccountId}
                    onValueChange={setBatchBankAccountId}
                    disabled={editBatchId != null || bankLedgersLoading || reconciliationBankAccounts.length === 0}
                  >
                    <SelectTrigger
                      id="reconciliation-bank-account"
                      className="h-9"
                      data-testid="select-reconciliation-bank-account"
                    >
                      <SelectValue placeholder={
                        bankLedgersLoading
                          ? 'Loading bank accounts…'
                          : reconciliationBankAccounts.length === 0
                            ? 'No matching bank account'
                            : 'Select bank account'
                      } />
                    </SelectTrigger>
                    <SelectContent>
                      {reconciliationBankAccounts.map(account => (
                        <SelectItem key={account.accountId} value={String(account.accountId)}>
                          {account.name} · {account.locationName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Choose the account that owns the selected transactions.
                  </p>
                </div>
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
              <Button
                onClick={submitBatch}
                disabled={
                  createBatchMutation.isPending
                  || updateBatchMutation.isPending
                  || !reconciliationDate
                  || selectedMixedAccounts
                  || !batchBankAccountId
                  || !selectedBatchAccountIsValid
                }
              >
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