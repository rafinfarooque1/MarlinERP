import { useState } from 'react';
import { useListPayments, useCreatePayment, useDeletePayment, useListAccountsFlat, useCashBankLedgersFlat } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, ArrowUpLeft, Download, Trash2, Search, Calendar, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Form, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { AccountCombobox } from '@/components/ui/account-combobox';

const schema = z.object({
  paymentDate: z.string().min(1, 'Date required'),
  paidFromLedgerId: z.coerce.number().min(1, 'Select account'),
  paidToLedgerId: z.coerce.number().min(1, 'Select account'),
  amount: z.coerce.number().min(0.01, 'Amount > 0'),
  narration: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Payment() {
  const perm = usePermission('Accounts');
  const { data: payments = [], isLoading } = useListPayments();
  const { data: allAccounts = [] } = useListAccountsFlat();
  const { data: cashBankAccounts = [] } = useCashBankLedgersFlat();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const createMutation = useCreatePayment();
  const deleteMutation = useDeletePayment();

  // "Paid From" — only Bank / Cash and their sub-ledgers
  const fromOptions = cashBankAccounts as any[];
  // "Paid To" — all non-system-group ledgers (expense, payable, etc.)
  const toOptions = (allAccounts as any[]).filter(a => !a.isSystemGroup);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { paymentDate: new Date().toISOString().split('T')[0], paidFromLedgerId: 0, paidToLedgerId: 0, amount: 0, narration: '' },
  });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate(data as any, {
      onSuccess: () => { toast.success('Payment recorded'); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success('Payment deleted'); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = (payments as any[]).filter(p =>
    p.voucherNumber?.toLowerCase().includes(search.toLowerCase()) ||
    p.paidFromName?.toLowerCase().includes(search.toLowerCase()) ||
    p.paidToName?.toLowerCase().includes(search.toLowerCase()) ||
    p.narration?.toLowerCase().includes(search.toLowerCase())
  );

  const total = filtered.reduce((s: number, p: any) => s + Number(p.amount), 0);

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
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ArrowUpLeft className="w-6 h-6 text-red-500" /> Payment Vouchers
            </h1>
            <p className="text-muted-foreground mt-1">Record outgoing payments</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('payments.csv', filtered.map((p: any) => ({
                Voucher: p.voucherNumber, Date: p.paymentDate, 'Paid From': p.paidFromName,
                'Paid To': p.paidToName, Amount: p.amount, Narration: p.narration || '',
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => {
                form.reset({ paymentDate: new Date().toISOString().split('T')[0], paidFromLedgerId: 0, paidToLedgerId: 0, amount: 0, narration: '' });
                setIsOpen(true);
              }}>
                <Plus className="w-4 h-4 mr-2" /> New Payment
              </Button>
            )}
          </div>
        </div>

        {filtered.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
            <span className="text-muted-foreground text-sm">{filtered.length} payment vouchers</span>
            <span className="text-xl font-bold text-red-500 font-mono">₹{total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          </div>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search voucher, account or narration..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Voucher #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Paid From</TableHead>
                <TableHead>Paid To</TableHead>
                <TableHead>Narration</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <ArrowUpLeft className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No payment vouchers yet</p>
                </TableCell></TableRow>
              ) : filtered.map((p: any) => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold text-sm">{p.voucherNumber}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(p.paymentDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{p.paidFromName}</Badge></TableCell>
                  <TableCell className="font-medium text-sm">{p.paidToName}</TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">{p.narration || '—'}</TableCell>
                  <TableCell className="text-right font-mono font-bold text-red-500">₹{Number(p.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell className="text-right">
                    {perm.canDelete && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(p)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ── New Payment Dialog ── */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) form.reset(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>New Payment Voucher</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">

              {/* Date */}
              <FormField control={form.control} name="paymentDate" render={({ field }) => (
                <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel>
                  <Input type="date" {...field} />
                  <FormMessage />
                </FormItem>
              )} />

              {/* Paid From — searchable, Bank/Cash only */}
              <FormField control={form.control} name="paidFromLedgerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Paid From (Cash / Bank) <span className="text-destructive">*</span></FormLabel>
                  <AccountCombobox
                    options={fromOptions}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Select Bank or Cash account"
                  />
                  <FormMessage />
                </FormItem>
              )} />

              {/* Paid To — searchable, all non-system ledgers */}
              <FormField control={form.control} name="paidToLedgerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Paid To (Expense / Payable) <span className="text-destructive">*</span></FormLabel>
                  <AccountCombobox
                    options={toOptions}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Select account"
                  />
                  <FormMessage />
                </FormItem>
              )} />

              {/* Amount */}
              <FormField control={form.control} name="amount" render={({ field }) => (
                <FormItem><FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel>
                  <Input type="number" min={0} step="0.01" {...field} />
                  <FormMessage />
                </FormItem>
              )} />

              {/* Narration */}
              <FormField control={form.control} name="narration" render={({ field }) => (
                <FormItem><FormLabel>Narration</FormLabel>
                  <Textarea rows={2} placeholder="Brief description of the payment" {...field} />
                </FormItem>
              )} />

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Recording…' : 'Record Payment'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Payment</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">Delete payment voucher <span className="font-semibold text-foreground">{deleteTarget?.voucherNumber}</span> of ₹{Number(deleteTarget?.amount || 0).toLocaleString('en-IN')}? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
