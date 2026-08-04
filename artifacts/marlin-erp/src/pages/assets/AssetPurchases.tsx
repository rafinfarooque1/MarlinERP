/**
 * Asset Purchases — capital expenditure entry.
 *
 * Recording a purchase posts Dr Fixed Assets / Cr Cash, Bank or the vendor's
 * payable ledger according to the payment mode — and creates ZERO stock
 * movement: assets are not inventory. GST is captured (rate + amount) and
 * capitalised into the total; there is no input-tax-credit posting.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  useAssetPurchases, useCreateAssetPurchase, useDeleteAssetPurchase,
  useAssetCategories, useListVendors,
  type AssetPurchase, type AssetPaymentMode, type AssetPaymentStatus,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Trash2, Download, Landmark, Paperclip } from 'lucide-react';
import { usePermission } from '@/lib/usePermission';
import { toast } from 'sonner';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { attachmentViewUrl } from '@workspace/api-client-react';
import { AttachmentField } from '@/components/AttachmentField';
import { useActingLocations, decodeLocation } from '@/lib/useActingLocation';
import { fmt, fmtDate } from '@/pages/reports/shared';
import { AssetsAccessDenied, PAYMENT_MODE_LABELS, PAYMENT_STATUS_LABELS } from './shared';

const round2 = (n: number) => Math.round(n * 100) / 100;
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const schema = z.object({
  assetName: z.string().min(1, 'Asset name required'),
  categoryId: z.coerce.number().min(1, 'Select a category'),
  purchaseDate: z.string().min(1, 'Date required'),
  invoiceNumber: z.string().optional(),
  vendorId: z.string(),                                  // '0' = none
  location: z.string().min(1, 'Select a location'),
  quantity: z.coerce.number().positive('Qty > 0'),
  acquisitionCost: z.coerce.number().min(0, 'Cost ≥ 0'),
  gstRate: z.coerce.number().min(0).max(28),
  gstAmount: z.coerce.number().min(0),
  paymentMode: z.enum(['cash', 'bank', 'upi', 'credit']),
  paymentStatus: z.enum(['paid', 'unpaid', 'partial']),
  warrantyStart: z.string().optional(),
  warrantyEnd: z.string().optional(),
  serialNumber: z.string().optional(),
  assetTag: z.string().optional(),
  usefulLifeMonths: z.string().optional(),
  notes: z.string().optional(),
}).refine(v => v.paymentMode !== 'credit' || Number(v.vendorId) > 0, {
  message: 'Credit purchases need a vendor', path: ['vendorId'],
}).refine(v => !v.warrantyStart || !v.warrantyEnd || v.warrantyEnd >= v.warrantyStart, {
  message: 'Warranty end before start', path: ['warrantyEnd'],
});
type FormValues = z.infer<typeof schema>;

export default function AssetPurchases() {
  const perm = usePermission('page:/assets/purchases');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssetPurchase | null>(null);
  const [attachmentPath, setAttachmentPath] = useState<string | null>(null);

  const filters = useMemo(() => ({
    q: search.trim() || undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    locationBasis: 'purchase' as const,
  }), [search, fromDate, toDate]);

  const { data: purchases = [], isLoading } = useAssetPurchases(filters);
  const { data: categories = [] } = useAssetCategories();
  const { data: vendors = [] } = useListVendors();
  const createPurchase = useCreateAssetPurchase();
  const deletePurchase = useDeleteAssetPurchase();
  const locations = useActingLocations();

  const activeCategories = categories.filter(c => c.status === 'active');

  const { sorted, sort } = useTableSort(purchases, {
    date: p => p.purchaseDate,
    code: p => p.assetCode,
    asset: p => p.assetName,
    category: p => p.categoryName,
    vendor: p => p.vendorName,
    location: p => p.locationName,
    qty: p => Number(p.quantity),
    unitCost: p => Number(p.acquisitionCost),
    gst: p => Number(p.gstAmount),
    total: p => Number(p.totalCost),
    payment: p => PAYMENT_MODE_LABELS[p.paymentMode] ?? p.paymentMode,
    voucher: p => p.voucherNumber,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      assetName: '', categoryId: 0, purchaseDate: todayIso(), invoiceNumber: '',
      vendorId: '0', location: locations.defaultValue, quantity: 1, acquisitionCost: 0,
      gstRate: 18, gstAmount: 0, paymentMode: 'cash', paymentStatus: 'paid',
      warrantyStart: '', warrantyEnd: '', serialNumber: '', assetTag: '',
      usefulLifeMonths: '', notes: '',
    },
  });

  const wQty = Number(form.watch('quantity')) || 0;
  const wCost = Number(form.watch('acquisitionCost')) || 0;
  const wRate = Number(form.watch('gstRate')) || 0;
  const wGst = Number(form.watch('gstAmount')) || 0;
  const wMode = form.watch('paymentMode');
  const taxable = round2(wQty * wCost);
  const total = round2(taxable + wGst);

  // GST amount re-defaults whenever qty/cost/rate change; the user may then
  // nudge it by a few paise to match the vendor's invoice rounding.
  useEffect(() => {
    form.setValue('gstAmount', round2(taxable * wRate / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxable, wRate]);

  // Credit purchases start unpaid; cash/bank/upi settle at entry.
  useEffect(() => {
    form.setValue('paymentStatus', wMode === 'credit' ? 'unpaid' : 'paid');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wMode]);

  const openAdd = () => {
    form.reset({
      assetName: '', categoryId: 0, purchaseDate: todayIso(), invoiceNumber: '',
      vendorId: '0', location: locations.defaultValue, quantity: 1, acquisitionCost: 0,
      gstRate: 18, gstAmount: 0, paymentMode: 'cash', paymentStatus: 'paid',
      warrantyStart: '', warrantyEnd: '', serialNumber: '', assetTag: '',
      usefulLifeMonths: '', notes: '',
    });
    setAttachmentPath(null);
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    const { locationType, locationId } = decodeLocation(data.location);
    createPurchase.mutate({
      assetName: data.assetName.trim(),
      categoryId: data.categoryId,
      purchaseDate: data.purchaseDate,
      invoiceNumber: data.invoiceNumber?.trim() || undefined,
      vendorId: Number(data.vendorId) > 0 ? Number(data.vendorId) : null,
      locationType, locationId,
      quantity: data.quantity,
      acquisitionCost: data.acquisitionCost,
      gstRate: data.gstRate,
      gstAmount: data.gstAmount,
      paymentMode: data.paymentMode as AssetPaymentMode,
      paymentStatus: data.paymentStatus as AssetPaymentStatus,
      warrantyStart: data.warrantyStart || null,
      warrantyEnd: data.warrantyEnd || null,
      serialNumber: data.serialNumber?.trim() || null,
      assetTag: data.assetTag?.trim() || null,
      usefulLifeMonths: data.usefulLifeMonths?.trim() ? Number(data.usefulLifeMonths) : null,
      notes: data.notes?.trim() || null,
      attachmentPath,
    }, {
      onSuccess: () => { toast.success('Asset purchase recorded'); setIsOpen(false); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to record purchase'),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deletePurchase.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success('Purchase deleted — voucher reversed'); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  const exportCSV = () => downloadCSV('asset-purchases.csv', purchases.map(p => ({
    Code: p.assetCode, Asset: p.assetName, Category: p.categoryName || '',
    'Purchase Date': p.purchaseDate, 'Invoice No.': p.invoiceNumber || '',
    Vendor: p.vendorName || '', Location: p.locationName || '',
    Qty: p.quantity, 'Unit Cost': p.acquisitionCost, 'GST %': p.gstRate,
    'GST Amount': p.gstAmount, 'Total Cost': p.totalCost,
    'Payment Mode': PAYMENT_MODE_LABELS[p.paymentMode] ?? p.paymentMode,
    'Payment Status': PAYMENT_STATUS_LABELS[p.paymentStatus] ?? p.paymentStatus,
    'Serial No.': p.serialNumber || '', 'Asset Tag': p.assetTag || '',
    'Warranty End': p.warrantyEnd || '', Voucher: p.voucherNumber || '',
  })));

  if (!perm.isLoading && !perm.canView) return <AssetsAccessDenied />;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Landmark className="w-6 h-6 text-primary" /> Asset Purchases</h1>
            <p className="text-muted-foreground mt-1">Capital purchases — posted to Fixed Assets, never to inventory stock.</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={exportCSV}><Download className="w-4 h-4 mr-2" /> Export</Button>
            )}
            {perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> New Asset Purchase</Button>}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input placeholder="Search asset, code, invoice, serial..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <div className="flex items-center gap-1.5">
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-9 text-xs w-36" />
              <span className="text-muted-foreground text-xs">to</span>
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-9 text-xs w-36" />
            </div>
          </div>

          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="code" sort={sort}>Code</SortableHead>
                <SortableHead k="asset" sort={sort}>Asset</SortableHead>
                <SortableHead k="category" sort={sort}>Category</SortableHead>
                <SortableHead k="vendor" sort={sort}>Vendor</SortableHead>
                <SortableHead k="location" sort={sort}>Location</SortableHead>
                <SortableHead k="qty" sort={sort} className="text-right">Qty</SortableHead>
                <SortableHead k="unitCost" sort={sort} className="text-right">Unit Cost</SortableHead>
                <SortableHead k="gst" sort={sort} className="text-right">GST</SortableHead>
                <SortableHead k="total" sort={sort} className="text-right">Total</SortableHead>
                <SortableHead k="payment" sort={sort}>Payment</SortableHead>
                <SortableHead k="voucher" sort={sort}>Voucher</SortableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={13}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : purchases.length === 0 ? (
                <TableRow><TableCell colSpan={13} className="text-center py-16 text-muted-foreground">
                  <Landmark className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No asset purchases recorded</p>
                </TableCell></TableRow>
              ) : sorted.map(p => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="whitespace-nowrap text-sm">{fmtDate(p.purchaseDate)}</TableCell>
                  <TableCell className="font-mono text-sm font-semibold whitespace-nowrap">{p.assetCode}</TableCell>
                  <TableCell className="font-medium">
                    {p.assetName}
                    {p.attachmentPath && (
                      <a href={attachmentViewUrl(p.attachmentPath)} target="_blank" rel="noreferrer" title="View invoice attachment" className="inline-flex ml-1.5 text-primary align-middle">
                        <Paperclip className="w-3.5 h-3.5" />
                      </a>
                    )}
                    {p.serialNumber && <div className="text-[10px] text-muted-foreground font-mono">SN {p.serialNumber}</div>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{p.categoryName || '—'}</TableCell>
                  <TableCell className="text-sm">{p.vendorName || '—'}</TableCell>
                  <TableCell className="text-sm">{p.locationName || '—'}</TableCell>
                  <TableCell className="text-right font-mono">{Number(p.quantity)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(p.acquisitionCost)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmt(p.gstAmount)}
                    <div className="text-[10px] text-muted-foreground">{Number(p.gstRate)}%</div>
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold">{fmt(p.totalCost)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] whitespace-nowrap">{PAYMENT_MODE_LABELS[p.paymentMode] ?? p.paymentMode}</Badge>
                    <div className={`text-[10px] mt-0.5 ${p.paymentStatus === 'paid' ? 'text-emerald-600' : 'text-amber-600'}`}>{PAYMENT_STATUS_LABELS[p.paymentStatus] ?? p.paymentStatus}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">{p.voucherNumber || '—'}</TableCell>
                  <TableCell className="text-right">
                    {perm.canDelete && p.status === 'active' && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(p)}><Trash2 className="w-4 h-4" /></Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        </div>
      </div>

      {/* New purchase dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Asset Purchase</DialogTitle>
            <DialogDescription>Posts Dr Fixed Assets / Cr {wMode === 'credit' ? "vendor's ledger" : wMode === 'cash' ? 'Cash' : 'Bank'} — no stock movement.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="assetName" render={({ field }) => (
                  <FormItem><FormLabel>Asset Name <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input placeholder="e.g. Blast Freezer 500L" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="categoryId" render={({ field }) => (
                  <FormItem><FormLabel>Category <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger></FormControl>
                      <SelectContent>{activeCategories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="purchaseDate" render={({ field }) => (
                  <FormItem><FormLabel>Purchase Date <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="invoiceNumber" render={({ field }) => (
                  <FormItem><FormLabel>Invoice No.</FormLabel>
                    <FormControl><Input className="font-mono" placeholder="Vendor invoice number" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem><FormLabel>Vendor {wMode === 'credit' && <span className="text-destructive">*</span>}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="0">— None —</SelectItem>
                        {(vendors as any[]).map(v => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="location" render={({ field }) => (
                  <FormItem><FormLabel>Warehouse / Location <span className="text-destructive">*</span></FormLabel>
                    {locations.canChoose ? (
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>{locations.options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                      </Select>
                    ) : (
                      <p className="text-sm py-2 px-3 rounded-md border border-border bg-muted/30">{locations.labelFor(field.value)}</p>
                    )}
                    <FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="quantity" render={({ field }) => (
                  <FormItem><FormLabel>Quantity <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="number" min={0} step="1" className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="acquisitionCost" render={({ field }) => (
                  <FormItem><FormLabel>Unit Cost (₹) <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input type="number" min={0} step="0.01" className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="gstRate" render={({ field }) => (
                  <FormItem><FormLabel>GST %</FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={String(field.value ?? 18)}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>{[0, 5, 12, 18, 28].map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="gstAmount" render={({ field }) => (
                  <FormItem><FormLabel>GST Amount (₹) <span className="text-[10px] font-normal text-muted-foreground">adjust to match invoice</span></FormLabel>
                    <FormControl><Input type="number" min={0} step="0.01" className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="paymentMode" render={({ field }) => (
                  <FormItem><FormLabel>Payment Mode</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="cash">Cash</SelectItem>
                        <SelectItem value="bank">Bank</SelectItem>
                        <SelectItem value="upi">UPI</SelectItem>
                        <SelectItem value="credit">Credit (vendor)</SelectItem>
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="paymentStatus" render={({ field }) => (
                  <FormItem><FormLabel>Payment Status</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="paid">Paid</SelectItem>
                        <SelectItem value="unpaid">Unpaid</SelectItem>
                        <SelectItem value="partial">Partial</SelectItem>
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="warrantyStart" render={({ field }) => (
                  <FormItem><FormLabel>Warranty Start</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="warrantyEnd" render={({ field }) => (
                  <FormItem><FormLabel>Warranty End</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="serialNumber" render={({ field }) => (
                  <FormItem><FormLabel>Serial Number</FormLabel>
                    <FormControl><Input className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="assetTag" render={({ field }) => (
                  <FormItem><FormLabel>Asset Tag</FormLabel>
                    <FormControl><Input className="font-mono" placeholder="Company tag / sticker no." {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="usefulLifeMonths" render={({ field }) => (
                  <FormItem><FormLabel>Useful Life (months) <span className="text-[10px] font-normal text-muted-foreground">for future depreciation</span></FormLabel>
                    <FormControl><Input type="number" min={0} step="1" className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />

              <div className="space-y-1.5">
                <p className="text-sm font-medium">Invoice Attachment</p>
                <AttachmentField value={attachmentPath} onChange={setAttachmentPath} />
              </div>

              {/* Totals preview */}
              <div className="rounded-lg border border-border bg-muted/20 p-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                <div><p className="text-xs text-muted-foreground">Taxable ({wQty || 0} × {fmt(wCost)})</p><p className="font-mono font-semibold">{fmt(taxable)}</p></div>
                <div><p className="text-xs text-muted-foreground">GST ({wRate}%)</p><p className="font-mono font-semibold">{fmt(wGst)}</p></div>
                <div><p className="text-xs text-muted-foreground">Total Cost (capitalised)</p><p className="font-mono font-bold text-primary">{fmt(total)}</p></div>
              </div>

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createPurchase.isPending}>{createPurchase.isPending ? 'Recording…' : 'Record Purchase'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" /> Delete Asset Purchase</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground py-2">
            Delete <span className="font-semibold text-foreground">{deleteTarget?.assetCode} — {deleteTarget?.assetName}</span>?
            The Fixed Assets voucher is removed with it. This cannot be undone.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deletePurchase.isPending}>{deletePurchase.isPending ? 'Deleting…' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
