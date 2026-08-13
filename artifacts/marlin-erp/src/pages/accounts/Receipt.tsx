import { useState, useMemo, useEffect } from 'react';
import { useListReceipts, useCreateReceipt, useDeleteReceipt, useListAccountsFlat, useCashBankLedgersFlat } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { TransactionDialog, TransactionDialogContent } from '@/components/ui/transaction-dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, ArrowDownRight, Download, Trash2, Search, Calendar, AlertTriangle, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Form, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { isSystemLedger } from '@/lib/systemLedgers';
import { BillSettlementPanel, type SettlementSelection } from '@/components/settlement/BillSettlementPanel';
import { useVoucherLocationChoice, parseLocKey, LocationSelectField, voucherLocationName } from '@/lib/voucherLocation';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { FileStack } from 'lucide-react';
import { inr } from '@/lib/currency';

const schema = z.object({
  receiptDate: z.string().min(1, 'Date required'),
  receivedFromLedgerId: z.coerce.number().min(1, 'Select account'),
  receivedInLedgerId: z.coerce.number().min(1, 'Select account'),
  amount: z.coerce.number().min(0.01, 'Amount > 0'),
  referenceNumber: z.string().max(100).optional(),
  narration: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function ReceiptPage() {
  const perm = usePermission('page:/accounts/vouchers');
  const { data: receipts = [], isLoading } = useListReceipts();
  const { data: allAccounts = [] } = useListAccountsFlat();
  const { data: cashBankAccounts = [] } = useCashBankLedgersFlat();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [settlement, setSettlement] = useState<SettlementSelection | null>(null);
  const createMutation = useCreateReceipt();
  const deleteMutation = useDeleteReceipt();

  // The selected location OWNS the receipt's accounting — an Admin recording
  // on behalf of a branch produces a branch voucher. Defaults to the global
  // location selector; the pickers narrow to that location's own accounts.
  const { locations, locKey, setLocKey, selLoc, foreignLedgerIds } = useVoucherLocationChoice();

  // "Received From" — all non-system ledgers minus other locations' accounts.
  // Payroll/GST/internal ledgers stay module-owned (advances are recovered
  // through payroll, not receipts).
  const fromOptions = (allAccounts as any[]).filter(a =>
    !a.isSystemGroup && !a.isGroup && !isSystemLedger(a.code) && !foreignLedgerIds.has(a.id));
  // "Received In" — only the selected location's Bank / Cash accounts
  const inOptions = (cashBankAccounts as any[]).filter(a =>
    !selLoc || selLoc.cashBankLedgerIds.includes(a.id));

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { receiptDate: new Date().toISOString().split('T')[0], receivedFromLedgerId: 0, receivedInLedgerId: 0, amount: 0, referenceNumber: '', narration: '' },
  });

  // Switching location narrows the pickers — clear selections that just
  // became foreign so a hidden value can't ride along into the submit.
  useEffect(() => {
    const inId = Number(form.getValues('receivedInLedgerId'));
    if (inId && !inOptions.some((a: any) => Number(a.id) === inId)) form.setValue('receivedInLedgerId', 0);
    const fromId = Number(form.getValues('receivedFromLedgerId'));
    if (fromId && foreignLedgerIds.has(fromId)) form.setValue('receivedFromLedgerId', 0);
  }, [locKey, inOptions, foreignLedgerIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = (data: FormValues) => {
    const loc = parseLocKey(locKey);
    if (!loc) { toast.error('Please select a location.'); return; }
    // A customer receipt carries its bill split so the books settle those
    // exact bills; any excess parks as the customer's advance.
    const body: any = { ...data, locationType: loc.locationType, locationId: loc.locationId };
    if (settlement && settlement.kind === 'customer'
        && (settlement.allocations.length > 0 || settlement.advanceAmount > 0.004)) {
      body.allocations = settlement.allocations.map(a => ({ saleId: a.billId, amount: a.amount }));
      body.advanceAmount = settlement.advanceAmount;
    }
    createMutation.mutate(body, {
      onSuccess: () => { toast.success('Receipt recorded'); setIsOpen(false); form.reset(); setSettlement(null); },
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

  const filtered = useMemo(() => (receipts as any[]).filter(r =>
    r.voucherNumber?.toLowerCase().includes(search.toLowerCase()) ||
    r.receivedFromName?.toLowerCase().includes(search.toLowerCase()) ||
    r.receivedInName?.toLowerCase().includes(search.toLowerCase()) ||
    r.narration?.toLowerCase().includes(search.toLowerCase())
  ), [receipts, search]);

  const total = filtered.reduce((s: number, r: any) => s + Number(r.amount), 0);

  const { sorted, sort } = useTableSort(filtered, {
    voucher: (r: any) => r.voucherNumber,
    date: (r: any) => r.receiptDate,
    from: (r: any) => r.receivedFromName,
    in: (r: any) => r.receivedInName,
    location: (r: any) => voucherLocationName(locations, r.locationType, r.locationId),
    reference: (r: any) => r.referenceNumber,
    narration: (r: any) => r.narration,
    amount: (r: any) => Number(r.amount),
  });

  const { pageRows, pagerProps } = useClientPage(sorted);

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
        <PageHeader
          title="Receipt Vouchers"
          description="Record incoming receipts"
          icon={ArrowDownRight}
          actions={
            <>
              {perm.canDownload && (
                <Button variant="outline" size="sm" onClick={() => downloadCSV('receipts.csv', filtered.map((r: any) => ({
                  Voucher: r.voucherNumber, Date: r.receiptDate, 'Received From': r.receivedFromName,
                  'Received In': r.receivedInName, Location: voucherLocationName(locations, r.locationType, r.locationId),
                  Amount: r.amount,
                  Reference: r.referenceNumber || '', Narration: r.narration || '',
                })))}>
                  <Download className="w-4 h-4 mr-2" /> Export
                </Button>
              )}
              {perm.canAdd && (
                <Button onClick={() => {
                  form.reset({ receiptDate: new Date().toISOString().split('T')[0], receivedFromLedgerId: 0, receivedInLedgerId: 0, amount: 0, referenceNumber: '', narration: '' });
                  setIsOpen(true);
                }}>
                  <Plus className="w-4 h-4 mr-2" /> New Receipt
                </Button>
              )}
            </>
          }
        />

        <SummaryCardGrid>
          <SummaryCard label="Receipt Vouchers" value={filtered.length.toLocaleString('en-IN')} icon={FileStack} tone="info" loading={isLoading} />
          <SummaryCard label="Total Received" value={`${inr(total)}`} icon={ArrowDownRight} tone="positive" loading={isLoading} />
        </SummaryCardGrid>

        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input placeholder="Search voucher, account or narration..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={8} cols={9} />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="voucher" sort={sort}>Voucher #</SortableHead>
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="from" sort={sort}>Received From</SortableHead>
                <SortableHead k="in" sort={sort}>Received In</SortableHead>
                <SortableHead k="location" sort={sort}>Location</SortableHead>
                <SortableHead k="reference" sort={sort}>Reference</SortableHead>
                <SortableHead k="narration" sort={sort}>Narration</SortableHead>
                <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="p-0">
                  <EmptyState icon={ArrowDownRight} title="No receipt vouchers yet" hint="Record an incoming receipt to see it here." compact />
                </TableCell></TableRow>
              ) : pageRows.map((r: any) => (
                <TableRow key={r.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-emerald-500 font-bold text-sm">{r.voucherNumber}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(r.receiptDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="font-medium text-sm">{r.receivedFromName}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{r.receivedInName}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{voucherLocationName(locations, r.locationType, r.locationId)}</TableCell>
                  <TableCell className="text-sm">
                    {r.referenceNumber
                      ? <span className="text-[11px] text-muted-foreground font-mono max-w-[120px] truncate inline-block" title={r.referenceNumber}>{r.referenceNumber}</span>
                      : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">{r.narration || '—'}</TableCell>
                  <TableCell className="text-right font-mono font-bold text-emerald-500">{inr(Number(r.amount))}</TableCell>
                  <TableCell className="text-right">
                    {r.origin === 'system' ? (
                      // System-generated (sale settlements, credit clearings) — owned
                      // by its module; the server refuses edits/deletes, so no button.
                      <span title="System voucher — manage from its own module" className="inline-flex justify-center w-8">
                        <Lock className="w-3.5 h-3.5 text-muted-foreground/60" />
                      </span>
                    ) : perm.canDelete && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(r)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </div>
        <TablePager {...pagerProps} />
      </div>

      {/* ── New Receipt Dialog ── */}
      <TransactionDialog open={isOpen} dirty={form.formState.isDirty} onOpenChange={v => { setIsOpen(v); if (!v) form.reset(); }}>
        <TransactionDialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>New Receipt Voucher</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">

              {/* Location — owns the voucher's accounting */}
              <LocationSelectField locations={locations} locKey={locKey} setLocKey={setLocKey} />

              {/* Date */}
              <FormField control={form.control} name="receiptDate" render={({ field }) => (
                <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel>
                  <Input type="date" {...field} />
                  <FormMessage />
                </FormItem>
              )} />

              {/* Received From — searchable, all non-system ledgers */}
              <FormField control={form.control} name="receivedFromLedgerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Received From <span className="text-destructive">*</span></FormLabel>
                  <AccountCombobox
                    options={fromOptions}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Select account"
                  />
                  <FormMessage />
                </FormItem>
              )} />

              {/* Received In — searchable, Bank/Cash only */}
              <FormField control={form.control} name="receivedInLedgerId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Received In (Cash / Bank) <span className="text-destructive">*</span></FormLabel>
                  <AccountCombobox
                    options={inOptions}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Select Bank or Cash account"
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

              {/* Bill-wise settlement — appears when a customer ledger is picked */}
              <BillSettlementPanel
                ledgerId={Number(form.watch('receivedFromLedgerId')) || 0}
                amount={Number(form.watch('amount')) || 0}
                onSelection={setSettlement}
              />

              {/* Reference — descriptive metadata only */}
              <FormField control={form.control} name="referenceNumber" render={({ field }) => (
                <FormItem><FormLabel>Reference #</FormLabel>
                  <Input placeholder="Cheque / UTR / Txn no." {...field} />
                  <FormMessage />
                </FormItem>
              )} />

              {/* Narration */}
              <FormField control={form.control} name="narration" render={({ field }) => (
                <FormItem><FormLabel>Narration</FormLabel>
                  <Textarea rows={2} placeholder="Brief description of the receipt" {...field} />
                </FormItem>
              )} />

              <DialogFooter className="max-md:sticky max-md:bottom-0 max-md:z-20 max-md:-mx-4 max-md:px-4 max-md:py-2 max-md:bg-background/95 max-md:backdrop-blur max-md:border-t max-md:border-border">
                <DialogClose asChild><Button variant="outline" type="button">Cancel</Button></DialogClose>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? 'Recording…' : 'Record Receipt'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </TransactionDialogContent>
      </TransactionDialog>

      {/* ── Delete Confirmation ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Receipt</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">Delete receipt voucher <span className="font-semibold text-foreground">{deleteTarget?.voucherNumber}</span> of {inr(Number(deleteTarget?.amount || 0))}? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
