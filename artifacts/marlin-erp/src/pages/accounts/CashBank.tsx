import { useState } from 'react';
import { Link } from 'wouter';
import { useListCashBankAccounts, useCreateCashBankAccount, getListCashBankAccountsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Banknote, Download, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';

const BAD_BALANCE = 'Please enter a valid opening balance.';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  accountType: z.enum(['cash', 'bank', 'upi', 'other']),
  // Never parsed as numbers: leading zeros are significant and real account
  // numbers exceed the safe integer range.
  accountNumber: z.string().optional(),
  bankName: z.string().optional(),
  ifscCode: z.string().optional(),
  // Coercion turns the input element's string into a number, and blank into 0
  // as the business rule requires. `.finite()` is what stops 'Infinity' —
  // which Number() accepts and a bare .number() check would pass — from
  // reaching the API.
  openingBalance: z.coerce
    .number({ invalid_type_error: BAD_BALANCE })
    .finite(BAD_BALANCE)
    .min(0, 'Opening balance cannot be negative.')
    // Scale and range both mirror the server's NUMERIC(12,2), so the form
    // cannot accept a figure the API will turn round and reject with a late
    // 400. multipleOf uses decimal-safe remainder arithmetic, unlike a
    // hand-rolled n * 100 check.
    //
    // The server additionally polices decimal *notation* ('1e5', '₹1000',
    // '1,000'). That grammar is unreachable from here and deliberately not
    // duplicated: onSubmit posts this schema's parsed output, so the API only
    // ever receives an already-coerced number — never the raw field text.
    .multipleOf(0.01, 'Opening balance can have at most two decimal places.')
    .max(9999999999.99, 'Opening balance is larger than this field can store.'),
});
type FormValues = z.infer<typeof schema>;

export default function CashBank() {
  const perm = usePermission('page:/accounts/cash-bank');
  const { data: accounts = [], isLoading } = useListCashBankAccounts();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const createMutation = useCreateCashBankAccount();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', accountType: 'bank', accountNumber: '', bankName: '', ifscCode: '', openingBalance: 0 },
  });

  const watchType = form.watch('accountType');

  // `data` is already the parsed output of the schema above, so openingBalance
  // is a number here. It used to be stringified back on the way out — with an
  // `as any` hiding the resulting contract violation — which is what the API
  // rejected with "Expected number, received string".
  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data }, {
      onSuccess: () => { toast.success('Account added'); queryClient.invalidateQueries({ queryKey: getListCashBankAccountsQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = accounts.filter(a => a.name?.toLowerCase().includes(search.toLowerCase()) || a.bankName?.toLowerCase().includes(search.toLowerCase()));
  // These legacy payment accounts predate the chart of accounts and are not
  // linked to any ledger, so the API returns currentBalance: null. Summing the
  // stored column instead would put lakhs of unreconciled rupees on screen under
  // the heading "Total Balance"; the reconciled cash and bank positions are on
  // the Cash & Bank Book and the Trial Balance.
  const linked = filtered.filter(a => a.currentBalance != null);
  const totalBalance = linked.reduce((s, a) => s + Number(a.currentBalance ?? 0), 0);
  const anyUnlinked = filtered.some(a => a.currentBalance == null);

  const { sorted, sort } = useTableSort(filtered, {
    name: a => a.name,
    type: a => a.accountType,
    bank: a => a.bankName,
    accountNumber: a => a.accountNumber,
    storedBalance: a => Number(a.storedBalance ?? 0),
    balance: a => a.currentBalance == null ? null : Number(a.currentBalance),
  });

  const typeColor = (t: string) => t === 'cash' ? 'bg-emerald-500/10 text-emerald-500' : t === 'bank' ? 'bg-primary/10 text-primary' : t === 'upi' ? 'bg-purple-500/10 text-purple-500' : 'bg-muted';

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
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Banknote className="w-6 h-6 text-primary" /> Cash & Bank</h1>
            <p className="text-muted-foreground mt-1">Payment account balances and details</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('cash-bank.csv', filtered.map(a => ({ Name: a.name, Type: a.accountType, Bank: a.bankName || '', 'Account No': a.accountNumber || '', IFSC: a.ifscCode || '', 'Stored Balance': a.storedBalance ?? 0, Balance: a.currentBalance ?? '' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            )}
            <Button onClick={() => { form.reset(); setIsOpen(true); }}><Plus className="w-4 h-4 mr-2" /> Add Account</Button>
          </div>
        </div>

        {/* Balance Summary */}
        <div className="bg-card border border-border rounded-xl p-5 flex justify-between items-center">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Balance</p>
            <p className="text-3xl font-bold font-mono text-primary mt-1">
              {linked.length === 0 ? '—' : `₹${totalBalance.toLocaleString('en-IN')}`}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">{filtered.length} accounts</p>
          </div>
        </div>

        {anyUnlinked && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            <p className="font-medium text-amber-600">Not linked to the chart of accounts</p>
            <p className="text-muted-foreground mt-1">
              These payment accounts pre-date the ledgers and carry a stored figure that no
              accounting entry maintains, so no current balance can be shown for them. The
              Stored Balance column shows that unmaintained figure — it starts at the opening
              balance entered when the account was added and is then reduced by expenses paid
              from it. For reconciled cash and bank positions use{' '}
              the <Link href="/accounts/cash-book" className="underline">Cash Book</Link>,{' '}
              <Link href="/accounts/bank-book" className="underline">Bank Book</Link>,{' '}
              <Link href="/accounts/trial-balance" className="underline">Trial Balance</Link> or the Balance Sheet.
            </p>
          </div>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search accounts..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="name" sort={sort}>Name</SortableHead>
                <SortableHead k="type" sort={sort}>Type</SortableHead>
                <SortableHead k="bank" sort={sort}>Bank</SortableHead>
                <SortableHead k="accountNumber" sort={sort}>Account No.</SortableHead>
                {/* Not "Opening Balance": creating an expense decrements this same
                    column, so on any account that has been paid from it is a stale
                    running figure rather than the amount originally entered. */}
                <SortableHead k="storedBalance" sort={sort} className="text-right">
                  <span title="Seeded from the opening balance when the account was added, then reduced by expenses paid from it. No accounting entry maintains this figure.">
                    Stored Balance
                  </span>
                </SortableHead>
                <SortableHead k="balance" sort={sort} className="text-right">Balance</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Banknote className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No payment accounts yet</p>
                </TableCell></TableRow>
              ) : sorted.map(a => (
                <TableRow key={a.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{a.name}</TableCell>
                  <TableCell><Badge variant="outline" className={`capitalize ${typeColor(a.accountType)}`}>{a.accountType}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.bankName || '—'}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{a.accountNumber || '—'}</TableCell>
                  <TableCell className="text-right font-mono text-sm text-muted-foreground">
                    ₹{Number(a.storedBalance ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {a.currentBalance == null ? (
                      <span className="text-muted-foreground" title="No ledger backs this account, so it has no reconciled balance">—</span>
                    ) : (
                      <span className="font-bold text-primary text-lg">₹{Number(a.currentBalance).toLocaleString('en-IN')}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add Payment Account</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Account Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. HDFC Main A/C" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="accountType" render={({ field }) => (
                <FormItem><FormLabel>Type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="bank">Bank Account</SelectItem>
                      <SelectItem value="upi">UPI / Digital</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select><FormMessage /></FormItem>
              )} />
              {watchType === 'bank' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField control={form.control} name="bankName" render={({ field }) => (
                    <FormItem><FormLabel>Bank Name</FormLabel><FormControl><Input placeholder="HDFC, SBI..." {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="ifscCode" render={({ field }) => (
                    <FormItem><FormLabel>IFSC Code</FormLabel><FormControl><Input className="font-mono" placeholder="HDFC0001234" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="accountNumber" render={({ field }) => (
                    <FormItem className="col-span-2"><FormLabel>Account Number</FormLabel><FormControl><Input className="font-mono" inputMode="numeric" placeholder="001234567890" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              )}
              <FormField control={form.control} name="openingBalance" render={({ field }) => (
                <FormItem><FormLabel>Opening Balance ₹</FormLabel><FormControl><Input type="number" step="0.01" min={0} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Adding…' : 'Add Account'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
