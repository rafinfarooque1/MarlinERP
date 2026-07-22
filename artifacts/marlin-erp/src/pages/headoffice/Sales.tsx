import { useState, useMemo, useEffect } from 'react';
import {
  useListSales, useCreateSale, useListOutlets, useListCustomers, useCreateCustomer,
  useListItems, useListItemPrices, useListStock, useGetCompanySettings,
  getListSalesQueryKey, getListCustomersQueryKey, useListCoupons,
} from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Textarea } from '@/components/ui/textarea';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { INDIAN_STATES } from '@/lib/indianStates';
import {
  Plus, Search, Trash2, CreditCard, Calendar, Receipt,
  Download, Eye, PackageOpen, FileDown, AlertTriangle,
  UserPlus, Check, ChevronsUpDown,
} from 'lucide-react';

// ── WhatsApp brand icon (inline SVG) ──────────────────────────────────────────
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}
import { cn } from '@/lib/utils';
import { downloadInvoicePDF, generateInvoicePDFBlob } from '@/lib/pdfUtils';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { downloadCSV } from '@/lib/download';
import { Separator } from '@/components/ui/separator';

// ── Types ──────────────────────────────────────────────────────────────────────

interface GstBreakdown {
  taxRate: number;
  taxType: 'cgst_sgst' | 'igst';
  lineGross: number;    // MRP × qty (GST-inclusive total for this line)
  lineSubtotal: number; // taxable amount (ex-GST, = lineGross / (1 + rate/100))
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
}

// GST is INCLUSIVE in MRP. Back-calculate taxable from gross.
function computeLineGst(
  qty: number, price: number, taxRate: number, isInterState: boolean
): GstBreakdown {
  const lineGross = qty * price; // MRP × qty (inclusive)
  const lineSubtotal = taxRate > 0
    ? Math.round(lineGross / (1 + taxRate / 100) * 100) / 100
    : lineGross; // taxable (ex-GST)
  const rawTax = Math.round((lineGross - lineSubtotal) * 100) / 100;
  if (isInterState) {
    return { taxRate, taxType: 'igst', lineGross, lineSubtotal, cgst: 0, sgst: 0, igst: rawTax, taxAmount: rawTax };
  }
  const half = Math.round(rawTax / 2 * 100) / 100;
  return { taxRate, taxType: 'cgst_sgst', lineGross, lineSubtotal, cgst: half, sgst: half, igst: 0, taxAmount: rawTax };
}

// ── Form Schema ─────────────────────────────────────────────────────────────────

const saleLineSchema = z.object({
  itemId:    z.coerce.number().min(1, 'Item required'),
  quantity:  z.coerce.number().min(1, 'Qty ≥ 1'),
  unitPrice: z.coerce.number().min(0, 'Price required'),
});
const schema = z.object({
  outletId: z.coerce.number().min(1, 'Outlet required'),
  customerId: z.coerce.number().optional(),
  saleDate: z.string().min(1, 'Date required'),
  paymentMode: z.string().min(1, 'Payment mode required'),
  couponCode: z.string().optional(),
  lineItems: z.array(saleLineSchema).min(1, 'Add at least one item'),
});
type FormValues = z.infer<typeof schema>;

// ── Customer quick-create schema (mirrors Customers page) ─────────────────────
const custSchema = z.object({
  name:      z.string().min(1, 'Name is required'),
  phone:     z.string().optional(),
  email:     z.string().email().optional().or(z.literal('')),
  gstNumber: z.string().optional(),
  state:     z.string().optional(),
  address:   z.string().optional(),
  notes:     z.string().optional(),
});
type CustForm = z.infer<typeof custSchema>;

const defaultFormValues: FormValues = {
  outletId: 0,
  saleDate: new Date().toISOString().split('T')[0],
  paymentMode: 'cash',
  couponCode: '',
  lineItems: [{ itemId: 0, quantity: 1, unitPrice: 0 }],
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function Sales() {
  const perm = usePermission('Sales');
  const { data: outlets = [] } = useListOutlets();
  const [outletFilter, setOutletFilter] = useState<string>('all');
  const { data: sales = [], isLoading } = useListSales(
    outletFilter !== 'all' ? { outletId: Number(outletFilter) } : undefined
  );
  const { data: customers = [] } = useListCustomers();
  const { data: items = [] } = useListItems();
  const { data: companySettings } = useGetCompanySettings();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const [viewQrUrl, setViewQrUrl] = useState<string | null>(null);

  // Generate UPI QR data URL whenever the invoice view opens
  useEffect(() => {
    if (!viewItem || !(viewItem as any).outletUpiId) { setViewQrUrl(null); return; }
    const upiId  = (viewItem as any).outletUpiId as string;
    const amount = Number(viewItem.totalAmount).toFixed(2);
    const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(viewItem.outletName || '')}&am=${amount}&cu=INR&tn=${encodeURIComponent(viewItem.invoiceNumber || '')}`;
    let cancelled = false;
    (import('qrcode') as Promise<any>).then(QR => {
      QR.toDataURL(upiUri, { width: 200, margin: 2 }).then((url: string) => { if (!cancelled) setViewQrUrl(url); });
    }).catch(() => { if (!cancelled) setViewQrUrl(null); });
    return () => { cancelled = true; };
  }, [viewItem]);
  const queryClient = useQueryClient();
  const createMutation = useCreateSale();
  const createCustomerMutation = useCreateCustomer();

  // Customer combobox + quick-create state
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showNewCustomer, setShowNewCustomer] = useState(false);

  // Quick-create customer form (schema defined at module level)
  const custForm = useForm<CustForm>({
    resolver: zodResolver(custSchema),
    defaultValues: { name: '', phone: '', email: '', gstNumber: '', state: '', address: '', notes: '' },
  });

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: defaultFormValues });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const watchOutletId = form.watch('outletId');
  const watchCustomerId = form.watch('customerId');

  const { data: outletPrices = [] } = useListItemPrices(
    { outletId: watchOutletId },
    { query: { enabled: !!watchOutletId && watchOutletId > 0 } }
  );
  const { data: outletStock = [] } = useListStock(
    { branchType: 'outlet' as any, branchId: watchOutletId },
    { query: { enabled: !!watchOutletId && watchOutletId > 0 } }
  );

  const stockMap = new Map<number, number>(outletStock.map(s => [s.itemId!, Number(s.quantity ?? 0)]));
  const availableItems = items.filter(it => (stockMap.get(it.id) ?? 0) > 0);

  // Price comes from item MRP (set in Item Master) — not outlet-specific
  const getPrice = (itemId: number) => Number((items.find(i => i.id === itemId) as any)?.mrp ?? 0);
  const getAvailableQty = (itemId: number) => stockMap.get(itemId) ?? 0;
  const getItem = (itemId: number) => items.find(i => i.id === itemId);

  // GST state determination
  const companyState = ((companySettings as any)?.state ?? '').trim().toLowerCase();
  const selectedCustomer = customers.find(c => c.id === watchCustomerId);
  const customerState = ((selectedCustomer as any)?.state ?? '').trim().toLowerCase();
  const isInterState = !!(companyState && customerState && companyState !== customerState);

  // Coupon validation
  const { data: coupons = [] } = useListCoupons();
  const watchCouponCode = (form.watch('couponCode') ?? '').trim().toUpperCase();
  const appliedCoupon = useMemo(() => {
    if (!watchCouponCode) return null;
    const c = (coupons as any[]).find(
      (c: any) => (c.code ?? '').toUpperCase() === watchCouponCode && c.isActive
    );
    if (!c) return null;
    if (c.expiryDate && new Date(c.expiryDate) < new Date()) return null;
    return c;
  }, [coupons, watchCouponCode]);

  // Compute aggregated GST totals for the cart (inclusive GST — MRP already includes tax)
  const computeCartTotals = () => {
    let grossTotal = 0, subtotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0, taxTotal = 0;
    fields.forEach((_, i) => {
      const itemId = form.watch(`lineItems.${i}.itemId`);
      const qty    = form.watch(`lineItems.${i}.quantity`);
      const price  = Number(form.watch(`lineItems.${i}.unitPrice`) ?? 0);
      if (!itemId || price <= 0) return;
      const taxRate = Number((getItem(itemId) as any)?.taxRate ?? 0);
      const gst     = computeLineGst(qty, price, taxRate, isInterState);
      grossTotal += gst.lineGross;
      subtotal   += gst.lineSubtotal;
      cgstTotal  += gst.cgst;
      sgstTotal  += gst.sgst;
      igstTotal  += gst.igst;
      taxTotal   += gst.taxAmount;
    });
    const grandTotal = grossTotal; // MRP × qty totals — inclusive
    const discountAmount = appliedCoupon
      ? appliedCoupon.discountType === 'percentage'
        ? Math.round(grandTotal * Number(appliedCoupon.discountValue) / 100 * 100) / 100
        : Math.min(Number(appliedCoupon.discountValue), grandTotal)
      : 0;
    return { grossTotal, subtotal, cgstTotal, sgstTotal, igstTotal, taxTotal, grandTotal, discountAmount, finalAmount: grandTotal - discountAmount };
  };

  const totals = computeCartTotals();
  // True when at least one item is selected
  const hasItems = fields.some((_, i) => (form.watch(`lineItems.${i}.itemId`) ?? 0) > 0);

  const onSubmit = (data: FormValues) => {
    const enrichedItems = data.lineItems.map(li => ({
      itemId: li.itemId,
      quantity: li.quantity,
      unitPrice: Number(li.unitPrice),
      discount: 0,
      taxAmount: 0, // backend recomputes authoritatively
    }));
    const { discountAmount } = computeCartTotals();
    createMutation.mutate({ data: { ...data, lineItems: enrichedItems, customerId: data.customerId || undefined, discountTotal: discountAmount } as any }, {
      onSuccess: () => {
        toast.success('Sale recorded successfully');
        queryClient.invalidateQueries({ queryKey: getListSalesQueryKey() });
        setIsOpen(false);
        form.reset(defaultFormValues);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not record sale'),
    });
  };

  // ── WhatsApp invoice share ─────────────────────────────────────────────────
  // Flow:
  //   Mobile / Web Share API with file support → native share sheet with PDF + text
  //     (user picks WhatsApp → PDF is attached automatically)
  //   Desktop / no file-share support → open PDF in new browser tab
  //     (avoids AV false-positives) + open wa.me/<phone> with pre-filled text
  const handleWhatsApp = async (sale: any) => {
    const phone = (sale.customerPhone ?? '').replace(/\D/g, '');
    if (!phone) {
      toast.error('WhatsApp number is not available for this customer. Please update Customer Details.');
      return;
    }
    // Normalise to Indian international format (91XXXXXXXXXX)
    const intl = phone.startsWith('91') && phone.length === 12 ? phone : `91${phone}`;

    const cs      = companySettings as any;
    const company = cs?.companyName ?? cs?.name ?? 'Marlin Frozen Fruits';
    const fileName = `Invoice-${sale.invoiceNumber || sale.id}.pdf`;
    const date     = new Date(sale.saleDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const total    = Number(sale.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    const taxLine  = Number(sale.taxTotal) > 0
      ? `\nGST (incl. in MRP): ₹${Number(sale.taxTotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
      : '';

    // Build the invoice message (same content for all platforms)
    const lines = (sale.lineItems ?? []).map((li: any) => {
      const name  = li.itemName || `Item #${li.itemId}`;
      const total = Number(li.unitPrice ?? 0) * Number(li.quantity ?? 1);
      return `  • ${name} × ${li.quantity} = ₹${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    }).join('\n');

    const message = [
      `Dear ${sale.customerName || 'Customer'},`,
      ``,
      `Please find attached Invoice *${sale.invoiceNumber}*.`,
      ``,
      `Invoice Date: ${date}`,
      `Outlet: ${sale.outletName || ''}`,
      ``,
      `*Items:*`,
      lines,
      ``,
      `Amount: ₹${total}${taxLine}`,
      `Payment: ${(sale.paymentMode ?? '').replace('_', ' ').toUpperCase()}`,
      ``,
      `📎 Invoice PDF is attached/shared with this message.`,
      `Thank you for your purchase! 🙏`,
      ``,
      `— ${company}`,
    ].join('\n');

    // Generate the same PDF used by "Download PDF" and "Print"
    let pdfBlob: Blob;
    try {
      pdfBlob = await generateInvoicePDFBlob(sale, companySettings);
    } catch {
      toast.error('Unable to generate invoice PDF. Please try again.');
      return;
    }
    const pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

    // ── Path 1: Mobile / supported browser — Web Share API with PDF file ──────
    // This opens the native share sheet; user picks WhatsApp → PDF is attached.
    if (
      typeof navigator !== 'undefined' &&
      typeof (navigator as any).share === 'function' &&
      typeof (navigator as any).canShare === 'function' &&
      (navigator as any).canShare({ files: [pdfFile] })
    ) {
      try {
        await (navigator as any).share({
          title: `Invoice ${sale.invoiceNumber}`,
          text: message,
          files: [pdfFile],
        });
        return; // native share sheet handled everything
      } catch (err: any) {
        if (err?.name === 'AbortError') return; // user dismissed — no fallback needed
        // Other error → fall through to desktop fallback
      }
    }

    // ── Path 2: Desktop fallback ───────────────────────────────────────────────
    // Open the PDF in a new browser tab (same as Download PDF — avoids AV scan).
    // Then open the customer's WhatsApp chat with the pre-filled message.
    // The user downloads the PDF from the browser tab and attaches it in WhatsApp.
    const blobUrl = URL.createObjectURL(pdfBlob);
    const pdfTab  = window.open(blobUrl, '_blank', 'noopener');
    if (pdfTab) {
      pdfTab.addEventListener('load', () => URL.revokeObjectURL(blobUrl));
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    } else {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
    }

    const desktopMessage = message.replace(
      '📎 Invoice PDF is attached/shared with this message.',
      '📎 Invoice PDF has been opened in a new tab — please download and attach it in WhatsApp.',
    );

    // Small delay so the PDF tab opens first
    setTimeout(() => {
      window.open(`https://wa.me/${intl}?text=${encodeURIComponent(desktopMessage)}`, '_blank', 'noopener');
    }, 500);
  };

  const filtered = sales.filter(s =>
    s.invoiceNumber?.toLowerCase().includes(search.toLowerCase()) ||
    s.customerName?.toLowerCase().includes(search.toLowerCase())
  );

  const itemsMap = new Map(items.map(i => [i.id, i]));

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Sales.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><CreditCard className="w-6 h-6 text-primary" /> Point of Sale</h1>
            <p className="text-muted-foreground mt-1">Record and view retail transactions</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('sales.csv', filtered.map(s => ({
                Invoice: s.invoiceNumber, Date: s.saleDate, Outlet: s.outletName,
                Customer: s.customerName || 'Walk-in', Payment: s.paymentMode,
                Subtotal: s.subtotal, Tax: s.taxTotal, Total: s.totalAmount,
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { form.reset(defaultFormValues); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Sale
              </Button>
            )}
          </div>
        </div>

        {/* Sales Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search invoice or customer..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <Select value={outletFilter} onValueChange={setOutletFilter}>
              <SelectTrigger className="w-40"><SelectValue placeholder="All Outlets" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Outlets</SelectItem>
                {outlets.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(4)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-16 text-muted-foreground">
                  <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No sales recorded yet</p>
                </TableCell></TableRow>
              ) : filtered.map(sale => (
                <TableRow key={sale.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold">{sale.invoiceNumber}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(sale.saleDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="text-sm">{sale.outletName}</TableCell>
                  <TableCell className="text-sm">{sale.customerName || 'Walk-in'}</TableCell>
                  <TableCell><Badge variant="outline" className="uppercase text-xs">{sale.paymentMode?.replace('_', ' ')}</Badge></TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {Number(sale.taxTotal) > 0 ? `₹${Number(sale.taxTotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-emerald-500">₹{Number(sale.totalAmount).toLocaleString('en-IN')}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(sale)} title="View"><Eye className="w-4 h-4" /></Button>
                      {perm.canDownload && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-600" onClick={() => void downloadInvoicePDF(sale, companySettings)} title="Download PDF"><FileDown className="w-4 h-4" /></Button>}
                      {(sale as any).customerPhone && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-[#25D366] hover:text-[#128C7E] hover:bg-[#25D366]/10" onClick={() => void handleWhatsApp(sale)} title={`Send invoice to ${(sale as any).customerPhone} via WhatsApp`}>
                          <WhatsAppIcon className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {filtered.length > 0 && (
            <div className="p-3 border-t border-border flex justify-between text-sm">
              <span className="text-muted-foreground">{filtered.length} sales</span>
              <span className="font-bold text-emerald-500">Total: ₹{filtered.reduce((s, r) => s + Number(r.totalAmount || 0), 0).toLocaleString('en-IN')}</span>
            </div>
          )}
        </div>
      </div>

      {/* Sale Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Record Sale</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="outletId" render={({ field }) => (
                  <FormItem><FormLabel>Outlet <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => { field.onChange(Number(v)); form.setValue('lineItems', [{ itemId: 0, quantity: 1, unitPrice: 0 }]); }} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select outlet" /></SelectTrigger></FormControl>
                      <SelectContent>{outlets.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="saleDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="customerId" render={({ field }) => {
                  const filteredCustomers = customers.filter(c =>
                    c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
                    ((c as any).phone ?? '').includes(customerSearch)
                  );
                  const selected = customers.find(c => c.id === field.value);
                  return (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Customer</FormLabel>
                        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs text-primary gap-1"
                          onClick={() => { custForm.reset(); setShowNewCustomer(true); }}>
                          <UserPlus className="w-3 h-3" /> New
                        </Button>
                      </div>
                      <Popover open={customerOpen} onOpenChange={v => { setCustomerOpen(v); if (!v) setCustomerSearch(''); }}>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="outline" role="combobox"
                            className={cn('w-full justify-between font-normal h-10 px-3', !selected && 'text-muted-foreground')}>
                            <span className="truncate">{selected ? `${selected.name}${(selected as any).state ? ` (${(selected as any).state})` : ''}` : 'Walk-in Customer'}</span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="p-0" style={{ width: 'var(--radix-popover-trigger-width)', minWidth: '240px' }}>
                          <Command shouldFilter={false}>
                            <CommandInput placeholder="Search customer…" value={customerSearch} onValueChange={setCustomerSearch} />
                            <CommandEmpty>No customers found. <button type="button" className="text-primary underline ml-1" onClick={() => { setCustomerOpen(false); custForm.reset(); custForm.setValue('name', customerSearch); setCustomerSearch(''); setShowNewCustomer(true); }}>Create "{customerSearch}"?</button></CommandEmpty>
                            <CommandGroup className="max-h-52 overflow-auto">
                              <CommandItem value="0" onSelect={() => { field.onChange(undefined); setCustomerOpen(false); setCustomerSearch(''); }}>
                                <Check className={cn('mr-2 h-4 w-4 shrink-0', !field.value ? 'opacity-100' : 'opacity-0')} />
                                Walk-in Customer
                              </CommandItem>
                              {filteredCustomers.map(c => (
                                <CommandItem key={c.id} value={String(c.id)} onSelect={() => { field.onChange(c.id); setCustomerOpen(false); setCustomerSearch(''); }}>
                                  <Check className={cn('mr-2 h-4 w-4 shrink-0', field.value === c.id ? 'opacity-100' : 'opacity-0')} />
                                  {c.name}{(c as any).state ? ` (${(c as any).state})` : ''}
                                  {(c as any).phone ? <span className="ml-2 text-xs text-muted-foreground">{(c as any).phone}</span> : null}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      {watchCustomerId && isInterState && (
                        <p className="text-xs text-amber-500 mt-1">Inter-state sale → IGST applies</p>
                      )}
                      {watchCustomerId && !isInterState && companyState && customerState && (
                        <p className="text-xs text-emerald-600 mt-1">Intra-state sale → CGST + SGST apply</p>
                      )}
                    </FormItem>
                  );
                }} />
                <FormField control={form.control} name="paymentMode" render={({ field }) => (
                  <FormItem><FormLabel>Payment <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="cash">Cash</SelectItem>
                        <SelectItem value="card">Card</SelectItem>
                        <SelectItem value="upi">UPI / QR</SelectItem>
                        <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
              </div>

              {/* Coupon code */}
              <div className="flex gap-2 items-end">
                <FormField control={form.control} name="couponCode" render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel className="text-sm">Coupon Code <span className="text-xs text-muted-foreground font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. SUMMER10"
                        className="uppercase font-mono tracking-wider"
                        {...field}
                        onChange={e => field.onChange(e.target.value.toUpperCase())}
                      />
                    </FormControl>
                  </FormItem>
                )} />
                <div className="pb-1">
                  {watchCouponCode && appliedCoupon && (
                    <div className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 text-sm font-medium">
                      <Check className="w-4 h-4" />
                      {appliedCoupon.discountType === 'percentage'
                        ? `${appliedCoupon.discountValue}% off`
                        : `₹${Number(appliedCoupon.discountValue).toLocaleString('en-IN')} off`}
                    </div>
                  )}
                  {watchCouponCode && !appliedCoupon && (
                    <div className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Invalid / expired
                    </div>
                  )}
                </div>
              </div>

              {/* Line items */}
              <div>
                {!watchOutletId || watchOutletId === 0 ? (
                  <div className="p-6 border border-dashed border-border rounded-lg text-center text-muted-foreground">Select an outlet above to load available stock</div>
                ) : availableItems.length === 0 ? (
                  <div className="p-6 border border-dashed border-amber-500/40 rounded-lg text-center text-amber-500 bg-amber-500/5 flex flex-col items-center gap-2">
                    <PackageOpen className="w-8 h-8 opacity-60" />
                    <p className="font-medium">No stock available at this outlet</p>
                    <p className="text-xs text-muted-foreground">Transfer stock to this outlet before recording a sale</p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-3">
                      <p className="font-semibold">Cart Items <span className="text-xs text-muted-foreground font-normal ml-1">({availableItems.length} in stock)</span></p>
                      <Button type="button" variant="outline" size="sm" onClick={() => append({ itemId: 0, quantity: 1 })}>
                        <Plus className="w-3 h-3 mr-1" /> Add Item
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {fields.map((field, index) => {
                        const itemId   = form.watch(`lineItems.${index}.itemId`);
                        const qty      = form.watch(`lineItems.${index}.quantity`);
                        const unitPrice = Number(form.watch(`lineItems.${index}.unitPrice`) ?? 0);
                        const availQty = getAvailableQty(itemId);
                        const taxRate  = Number((getItem(itemId) as any)?.taxRate ?? 0);
                        const gst      = computeLineGst(qty, unitPrice, taxRate, isInterState);
                        const lineTotal = gst.lineGross; // MRP × qty (inclusive of GST)

                        return (
                          <div key={field.id} className="p-3 bg-muted/20 rounded-lg border border-border space-y-2">
                            {/* Row 1: Item selector */}
                            <FormField control={form.control} name={`lineItems.${index}.itemId`} render={({ field: f }) => (
                              <FormItem>
                                <FormLabel className="text-xs">Item</FormLabel>
                                <Select
                                  onValueChange={v => {
                                    const id = Number(v);
                                    f.onChange(id);
                                    // Auto-fill from Item Master MRP — read-only in sale
                                    form.setValue(`lineItems.${index}.unitPrice`, getPrice(id));
                                  }}
                                  value={f.value ? String(f.value) : ''}
                                >
                                  <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                                  <SelectContent>
                                    {availableItems.map(it => {
                                      const avail = stockMap.get(it.id) ?? 0;
                                      const mrp   = getPrice(it.id);
                                      const r     = Number((it as any).taxRate ?? 0);
                                      return (
                                        <SelectItem key={it.id} value={String(it.id)}>
                                          {it.name} — {avail} avail
                                          {mrp > 0 ? ` · MRP ₹${mrp}` : ' · MRP not set'}
                                          {r > 0 ? ` · ${r}% GST` : ''}
                                        </SelectItem>
                                      );
                                    })}
                                  </SelectContent>
                                </Select>
                              </FormItem>
                            )} />

                            {/* Row 2: Qty + MRP display (read-only) + Line total */}
                            <div className="grid grid-cols-12 gap-2 items-end">
                              <div className="col-span-4">
                                <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({ field: f }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs">Qty {itemId > 0 && <span className="text-muted-foreground">(max {availQty})</span>}</FormLabel>
                                    <FormControl><Input type="number" min={1} max={itemId > 0 ? availQty : undefined} className="h-8 text-xs" {...f} /></FormControl>
                                  </FormItem>
                                )} />
                              </div>

                              {/* MRP — read-only, set in Item Master */}
                              <div className="col-span-4">
                                <p className="text-xs font-medium mb-1.5 text-foreground/80">
                                  MRP (₹) <span className="text-[10px] text-muted-foreground font-normal">from Item Master</span>
                                </p>
                                <div className={`h-8 flex items-center px-3 rounded-md border text-xs font-mono select-none cursor-default ${
                                  unitPrice > 0
                                    ? 'border-border bg-muted/40 text-foreground'
                                    : 'border-amber-500/40 bg-amber-500/5 text-amber-500 text-[10px]'
                                }`}>
                                  {unitPrice > 0
                                    ? `₹${unitPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                                    : 'Set MRP in Item Master'}
                                </div>
                              </div>

                              <div className="col-span-3 text-right pb-0.5 space-y-0.5">
                                {itemId > 0 ? (
                                  unitPrice > 0 ? (
                                    <>
                                      <p className="text-xs text-muted-foreground">Subtotal ₹{gst.lineSubtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                                      {taxRate > 0 && (
                                        <p className="text-xs text-amber-500 font-medium">
                                          {isInterState ? 'IGST' : 'CGST+SGST'} ({taxRate}%) = ₹{gst.taxAmount.toFixed(2)}
                                        </p>
                                      )}
                                      {taxRate === 0 && <p className="text-xs text-muted-foreground/50">No GST</p>}
                                      <p className="font-mono font-bold text-primary text-sm">₹{lineTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                                    </>
                                  ) : (
                                    <p className="text-xs text-amber-400 italic">No MRP</p>
                                  )
                                ) : (
                                  <p className="text-muted-foreground text-xs">—</p>
                                )}
                              </div>
                              <div className="col-span-1 pb-0.5 flex justify-end">
                                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(index)} disabled={fields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              {/* ── Tax Summary + Footer ── */}
              <DialogFooter className="flex-col gap-0 sm:flex-col w-full pt-2 border-t border-border">
                {hasItems && (
                  <div className="w-full mb-3 rounded-lg border border-border overflow-hidden text-sm">
                    {/* Header */}
                    <div className="px-3 py-1.5 bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Invoice Summary
                    </div>
                    <div className="px-3 py-2 space-y-1.5">
                      {/* Subtotal */}
                      <div className="flex justify-between text-muted-foreground">
                        <span>Taxable Amount</span>
                        <span className="font-mono">₹{totals.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>

                      {/* GST lines */}
                      {totals.taxTotal > 0 && (
                        <>
                          {isInterState ? (
                            <div className="flex justify-between">
                              <span className="flex items-center gap-1.5 text-amber-500">
                                IGST (inter-state)
                                <span className="text-[10px] text-muted-foreground/60 font-normal">→ Duty &amp; Tax</span>
                              </span>
                              <span className="font-mono text-amber-500">₹{totals.igstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                            </div>
                          ) : (
                            <>
                              <div className="flex justify-between text-muted-foreground">
                                <span className="flex items-center gap-1.5">
                                  CGST
                                  <span className="text-[10px] text-muted-foreground/60 font-normal">→ Duty &amp; Tax</span>
                                </span>
                                <span className="font-mono">₹{totals.cgstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                              </div>
                              <div className="flex justify-between text-muted-foreground">
                                <span className="flex items-center gap-1.5">
                                  SGST
                                  <span className="text-[10px] text-muted-foreground/60 font-normal">→ Duty &amp; Tax</span>
                                </span>
                                <span className="font-mono">₹{totals.sgstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                              </div>
                            </>
                          )}
                          {/* Total tax callout */}
                          <div className="flex justify-between text-xs py-1 px-2 rounded bg-amber-500/8 text-amber-600 border border-amber-500/15">
                            <span className="font-medium">Total Output GST (to Duty &amp; Tax)</span>
                            <span className="font-mono font-semibold">₹{totals.taxTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                          </div>
                        </>
                      )}

                      {totals.taxTotal === 0 && totals.subtotal > 0 && (
                        <p className="text-xs text-muted-foreground/50 italic">No GST applicable on selected items</p>
                      )}

                      <Separator className="my-1" />

                      {/* Coupon discount line */}
                      {totals.discountAmount > 0 && appliedCoupon && (
                        <div className="flex justify-between text-emerald-600 font-medium">
                          <span className="flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" />
                            Coupon <span className="font-mono text-xs ml-1">{watchCouponCode}</span>
                            {appliedCoupon.discountType === 'percentage' && <span className="text-xs text-muted-foreground ml-1">({appliedCoupon.discountValue}%)</span>}
                          </span>
                          <span className="font-mono">−₹{totals.discountAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      )}

                      <div className="flex justify-between font-bold text-base">
                        <span>{totals.discountAmount > 0 ? 'Amount Payable' : 'Grand Total'}</span>
                        <span className="font-mono text-primary">₹{totals.finalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex gap-2 justify-end w-full">
                  <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createMutation.isPending || !watchOutletId || availableItems.length === 0 || totals.finalAmount === 0}>
                    {createMutation.isPending ? 'Processing…' : 'Complete Sale'}
                  </Button>
                </div>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── Quick Create Customer Dialog (full form, mirrors Customers page) ── */}
      <Dialog open={showNewCustomer} onOpenChange={v => { setShowNewCustomer(v); if (!v) custForm.reset(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Add Customer</DialogTitle></DialogHeader>
          <Form {...custForm}>
            <form onSubmit={custForm.handleSubmit((data: any) => {
              createCustomerMutation.mutate(
                { data: { name: data.name, phone: data.phone || undefined, email: data.email || undefined, gstNumber: data.gstNumber || undefined, state: data.state || undefined, address: data.address || undefined, notes: data.notes || undefined } as any },
                {
                  onSuccess: (created: any) => {
                    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
                    form.setValue('customerId', created.id);
                    toast.success(`Customer "${created.name}" created`);
                    setShowNewCustomer(false);
                    custForm.reset();
                  },
                  onError: (e: any) => toast.error(e?.data?.error || 'Could not create customer'),
                }
              );
            })} className="space-y-4 pt-2">
              <FormField control={custForm.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="Full name / company name" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={custForm.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                )} />
                <FormField control={custForm.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={custForm.control} name="gstNumber" render={({ field }) => (
                  <FormItem><FormLabel>GST Number (GSTIN)</FormLabel><FormControl><Input placeholder="15-char GSTIN" className="font-mono" {...field} /></FormControl></FormItem>
                )} />
                <FormField control={custForm.control} name="state" render={({ field }) => (
                  <FormItem><FormLabel>State</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value || ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select state" /></SelectTrigger></FormControl>
                      <SelectContent>{INDIAN_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  </FormItem>
                )} />
              </div>
              <FormField control={custForm.control} name="address" render={({ field }) => (
                <FormItem><FormLabel>Address</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <FormField control={custForm.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => { setShowNewCustomer(false); custForm.reset(); }}>Cancel</Button>
                <Button type="submit" disabled={createCustomerMutation.isPending}>{createCustomerMutation.isPending ? 'Saving…' : 'Save'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Invoice View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Receipt className="w-5 h-5 text-primary" />{viewItem?.invoiceNumber}</SheetTitle>
            <SheetDescription>{viewItem?.outletName} · {viewItem && new Date(viewItem.saleDate).toLocaleDateString('en-IN')}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['Customer', viewItem.customerName || 'Walk-in'],
                  ['Payment', viewItem.paymentMode?.replace('_', ' ').toUpperCase()],
                  ['Coupon', viewItem.couponCode || '—'],
                ].map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                    <span className="font-semibold">{v}</span>
                  </div>
                ))}
              </div>

              {/* Line items */}
              <div>
                <p className="text-sm font-semibold mb-2">Items</p>
                <div className="space-y-2">
                  {(viewItem.lineItems || []).map((li: any, i: number) => {
                    const itemInfo = itemsMap.get(li.itemId);
                    const itemName = li.itemName || itemInfo?.name || `Item #${li.itemId}`;
                    const hsnCode = li.hsnCode || (itemInfo as any)?.hsnCode || '';
                    const lineSubtotal = li.lineSubtotal ?? (li.quantity * li.unitPrice);
                    return (
                      <div key={i} className="p-3 bg-muted/20 rounded-lg text-sm border border-border">
                        <div className="flex justify-between items-start">
                          <div>
                            <p className="font-medium">{itemName}</p>
                            {hsnCode && <p className="text-xs text-muted-foreground">HSN: {hsnCode}</p>}
                          </div>
                          <Badge variant="secondary" className="text-xs">{li.taxRate ?? 0}% GST</Badge>
                        </div>
                        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                          <span>{li.quantity} × ₹{Number(li.unitPrice).toFixed(2)}</span>
                          <span>Taxable: ₹{Number(lineSubtotal).toFixed(2)}</span>
                        </div>
                        {(li.taxAmount ?? 0) > 0 && (
                          <div className="mt-1 flex justify-between text-xs text-amber-600">
                            <span>{li.taxType === 'igst' ? `IGST ${li.taxRate}%` : `CGST ${(li.taxRate ?? 0) / 2}% + SGST ${(li.taxRate ?? 0) / 2}%`}</span>
                            <span>₹{Number(li.taxAmount).toFixed(2)}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Totals */}
              <div className="p-3 bg-muted/30 rounded-lg space-y-1.5 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="font-mono">₹{Number(viewItem.subtotal ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                {Number(viewItem.taxTotal) > 0 && (
                  <div className="flex justify-between text-amber-600">
                    <span>Total Tax</span>
                    <span className="font-mono">₹{Number(viewItem.taxTotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between font-bold text-base">
                  <span>Grand Total</span>
                  <span className="font-mono text-primary">₹{Number(viewItem.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>

              {/* ── UPI QR Payment section ──────────────────────────────────── */}
              {(viewItem as any).outletUpiId ? (
                <div className="border border-teal-500/30 rounded-xl bg-teal-500/5 p-4 text-center">
                  <p className="text-xs font-bold text-teal-600 uppercase tracking-widest mb-3">⊡ Scan to Pay (UPI)</p>
                  {viewQrUrl ? (
                    <img src={viewQrUrl} alt="UPI QR Code" className="w-44 h-44 mx-auto rounded-lg border border-border shadow-sm" />
                  ) : (
                    <div className="w-44 h-44 mx-auto rounded-lg border border-border bg-muted/30 flex items-center justify-center">
                      <p className="text-xs text-muted-foreground">Generating QR…</p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-2 font-mono">{(viewItem as any).outletUpiId}</p>
                  <p className="text-base font-bold mt-0.5">₹{Number(viewItem.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                  <p className="text-xs text-muted-foreground">{viewItem.invoiceNumber}</p>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
                  <p className="font-semibold">UPI payment QR not available</p>
                  <p className="mt-0.5 opacity-80">No UPI ID configured for <strong>{viewItem.outletName}</strong>. Update the outlet profile to enable QR payments on invoices.</p>
                </div>
              )}

              <div className="flex flex-col gap-2">
                {/* WhatsApp — only when customer has a phone number */}
                {(viewItem as any)?.customerPhone && (
                  <Button
                    className="w-full bg-[#25D366] hover:bg-[#128C7E] text-white border-0"
                    onClick={() => void handleWhatsApp(viewItem)}
                  >
                    <WhatsAppIcon className="w-4 h-4 mr-2" />
                    Share Invoice on WhatsApp
                    <span className="ml-2 text-xs opacity-80 font-normal">{(viewItem as any).customerPhone}</span>
                  </Button>
                )}
                {perm.canDownload && (
                  <Button className="w-full" variant="outline" onClick={() => void downloadInvoicePDF(viewItem, companySettings)}>
                    <FileDown className="w-4 h-4 mr-2" /> Download / Print PDF
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
