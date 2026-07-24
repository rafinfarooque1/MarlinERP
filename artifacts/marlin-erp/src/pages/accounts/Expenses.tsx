import { useState } from 'react';
import { useListExpenses, useCreateExpense, getListExpensesQueryKey, useListChartOfAccounts, useListCashBankAccounts, useLocationExpensesSummary, useLocationExpenses, LocationExpenseSummary } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Receipt, Download, Eye, Calendar, MapPin, Building2, ChevronRight, ArrowLeft, LayoutList } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  description: z.string().min(1, 'Description required'),
  amount: z.coerce.number().min(0.01, 'Amount > 0'),
  expenseDate: z.string().min(1, 'Date required'),
  ledgerAccountId: z.coerce.number().min(1, 'Ledger account required'),
  paymentAccountId: z.coerce.number().min(1, 'Payment account required'),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

// ── By-Location drilldown panel ───────────────────────────────────────────────
function LocationDrilldown({ loc, onBack }: { loc: LocationExpenseSummary; onBack: () => void }) {
  const { data, isLoading } = useLocationExpenses(loc.locationType, loc.locationId);
  const expenses = data?.expenses ?? [];
  const [viewItem, setViewItem] = useState<any>(null);

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
            ₹{expenses.reduce((s, e) => s + e.amount, 0).toLocaleString('en-IN')}
          </span>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead>Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Expense Account</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [...Array(3)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                </TableRow>
              ))
            ) : expenses.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                  <Receipt className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  <p>No expenses recorded for this location</p>
                </TableCell>
              </TableRow>
            ) : expenses.map(e => (
              <TableRow key={e.id} className="hover:bg-muted/10">
                <TableCell className="text-sm text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {new Date(e.expenseDate).toLocaleDateString('en-IN')}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="font-medium">{e.description ?? <span className="italic text-muted-foreground">No description</span>}</span>
                  {e.voucherNumber && (
                    <span className="ml-2 text-xs text-muted-foreground">{e.voucherNumber}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">{e.expenseLedgerName || '—'}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono font-bold text-red-500">
                  ₹{e.amount.toLocaleString('en-IN')}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(e)}>
                    <Eye className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
                ['Amount', `₹${viewItem.amount.toLocaleString('en-IN')}`],
                ['Date', new Date(viewItem.expenseDate).toLocaleDateString('en-IN')],
                ['Expense Account', viewItem.expenseLedgerName || '—'],
                ['Paid From', viewItem.cashLedgerName || '—'],
                ...(viewItem.voucherNumber ? [['Voucher', viewItem.voucherNumber]] : []),
                ['Location', `${loc.locationName} (${loc.locationType})`],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ── By-Location summary tab ───────────────────────────────────────────────────
function ByLocationTab() {
  const { data: summary = [], isLoading } = useLocationExpensesSummary();
  const [drilldown, setDrilldown] = useState<LocationExpenseSummary | null>(null);

  if (drilldown) {
    return <LocationDrilldown loc={drilldown} onBack={() => setDrilldown(null)} />;
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
            ₹{grandTotal.toLocaleString('en-IN')} total
          </span>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
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
            {isLoading ? (
              [...Array(4)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                </TableRow>
              ))
            ) : summary.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                  <Building2 className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p>No warehouses or outlets with cash ledgers found</p>
                  <p className="text-xs mt-1">Provision ledgers under Accounts → Warehouses/Outlets</p>
                </TableCell>
              </TableRow>
            ) : (
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
                        ₹{loc.total.toLocaleString('en-IN')}
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
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── Main Expenses page ────────────────────────────────────────────────────────
export default function Expenses() {
  const { data: expenses = [], isLoading } = useListExpenses();
  const { data: accounts = [] } = useListChartOfAccounts();
  const { data: cashBanks = [] } = useListCashBankAccounts();
  const expenseAccounts = accounts.filter(a => a.type === 'expense');
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateExpense();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { description: '', amount: 0, expenseDate: new Date().toISOString().split('T')[0], ledgerAccountId: 0, paymentAccountId: 0 },
  });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data: { ...data, amount: String(data.amount) } as any }, {
      onSuccess: () => {
        toast.success('Expense recorded');
        queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey() });
        setIsOpen(false);
        form.reset();
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = (expenses as any[]).filter(e => {
    const q = search.toLowerCase();
    return (
      (e.description ?? '').toLowerCase().includes(q) ||
      (e.ledgerAccountName ?? '').toLowerCase().includes(q) ||
      (e.paymentAccountName ?? '').toLowerCase().includes(q)
    );
  });
  const total = filtered.reduce((s, e) => s + Number(e.amount || 0), 0);

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Receipt className="w-6 h-6 text-primary" /> Expenses
            </h1>
            <p className="text-muted-foreground mt-1">All business expenditure — head office and locations</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('expenses.csv', filtered.map(e => ({
              Date: e.expenseDate,
              Description: e.description ?? '',
              Account: e.ledgerAccountName ?? '',
              PaidFrom: e.paymentAccountName ?? '',
              Amount: e.amount,
              Source: e.source === 'location' ? 'Location' : 'Direct',
            })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => {
              form.reset({ description: '', amount: 0, expenseDate: new Date().toISOString().split('T')[0], ledgerAccountId: 0, paymentAccountId: 0 });
              setIsOpen(true);
            }}>
              <Plus className="w-4 h-4 mr-2" /> Add Expense
            </Button>
          </div>
        </div>

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
              <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
                <span className="text-muted-foreground text-sm">{filtered.length} expense entries</span>
                <span className="text-xl font-bold text-red-500 font-mono">₹{total.toLocaleString('en-IN')}</span>
              </div>
            )}

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
                <Search className="w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search by description, account…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm"
                />
              </div>
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/10">
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Expense Account</TableHead>
                    <TableHead>Paid From</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    [...Array(4)].map((_, i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                      </TableRow>
                    ))
                  ) : filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                        <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" />
                        <p>No expenses recorded</p>
                      </TableCell>
                    </TableRow>
                  ) : filtered.map(e => (
                    <TableRow key={`${e.source}-${e.id}`} className="hover:bg-muted/10">
                      <TableCell className="text-sm text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {new Date(e.expenseDate).toLocaleDateString('en-IN')}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{e.description ?? <span className="text-muted-foreground italic">No description</span>}</span>
                          {e.source === 'location' && (
                            <Badge variant="secondary" className="text-xs gap-1">
                              <MapPin className="w-2.5 h-2.5" /> Location
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{e.ledgerAccountName || '—'}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{e.paymentAccountName || '—'}</TableCell>
                      <TableCell className="text-right font-mono font-bold text-red-500">
                        ₹{Number(e.amount).toLocaleString('en-IN')}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(e)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          {/* ── By Location tab ── */}
          <TabsContent value="by-location" className="mt-4">
            <ByLocationTab />
          </TabsContent>
        </Tabs>
      </div>

      {/* Add Expense Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Record Expense</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Description <span className="text-destructive">*</span></FormLabel>
                  <FormControl><Input placeholder="e.g. Office rent - July" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="number" step="0.01" min={0} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="expenseDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="ledgerAccountId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Expense Account <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {expenseAccounts.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="paymentAccountId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Paid From <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select cash/bank account" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {(cashBanks as any[]).map((cb: any) => <SelectItem key={cb.id} value={String(cb.id)}>{cb.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Saving…' : 'Record Expense'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

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
                ['Amount', `₹${Number(viewItem.amount).toLocaleString('en-IN')}`],
                ['Date', new Date(viewItem.expenseDate).toLocaleDateString('en-IN')],
                ['Expense Account', viewItem.ledgerAccountName || '—'],
                ['Paid From', viewItem.paymentAccountName || '—'],
                ...(viewItem.voucherNumber ? [['Voucher', viewItem.voucherNumber]] : []),
                ['Source', viewItem.source === 'location' ? 'Location (Sales segment)' : 'Direct entry'],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
