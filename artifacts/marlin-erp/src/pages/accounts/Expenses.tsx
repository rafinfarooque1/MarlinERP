import { useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFilteredExpenses, useCreateExpense, useListCashBankAccounts, useLocationExpensesSummary, useLocationExpenses, LocationExpenseSummary, useListWarehouses, useListOutlets, attachmentViewUrl, customFetch, useGetMe } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DialogClose, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { TransactionDialog, TransactionDialogContent } from '@/components/ui/transaction-dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Receipt, Download, Eye, Calendar, MapPin, Building2, ChevronRight, ArrowLeft, LayoutList, ShieldOff, Printer, Paperclip } from 'lucide-react';
import { usePermission } from '@/lib/usePermission';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV, downloadPDFFromEndpoint } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { useDateRange, RangeBar } from '@/pages/reports/shared';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { EntityCombobox } from '@/components/ui/entity-combobox';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
import { entryScopeKeyDown, autoFocusFirst, focusField, useEntryShortcuts } from '@/lib/keyboard-entry';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { inr } from '@/lib/currency';

const schema = z.object({
  description: z.string().min(1, 'Description required'),
  amount: z.coerce.number().min(0.01, 'Amount > 0'),
  expenseDate: z.string().min(1, 'Date required'),
  ledgerAccountId: z.coerce.number().min(1, 'Ledger account required'),
  paymentAccountId: z.coerce.number().min(1, 'Payment account required'),
  attributeTo: z.string().min(1),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

/**
 * Print the payment voucher. Assembled entirely server-side from the row id —
 * nothing about the figures comes from this page, so a printed voucher can
 * never state an amount the books do not hold.
 */
async function printVoucher(source: 'direct' | 'location', id: number, label?: string) {
  try {
    await downloadPDFFromEndpoint(
      '/api/pdf/expense-voucher',
      { source, id },
      `expense-voucher-${(label || id).toString().replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`,
    );
  } catch (e: any) {
    toast.error(e?.message ?? 'Could not generate the voucher');
  }
}

// ── By-Location drilldown panel ───────────────────────────────────────────────
function LocationDrilldown({ loc, onBack, canDownload }: { loc: LocationExpenseSummary; onBack: () => void; canDownload: boolean }) {
  const { data, isLoading } = useLocationExpenses(loc.locationType, loc.locationId);
  const expenses = data?.expenses ?? [];
  const [viewItem, setViewItem] = useState<any>(null);

  const { sorted, sort } = useTableSort(expenses, {
    voucher: e => e.voucherNumber,
    date: e => e.expenseDate,
    description: e => e.description,
    category: e => (e as any).category,
    account: e => e.expenseLedgerName,
    amount: e => Number(e.amount),
  });

  const { pageRows, pagerProps } = useClientPage(sorted);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h2 className="font-semibold text-lg flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" />
            {loc.locationName}
          </h2>
          <p className="text-xs text-muted-foreground capitalize">{loc.locationType}</p>
        </div>
      </div>

      {expenses.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
          <span className="text-muted-foreground text-sm">{expenses.length} expense entries</span>
          <span className="text-xl font-bold text-red-500 font-mono">
            {inr(expenses.reduce((s, e) => s + e.amount, 0))}
          </span>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={3} cols={7} />
        ) : expenses.length === 0 ? (
          <EmptyState icon={Receipt} title="No expenses recorded for this location" compact />
        ) : (
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <SortableHead k="voucher" sort={sort}>Voucher</SortableHead>
              <SortableHead k="date" sort={sort}>Date</SortableHead>
              <SortableHead k="description" sort={sort}>Description</SortableHead>
              <SortableHead k="category" sort={sort}>Category</SortableHead>
              <SortableHead k="account" sort={sort}>Expense Account</SortableHead>
              <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map(e => (
              <TableRow key={e.id} className="hover:bg-muted/10">
                <TableCell className="font-mono text-xs text-primary whitespace-nowrap">
                  {e.voucherNumber || <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {new Date(e.expenseDate).toLocaleDateString('en-IN')}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{e.description ?? <span className="italic text-muted-foreground">No description</span>}</span>
                    {(e as any).attachmentUrl && (
                      <a
                        href={attachmentViewUrl((e as any).attachmentUrl)}
                        target="_blank" rel="noreferrer"
                        title="View attached bill"
                        onClick={ev => ev.stopPropagation()}
                        className="text-muted-foreground hover:text-primary shrink-0"
                      >
                        <Paperclip className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {(e as any).category || 'Uncategorised'}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">{e.expenseLedgerName || '—'}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono font-bold text-red-500">
                  {inr(e.amount)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {canDownload && (
                  <Button
                    variant="ghost" size="icon" className="h-8 w-8 hover:text-primary"
                    title="Print payment voucher"
                    onClick={() => printVoucher('location', e.id, e.voucherNumber)}
                  >
                    <Printer className="w-4 h-4" />
                  </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(e)}>
                    <Eye className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        )}
        <TablePager {...pagerProps} />
      </div>

      {/* Detail sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{viewItem?.description ?? 'Expense Detail'}</SheetTitle>
            <SheetDescription className="flex items-center gap-1">
              <MapPin className="w-3 h-3" /> {loc.locationName}
            </SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[
                ...(viewItem.voucherNumber ? [['Voucher', viewItem.voucherNumber]] : []),
                ['Amount', `${inr(viewItem.amount)}`],
                ['Date', new Date(viewItem.expenseDate).toLocaleDateString('en-IN')],
                ['Category', viewItem.category || 'Uncategorised'],
                ['Expense Account', viewItem.expenseLedgerName || '—'],
                ['Paid From', viewItem.cashLedgerName || '—'],
                ['Location', `${loc.locationName} (${loc.locationType})`],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}

              <div className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Supporting Bill</span>
                {viewItem.attachmentUrl ? (
                  <a
                    href={attachmentViewUrl(viewItem.attachmentUrl)}
                    target="_blank" rel="noreferrer"
                    className="font-medium text-primary hover:underline flex items-center gap-1.5"
                  >
                    <Paperclip className="w-3.5 h-3.5" /> View attached bill
                  </a>
                ) : (
                  <span className="font-medium text-amber-600">Not attached</span>
                )}
              </div>

              {canDownload && (
              <Button
                variant="outline" className="w-full"
                onClick={() => printVoucher('location', viewItem.id, viewItem.voucherNumber)}
              >
                <Printer className="w-4 h-4 mr-2" /> Print Payment Voucher
              </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ── By-Location summary tab ───────────────────────────────────────────────────
function ByLocationTab({ canDownload }: { canDownload: boolean }) {
  const { data: summary = [], isLoading } = useLocationExpensesSummary();
  const [drilldown, setDrilldown] = useState<LocationExpenseSummary | null>(null);

  if (drilldown) {
    return <LocationDrilldown loc={drilldown} onBack={() => setDrilldown(null)} canDownload={canDownload} />;
  }

  const grandTotal = (summary as LocationExpenseSummary[]).reduce((s, l) => s + l.total, 0);
  const locationsWithExpenses = (summary as LocationExpenseSummary[]).filter(l => l.count > 0);
  const locationsWithoutExpenses = (summary as LocationExpenseSummary[]).filter(l => l.count === 0);

  return (
    <div className="space-y-4">
      {locationsWithExpenses.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
          <span className="text-muted-foreground text-sm">
            {locationsWithExpenses.length} location{locationsWithExpenses.length !== 1 ? 's' : ''} with expenses
          </span>
          <span className="text-xl font-bold text-red-500 font-mono">
            {inr(grandTotal)} total
          </span>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={4} cols={5} />
        ) : summary.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No warehouses or outlets with cash ledgers found"
            hint="Provision ledgers under Accounts → Warehouses/Outlets"
          />
        ) : (
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead>Location</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-center">Entries</TableHead>
              <TableHead className="text-right">Total Spend</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            <>
                {/* Locations that have expenses — sorted by spend descending */}
                {[...locationsWithExpenses]
                  .sort((a, b) => b.total - a.total)
                  .map(loc => (
                    <TableRow
                      key={`${loc.locationType}-${loc.locationId}`}
                      className="hover:bg-muted/10 cursor-pointer"
                      onClick={() => setDrilldown(loc)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2 font-semibold">
                          <Building2 className="w-4 h-4 text-primary shrink-0" />
                          {loc.locationName}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize text-xs">{loc.locationType}</Badge>
                      </TableCell>
                      <TableCell className="text-center text-sm">{loc.count}</TableCell>
                      <TableCell className="text-right font-mono font-bold text-red-500">
                        {inr(loc.total)}
                      </TableCell>
                      <TableCell className="text-right">
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ))}

                {/* Locations with zero expenses — greyed out, still clickable */}
                {locationsWithoutExpenses.map(loc => (
                  <TableRow
                    key={`${loc.locationType}-${loc.locationId}`}
                    className="hover:bg-muted/10 cursor-pointer opacity-50"
                    onClick={() => setDrilldown(loc)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium text-muted-foreground">
                        <Building2 className="w-4 h-4 shrink-0" />
                        {loc.locationName}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize text-xs">{loc.locationType}</Badge>
                    </TableCell>
                    <TableCell className="text-center text-sm text-muted-foreground">0</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">₹0</TableCell>
                    <TableCell className="text-right">
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))}
              </>
          </TableBody>
        </Table>
        )}
      </div>
    </div>
  );
}

// ── Main Expenses page ────────────────────────────────────────────────────────
export default function Expenses() {
  const perm = usePermission('page:/accounts/expenses');
  // Recording a company (Head Office) expense is HO-only — the server tells
  // branch users to use Sales → Expenses instead. Hiding the button also hides
  // the "Attribute To" list, which would otherwise name every branch.
  const { data: me } = useGetMe();
  const isHOUser = !(me as any)?.branchType || (me as any)?.branchType === 'headoffice';
  const range = useDateRange('all');
  const { locationState } = useLocationContext();
  const { data: expenses = [], isLoading } = useFilteredExpenses({
    from: range.from || undefined,
    to: range.to || undefined,
    ...locationFilterParams(locationState),
  });
  const { data: cashBanks = [] } = useListCashBankAccounts();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  // Postable Indirect Expense ledgers only. The server restricts this endpoint
  // to the Indirect Expense subtree and rejects anything else on write.
  const { data: expenseAccounts = [] } = useQuery<any[]>({
    queryKey: ['expense-ledgers'],
    queryFn: () => customFetch('/api/accounts/expense-ledgers'),
  });
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateExpense();
  const scopeRef = useRef<HTMLFormElement>(null);

  // Default "Attribute To" follows the global location selector — an Admin
  // viewing a branch records that branch's expense unless they change it.
  // "All Locations" is never a posting location, so it falls back to HO.
  const defaultAttributeTo =
    (locationState.locationType === 'warehouse' || locationState.locationType === 'outlet') && locationState.locationId
      ? `${locationState.locationType}:${locationState.locationId}`
      : 'headoffice';
  const blankForm = {
    description: '', amount: 0, expenseDate: new Date().toISOString().split('T')[0],
    ledgerAccountId: 0, paymentAccountId: 0, attributeTo: defaultAttributeTo,
  };
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: blankForm,
  });

  const onSubmit = (data: FormValues) => {
    // `attributeTo` is one picker in the UI ("Head Office" / a warehouse / an
    // outlet) but two fields on the wire.
    const [locationType, rawId] = data.attributeTo.split(':');
    const { attributeTo: _drop, ...rest } = data;
    createMutation.mutate({
      data: {
        ...rest,
        amount: Number(data.amount),
        locationType,
        ...(locationType === 'headoffice' ? {} : { locationId: Number(rawId) }),
      } as any,
    }, {
      onSuccess: () => {
        toast.success('Expense recorded');
        // Refresh both the generated exact key and every '/api/expenses'-keyed
        // view (the filtered list is keyed under this prefix, not the exact key).
        queryClient.invalidateQueries({
          predicate: q => String(q.queryKey[0] ?? '').startsWith('/api/expenses'),
        });
        setIsOpen(false);
        form.reset(blankForm);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // ── Keyboard Entry Mode ──
  const save = () => {
    if (createMutation.isPending) return;
    form.handleSubmit(onSubmit, (errors) => {
      const first = ['description', 'amount', 'expenseDate', 'ledgerAccountId', 'paymentAccountId']
        .find(f => (errors as any)[f]);
      if (first) focusField(first, scopeRef.current);
    })();
  };
  useEntryShortcuts(isOpen, { onSave: save });

  const filtered = (expenses as any[]).filter(e => {
    const q = search.toLowerCase();
    return (
      (e.description ?? '').toLowerCase().includes(q) ||
      (e.ledgerAccountName ?? '').toLowerCase().includes(q) ||
      (e.paymentAccountName ?? '').toLowerCase().includes(q) ||
      (e.category ?? '').toLowerCase().includes(q) ||
      (e.expenseNumber ?? '').toLowerCase().includes(q) ||
      (e.locationName ?? '').toLowerCase().includes(q)
    );
  });
  const total = filtered.reduce((s, e) => s + Number(e.amount || 0), 0);

  const { sorted, sort } = useTableSort(filtered, {
    voucher: e => e.expenseNumber ?? e.voucherNumber,
    date: e => e.expenseDate,
    description: e => e.description,
    category: e => e.category,
    account: e => e.ledgerAccountName,
    location: e => e.locationName,
    paidFrom: e => e.paymentAccountName,
    amount: e => Number(e.amount),
  });

  const { pageRows, pagerProps } = useClientPage(sorted);

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">You don't have permission to view this page.<br />Contact your administrator to request access.</p>
          </div>
        </div>
      </AppLayout>
    );
  }
  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Expenses"
          description="All business expenditure — head office and locations"
          icon={Receipt}
          actions={
            <>
              {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('expenses.csv', filtered.map(e => ({
                Voucher: e.expenseNumber ?? e.voucherNumber ?? '',
                Date: e.expenseDate,
                Description: e.description ?? '',
                Category: e.category ?? 'Uncategorised',
                Account: e.ledgerAccountName ?? '',
                PaidFrom: e.paymentAccountName ?? '',
                Location: e.locationName ?? 'Head Office',
                Amount: e.amount,
                Bill: e.attachmentUrl ? 'Attached' : 'Missing',
                Source: e.source === 'location' ? 'Location' : 'Direct',
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
              )}
              {perm.canAdd && isHOUser && (
              <Button onClick={() => {
                form.reset(blankForm);
                setIsOpen(true);
              }}>
                <Plus className="w-4 h-4 mr-2" /> Add Expense
              </Button>
              )}
            </>
          }
        />

        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all" className="flex items-center gap-1.5">
              <LayoutList className="w-3.5 h-3.5" /> All Expenses
            </TabsTrigger>
            <TabsTrigger value="by-location" className="flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5" /> By Location
            </TabsTrigger>
          </TabsList>

          {/* ── All Expenses tab ── */}
          <TabsContent value="all" className="mt-4 space-y-4">
            {filtered.length > 0 && (
              <SummaryCardGrid className="lg:grid-cols-2">
                <SummaryCard label="Expense Entries" value={String(filtered.length)} icon={LayoutList} tone="default" loading={isLoading} />
                <SummaryCard label="Total Spend" value={<span className="font-mono text-red-500">{inr(total)}</span>} icon={Receipt} tone="negative" loading={isLoading} />
              </SummaryCardGrid>
            )}

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border flex flex-wrap items-center gap-2 bg-muted/20">
                <Search className="w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search by voucher, description, category, account, location…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm max-md:max-w-full"
                />
                <div className="ml-auto"><RangeBar range={range} /></div>
              </div>
              {isLoading ? (
                <TableSkeleton rows={4} cols={9} />
              ) : filtered.length === 0 ? (
                <EmptyState icon={Receipt} title="No expenses recorded" />
              ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/10">
                    <SortableHead k="voucher" sort={sort}>Voucher</SortableHead>
                    <SortableHead k="date" sort={sort}>Date</SortableHead>
                    <SortableHead k="description" sort={sort}>Description</SortableHead>
                    <SortableHead k="category" sort={sort}>Category</SortableHead>
                    <SortableHead k="account" sort={sort}>Expense Account</SortableHead>
                    <SortableHead k="location" sort={sort}>Location</SortableHead>
                    <SortableHead k="paidFrom" sort={sort}>Paid From</SortableHead>
                    <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map(e => (
                    <TableRow key={`${e.source}-${e.id}`} className="hover:bg-muted/10">
                      <TableCell className="font-mono text-xs text-primary whitespace-nowrap">
                        {e.expenseNumber ?? e.voucherNumber ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {new Date(e.expenseDate).toLocaleDateString('en-IN')}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{e.description ?? <span className="text-muted-foreground italic">No description</span>}</span>
                          {e.attachmentUrl && (
                            <a
                              href={attachmentViewUrl(e.attachmentUrl)}
                              target="_blank"
                              rel="noreferrer"
                              title="View attached bill"
                              onClick={ev => ev.stopPropagation()}
                              className="text-muted-foreground hover:text-primary shrink-0"
                            >
                              <Paperclip className="w-3.5 h-3.5" />
                            </a>
                          )}
                          {e.source === 'location' && (
                            <Badge variant="secondary" className="text-xs gap-1">
                              <MapPin className="w-2.5 h-2.5" /> Location
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">{e.category || 'Uncategorised'}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{e.ledgerAccountName || '—'}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{e.locationName || 'Head Office'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{e.paymentAccountName || '—'}</TableCell>
                      <TableCell className="text-right font-mono font-bold text-red-500">
                        {inr(Number(e.amount))}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {perm.canDownload && (
                        <Button
                          variant="ghost" size="icon" className="h-8 w-8 hover:text-primary"
                          title="Print payment voucher"
                          onClick={() => printVoucher(e.source === 'location' ? 'location' : 'direct', e.id, e.expenseNumber ?? e.voucherNumber)}
                        >
                          <Printer className="w-4 h-4" />
                        </Button>
                        )}
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(e)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              )}
              <TablePager {...pagerProps} />
            </div>
          </TabsContent>

          {/* ── By Location tab ── */}
          <TabsContent value="by-location" className="mt-4">
            <ByLocationTab canDownload={perm.canDownload} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Add Expense Dialog */}
      <TransactionDialog open={isOpen} dirty={form.formState.isDirty} onOpenChange={setIsOpen}>
        <TransactionDialogContent className="sm:max-w-md" onOpenAutoFocus={autoFocusFirst}>
          <DialogHeader><DialogTitle>Record Expense</DialogTitle></DialogHeader>
          <Form {...form}>
            <form
              ref={scopeRef}
              data-kbd-scope
              onKeyDown={entryScopeKeyDown({ onSave: save })}
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4 pt-2"
            >
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Description <span className="text-destructive">*</span></FormLabel>
                  <FormControl><Input placeholder="e.g. Office rent - July" data-field="description" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="number" step="0.01" min={0} data-field="amount" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="expenseDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl><Input type="date" data-field="expenseDate" {...field} /></FormControl>
                  </FormItem>
                )} />
              </div>
              {/* Searchable + scrollable; only postable Indirect Expense ledgers
                  are offered, and the server rejects anything else. */}
              <FormField control={form.control} name="ledgerAccountId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Expense Account <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <AccountCombobox
                      options={(expenseAccounts as any[]).map(a => ({ id: a.id, name: a.name, code: a.code, parentId: a.parentId }))}
                      value={Number(field.value) || 0}
                      onChange={id => field.onChange(id)}
                      placeholder={(expenseAccounts as any[]).length === 0 ? 'No expense ledgers found' : 'Select account'}
                      disabled={(expenseAccounts as any[]).length === 0}
                      advanceOnSelect
                      data-field="ledgerAccountId"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="paymentAccountId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Paid From <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <EntityCombobox
                      options={(cashBanks as any[]).map((cb: any) => ({ id: cb.id, label: cb.name, sublabel: cb.gstin ?? cb.phone ?? cb.code ?? null }))}
                      value={Number(field.value) || null}
                      onChange={id => field.onChange(id ?? 0)}
                      placeholder="Select cash/bank account"
                      clearable
                      data-field="paymentAccountId"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              {/* Attribution, not payment: the money still leaves a company
                  account, but the cost belongs to whichever site incurred it. */}
              <FormField control={form.control} name="attributeTo" render={({ field }) => (
                <FormItem>
                  <FormLabel>Attribute To</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="headoffice">Head Office</SelectItem>
                      {(warehouses as any[]).map((w: any) => (
                        <SelectItem key={`w${w.id}`} value={`warehouse:${w.id}`}>{w.name} (warehouse)</SelectItem>
                      ))}
                      {outletsEnabled && (outlets as any[]).map((o: any) => (
                        <SelectItem key={`o${o.id}`} value={`outlet:${o.id}`}>{o.name} (outlet)</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Which site the cost belongs to. Payment still comes from the company account above.
                  </p>
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <DialogClose asChild><Button variant="outline" type="button">Cancel</Button></DialogClose>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Saving…' : 'Record Expense'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </TransactionDialogContent>
      </TransactionDialog>

      {/* View Expense Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{viewItem?.description ?? 'Expense Detail'}</SheetTitle>
            <SheetDescription className="flex items-center gap-1">
              {viewItem?.source === 'location' && <MapPin className="w-3 h-3" />}
              {viewItem?.ledgerAccountName || '—'}
            </SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[
                ['Voucher', viewItem.expenseNumber ?? viewItem.voucherNumber ?? 'Not numbered'],
                ['Amount', `${inr(Number(viewItem.amount))}`],
                ['Date', new Date(viewItem.expenseDate).toLocaleDateString('en-IN')],
                ['Category', viewItem.category || 'Uncategorised'],
                ['Expense Account', viewItem.ledgerAccountName || '—'],
                ['Location', viewItem.locationName || 'Head Office'],
                ['Paid From', viewItem.paymentAccountName || '—'],
                ['Source', viewItem.source === 'location' ? 'Location (Sales segment)' : 'Direct entry'],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}

              <div className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">Supporting Bill</span>
                {viewItem.attachmentUrl ? (
                  <a
                    href={attachmentViewUrl(viewItem.attachmentUrl)}
                    target="_blank" rel="noreferrer"
                    className="font-medium text-primary hover:underline flex items-center gap-1.5"
                  >
                    <Paperclip className="w-3.5 h-3.5" /> View attached bill
                  </a>
                ) : (
                  <span className="font-medium text-amber-600">Not attached</span>
                )}
              </div>

              {perm.canDownload && (
              <Button
                variant="outline" className="w-full"
                onClick={() => printVoucher(
                  viewItem.source === 'location' ? 'location' : 'direct',
                  viewItem.id,
                  viewItem.expenseNumber ?? viewItem.voucherNumber,
                )}
              >
                <Printer className="w-4 h-4 mr-2" /> Print Payment Voucher
              </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
