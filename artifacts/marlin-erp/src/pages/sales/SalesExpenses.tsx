import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import { customFetch } from '@workspace/api-client-react';
import { Receipt, Plus, Calendar, Wallet, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { toast } from 'sonner';

const schema = z.object({
  expenseLedgerId: z.coerce.number().min(1, 'Select an expense category'),
  description:     z.string().min(1, 'Description required'),
  amount:          z.coerce.number().min(0.01, 'Amount must be > 0'),
  expenseDate:     z.string().min(1, 'Date required'),
  reference:       z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const TODAY = new Date().toISOString().split('T')[0];

export default function SalesExpenses() {
  const [, navigate] = useLocation();
  const { locationState } = useLocationContext();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!locationState.locationType || !locationState.locationId) navigate('/sales');
  }, [locationState, navigate]);

  const { locationType, locationId, locationName } = locationState;

  // Fetch expense category ledgers (Direct + Indirect Expenses only)
  const { data: expenseLedgers = [] } = useQuery<any[]>({
    queryKey: ['expense-ledgers'],
    queryFn: () => customFetch('/api/accounts/expense-ledgers'),
  });

  // Fetch this location's expense list (returns { cashLedgerId, cashLedgerName, expenses: [...] })
  const expensesQueryKey = ['location-expenses', locationType, locationId];
  const { data: expenseData, isLoading, error: expensesError } = useQuery<{
    cashLedgerId: number; cashLedgerName: string; expenses: any[];
  }>({
    queryKey: expensesQueryKey,
    queryFn: () => customFetch(`/api/accounts/location-expenses?locationType=${locationType}&locationId=${locationId}`),
    enabled: !!locationType && !!locationId,
  });

  const cashLedgerName: string | null = expenseData?.cashLedgerName ?? null;
  const expenses: any[] = expenseData?.expenses ?? [];
  const totalExpenses = expenses.reduce((s: number, e: any) => s + Number(e.amount ?? 0), 0);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { expenseLedgerId: 0, description: '', amount: 0, expenseDate: TODAY, reference: '' },
  });

  const openAdd = () => {
    form.reset({ expenseLedgerId: 0, description: '', amount: 0, expenseDate: TODAY, reference: '' });
    setIsOpen(true);
  };

  const onSubmit = async (data: FormValues) => {
    setSubmitting(true);
    try {
      await customFetch('/api/accounts/location-expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationType,
          locationId,
          expenseLedgerId: data.expenseLedgerId,
          amount: data.amount,
          expenseDate: data.expenseDate,
          description: data.description,
          reference: data.reference || undefined,
        }),
      });
      toast.success('Expense recorded');
      queryClient.invalidateQueries({ queryKey: expensesQueryKey });
      setIsOpen(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to record expense');
    } finally {
      setSubmitting(false);
    }
  };

  if (!locationType || !locationId) return null;

  // No cash ledger error (404 response)
  const hasCashLedgerError = (expensesError as any)?.message?.includes('no Cash ledger') ||
    (expensesError as any)?.response?.status === 404;

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Receipt className="w-6 h-6 text-primary" />
              Expenses — {locationName}
            </h1>
            <p className="text-muted-foreground mt-1 flex items-center gap-2 text-sm">
              <Wallet className="w-3.5 h-3.5" />
              {cashLedgerName ? <>Paid from: <span className="font-medium">{cashLedgerName}</span></> : 'Loading payment source…'}
            </p>
          </div>
          <Button onClick={openAdd} disabled={!cashLedgerName}>
            <Plus className="w-4 h-4 mr-2" /> Add Expense
          </Button>
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

        {/* Summary */}
        {(expenses as any[]).length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
            <span className="text-muted-foreground text-sm">{(expenses as any[]).length} expense entries</span>
            <span className="text-xl font-bold text-red-500 font-mono">
              ₹{totalExpenses.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </span>
          </div>
        )}

        {/* Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Voucher</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                  </TableRow>
                ))
              ) : (expenses as any[]).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                    <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>No expenses recorded for {locationName}</p>
                  </TableCell>
                </TableRow>
              ) : (expenses as any[]).map((e: any) => (
                <TableRow key={e.id} className="hover:bg-muted/10">
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {e.expenseDate ? new Date(e.expenseDate).toLocaleDateString('en-IN') : '—'}
                    </div>
                  </TableCell>
                  <TableCell className="font-medium max-w-xs truncate">{e.description}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{e.expenseLedgerName}</TableCell>
                  <TableCell className="font-mono text-xs text-primary">{e.voucherNumber}</TableCell>
                  <TableCell className="text-right font-mono font-bold text-red-500">
                    ₹{Number(e.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Add Expense Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="w-5 h-5 text-primary" /> Record Expense
            </DialogTitle>
            <DialogDescription>
              Charge against <strong>{locationName}</strong> cash. Debit goes to the selected expense account.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">

              {/* Paid from — read-only */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Paid From</p>
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 rounded-md border border-border text-sm">
                  <Wallet className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{cashLedgerName ?? 'Loading…'}</span>
                  <span className="ml-auto text-[10px] bg-muted rounded px-1 py-0.5 text-muted-foreground">Auto</span>
                </div>
              </div>

              {/* Expense Category */}
              <FormField control={form.control} name="expenseLedgerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Expense Category <span className="text-destructive">*</span></FormLabel>
                  <Select
                    onValueChange={v => field.onChange(Number(v))}
                    value={field.value && field.value > 0 ? String(field.value) : ''}
                  >
                    <FormControl><SelectTrigger><SelectValue placeholder="Select expense account" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {(expenseLedgers as any[]).length === 0 ? (
                        <SelectItem value="0" disabled>No expense ledgers found</SelectItem>
                      ) : (expenseLedgers as any[]).map((l: any) => (
                        <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

              {/* Description */}
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>Description <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <Textarea rows={2} placeholder="e.g. Electricity bill July, Freight charges" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <div className="grid grid-cols-2 gap-4">
                {/* Amount */}
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="number" step="0.01" min={0.01} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                {/* Date */}
                <FormField control={form.control} name="expenseDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              {/* Reference */}
              <FormField control={form.control} name="reference" render={({ field }) => (
                <FormItem>
                  <FormLabel>Bill / Reference No. <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                  <FormControl><Input placeholder="e.g. BILL-2024-001" {...field} /></FormControl>
                </FormItem>
              )} />

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Saving…' : 'Record Expense'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
