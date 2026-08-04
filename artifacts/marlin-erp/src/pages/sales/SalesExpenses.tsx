import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import { customFetch, useListOutlets, useListWarehouses, useDeleteLocationExpense, useGetCashInOutlet, attachmentViewUrl } from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { entryScopeKeyDown, autoFocusFirst, focusField, useEntryShortcuts } from '@/lib/keyboard-entry';
import { downloadPDFFromEndpoint } from '@/lib/download';
import { Receipt, Plus, Calendar, Wallet, AlertCircle, Layers, Trash2, Loader2, ShieldOff, AlertTriangle, Printer, Paperclip, Landmark, Clock } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { toast } from 'sonner';

/** Payment methods, in the order they appear in the form. */
const PAYMENT_MODES = [
  { value: 'cash',   label: 'Cash',   hint: "Paid from this location's till" },
  { value: 'bank',   label: 'Bank',   hint: 'Paid from a company bank account' },
  { value: 'credit', label: 'Credit', hint: 'Not paid yet — recorded as Expense Payable' },
] as const;

const schema = z.object({
  // Held as "warehouse:3" / "outlet:1" so one Select can span both kinds.
  location:         z.string().min(1, 'Select a location'),
  expenseLedgerId:  z.coerce.number().min(1, 'Select an expense account'),
  description:      z.string().min(1, 'Description required'),
  amount:           z.coerce.number().min(0.01, 'Amount must be > 0'),
  expenseDate:      z.string().min(1, 'Date required'),
  reference:        z.string().optional(),
  paymentMode:      z.enum(['cash', 'bank', 'credit']),
  paymentAccountId: z.coerce.number().optional(),
  notes:            z.string().optional(),
}).refine(d => d.paymentMode !== 'bank' || Number(d.paymentAccountId ?? 0) > 0, {
  message: 'Select the bank account it was paid from',
  path: ['paymentAccountId'],
});
type FormValues = z.infer<typeof schema>;

/**
 * Flags the payment method in a list, but only when it is not Cash: cash is the
 * norm here, so tagging every row would be noise. "Unpaid" rather than "Credit"
 * because what matters at a glance is that money is still owed.
 */
function PaymentModeTag({ mode }: { mode?: string }) {
  if (mode === 'bank') return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-blue-500/10 text-blue-600">
      Bank
    </span>
  );
  if (mode === 'credit') return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-500/10 text-amber-600">
      Unpaid
    </span>
  );
  return null;
}

const TODAY = new Date().toISOString().split('T')[0];

const fmt = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

/**
 * Print the payment voucher for a location expense. The server builds it from
 * the row id, so the printed figures always match the books.
 */
async function printVoucher(id: number, label?: string) {
  try {
    await downloadPDFFromEndpoint(
      '/api/pdf/expense-voucher',
      { source: 'location', id },
      `expense-voucher-${(label || id).toString().replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`,
    );
  } catch (e: any) {
    toast.error(e?.message ?? 'Could not generate the voucher');
  }
}

export default function SalesExpenses() {
  const [, navigate] = useLocation();
  const { locationState } = useLocationContext();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const scopeRef = useRef<HTMLFormElement>(null);
  const perm = usePermission('page:/sales/expenses');
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const deleteMutation = useDeleteLocationExpense();
  const { outletsEnabled } = useOutletsEnabled();
  const { data: warehouses = [] } = useListWarehouses();

  // Bank accounts for the Bank payment method. The endpoint is LBAC-scoped: a
  // branch sees only its own till and so gets an empty bank list, which is
  // exactly when Bank must not be offered. The UI therefore reads the
  // availability off the data instead of guessing at the user's branch.
  const { data: cashBankLedgers = [] } = useQuery<any[]>({
    queryKey: ['cash-bank-ledgers'],
    queryFn: () => customFetch('/api/accounts/cash-bank-ledgers'),
    retry: false,
  });
  const bankAccounts = (() => {
    const list = cashBankLedgers as any[];
    const root = list.find(l => l.code === 'STD-BANK');
    if (!root) return [] as any[];
    const ids = new Set<number>([root.id]);
    for (let i = 0; i < 4; i++) {
      for (const l of list) if (l.parentId && ids.has(l.parentId)) ids.add(l.id);
    }
    // The root itself is the group heading, never a payable account.
    return list.filter(l => ids.has(l.id) && l.id !== root.id);
  })();

  const { locationType, locationId, locationName } = locationState;
  const isAll       = locationType === 'all';
  const isWarehouse = locationType === 'warehouse' && !!locationId && !isAll;
  const isSpecific  = !isAll && !!locationType && !!locationId;

  // Cash balance for the current specific location (used to cap expense amount)
  const { data: allCashBalances = [] } = useGetCashInOutlet();
  const locationCash = isSpecific
    ? (allCashBalances as any[]).find(b => b.locationType === locationType && b.locationId === locationId)
    : null;
  const availableCash: number = locationCash ? Number(locationCash.availableBalance ?? 0) : 0;

  // Redirect only if nothing is selected
  useEffect(() => {
    if (!locationType) navigate('/sales');
  }, [locationType, navigate]);

  // Child outlets for warehouse mode
  const { data: outlets = [] } = useListOutlets();
  const childOutletIds = isWarehouse
    ? new Set((outlets as any[]).filter(o => Number(o.warehouseId) === locationId).map(o => o.id))
    : new Set<number>();

  // Expense category ledgers
  const { data: expenseLedgers = [] } = useQuery<any[]>({
    queryKey: ['expense-ledgers'],
    queryFn: () => customFetch('/api/accounts/expense-ledgers'),
  });

  // All-locations endpoint (for 'all' and warehouse modes)
  const { data: allLocExpenses = [], isLoading: loadingAll } = useQuery<any[]>({
    queryKey: ['location-expenses-all'],
    queryFn: () => customFetch('/api/accounts/location-expenses/all'),
    enabled: isAll || isWarehouse,
  });

  // Single-location endpoint (for specific location)
  const expensesQueryKey = ['location-expenses', locationType, locationId];
  const { data: expenseData, isLoading: loadingSingle, error: expensesError } = useQuery<{
    cashLedgerId: number; cashLedgerName: string; expenses: any[];
  }>({
    queryKey: expensesQueryKey,
    queryFn: () => customFetch(`/api/accounts/location-expenses?locationType=${locationType}&locationId=${locationId}`),
    enabled: isSpecific,
  });

  const isLoading = isAll || isWarehouse ? loadingAll : loadingSingle;

  // -- Derive displayed expenses --
  let expenses: any[] = [];
  let totalExpenses = 0;

  if (isAll) {
    expenses = allLocExpenses as any[];
    totalExpenses = expenses.reduce((s, e) => s + Number(e.amount ?? 0), 0);
  } else if (isWarehouse) {
    expenses = (allLocExpenses as any[]).filter(e =>
      (e.locationType === 'warehouse' && Number(e.locationId) === locationId) ||
      (e.locationType === 'outlet'    && childOutletIds.has(Number(e.locationId)))
    );
    totalExpenses = expenses.reduce((s, e) => s + Number(e.amount ?? 0), 0);
  } else {
    expenses = expenseData?.expenses ?? [];
    totalExpenses = expenses.reduce((s, e) => s + Number(e.amount ?? 0), 0);
  }

  // Group expenses by location for all/warehouse multi-location views
  function groupExpenses(list: any[]) {
    const map = new Map<string, { locationType: string; locationId: number; locationName: string; expenses: any[]; total: number }>();
    for (const e of list) {
      const key = `${e.locationType}-${e.locationId}`;
      if (!map.has(key)) map.set(key, { locationType: e.locationType, locationId: Number(e.locationId), locationName: e.locationName ?? `${e.locationType} #${e.locationId}`, expenses: [], total: 0 });
      const grp = map.get(key)!;
      grp.expenses.push(e);
      grp.total += Number(e.amount ?? 0);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }

  const showGrouped = isAll || isWarehouse;
  const grouped     = showGrouped ? groupExpenses(expenses) : [];

  // Single-location listing sort. Grouped (all/warehouse) view is left as-is:
  // it is a hierarchical location grouping (one table per location, ordered by
  // spend), so sorting is scoped to the flat single-location table only.
  const { sorted: sortedExpenses, sort } = useTableSort(expenses, {
    date: r => r.expenseDate,
    description: r => r.description,
    category: r => r.category || 'Uncategorised',
    account: r => r.expenseLedgerName,
    voucher: r => r.voucherNumber,
    amount: r => Number(r.amount),
  });

  const cashLedgerName: string | null = isSpecific ? (expenseData?.cashLedgerName ?? null) : null;

  // The form carries its own location, so an expense can be recorded from the
  // All-locations view as well. Outlets appear only while Outlet Management is
  // enabled; warehouses are always available.
  const locationOptions = [
    ...(warehouses as any[]).map(w => ({ key: `warehouse:${w.id}`, label: w.name, kind: 'Warehouse', cashLedgerId: w.cashLedgerId ?? null })),
    ...(outletsEnabled
      ? (outlets as any[]).map(o => ({ key: `outlet:${o.id}`, label: o.name, kind: 'Outlet', cashLedgerId: o.cashLedgerId ?? null }))
      : []),
  ];
  const defaultLocationKey = isSpecific
    ? `${locationType}:${locationId}`
    : (locationOptions[0]?.key ?? '');

  const blankForm: FormValues = {
    location: defaultLocationKey,
    expenseLedgerId: 0, description: '', amount: 0, expenseDate: TODAY,
    reference: '',
    paymentMode: 'cash', paymentAccountId: 0, notes: '',
  };
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: blankForm,
  });

  const watchAmount = form.watch('amount');
  const watchMode   = form.watch('paymentMode');
  const watchLoc    = form.watch('location');
  const amountNum   = Number(watchAmount) || 0;

  // Cash checks follow the location chosen *in the form*, not the page filter,
  // so recording from the All-locations view still checks the right till.
  const [formLocType, formLocIdRaw] = (watchLoc || '').split(':');
  const formLocId = Number(formLocIdRaw);
  const selectedOption = locationOptions.find(o => o.key === watchLoc);
  // Matched by cash ledger first, and only by location second. An outlet that is
  // mirrored as a warehouse row shares one till, and the balances endpoint
  // reports that till under a single identity — matching on the pair alone would
  // read ₹0 for the other identity and block a spend the location can afford.
  const formCash = (() => {
    const list = allCashBalances as any[];
    if (selectedOption?.cashLedgerId) {
      const byLedger = list.find(b => Number(b.cashLedgerId) === Number(selectedOption.cashLedgerId));
      if (byLedger) return byLedger;
    }
    return list.find(b => b.locationType === formLocType && Number(b.locationId) === formLocId) ?? null;
  })();
  // Without a resolved ledger the balance is unknown, not zero — so say nothing
  // and let the server decide rather than blocking a legitimate entry.
  const hasKnownCash = !!formCash?.cashLedgerId;
  const formAvailableCash: number = hasKnownCash ? Number(formCash.availableBalance ?? 0) : 0;
  // Only Cash is capped: Bank draws on a company account and Credit moves nothing.
  const overBalance = watchMode === 'cash' && hasKnownCash && amountNum > formAvailableCash + 0.001;

  const openAdd = () => {
    form.reset({ ...blankForm, location: defaultLocationKey });
    setIsOpen(true);
  };

  // ── Keyboard Entry Mode ──
  const save = () => {
    if (submitting || overBalance || (watchMode === 'cash' && hasKnownCash && formAvailableCash <= 0)) return;
    form.handleSubmit(onSubmit, (errors) => {
      const first = ['location', 'paymentMode', 'paymentAccountId', 'expenseLedgerId', 'description', 'amount', 'expenseDate']
        .find(f => (errors as any)[f]);
      if (first) focusField(first, scopeRef.current);
    })();
  };
  useEntryShortcuts(isOpen, { onSave: save });

  const onSubmit = async (data: FormValues) => {
    const [locType, locIdRaw] = data.location.split(':');
    setSubmitting(true);
    try {
      await customFetch('/api/accounts/location-expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationType: locType,
          locationId: Number(locIdRaw),
          expenseLedgerId: data.expenseLedgerId,
          amount: data.amount,
          expenseDate: data.expenseDate,
          description: data.description,
          reference: data.reference || undefined,
          paymentMode: data.paymentMode,
          paymentAccountId: data.paymentMode === 'bank' ? data.paymentAccountId : undefined,
          notes: data.notes || undefined,
        }),
      });
      toast.success('Expense recorded');
      queryClient.invalidateQueries({ queryKey: expensesQueryKey });
      queryClient.invalidateQueries({ queryKey: ['location-expenses-all'] });
      setIsOpen(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to record expense');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast.success('Expense deleted — cash returned to the location ledger');
      // Refresh both the page queries and any lib-hook consumers
      queryClient.invalidateQueries({ queryKey: ['location-expenses-all'] });
      queryClient.invalidateQueries({ queryKey: ['location-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['/api/accounts/location-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['/api/accounts/location-expenses/summary'] });
      setDeleteTarget(null);
    } catch (err: any) {
      toast.error(err?.data?.error ?? err?.message ?? 'Failed to delete expense');
    }
  };

  if (!locationType) return null;

  const hasCashLedgerError = !isAll && !isWarehouse && (
    (expensesError as any)?.message?.includes('no Cash ledger') ||
    (expensesError as any)?.response?.status === 404
  );

  const title    = isAll ? 'Expenses — All Locations' : `Expenses — ${locationName}`;
  const subtitle = isAll
    ? 'All expense entries across every warehouse and outlet'
    : isWarehouse
    ? `Expenses for ${locationName} and its outlets`
    : null;

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
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Receipt className="w-6 h-6 text-primary" />
              {title}
            </h1>
            {subtitle && <p className="text-muted-foreground mt-1 text-sm">{subtitle}</p>}
            {isSpecific && (
              <p className="text-muted-foreground mt-1 flex items-center gap-2 text-sm">
                <Wallet className="w-3.5 h-3.5" />
                {cashLedgerName ? <>Paid from: <span className="font-medium">{cashLedgerName}</span></> : 'Loading payment source…'}
              </p>
            )}
          </div>
          {/* Always offered: the form carries its own location, so this works
              from the All-locations view too — and Bank/Credit expenses do not
              need the location to have a till. */}
          {perm.canAdd && locationOptions.length > 0 && (
            <Button onClick={openAdd}>
              <Plus className="w-4 h-4 mr-2" /> Add Expense
            </Button>
          )}
        </div>

        {/* No cash ledger warning */}
        {hasCashLedgerError && (
          <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/20 rounded-xl text-sm">
            <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-destructive">No Cash ledger assigned to this location</p>
              <p className="text-muted-foreground mt-0.5">
                Go to <strong>Accounts → Warehouses</strong> (or Outlets), open this location, and click <strong>Provision Ledgers</strong> to set up its Cash account.
              </p>
            </div>
          </div>
        )}

        {/* Summary strip */}
        {expenses.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4 flex flex-wrap gap-4 items-center">
            {showGrouped ? (
              <>
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Layers className="w-4 h-4" />
                  <span>{grouped.length} location{grouped.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex-1" />
                <span className="text-muted-foreground text-sm">{expenses.length} expense entries</span>
                <span className="text-xl font-bold text-red-500 font-mono">{fmt(totalExpenses)}</span>
              </>
            ) : (
              <>
                <span className="text-muted-foreground text-sm">{expenses.length} expense entries</span>
                <div className="flex-1" />
                <span className="text-xl font-bold text-red-500 font-mono">{fmt(totalExpenses)}</span>
              </>
            )}
          </div>
        )}

        {/* ── GROUPED VIEW (all / warehouse mode) ───────────────────────── */}
        {showGrouped ? (
          <div className="space-y-4">
            {isLoading ? (
              [...Array(3)].map((_, i) => (
                <div key={i} className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="h-12 bg-muted/30 animate-pulse" />
                  <div className="h-20 bg-muted/10 animate-pulse" />
                </div>
              ))
            ) : grouped.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground bg-card border border-border rounded-xl">
                <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p>No expenses recorded</p>
              </div>
            ) : grouped.map(grp => (
              <div key={`${grp.locationType}-${grp.locationId}`} className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
                {/* Location header */}
                <div className="flex items-center justify-between px-4 py-3 bg-muted/20 border-b border-border">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] capitalize">{grp.locationType}</Badge>
                    <span className="font-semibold text-sm">{grp.locationName}</span>
                  </div>
                  <span className="font-bold text-red-500 font-mono text-sm">{fmt(grp.total)}</span>
                </div>
                {/* Expenses table */}
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/5">
                      <TableHead className="text-xs">Date</TableHead>
                      <TableHead className="text-xs">Description</TableHead>
                      <TableHead className="text-xs">Category</TableHead>
                      <TableHead className="text-xs">Expense Account</TableHead>
                      <TableHead className="text-xs">Voucher</TableHead>
                      <TableHead className="text-right text-xs">Amount</TableHead>
                      <TableHead className="w-10" />
                      {perm.canDelete && <TableHead className="w-10" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grp.expenses.map((e: any) => (
                      <TableRow key={e.id} className="hover:bg-muted/10">
                        <TableCell className="text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {e.expenseDate ? new Date(e.expenseDate).toLocaleDateString('en-IN') : '—'}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm font-medium max-w-xs truncate">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{e.description}</span>
                            <PaymentModeTag mode={e.paymentMode} />
                            {e.attachmentUrl && (
                              <a
                                href={attachmentViewUrl(e.attachmentUrl)}
                                target="_blank" rel="noreferrer"
                                title="View attached bill"
                                className="text-muted-foreground hover:text-primary shrink-0"
                              >
                                <Paperclip className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{e.category || 'Uncategorised'}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{e.expenseLedgerName}</TableCell>
                        <TableCell className="font-mono text-xs text-primary">{e.voucherNumber}</TableCell>
                        <TableCell className="text-right font-mono font-bold text-red-500 text-sm">
                          {fmt(Number(e.amount))}
                        </TableCell>
                        {perm.canDownload && (
                        <TableCell className="w-10">
                          <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-primary"
                            title="Print payment voucher"
                            onClick={() => printVoucher(e.id, e.voucherNumber)}
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </Button>
                        </TableCell>
                        )}
                        {perm.canDelete && (
                          <TableCell className="w-10">
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              title="Delete expense"
                              onClick={() => setDeleteTarget(e)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ))}
          </div>
        ) : (
          /* ── SINGLE-LOCATION VIEW ───────────────────────────────────── */
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <SortableHead k="date" sort={sort}>Date</SortableHead>
                  <SortableHead k="description" sort={sort}>Description</SortableHead>
                  <SortableHead k="category" sort={sort}>Category</SortableHead>
                  <SortableHead k="account" sort={sort}>Expense Account</SortableHead>
                  <SortableHead k="voucher" sort={sort}>Voucher</SortableHead>
                  <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
                  <TableHead className="w-10" />
                  {perm.canDelete && <TableHead className="w-10" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(3)].map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={perm.canDelete ? 8 : 7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                    </TableRow>
                  ))
                ) : expenses.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={perm.canDelete ? 8 : 7} className="text-center py-16 text-muted-foreground">
                      <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" />
                      <p>No expenses recorded for {locationName}</p>
                    </TableCell>
                  </TableRow>
                ) : sortedExpenses.map((e: any) => (
                  <TableRow key={e.id} className="hover:bg-muted/10">
                    <TableCell className="text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {e.expenseDate ? new Date(e.expenseDate).toLocaleDateString('en-IN') : '—'}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium max-w-xs truncate">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">{e.description}</span>
                        <PaymentModeTag mode={e.paymentMode} />
                        {e.attachmentUrl && (
                          <a
                            href={attachmentViewUrl(e.attachmentUrl)}
                            target="_blank" rel="noreferrer"
                            title="View attached bill"
                            className="text-muted-foreground hover:text-primary shrink-0"
                          >
                            <Paperclip className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{e.category || 'Uncategorised'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{e.expenseLedgerName}</TableCell>
                    <TableCell className="font-mono text-xs text-primary">{e.voucherNumber}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-red-500">
                      {fmt(Number(e.amount))}
                    </TableCell>
                    {perm.canDownload && (
                    <TableCell className="w-10">
                      <Button
                        variant="ghost" size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        title="Print payment voucher"
                        onClick={() => printVoucher(e.id, e.voucherNumber)}
                      >
                        <Printer className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                    )}
                    {perm.canDelete && (
                      <TableCell className="w-10">
                        <Button
                          variant="ghost" size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          title="Delete expense"
                          onClick={() => setDeleteTarget(e)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" /> Delete this expense?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <span className="block">
                  <span className="font-medium text-foreground">{deleteTarget?.description}</span>
                  {' — '}
                  <span className="font-mono font-semibold text-red-500">{deleteTarget ? fmt(Number(deleteTarget.amount)) : ''}</span>
                </span>
                <span className="block">
                  Voucher <span className="font-mono text-primary">{deleteTarget?.voucherNumber}</span> will be
                  removed and the amount returned to the location's cash ledger. The deletion is recorded in the
                  audit log. This cannot be undone.
                </span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); confirmDelete(); }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Deleting…</> : 'Delete Expense'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Expense — reachable from any view; the form picks the location. */}
      {locationOptions.length > 0 && (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto" onOpenAutoFocus={autoFocusFirst}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Receipt className="w-5 h-5 text-primary" /> Record Expense
              </DialogTitle>
              <DialogDescription>
                Charged against the location you choose. The debit goes to the selected expense account.
              </DialogDescription>
            </DialogHeader>

            <Form {...form}>
              <form
                ref={scopeRef}
                data-kbd-scope
                onKeyDown={entryScopeKeyDown({ onSave: save })}
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-4 pt-2"
              >

                {/* Location — defaults to the page's location, but editable so
                    the All-locations view can record an expense too. */}
                <FormField control={form.control} name="location" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger data-field="location"><SelectValue placeholder="Select location" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {locationOptions.map(o => (
                          <SelectItem key={o.key} value={o.key}>
                            {o.label} <span className="text-muted-foreground text-xs">· {o.kind}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />

                {/* Payment method decides what gets credited: the till, a bank
                    account, or Expense Payable. */}
                <FormField control={form.control} name="paymentMode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Payment Method <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {PAYMENT_MODES.map(m => (
                          <SelectItem
                            key={m.value}
                            value={m.value}
                            disabled={m.value === 'bank' && bankAccounts.length === 0}
                          >
                            {m.label}
                            <span className="text-muted-foreground text-xs">
                              {' · '}
                              {m.value === 'bank' && bankAccounts.length === 0 ? 'Head Office only' : m.hint}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />

                {/* Funding source, per method */}
                {watchMode === 'cash' && (
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">Paid From (Cash)</p>
                    <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 rounded-md border border-border text-sm">
                      <Wallet className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-muted-foreground">
                        {formCash?.cashLedgerName ?? formCash?.locationName ?? "This location's cash"}
                      </span>
                      {hasKnownCash && (
                        <span className="ml-auto font-mono text-xs font-semibold text-emerald-600">
                          {fmt(formAvailableCash)} available
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {watchMode === 'bank' && (
                  <FormField control={form.control} name="paymentAccountId" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-1.5">
                        <Landmark className="w-3.5 h-3.5" /> Bank Account <span className="text-destructive">*</span>
                      </FormLabel>
                      <Select
                        onValueChange={v => field.onChange(Number(v))}
                        value={field.value && Number(field.value) > 0 ? String(field.value) : ''}
                      >
                        <FormControl><SelectTrigger><SelectValue placeholder="Select bank account" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {bankAccounts.length === 0 ? (
                            <SelectItem value="0" disabled>No bank accounts available</SelectItem>
                          ) : bankAccounts.map((b: any) => (
                            <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                {watchMode === 'credit' && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-sm">
                    <Clock className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                    <span className="text-muted-foreground">
                      Nothing is paid now — this posts to <strong className="text-foreground">Expense Payable</strong> and
                      stays outstanding until it is settled.
                    </span>
                  </div>
                )}

                {/* Searchable + scrollable so a long Indirect Expense tree stays
                    usable on small screens. Only postable Indirect Expense
                    ledgers are offered; the server rejects anything else. */}
                <FormField control={form.control} name="expenseLedgerId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expense Account <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <AccountCombobox
                        options={(expenseLedgers as any[]).map(l => ({ id: l.id, name: l.name, code: l.code, parentId: l.parentId }))}
                        value={Number(field.value) || 0}
                        onChange={id => field.onChange(id)}
                        placeholder={(expenseLedgers as any[]).length === 0 ? 'No expense ledgers found' : 'Select expense account'}
                        disabled={(expenseLedgers as any[]).length === 0}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="description" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <Textarea rows={2} placeholder="e.g. Electricity bill July, Freight charges" data-field="description" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField control={form.control} name="amount" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input
                          type="number" step="0.01" min={0.01}
                          max={watchMode === 'cash' && formAvailableCash > 0 ? formAvailableCash : undefined}
                          className={overBalance ? 'border-destructive focus-visible:ring-destructive' : ''}
                          data-field="amount"
                          {...field}
                        />
                      </FormControl>
                      {overBalance ? (
                        <p className="text-xs text-destructive flex items-center gap-1 mt-1">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          Exceeds available cash (₹{formAvailableCash.toLocaleString('en-IN', { minimumFractionDigits: 2 })})
                        </p>
                      ) : watchMode === 'cash' && hasKnownCash && amountNum > 0 ? (
                        <p className="text-xs text-muted-foreground mt-1">
                          Remaining: <span className="font-mono font-medium text-foreground">{fmt(formAvailableCash - amountNum)}</span>
                        </p>
                      ) : null}
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="expenseDate" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date</FormLabel>
                      <FormControl><Input type="date" data-field="expenseDate" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>

                {/* Hard block if no cash available — cash mode only. */}
                {watchMode === 'cash' && hasKnownCash && formAvailableCash <= 0 && (
                  <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>No cash available at this location. Collect cash, make a sale, or record this as Credit.</span>
                  </div>
                )}

                <FormField control={form.control} name="reference" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bill / Reference No. <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                    <FormControl><Input placeholder="e.g. BILL-2024-001" {...field} /></FormControl>
                  </FormItem>
                )} />

                {/* Kept out of the description because the description becomes
                    the voucher narration shown in the day book and ledgers. */}
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                    <FormControl>
                      <Textarea rows={2} placeholder="Anything worth recording for later — approvals, context, follow-ups" {...field} />
                    </FormControl>
                  </FormItem>
                )} />

                <DialogFooter>
                  <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={submitting || overBalance || (watchMode === 'cash' && hasKnownCash && formAvailableCash <= 0)}>
                    {submitting ? 'Saving…' : 'Record Expense'}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      )}
    </AppLayout>
  );
}
