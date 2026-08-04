import { useState, useRef } from 'react';
import {
  useListJournalVouchers, useCreateJournalVoucher, useDeleteJournalVoucher,
  useCashBankLedgersFlat, type JournalVoucher,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, ArrowLeftRight, Download, Trash2, Search, Calendar, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Form, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { entryScopeKeyDown, autoFocusFirst, focusField, useEntryShortcuts } from '@/lib/keyboard-entry';

const schema = z.object({
  voucherDate: z.string().min(1, 'Date required'),
  fromLedgerId: z.coerce.number().min(1, 'Select account'),
  toLedgerId: z.coerce.number().min(1, 'Select account'),
  amount: z.coerce.number().min(0.01, 'Amount > 0'),
  narration: z.string().optional(),
}).refine(d => d.fromLedgerId !== d.toLedgerId, { message: 'From and To must differ', path: ['toLedgerId'] });
type FormValues = z.infer<typeof schema>;

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().split('T')[0];

export default function Contra() {
  const perm = usePermission('page:/accounts/vouchers');
  const { data: vouchers = [], isLoading } = useListJournalVouchers({ type: 'contra' });
  const { data: cashBankAccounts = [] } = useCashBankLedgersFlat();
  const createMutation = useCreateJournalVoucher();
  const deleteMutation = useDeleteJournalVoucher();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<JournalVoucher | null>(null);
  const scopeRef = useRef<HTMLFormElement>(null);

  const options = (cashBankAccounts as any[]).filter(a => !a.isGroup && !a.isSystemGroup);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { voucherDate: today(), fromLedgerId: 0, toLedgerId: 0, amount: 0, narration: '' },
  });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({
      voucherType: 'contra',
      voucherDate: data.voucherDate,
      fromLedgerId: data.fromLedgerId,
      toLedgerId: data.toLedgerId,
      amount: data.amount,
      narration: data.narration?.trim() || undefined,
    }, {
      onSuccess: (v) => { toast.success(`Contra ${v.voucherNumber} recorded`); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // ── Keyboard Entry Mode ──
  const save = () => {
    if (createMutation.isPending) return;
    form.handleSubmit(onSubmit, (errors) => {
      const first = ['voucherDate', 'fromLedgerId', 'toLedgerId', 'amount']
        .find(f => (errors as any)[f]);
      if (first) focusField(first, scopeRef.current);
    })();
  };
  useEntryShortcuts(isOpen, { onSave: save });

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success('Contra deleted'); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // Contra lines: debit = destination, credit = source
  const rows = (vouchers as JournalVoucher[]).map(v => {
    const toLine = v.lines.find(l => l.debit > 0);
    const fromLine = v.lines.find(l => l.credit > 0);
    return { ...v, fromName: fromLine?.ledgerName ?? '—', toName: toLine?.ledgerName ?? '—' };
  }).filter(v =>
    v.voucherNumber?.toLowerCase().includes(search.toLowerCase()) ||
    v.fromName.toLowerCase().includes(search.toLowerCase()) ||
    v.toName.toLowerCase().includes(search.toLowerCase()) ||
    v.narration?.toLowerCase().includes(search.toLowerCase())
  );

  const total = rows.reduce((s, v) => s + v.totalAmount, 0);

  const { sorted, sort } = useTableSort(rows, {
    voucher: v => v.voucherNumber,
    date: v => v.voucherDate,
    from: v => v.fromName,
    to: v => v.toName,
    narration: v => v.narration,
    amount: v => Number(v.totalAmount),
  });

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
              <ArrowLeftRight className="w-6 h-6 text-violet-500" /> Contra Vouchers
            </h1>
            <p className="text-muted-foreground mt-1">Move money between cash and bank accounts</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('contra-vouchers.csv', rows.map(v => ({
                Voucher: v.voucherNumber, Date: v.voucherDate, From: v.fromName, To: v.toName,
                Amount: v.totalAmount, Narration: v.narration || '',
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { form.reset({ voucherDate: today(), fromLedgerId: 0, toLedgerId: 0, amount: 0, narration: '' }); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Contra
              </Button>
            )}
          </div>
        </div>

        {rows.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
            <span className="text-muted-foreground text-sm">{rows.length} contra vouchers</span>
            <span className="text-xl font-bold text-violet-500 font-mono">{inr(total)}</span>
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
                <SortableHead k="voucher" sort={sort}>Voucher #</SortableHead>
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="from" sort={sort}>From</SortableHead>
                <SortableHead k="to" sort={sort}>To</SortableHead>
                <SortableHead k="narration" sort={sort}>Narration</SortableHead>
                <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : rows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <ArrowLeftRight className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No contra vouchers yet</p>
                </TableCell></TableRow>
              ) : sorted.map(v => (
                <TableRow key={v.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold text-sm">{v.voucherNumber}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(v.voucherDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{v.fromName}</Badge></TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{v.toName}</Badge></TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">{v.narration || '—'}</TableCell>
                  <TableCell className="text-right font-mono font-bold text-violet-500">{inr(v.totalAmount)}</TableCell>
                  <TableCell className="text-right">
                    {perm.canDelete && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(v)}>
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

      {/* ── New Contra Dialog ── */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) form.reset(); }}>
        <DialogContent className="sm:max-w-lg" onOpenAutoFocus={autoFocusFirst}>
          <DialogHeader><DialogTitle>New Contra Voucher</DialogTitle></DialogHeader>
          <Form {...form}>
            <form
              ref={scopeRef}
              data-kbd-scope
              onKeyDown={entryScopeKeyDown({ onSave: save })}
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4 pt-2"
            >
              <FormField control={form.control} name="voucherDate" render={({ field }) => (
                <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel>
                  <Input type="date" data-field="voucherDate" {...field} />
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="fromLedgerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>From (money leaves) <span className="text-destructive">*</span></FormLabel>
                  <AccountCombobox options={options} value={field.value} onChange={field.onChange} placeholder="Select Cash or Bank account" advanceOnSelect data-field="fromLedgerId" />
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="toLedgerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>To (money arrives) <span className="text-destructive">*</span></FormLabel>
                  <AccountCombobox options={options} value={field.value} onChange={field.onChange} placeholder="Select Cash or Bank account" advanceOnSelect data-field="toLedgerId" />
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="amount" render={({ field }) => (
                <FormItem><FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel>
                  <Input type="number" min={0} step="0.01" data-field="amount" {...field} />
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="narration" render={({ field }) => (
                <FormItem><FormLabel>Narration</FormLabel>
                  <Textarea rows={2} placeholder="e.g. Cash deposited into bank" {...field} />
                </FormItem>
              )} />

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Recording…' : 'Record Contra'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Contra</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">Delete contra voucher <span className="font-semibold text-foreground">{deleteTarget?.voucherNumber}</span> of {inr(Number(deleteTarget?.totalAmount || 0))}? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
