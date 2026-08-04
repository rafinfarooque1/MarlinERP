import { useState, useRef } from 'react';
import {
  useListJournalVouchers, useCreateJournalVoucher, useDeleteJournalVoucher,
  useListAccountsFlat, useListCustomers, useListVendors, type JournalVoucher,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, FileMinus2, FilePlus2, Download, Trash2, Search, Calendar, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Form, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { entryScopeKeyDown, autoFocusFirst, focusField, useEntryShortcuts } from '@/lib/keyboard-entry';

const schema = z.object({
  voucherDate: z.string().min(1, 'Date required'),
  partyId: z.coerce.number().min(1, 'Select party'),
  amount: z.coerce.number().min(0.01, 'Amount > 0'),
  counterLedgerId: z.coerce.number().optional(),
  reason: z.string().optional(),
  narration: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().split('T')[0];

function NotesTab({ noteType }: { noteType: 'credit_note' | 'debit_note' }) {
  const isCN = noteType === 'credit_note';
  const perm = usePermission('page:/accounts/vouchers');
  const { data: vouchers = [], isLoading } = useListJournalVouchers({ type: noteType });
  const { data: allAccounts = [] } = useListAccountsFlat();
  const { data: customers = [] } = useListCustomers();
  const { data: vendors = [] } = useListVendors();
  const createMutation = useCreateJournalVoucher();
  const deleteMutation = useDeleteJournalVoucher();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<JournalVoucher | null>(null);
  const scopeRef = useRef<HTMLFormElement>(null);

  const parties = (isCN ? (customers as any[]) : (vendors as any[])).map(p => ({ id: p.id, name: p.name }));
  const counterOptions = (allAccounts as any[]).filter(a => !a.isSystemGroup && !a.isGroup);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { voucherDate: today(), partyId: 0, amount: 0, counterLedgerId: 0, reason: '', narration: '' },
  });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({
      voucherType: noteType,
      voucherDate: data.voucherDate,
      partyId: data.partyId,
      amount: data.amount,
      counterLedgerId: data.counterLedgerId || undefined,
      reason: data.reason?.trim() || undefined,
      narration: data.narration?.trim() || undefined,
    }, {
      onSuccess: (v) => { toast.success(`${isCN ? 'Credit' : 'Debit'} note ${v.voucherNumber} recorded`); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // ── Keyboard Entry Mode ──
  const save = () => {
    if (createMutation.isPending) return;
    form.handleSubmit(onSubmit, (errors) => {
      const first = ['voucherDate', 'partyId', 'amount'].find(f => (errors as any)[f]);
      if (first) focusField(first, scopeRef.current);
    })();
  };
  useEntryShortcuts(isOpen, { onSave: save });

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success('Note deleted'); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = (vouchers as JournalVoucher[]).filter(v =>
    v.voucherNumber?.toLowerCase().includes(search.toLowerCase()) ||
    v.partyName?.toLowerCase().includes(search.toLowerCase()) ||
    v.reason?.toLowerCase().includes(search.toLowerCase())
  );
  const total = filtered.reduce((s, v) => s + v.totalAmount, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <p className="text-muted-foreground text-sm">
          {isCN
            ? 'Issue against customer returns or overbilling — reduces what the customer owes'
            : 'Issue against purchase returns or vendor overcharges — reduces what you owe the vendor'}
        </p>
        <div className="flex gap-2">
          {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV(`${noteType}s.csv`, filtered.map(v => ({
              Voucher: v.voucherNumber, Date: v.voucherDate, Party: v.partyName || '',
              Amount: v.totalAmount, Reason: v.reason || '',
            })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
          )}
          {perm.canAdd && (
            <Button size="sm" onClick={() => { form.reset({ voucherDate: today(), partyId: 0, amount: 0, counterLedgerId: 0, reason: '', narration: '' }); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> New {isCN ? 'Credit' : 'Debit'} Note
            </Button>
          )}
        </div>
      </div>

      {filtered.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4 flex justify-between items-center">
          <span className="text-muted-foreground text-sm">{filtered.length} {isCN ? 'credit' : 'debit'} notes</span>
          <span className={`text-xl font-bold font-mono ${isCN ? 'text-emerald-500' : 'text-amber-500'}`}>{inr(total)}</span>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input placeholder="Search voucher, party or reason..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm" />
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead>Note #</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>{isCN ? 'Customer' : 'Vendor'}</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? [...Array(3)].map((_, i) => (
              <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
            )) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                {isCN ? <FileMinus2 className="w-10 h-10 mx-auto mb-3 opacity-20" /> : <FilePlus2 className="w-10 h-10 mx-auto mb-3 opacity-20" />}
                <p>No {isCN ? 'credit' : 'debit'} notes yet</p>
              </TableCell></TableRow>
            ) : filtered.map(v => (
              <TableRow key={v.id} className="hover:bg-muted/10">
                <TableCell className="font-mono text-primary font-bold text-sm">{v.voucherNumber}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(v.voucherDate).toLocaleDateString('en-IN')}</div>
                </TableCell>
                <TableCell className="font-medium text-sm">{v.partyName || '—'}</TableCell>
                <TableCell className="text-muted-foreground text-sm max-w-[240px] truncate">{v.reason || v.narration || '—'}</TableCell>
                <TableCell className={`text-right font-mono font-bold ${isCN ? 'text-emerald-500' : 'text-amber-500'}`}>{inr(v.totalAmount)}</TableCell>
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

      {/* ── New Note Dialog ── */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) form.reset(); }}>
        <DialogContent className="sm:max-w-lg" onOpenAutoFocus={autoFocusFirst}>
          <DialogHeader><DialogTitle>New {isCN ? 'Credit' : 'Debit'} Note</DialogTitle></DialogHeader>
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

              <FormField control={form.control} name="partyId" render={({ field }) => (
                <FormItem>
                  <FormLabel>{isCN ? 'Customer' : 'Vendor'} <span className="text-destructive">*</span></FormLabel>
                  <AccountCombobox options={parties} value={field.value} onChange={field.onChange} placeholder={`Select ${isCN ? 'customer' : 'vendor'}`} advanceOnSelect data-field="partyId" />
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="amount" render={({ field }) => (
                <FormItem><FormLabel>Amount ₹ <span className="text-destructive">*</span></FormLabel>
                  <Input type="number" min={0} step="0.01" data-field="amount" {...field} />
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="counterLedgerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Adjust against <span className="text-muted-foreground font-normal">(default: {isCN ? 'Sales' : 'Purchases'})</span></FormLabel>
                  <AccountCombobox options={counterOptions} value={field.value ?? 0} onChange={field.onChange} placeholder={`Default — ${isCN ? 'Sales' : 'Purchases'} account`} advanceOnSelect />
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="reason" render={({ field }) => (
                <FormItem><FormLabel>Reason</FormLabel>
                  <Input placeholder={isCN ? 'e.g. Sales return — damaged goods' : 'e.g. Purchase return — short delivery'} {...field} />
                </FormItem>
              )} />

              <FormField control={form.control} name="narration" render={({ field }) => (
                <FormItem><FormLabel>Narration</FormLabel>
                  <Textarea rows={2} placeholder="Additional details (optional)" {...field} />
                </FormItem>
              )} />

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Recording…' : `Record ${isCN ? 'Credit' : 'Debit'} Note`}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Note</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">Delete <span className="font-semibold text-foreground">{deleteTarget?.voucherNumber}</span> of {inr(Number(deleteTarget?.totalAmount || 0))}? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Notes() {
  const perm = usePermission('page:/accounts/vouchers');

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
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileMinus2 className="w-6 h-6 text-emerald-500" /> Credit & Debit Notes
          </h1>
          <p className="text-muted-foreground mt-1">Returns, rate differences and billing adjustments</p>
        </div>

        <Tabs defaultValue="credit_note">
          <TabsList>
            <TabsTrigger value="credit_note" className="gap-1.5"><FileMinus2 className="w-4 h-4" /> Credit Notes (Customers)</TabsTrigger>
            <TabsTrigger value="debit_note" className="gap-1.5"><FilePlus2 className="w-4 h-4" /> Debit Notes (Vendors)</TabsTrigger>
          </TabsList>
          <TabsContent value="credit_note" className="mt-4"><NotesTab noteType="credit_note" /></TabsContent>
          <TabsContent value="debit_note" className="mt-4"><NotesTab noteType="debit_note" /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
