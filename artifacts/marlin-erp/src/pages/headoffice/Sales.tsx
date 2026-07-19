import { useState } from 'react';
import {
  useListSales, useCreateSale, useListOutlets, useListCustomers,
  useListItems, useListItemPrices, useListStock, useGetCompanySettings,
  getListSalesQueryKey, useListCoupons,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Plus, Search, Trash2, CreditCard, Calendar, Receipt,
  Download, Eye, Printer, PackageOpen, FileDown,
} from 'lucide-react';
import { downloadInvoicePDF } from '@/lib/pdfUtils';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { downloadCSV, printHTML } from '@/lib/download';
import { Separator } from '@/components/ui/separator';

// ── Types ──────────────────────────────────────────────────────────────────────

interface GstBreakdown {
  taxRate: number;
  taxType: 'cgst_sgst' | 'igst';
  lineSubtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxAmount: number;
}

function computeLineGst(
  qty: number, price: number, taxRate: number, isInterState: boolean
): GstBreakdown {
  const lineSubtotal = qty * price;
  const rawTax = Math.round(lineSubtotal * taxRate / 100 * 100) / 100;
  if (isInterState) {
    return { taxRate, taxType: 'igst', lineSubtotal, cgst: 0, sgst: 0, igst: rawTax, taxAmount: rawTax };
  }
  const half = Math.round(rawTax / 2 * 100) / 100;
  return { taxRate, taxType: 'cgst_sgst', lineSubtotal, cgst: half, sgst: half, igst: 0, taxAmount: rawTax };
}

// ── Form Schema ─────────────────────────────────────────────────────────────────

const saleLineSchema = z.object({
  itemId: z.coerce.number().min(1, 'Item required'),
  quantity: z.coerce.number().min(1, 'Qty ≥ 1'),
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

const defaultFormValues: FormValues = {
  outletId: 0,
  saleDate: new Date().toISOString().split('T')[0],
  paymentMode: 'cash',
  couponCode: '',
  lineItems: [{ itemId: 0, quantity: 1 }],
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function Sales() {
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
  const queryClient = useQueryClient();
  const createMutation = useCreateSale();

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

  const getPrice = (itemId: number) => outletPrices.find(p => p.itemId === itemId)?.price ?? 0;
  const getAvailableQty = (itemId: number) => stockMap.get(itemId) ?? 0;
  const getItem = (itemId: number) => items.find(i => i.id === itemId);

  // GST state determination
  const companyState = ((companySettings as any)?.state ?? '').trim().toLowerCase();
  const selectedCustomer = customers.find(c => c.id === watchCustomerId);
  const customerState = ((selectedCustomer as any)?.state ?? '').trim().toLowerCase();
  const isInterState = !!(companyState && customerState && companyState !== customerState);

  // Compute aggregated GST totals for the cart
  const computeCartTotals = () => {
    let subtotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0, taxTotal = 0;
    fields.forEach((_, i) => {
      const itemId = form.watch(`lineItems.${i}.itemId`);
      const qty = form.watch(`lineItems.${i}.quantity`);
      const price = getPrice(itemId);
      if (!itemId || !price) return;
      const taxRate = Number((getItem(itemId) as any)?.taxRate ?? 0);
      const gst = computeLineGst(qty, price, taxRate, isInterState);
      subtotal += gst.lineSubtotal;
      cgstTotal += gst.cgst;
      sgstTotal += gst.sgst;
      igstTotal += gst.igst;
      taxTotal += gst.taxAmount;
    });
    return { subtotal, cgstTotal, sgstTotal, igstTotal, taxTotal, grandTotal: subtotal + taxTotal };
  };

  const totals = computeCartTotals();

  const onSubmit = (data: FormValues) => {
    const enrichedItems = data.lineItems.map(li => ({
      itemId: li.itemId,
      quantity: li.quantity,
      unitPrice: Number(getPrice(li.itemId)),
      discount: 0,
      taxAmount: 0, // backend recomputes authoritatively
    }));
    createMutation.mutate({ data: { ...data, lineItems: enrichedItems, customerId: data.customerId || undefined } as any }, {
      onSuccess: () => {
        toast.success('Sale recorded successfully');
        queryClient.invalidateQueries({ queryKey: getListSalesQueryKey() });
        setIsOpen(false);
        form.reset(defaultFormValues);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not record sale'),
    });
  };

  const handlePrintInvoice = (sale: any) => {
    const cs = companySettings as any;
    const lineRows = (sale.lineItems || []).map((li: any, i: number) => {
      const lineTotal = li.lineSubtotal ?? (li.quantity * li.unitPrice);
      const cgst = li.cgst ?? 0;
      const sgst = li.sgst ?? 0;
      const igst = li.igst ?? 0;
      return `<tr>
        <td>${i + 1}</td>
        <td>${li.itemName || `Item #${li.itemId}`}<br/><small style="color:#666">${li.hsnCode ? `HSN: ${li.hsnCode}` : ''}</small></td>
        <td style="text-align:center">${li.taxRate ?? 0}%</td>
        <td style="text-align:right">${li.quantity}</td>
        <td style="text-align:right">₹${Number(li.unitPrice).toFixed(2)}</td>
        <td style="text-align:right">₹${Number(lineTotal).toFixed(2)}</td>
        <td style="text-align:right">${cgst > 0 ? `₹${cgst.toFixed(2)}` : '—'}</td>
        <td style="text-align:right">${sgst > 0 ? `₹${sgst.toFixed(2)}` : '—'}</td>
        <td style="text-align:right">${igst > 0 ? `₹${igst.toFixed(2)}` : '—'}</td>
        <td style="text-align:right">₹${Number(li.taxAmount ?? 0).toFixed(2)}</td>
        <td style="text-align:right"><strong>₹${(Number(lineTotal) + Number(li.taxAmount ?? 0)).toFixed(2)}</strong></td>
      </tr>`;
    }).join('');

    printHTML(`
      <style>table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;font-size:11px}th{background:#f5f5f5}.total{font-size:14px;font-weight:bold;text-align:right;margin-top:12px}.header{margin-bottom:12px}.meta{font-size:12px;color:#555}.gstin{font-size:11px;font-family:monospace;color:#333}</style>
      <div class="header">
        <h2 style="margin:0">${cs?.companyName || 'Tax Invoice'}</h2>
        <p class="meta">${cs?.address || ''}${cs?.state ? ', ' + cs.state : ''}${cs?.pincode ? ' - ' + cs.pincode : ''}</p>
        ${cs?.gstNumber ? `<p class="gstin">GSTIN: ${cs.gstNumber}</p>` : ''}
      </div>
      <hr/>
      <table><tr><td><strong>Invoice:</strong> ${sale.invoiceNumber}</td><td><strong>Date:</strong> ${new Date(sale.saleDate).toLocaleDateString('en-IN')}</td></tr>
      <tr><td><strong>Outlet:</strong> ${sale.outletName}</td><td><strong>Payment:</strong> ${sale.paymentMode?.toUpperCase()}</td></tr>
      <tr><td colspan="2"><strong>Customer:</strong> ${sale.customerName || 'Walk-in'}${(sale as any).customerGstin ? ' | GSTIN: ' + (sale as any).customerGstin : ''}</td></tr>
      </table><br/>
      <table>
        <tr><th>#</th><th>Item / HSN</th><th>GST%</th><th>Qty</th><th>Unit Price</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Tax</th><th>Total</th></tr>
        ${lineRows}
      </table>
      <div class="total">Subtotal: ₹${Number(sale.subtotal ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
      ${sale.taxTotal > 0 ? `<div class="total" style="color:#555;font-size:12px">Tax: ₹${Number(sale.taxTotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>` : ''}
      <div class="total" style="font-size:16px">Grand Total: ₹${Number(sale.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
    `, sale.invoiceNumber);
  };

  const filtered = sales.filter(s =>
    s.invoiceNumber?.toLowerCase().includes(search.toLowerCase()) ||
    s.customerName?.toLowerCase().includes(search.toLowerCase())
  );

  const itemsMap = new Map(items.map(i => [i.id, i]));

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><CreditCard className="w-6 h-6 text-primary" /> Point of Sale</h1>
            <p className="text-muted-foreground mt-1">Record and view retail transactions</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('sales.csv', filtered.map(s => ({
              Invoice: s.invoiceNumber, Date: s.saleDate, Outlet: s.outletName,
              Customer: s.customerName || 'Walk-in', Payment: s.paymentMode,
              Subtotal: s.subtotal, Tax: s.taxTotal, Total: s.totalAmount,
            })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset(defaultFormValues); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> New Sale
            </Button>
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
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => handlePrintInvoice(sale)} title="Print"><Printer className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-600" onClick={() => downloadInvoicePDF(sale, companySettings)} title="Download PDF"><FileDown className="w-4 h-4" /></Button>
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
                    <Select onValueChange={v => { field.onChange(Number(v)); form.setValue('lineItems', [{ itemId: 0, quantity: 1 }]); }} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select outlet" /></SelectTrigger></FormControl>
                      <SelectContent>{outlets.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="saleDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="customerId" render={({ field }) => (
                  <FormItem><FormLabel>Customer</FormLabel>
                    <Select onValueChange={v => field.onChange(v === '0' ? undefined : Number(v))} value={field.value ? String(field.value) : '0'}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Walk-in" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="0">Walk-in Customer</SelectItem>
                        {customers.map(c => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.name}{(c as any).state ? ` (${(c as any).state})` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {watchCustomerId && isInterState && (
                      <p className="text-xs text-amber-500 mt-1">Inter-state sale → IGST applies</p>
                    )}
                    {watchCustomerId && !isInterState && companyState && customerState && (
                      <p className="text-xs text-emerald-600 mt-1">Intra-state sale → CGST + SGST apply</p>
                    )}
                  </FormItem>
                )} />
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
                        const itemId = form.watch(`lineItems.${index}.itemId`);
                        const qty = form.watch(`lineItems.${index}.quantity`);
                        const price = getPrice(itemId);
                        const availQty = getAvailableQty(itemId);
                        const taxRate = Number((getItem(itemId) as any)?.taxRate ?? 0);
                        const gst = computeLineGst(qty, price, taxRate, isInterState);
                        const lineTotal = gst.lineSubtotal + gst.taxAmount;

                        return (
                          <div key={field.id} className="grid grid-cols-12 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                            <div className="col-span-6">
                              <FormField control={form.control} name={`lineItems.${index}.itemId`} render={({ field: f }) => (
                                <FormItem>
                                  <FormLabel className="text-xs">Item</FormLabel>
                                  <Select onValueChange={v => f.onChange(Number(v))} value={f.value ? String(f.value) : ''}>
                                    <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                                    <SelectContent>
                                      {availableItems.map(it => {
                                        const avail = stockMap.get(it.id) ?? 0;
                                        const p = getPrice(it.id);
                                        const r = Number((it as any).taxRate ?? 0);
                                        return (
                                          <SelectItem key={it.id} value={String(it.id)}>
                                            {it.name} — {avail} avail{p > 0 ? ` · ₹${p}` : ''}{r > 0 ? ` · ${r}% GST` : ''}
                                          </SelectItem>
                                        );
                                      })}
                                    </SelectContent>
                                  </Select>
                                </FormItem>
                              )} />
                            </div>
                            <div className="col-span-2">
                              <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({ field: f }) => (
                                <FormItem>
                                  <FormLabel className="text-xs">Qty {itemId > 0 && <span className="text-muted-foreground">(max {availQty})</span>}</FormLabel>
                                  <FormControl><Input type="number" min={1} max={itemId > 0 ? availQty : undefined} className="h-8 text-xs" {...f} /></FormControl>
                                </FormItem>
                              )} />
                            </div>
                            <div className="col-span-3 text-right pb-1 space-y-0.5">
                              {itemId > 0 && price > 0 ? (
                                <>
                                  <p className="text-xs text-muted-foreground">₹{gst.lineSubtotal.toLocaleString('en-IN')}</p>
                                  {taxRate > 0 && (
                                    <p className="text-xs text-amber-600">
                                      +{isInterState ? 'IGST' : 'GST'} ₹{gst.taxAmount.toFixed(2)}
                                    </p>
                                  )}
                                  <p className="font-mono font-bold text-primary text-sm">₹{lineTotal.toLocaleString('en-IN')}</p>
                                </>
                              ) : (
                                <p className="text-muted-foreground text-xs">—</p>
                              )}
                            </div>
                            <div className="col-span-1 pb-1 flex justify-end">
                              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(index)} disabled={fields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              {/* Footer with GST breakdown */}
              <DialogFooter className="flex-col gap-0 sm:flex-col w-full pt-2 border-t border-border">
                {totals.subtotal > 0 && (
                  <div className="w-full mb-3 p-3 bg-muted/20 rounded-lg text-sm space-y-1">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Subtotal (taxable)</span>
                      <span className="font-mono">₹{totals.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                    {isInterState && totals.igstTotal > 0 && (
                      <div className="flex justify-between text-amber-600">
                        <span>IGST (inter-state)</span>
                        <span className="font-mono">₹{totals.igstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                    )}
                    {!isInterState && totals.cgstTotal > 0 && (
                      <>
                        <div className="flex justify-between text-muted-foreground">
                          <span>CGST</span>
                          <span className="font-mono">₹{totals.cgstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between text-muted-foreground">
                          <span>SGST</span>
                          <span className="font-mono">₹{totals.sgstTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </>
                    )}
                    <Separator className="my-1" />
                    <div className="flex justify-between font-bold text-base">
                      <span>Grand Total</span>
                      <span className="font-mono text-primary">₹{totals.grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                )}
                <div className="flex gap-2 justify-end w-full">
                  <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createMutation.isPending || !watchOutletId || availableItems.length === 0}>
                    {createMutation.isPending ? 'Processing…' : 'Complete Sale'}
                  </Button>
                </div>
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

              <div className="flex gap-2">
                <Button className="flex-1" variant="outline" onClick={() => handlePrintInvoice(viewItem)}>
                  <Printer className="w-4 h-4 mr-2" /> Print
                </Button>
                <Button className="flex-1" variant="outline" onClick={() => downloadInvoicePDF(viewItem, companySettings)}>
                  <FileDown className="w-4 h-4 mr-2" /> Download PDF
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
