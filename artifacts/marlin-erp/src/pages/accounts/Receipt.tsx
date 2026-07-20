import { useState } from 'react';
import { useListReceipts, useCreateReceipt, useDeleteReceipt, useListAccountsFlat } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, ArrowDownRight, Download, Trash2, Search, Calendar, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';

const schema = z.object({
  receiptDate: z.string().min(1, 'Date required'),
  receivedFromLedgerId: z.coerce.number().min(1, 'Select account'),
  receivedInLedgerId: z.coerce.number().min(1, 'Select account'),
  amount: z.coerce.number().min(0.01, 'Amount > 0'),
  narration: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function ReceiptPage() {
  const perm = usePermission('Accounts');
  const { data: receipts = [], isLoading } = useListReceipts();
  const { data: accounts = [] } = useListAccountsFlat();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const createMutation = useCreateReceipt();
  const deleteMutation = useDeleteReceipt();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { receiptDate: new Date().toISOString().split('T')[0], receivedFromLedgerId: 0, receivedInLedgerId: 0, amount: 0, narration: '' },
  });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate(data as any, {
      onSuccess: () => { toast.success('Receipt recorded'); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success('Receipt deleted'); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = (receipts as any[]).filter(r =>
    r.voucherNumber?.toLowerCase().includes(search.toLowerCase()) ||
    r.receivedFromName?.toLowerCase().includes(search.toLowerCase()) ||
    r.receivedInName?.toLowerCase().includes(search.toLowerCase()) ||
    r.narration?.toLowerCase().includes(search.toLowerCase())
  );

  const total = filtered.reduce((s: number, r: any) => s + Number(r.amount), 0);

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
              <ArrowDownRight className="w-6 h-6 text-emerald-500" /> Receipt Vouchers
            </h1>
            <p className="text-muted-foreground mt-1">Record incoming receipts</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('receipts.csv', filtered.map((r: any) => ({
                Voucher: r.voucherNumber, Date: r.receiptDate, 'Received From': r.receivedFromName,
                'Received In': r.receivedInName, Amount: r.amount, Narration: r.narration || '',
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { form.reset({ receiptDate: new Date().toISOString().split('T')[0], receivedFromLedgerId: 0, receivedInLedgerId: 0, amount: 0, narration: '' }); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Receipt
              </Button>
            )}
          </div>
        </div>

        {filtered.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
            <span className="text-muted-foreground text-sm">{filtered.length} receipt vouchers</span>
            <span className="text-xl font-bold text-emerald-500 font-mono">₹{total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
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
                <TableHead>Received From</TableHead>
                <TableHead>Received In</TableHead>
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
                  <ArrowDownRight className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No receipt vouchers yet</p>
                </TableCell></TableRow>
              ) : filtered.map((r: any) => (
                <TableRow key={r.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-emerald-500 font-bold text-sm">{r.voucherNumber}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(r.receiptDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="font-medium text-sm">{r.receivedFromName}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{r.receivedInName}</Badge></TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">{r.narration || '—'}</TableCell>
                  <TableCell className="text-right font-mono font-bold text-emerald-500">₹{Number(r.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</TableCell>
                  <TableCell className="text-right">
                    {perm.canDelete && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(r)}>
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

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) form.reset(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>New Receipt Voucher</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="receiptDate" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="receivedFromLedgerId" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Received From <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {(accounts as any[]).map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="receivedInLedgerId" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Received In (Cash / Bank) <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {(accounts as any[]).map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="amount" render={({ field }) => (
                  <FormItem><FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" min={0} step="0.01" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="narration" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Narration</FormLabel><FormControl><Textarea rows={2} placeholder="Brief description of the receipt" {...field} /></FormControl></FormItem>
                )} />
              </div>
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Recording…' : 'Record Receipt'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Receipt</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">Delete receipt voucher <span className="font-semibold text-foreground">{deleteTarget?.voucherNumber}</span> of ₹{Number(deleteTarget?.amount || 0).toLocaleString('en-IN')}? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
