import { useState } from 'react';
import {
  useListVendors, useCreateVendor, useUpdateVendor, getListVendorsQueryKey,
  useGetVendorLedger, useGetCashBankLedgers, useRecordVendorPayment,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Truck, Download, Eye, BookOpen, Pencil, IndianRupee, ArrowUpRight, ArrowDownLeft, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { INDIAN_STATES } from '@/lib/indianStates';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { usePermission } from '@/lib/usePermission';

// ── Schemas ───────────────────────────────────────────────────────────────────
const vendorSchema = z.object({
  name: z.string().min(1, 'Name required'),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  gstNumber: z.string().optional(),
  state: z.string().optional(),
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
});
type VendorFormValues = z.infer<typeof vendorSchema>;

const paymentSchema = z.object({
  date: z.string().min(1, 'Date required'),
  amount: z.number({ invalid_type_error: 'Amount required' }).positive('Must be > 0'),
  cashBankLedgerId: z.number({ invalid_type_error: 'Select an account' }),
  narration: z.string().optional(),
});
type PaymentFormValues = z.infer<typeof paymentSchema>;

// ── VendorLedger component ────────────────────────────────────────────────────
function VendorLedger({ vendorId }: { vendorId: number }) {
  const { data, isLoading } = useGetVendorLedger(vendorId);
  const entries = data?.entries ?? [];

  if (isLoading) return (
    <div className="space-y-2 mt-4">
      {[...Array(4)].map((_, i) => <div key={i} className="h-8 bg-muted/30 rounded animate-pulse" />)}
    </div>
  );

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-muted/20 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Purchased</p>
          <p className="font-bold font-mono text-sm text-foreground mt-0.5">
            ₹{Number(data?.totalPurchased ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-muted/20 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Paid</p>
          <p className="font-bold font-mono text-sm text-emerald-500 mt-0.5">
            ₹{Number(data?.totalPaid ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-muted/20 rounded-lg p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Balance Due</p>
          <p className={`font-bold font-mono text-sm mt-0.5 ${(data?.balance ?? 0) > 0 ? 'text-amber-500' : 'text-emerald-500'}`}>
            ₹{Number(data?.balance ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-20" />
          <p className="text-sm">No transactions yet</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead className="text-xs">Date</TableHead>
                <TableHead className="text-xs">Description</TableHead>
                <TableHead className="text-right text-xs">Debit</TableHead>
                <TableHead className="text-right text-xs">Credit</TableHead>
                <TableHead className="text-right text-xs">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...entries].reverse().map((e, i) => (
                <TableRow key={i} className="hover:bg-muted/10">
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(e.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className="flex items-center gap-1.5">
                      {e.entryType === 'payment'
                        ? <ArrowUpRight className="w-3 h-3 text-emerald-500 shrink-0" />
                        : <ArrowDownLeft className="w-3 h-3 text-amber-500 shrink-0" />}
                      {e.description}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono">
                    {e.debit > 0 ? <span className="text-emerald-600">₹{Number(e.debit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span> : '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono">
                    {e.credit > 0 ? <span className="text-amber-600">₹{Number(e.credit).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span> : '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono font-bold">
                    ₹{Number(e.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── VendorSheet ───────────────────────────────────────────────────────────────
function VendorSheet({ vendor, onClose, onPay, canPay }: { vendor: any; onClose: () => void; onPay: (v: any) => void; canPay: boolean }) {
  const [activeTab, setActiveTab] = useState<'details' | 'ledger'>('details');
  const { data: ledger } = useGetVendorLedger(vendor.id);

  return (
    <Sheet open onOpenChange={v => !v && onClose()}>
      <SheetContent className="sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Truck className="w-5 h-5 text-primary" />
            {vendor.name}
          </SheetTitle>
          <div className="flex gap-1 mt-3">
            <button
              onClick={() => setActiveTab('details')}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${activeTab === 'details' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'}`}
            >Details</button>
            <button
              onClick={() => setActiveTab('ledger')}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors flex items-center gap-1.5 ${activeTab === 'ledger' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'}`}
            ><BookOpen className="w-3.5 h-3.5" />Ledger</button>
          </div>
        </SheetHeader>

        {activeTab === 'details' && (
          <div className="space-y-4">
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Outstanding Balance</p>
                <p className="text-2xl font-bold font-mono text-amber-600 mt-0.5">
                  ₹{Number(ledger?.balance ?? vendor.outstandingBalance ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <button onClick={() => setActiveTab('ledger')} className="text-xs text-primary underline">View ledger →</button>
                {canPay && (
                <Button size="sm" variant="outline" className="border-amber-500/40 text-amber-600 hover:bg-amber-50" onClick={() => onPay(vendor)}>
                  <IndianRupee className="w-3.5 h-3.5 mr-1" /> Record Payment
                </Button>
                )}
              </div>
            </div>
            <Separator />
            {[['Phone', vendor.phone || '—'], ['Email', vendor.email || '—'], ['State', vendor.state || '—'], ['GSTIN', vendor.gstNumber || vendor.gst_number || '—'], ['Address', vendor.address || '—'], ['Bank Name', vendor.bankName || vendor.bank_name || '—'], ['Account Number', vendor.accountNumber || vendor.account_number || '—']].map(([k, v]) => (
              <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                <span className="font-medium">{v}</span>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'ledger' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-muted-foreground">Account: <span className="font-mono">VEND-{vendor.id}</span> · Current Liability — Sundry Creditors</p>
              {canPay && (
              <Button size="sm" variant="outline" className="border-amber-500/40 text-amber-600 hover:bg-amber-50 h-7 text-xs" onClick={() => onPay(vendor)}>
                <IndianRupee className="w-3 h-3 mr-1" /> Pay
              </Button>
              )}
            </div>
            <VendorLedger vendorId={vendor.id} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Payment Dialog ────────────────────────────────────────────────────────────
function PaymentDialog({ vendor, onClose }: { vendor: any; onClose: () => void }) {
  const { data: ledgers = [] } = useGetCashBankLedgers();
  const payMutation = useRecordVendorPayment();
  const today = new Date().toISOString().split('T')[0];

  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { date: today, amount: undefined as any, cashBankLedgerId: undefined as any, narration: '' },
  });

  const onSubmit = (data: PaymentFormValues) => {
    payMutation.mutate({ vendorId: vendor.id, data }, {
      onSuccess: () => { toast.success(`Payment recorded for ${vendor.name}`); onClose(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IndianRupee className="w-4 h-4 text-primary" />
            Record Payment — {vendor.name}
          </DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-1">
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
              Outstanding balance: <span className="font-bold font-mono">₹{Number(vendor.outstandingBalance ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField control={form.control} name="date" render={({ field }) => (
                <FormItem>
                  <FormLabel>Payment Date <span className="text-destructive">*</span></FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="amount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount (₹) <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <Input
                      type="number" step="0.01" min="0.01"
                      placeholder="0.00"
                      value={field.value ?? ''}
                      onChange={e => field.onChange(e.target.value ? parseFloat(e.target.value) : undefined)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <FormField control={form.control} name="cashBankLedgerId" render={({ field }) => (
              <FormItem>
                <FormLabel>Pay From (Cash / Bank Account) <span className="text-destructive">*</span></FormLabel>
                <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                  <FormControl><SelectTrigger><SelectValue placeholder="Select account…" /></SelectTrigger></FormControl>
                  <SelectContent>
                    {ledgers.map(l => (
                      <SelectItem key={l.id} value={String(l.id)}>
                        {l.name}{l.code ? <span className="ml-1.5 text-muted-foreground text-[10px]">({l.code})</span> : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="narration" render={({ field }) => (
              <FormItem>
                <FormLabel>Narration / Note</FormLabel>
                <FormControl><Textarea rows={2} placeholder="e.g. Paid for PO-0001" {...field} /></FormControl>
              </FormItem>
            )} />

            <DialogFooter>
              <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={payMutation.isPending} className="bg-amber-600 hover:bg-amber-700 text-white">
                {payMutation.isPending ? 'Recording…' : 'Record Payment'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Vendors() {
  const perm = usePermission('page:/vendors');
  const { data: vendors = [], isLoading } = useListVendors();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [payItem, setPayItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateVendor();
  const updateMutation = useUpdateVendor();

  const form = useForm<VendorFormValues>({
    resolver: zodResolver(vendorSchema),
    defaultValues: { name: '', phone: '', email: '', address: '', gstNumber: '', state: '', bankName: '', accountNumber: '' },
  });

  const openEdit = (v: any) => {
    setEditItem(v);
    form.reset({ name: v.name, phone: v.phone ?? '', email: v.email ?? '', address: v.address ?? '', gstNumber: v.gstNumber ?? '', state: v.state ?? '', bankName: v.bankName ?? '', accountNumber: v.accountNumber ?? '' });
    setIsOpen(true);
  };
  const closeDialog = () => { setIsOpen(false); setEditItem(null); form.reset(); };

  const onSubmit = (data: VendorFormValues) => {
    if (editItem) {
      updateMutation.mutate({ id: editItem.id, data: data as any }, {
        onSuccess: () => { toast.success('Vendor updated'); queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() }); closeDialog(); },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    } else {
      createMutation.mutate({ data: data as any }, {
        onSuccess: () => { toast.success('Vendor added'); queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() }); closeDialog(); },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    }
  };

  const filtered = vendors.filter(v =>
    v.name.toLowerCase().includes(search.toLowerCase()) ||
    v.phone?.includes(search)
  );

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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Truck className="w-6 h-6 text-primary" /> Vendors / Suppliers</h1>
            <p className="text-muted-foreground mt-1">Raw material and packaging suppliers</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('vendors.csv', filtered.map(v => ({ Name: v.name, Phone: v.phone || '', State: (v as any).state || '', GST: v.gstNumber || '', Balance: (v as any).outstandingBalance || 0 })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            )}
            {perm.canAdd && (
            <Button onClick={() => { form.reset(); setIsOpen(true); }}><Plus className="w-4 h-4 mr-2" /> Add Vendor</Button>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search name or phone..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>State</TableHead>
                <TableHead>GST No.</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Truck className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No vendors yet</p>
                </TableCell></TableRow>
              ) : filtered.map(v => (
                <TableRow key={v.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{v.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{v.phone || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{(v as any).state || '—'}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{v.gstNumber || '—'}</TableCell>
                  <TableCell className="text-right">
                    <span className={`font-mono text-sm font-semibold ${(v as any).outstandingBalance > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                      ₹{Number((v as any).outstandingBalance ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {perm.canAdd && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-amber-600" title="Record payment" onClick={() => setPayItem(v)}>
                        <IndianRupee className="w-4 h-4" />
                      </Button>
                      )}
                      {perm.canEdit && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(v)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(v)}>
                        <Eye className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Add / Edit Vendor Dialog */}
      <Dialog open={isOpen} onOpenChange={v => { if (!v) closeDialog(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{editItem ? 'Edit Vendor' : 'Add Vendor'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="Company / individual name" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="gstNumber" render={({ field }) => (
                  <FormItem><FormLabel>GST Number (GSTIN)</FormLabel><FormControl><Input placeholder="15-char GSTIN" className="font-mono" {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="state" render={({ field }) => (
                  <FormItem><FormLabel>State</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select state" /></SelectTrigger></FormControl>
                      <SelectContent>{INDIAN_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="address" render={({ field }) => (
                <FormItem><FormLabel>Address</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="bankName" render={({ field }) => (
                  <FormItem><FormLabel>Bank Name</FormLabel><FormControl><Input placeholder="e.g. HDFC Bank" {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="accountNumber" render={({ field }) => (
                  <FormItem><FormLabel>Account Number</FormLabel><FormControl><Input placeholder="e.g. 123456789012" className="font-mono" {...field} /></FormControl></FormItem>
                )} />
              </div>
              <DialogFooter>
                <Button variant="outline" type="button" onClick={closeDialog}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {createMutation.isPending || updateMutation.isPending ? 'Saving…' : editItem ? 'Save Changes' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* View Sheet */}
      {viewItem && (
        <VendorSheet
          vendor={viewItem}
          onClose={() => setViewItem(null)}
          onPay={v => { setViewItem(null); setPayItem(v); }}
          canPay={perm.canAdd}
        />
      )}

      {/* Payment Dialog */}
      {payItem && <PaymentDialog vendor={payItem} onClose={() => setPayItem(null)} />}
    </AppLayout>
  );
}
