import { useState } from 'react';
import { Link } from 'wouter';
import {
  useListCashBankAccounts, useCreateCashBankAccount, useUpdateCashBankAccount, useDeleteCashBankAccount,
  getListCashBankAccountsQueryKey, useListWarehouses, useListOutlets, useGetMe,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Banknote, Download, ShieldOff, Lock, Pencil, Trash2, Landmark } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';

const BAD_BALANCE = 'Please enter a valid opening balance.';

const schema = z.object({
  name: z.string().min(2, 'Name required (at least 2 characters)'),
  accountType: z.enum(['cash', 'bank', 'upi', 'other']),
  // "headoffice" or "warehouse:3" / "outlet:2" — split before submit.
  location: z.string(),
  // Never parsed as numbers: leading zeros are significant and real account
  // numbers exceed the safe integer range.
  accountNumber: z.string().optional(),
  bankName: z.string().optional(),
  ifscCode: z.string().optional(),
  // Bank/UPI only: ON = collections pass through Reconciliation before the
  // bank balance moves; OFF = they post straight into the account's ledger.
  requiresReconciliation: z.boolean(),
  // Coercion turns the input element's string into a number, and blank into 0
  // as the business rule requires. `.finite()` is what stops 'Infinity' —
  // which Number() accepts and a bare .number() check would pass — from
  // reaching the API.
  openingBalance: z.coerce
    .number({ invalid_type_error: BAD_BALANCE })
    .finite(BAD_BALANCE)
    .min(0, 'Opening balance cannot be negative.')
    .multipleOf(0.01, 'Opening balance can have at most two decimal places.')
    .max(9999999999.99, 'Opening balance is larger than this field can store.'),
});
type FormValues = z.infer<typeof schema>;

type LocationType = 'headoffice' | 'warehouse' | 'outlet';
function splitLocation(v: string): { locationType: LocationType; locationId?: number } {
  if (v === 'headoffice') return { locationType: 'headoffice' };
  const [locationType, id] = v.split(':');
  return { locationType: locationType as LocationType, locationId: Number(id) };
}

export default function CashBank() {
  const perm = usePermission('page:/accounts/cash-bank');
  // Managing accounts is a Head Office function (the server rejects everyone
  // else), so branch staff never see the Add button — or the location list
  // behind it, which would name other branches.
  const { data: me } = useGetMe();
  const isHOUser = !(me as any)?.branchType || (me as any)?.branchType === 'headoffice';
  const { data: accounts = [], isLoading } = useListCashBankAccounts();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateCashBankAccount();
  const updateMutation = useUpdateCashBankAccount();
  const deleteMutation = useDeleteCashBankAccount();
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListCashBankAccountsQueryKey() });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', accountType: 'bank', location: 'headoffice', accountNumber: '', bankName: '', ifscCode: '', openingBalance: 0, requiresReconciliation: true },
  });

  const watchType = form.watch('accountType');
  const isEdit = editing != null;

  const openAdd = () => {
    setEditing(null);
    form.reset({ name: '', accountType: 'bank', location: 'headoffice', accountNumber: '', bankName: '', ifscCode: '', openingBalance: 0, requiresReconciliation: true });
    setIsOpen(true);
  };
  const openEdit = (a: any) => {
    setEditing(a);
    form.reset({
      name: a.name ?? '',
      accountType: a.accountType,
      location: a.locationType && a.locationType !== 'headoffice' && a.locationId != null ? `${a.locationType}:${a.locationId}` : 'headoffice',
      accountNumber: a.accountNumber ?? '',
      bankName: a.bankName ?? '',
      ifscCode: a.ifscCode ?? '',
      openingBalance: 0,
      requiresReconciliation: a.requiresReconciliation === true,
    });
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    const loc = splitLocation(data.location);
    if (isEdit) {
      // Opening balance is only sent when the user typed one — 0 would
      // otherwise silently wipe an existing opening figure on every rename.
      const dirty = form.formState.dirtyFields;
      updateMutation.mutate({
        id: editing.id,
        data: {
          name: data.name, bankName: data.bankName, accountNumber: data.accountNumber, ifscCode: data.ifscCode,
          ...loc,
          ...(dirty.openingBalance ? { openingBalance: data.openingBalance } : {}),
          // Cash accounts never send the flag — the server rejects it for them.
          ...(data.accountType !== 'cash' ? { requiresReconciliation: data.requiresReconciliation } : {}),
        },
      }, {
        onSuccess: () => { toast.success('Account updated'); refresh(); setIsOpen(false); },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    } else {
      const { location: _l, ...rest } = data;
      createMutation.mutate({ data: { ...rest, ...loc } }, {
        onSuccess: () => { toast.success('Account added — its ledger now appears under Chart of Accounts'); refresh(); setIsOpen(false); form.reset(); },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    }
  };

  const confirmDelete = () => {
    if (!deleting) return;
    deleteMutation.mutate({ id: deleting.id }, {
      onSuccess: () => { toast.success('Account deleted'); refresh(); setDeleting(null); },
      onError: (e: any) => { toast.error(e?.data?.error || e.message || 'Failed'); setDeleting(null); },
    });
  };

  const filtered = accounts.filter(a =>
    a.name?.toLowerCase().includes(search.toLowerCase()) ||
    a.bankName?.toLowerCase().includes(search.toLowerCase()) ||
    (a as any).locationName?.toLowerCase().includes(search.toLowerCase())
  );

  // Every row carries a ledger-derived balance, so these sums are the books'
  // cash and bank positions — the same figures as the Cash Book, Bank Book,
  // Trial Balance and Balance Sheet.
  const cashTotal = filtered.filter(a => a.accountType === 'cash').reduce((s, a) => s + Number(a.balance ?? 0), 0);
  const bankTotal = filtered.filter(a => a.accountType !== 'cash').reduce((s, a) => s + Number(a.balance ?? 0), 0);

  const { sorted, sort } = useTableSort(filtered, {
    name: a => a.name,
    type: a => a.accountType,
    location: a => (a as any).locationName,
    bank: a => a.bankName,
    accountNumber: a => a.accountNumber,
    balance: a => Number(a.balance ?? 0),
  });

  const { pageRows, pagerProps } = useClientPage(sorted);

  const typeColor = (t: string) => t === 'cash' ? 'bg-emerald-500/10 text-emerald-500' : t === 'bank' ? 'bg-primary/10 text-primary' : t === 'upi' ? 'bg-purple-500/10 text-purple-500' : 'bg-muted';
  const sourceBadge = (a: any) => {
    if (a.source === 'system') return <Badge variant="outline" className="ml-2 gap-1 text-[10px] uppercase tracking-wide"><Lock className="w-2.5 h-2.5" /> system</Badge>;
    if (a.source === 'location') return <Badge variant="outline" className="ml-2 text-[10px] uppercase tracking-wide">location till</Badge>;
    return null;
  };
  const fmt = (n: number) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
        <PageHeader
          title="Cash & Bank"
          description="Every account is backed by a ledger under Cash / Bank Accounts — balances here match the books exactly"
          icon={Banknote}
          actions={
            <>
              {perm.canDownload && (
                <Button variant="outline" size="sm" onClick={() => downloadCSV('cash-bank.csv', filtered.map(a => ({ Name: a.name, Type: a.accountType, Location: (a as any).locationName || '', Bank: a.bankName || '', 'Account No': a.accountNumber || '', Balance: Number(a.balance ?? 0) })))}>
                  <Download className="w-4 h-4 mr-2" /> Export
                </Button>
              )}
              {perm.canAdd && isHOUser && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Account</Button>}
            </>
          }
        />

        {/* Balance Summary — ledger-derived, agrees with Cash Book / Bank Book / Balance Sheet */}
        <SummaryCardGrid className="lg:grid-cols-2">
          <SummaryCard
            label="Cash in Hand"
            value={fmt(cashTotal)}
            sub={<>Matches the <Link href="/accounts/cash-book" className="underline">Cash Book</Link></>}
            icon={Banknote}
            loading={isLoading}
          />
          <SummaryCard
            label="Bank Accounts"
            value={fmt(bankTotal)}
            sub={<>Matches the <Link href="/accounts/bank-book" className="underline">Bank Book</Link></>}
            icon={Landmark}
            tone="info"
            loading={isLoading}
          />
        </SummaryCardGrid>

        <div className="relative max-w-xs max-md:max-w-full">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <Input placeholder="Search accounts..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="name" sort={sort}>Name</SortableHead>
                <SortableHead k="type" sort={sort}>Type</SortableHead>
                <SortableHead k="location" sort={sort}>Location</SortableHead>
                <SortableHead k="bank" sort={sort}>Bank</SortableHead>
                <SortableHead k="accountNumber" sort={sort}>Account No.</SortableHead>
                <TableHead>Reconciliation</TableHead>
                <SortableHead k="balance" sort={sort} className="text-right">Balance</SortableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={8} className="p-0"><TableSkeleton rows={3} cols={8} /></TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="p-0">
                  <EmptyState icon={Banknote} title="No accounts yet" compact />
                </TableCell></TableRow>
              ) : pageRows.map(a => (
                <TableRow key={a.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{a.name}{sourceBadge(a)}</TableCell>
                  <TableCell><Badge variant="outline" className={`capitalize ${typeColor(a.accountType)}`}>{a.accountType}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{(a as any).locationName || 'Head Office'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.bankName || '—'}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{a.accountNumber || '—'}</TableCell>
                  <TableCell>
                    {/* The switch is the "button for reconciliation": ON = money
                        waits in Reconciliation; OFF = posts straight to the bank. */}
                    {(a as any).source === 'module' && a.accountType !== 'cash' ? (
                      perm.canEdit ? (
                        <Switch
                          checked={(a as any).requiresReconciliation === true}
                          disabled={updateMutation.isPending}
                          onCheckedChange={(on) => updateMutation.mutate(
                            { id: a.id, data: { requiresReconciliation: on } as any },
                            {
                              onSuccess: () => { toast.success(on ? 'Collections into this account now wait in Reconciliation' : 'Collections now post straight into this account'); refresh(); },
                              onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
                            },
                          )}
                          data-testid={`switch-recon-${a.id}`}
                        />
                      ) : (
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wide">{(a as any).requiresReconciliation ? 'On' : 'Off'}</Badge>
                      )
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    <span className="font-bold text-primary">{fmt(Number(a.balance ?? 0))}</span>
                  </TableCell>
                  <TableCell>
                    {!(a as any).readOnly && (
                      <div className="flex justify-end gap-1">
                        {perm.canEdit && (
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(a)} title="Edit">
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {perm.canDelete && (
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleting(a)} title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isLoading && filtered.length > 0 && (
            <div className="px-4 border-t border-border">
              <TablePager {...pagerProps} />
            </div>
          )}
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{isEdit ? 'Edit Account' : 'Add Account'}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? 'Renaming the account renames its ledger too — the chart and this screen never disagree.'
                : 'A ledger is created automatically under Cash or Bank Accounts in the chart.'}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Account Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. HDFC Main A/C" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="accountType" render={({ field }) => (
                  <FormItem><FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value} disabled={isEdit}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="cash">Cash</SelectItem>
                        <SelectItem value="bank">Bank Account</SelectItem>
                        <SelectItem value="upi">UPI / Digital</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    {isEdit && <p className="text-xs text-muted-foreground">Type decides the ledger's group and cannot change.</p>}
                    <FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="location" render={({ field }) => (
                  <FormItem><FormLabel>Location</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="headoffice">Head Office</SelectItem>
                        {warehouses.map((w: any) => <SelectItem key={`w${w.id}`} value={`warehouse:${w.id}`}>{w.name}</SelectItem>)}
                        {outlets.map((o: any) => <SelectItem key={`o${o.id}`} value={`outlet:${o.id}`}>{o.name}</SelectItem>)}
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
              </div>
              {(watchType === 'bank' || watchType === 'upi' || watchType === 'other') && (
                <FormField control={form.control} name="requiresReconciliation" render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
                    <div className="space-y-0.5">
                      <FormLabel>Needs bank reconciliation</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        {field.value
                          ? 'Collections wait in Reconciliation and reach this account\u2019s balance when the settlement is recorded.'
                          : 'Collections post straight into this account \u2014 the balance moves immediately, nothing to reconcile.'}
                      </p>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} data-testid="switch-requires-reconciliation" />
                    </FormControl>
                  </FormItem>
                )} />
              )}
              {(watchType === 'bank' || watchType === 'upi' || watchType === 'other') && (
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
                <FormItem>
                  <FormLabel>{isEdit ? 'Correct Opening Balance ₹ (leave 0 to keep as is)' : 'Opening Balance ₹'}</FormLabel>
                  <FormControl><Input type="number" step="0.01" min={0} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {isEdit ? (updateMutation.isPending ? 'Saving…' : 'Save Changes') : (createMutation.isPending ? 'Adding…' : 'Add Account')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting != null} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete "{deleting?.name}"?</DialogTitle>
            <DialogDescription>
              This removes the account and its ledger from the chart. Accounts that already
              carry transactions cannot be deleted — the books would break.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting…' : 'Delete Account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
