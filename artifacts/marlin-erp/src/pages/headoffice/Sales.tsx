import { useState } from 'react';
import { useListSales, useCreateSale, useListOutlets, useListCustomers, useListItems, useListItemPrices, getListSalesQueryKey, useListCoupons } from '@workspace/api-client-react';
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
import { Plus, Search, Trash2, CreditCard, Calendar, Receipt, Download, Eye, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { downloadCSV, printHTML } from '@/lib/download';

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

export default function Sales() {
  const { data: outlets = [] } = useListOutlets();
  const [outletFilter, setOutletFilter] = useState<string>('all');
  const { data: sales = [], isLoading } = useListSales(outletFilter !== 'all' ? { outletId: Number(outletFilter) } : undefined);
  const { data: customers = [] } = useListCustomers();
  const { data: items = [] } = useListItems();
  const { data: coupons = [] } = useListCoupons();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateSale();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { outletId: 0, saleDate: new Date().toISOString().split('T')[0], paymentMode: 'cash', couponCode: '', lineItems: [{ itemId: 0, quantity: 1 }] },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const watchOutletId = form.watch('outletId');
  const { data: outletPrices = [] } = useListItemPrices({ outletId: watchOutletId }, { query: { enabled: !!watchOutletId && watchOutletId > 0 } });

  const getPrice = (itemId: number) => outletPrices.find(p => p.itemId === itemId)?.price ?? 0;

  const calcTotal = () => fields.reduce((s, _, i) => {
    const itemId = form.watch(`lineItems.${i}.itemId`);
    const qty = form.watch(`lineItems.${i}.quantity`);
    return s + (getPrice(itemId) * qty);
  }, 0);

  const onSubmit = (data: FormValues) => {
    // Enrich line items with price data from outletPrices
    const enrichedItems = data.lineItems.map(li => ({
      itemId: li.itemId,
      quantity: li.quantity,
      unitPrice: Number(getPrice(li.itemId)),
      discount: 0,
      taxAmount: 0,
    }));
    createMutation.mutate({ data: { ...data, lineItems: enrichedItems, customerId: data.customerId || undefined } as any }, {
      onSuccess: () => {
        toast.success('Sale recorded successfully');
        queryClient.invalidateQueries({ queryKey: getListSalesQueryKey() });
        setIsOpen(false);
        form.reset({ outletId: 0, saleDate: new Date().toISOString().split('T')[0], paymentMode: 'cash', couponCode: '', lineItems: [{ itemId: 0, quantity: 1 }] });
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not record sale'),
    });
  };

  const handlePrintInvoice = (sale: any) => {
    const rows = (sale.lineItems || []).map((li: any, i: number) => `<tr><td>${i+1}</td><td>Item #${li.itemId}</td><td>${li.quantity}</td><td>₹${li.unitPrice}</td><td>₹${li.quantity * li.unitPrice}</td></tr>`).join('');
    printHTML(`<h2>Invoice — ${sale.invoiceNumber}</h2><p>Date: ${new Date(sale.saleDate).toLocaleDateString('en-IN')}&nbsp;&nbsp;|&nbsp;&nbsp;Outlet: ${sale.outletName}&nbsp;&nbsp;|&nbsp;&nbsp;Payment: ${sale.paymentMode?.toUpperCase()}</p><p>Customer: ${sale.customerName || 'Walk-in'}</p><table><tr><th>#</th><th>Item</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr>${rows}</table><p class="total">Total: ₹${Number(sale.totalAmount).toLocaleString('en-IN')}</p>`, sale.invoiceNumber);
  };

  const filtered = sales.filter(s => s.invoiceNumber?.toLowerCase().includes(search.toLowerCase()) || s.customerName?.toLowerCase().includes(search.toLowerCase()));

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><CreditCard className="w-6 h-6 text-primary" /> Point of Sale</h1>
            <p className="text-muted-foreground mt-1">Record and view retail transactions</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('sales.csv', filtered.map(s => ({ Invoice: s.invoiceNumber, Date: s.saleDate, Outlet: s.outletName, Customer: s.customerName || 'Walk-in', Payment: s.paymentMode, Total: s.totalAmount })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset({ outletId: 0, saleDate: new Date().toISOString().split('T')[0], paymentMode: 'cash', couponCode: '', lineItems: [{ itemId: 0, quantity: 1 }] }); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> New Sale
            </Button>
          </div>
        </div>

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
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(4)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <Receipt className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No sales recorded yet</p>
                </TableCell></TableRow>
              ) : filtered.map(sale => (
                <TableRow key={sale.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold">{sale.invoiceNumber}</TableCell>
                  <TableCell className="text-sm text-muted-foreground"><div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(sale.saleDate).toLocaleDateString('en-IN')}</div></TableCell>
                  <TableCell className="text-sm">{sale.outletName}</TableCell>
                  <TableCell className="text-sm">{sale.customerName || 'Walk-in'}</TableCell>
                  <TableCell><Badge variant="outline" className="uppercase text-xs">{sale.paymentMode?.replace('_', ' ')}</Badge></TableCell>
                  <TableCell className="text-right font-mono font-bold text-emerald-500">₹{Number(sale.totalAmount).toLocaleString('en-IN')}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(sale)}><Eye className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => handlePrintInvoice(sale)}><Printer className="w-4 h-4" /></Button>
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
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
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
                        {customers.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                      </SelectContent>
                    </Select></FormItem>
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

              <div>
                {!watchOutletId || watchOutletId === 0 ? (
                  <div className="p-6 border border-dashed border-border rounded-lg text-center text-muted-foreground">
                    Select an outlet above to load item prices
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-3">
                      <p className="font-semibold">Cart Items</p>
                      <Button type="button" variant="outline" size="sm" onClick={() => append({ itemId: 0, quantity: 1 })}><Plus className="w-3 h-3 mr-1" /> Add Item</Button>
                    </div>
                    <div className="space-y-2">
                      {fields.map((field, index) => {
                        const itemId = form.watch(`lineItems.${index}.itemId`);
                        const qty = form.watch(`lineItems.${index}.quantity`);
                        const price = getPrice(itemId);
                        return (
                          <div key={field.id} className="grid grid-cols-12 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                            <div className="col-span-6">
                              <FormField control={form.control} name={`lineItems.${index}.itemId`} render={({ field: f }) => (
                                <FormItem><FormLabel className="text-xs">Item</FormLabel>
                                  <Select onValueChange={v => f.onChange(Number(v))} value={f.value ? String(f.value) : ''}>
                                    <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                                    <SelectContent>{items.map(it => { const p = getPrice(it.id); return <SelectItem key={it.id} value={String(it.id)}>{it.name} (₹{p})</SelectItem>; })}</SelectContent>
                                  </Select></FormItem>
                              )} />
                            </div>
                            <div className="col-span-2">
                              <FormField control={form.control} name={`lineItems.${index}.quantity`} render={({ field: f }) => (
                                <FormItem><FormLabel className="text-xs">Qty</FormLabel><FormControl><Input type="number" min={1} className="h-8 text-xs" {...f} /></FormControl></FormItem>
                              )} />
                            </div>
                            <div className="col-span-3 text-right pb-1">
                              <p className="text-xs text-muted-foreground">Subtotal</p>
                              <p className="font-mono font-bold text-primary">₹{(price * qty).toLocaleString('en-IN')}</p>
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

              <DialogFooter className="flex-row justify-between items-center w-full pt-2 border-t border-border">
                <div>
                  <p className="text-xs text-muted-foreground">Total Amount</p>
                  <p className="text-2xl font-bold font-mono text-primary">₹{calcTotal().toLocaleString('en-IN')}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createMutation.isPending || !watchOutletId}>
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
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Receipt className="w-5 h-5 text-primary" />{viewItem?.invoiceNumber}</SheetTitle>
            <SheetDescription>{viewItem?.outletName} · {viewItem && new Date(viewItem.saleDate).toLocaleDateString('en-IN')}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                {[['Customer', viewItem.customerName || 'Walk-in'], ['Payment', viewItem.paymentMode?.replace('_', ' ').toUpperCase()], ['Coupon', viewItem.couponCode || '—']].map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-1"><span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span><span className="font-semibold">{v}</span></div>
                ))}
              </div>
              <div>
                <p className="text-sm font-semibold mb-2">Items</p>
                {(viewItem.lineItems || []).map((li: any, i: number) => (
                  <div key={i} className="flex justify-between p-3 bg-muted/20 rounded text-sm mb-2">
                    <span>Item #{li.itemId} × {li.quantity}</span>
                    <span className="font-bold">₹{(li.quantity * li.unitPrice).toLocaleString()}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-xl font-bold border-t border-border pt-3">
                <span>Total</span><span className="text-primary">₹{Number(viewItem.totalAmount).toLocaleString('en-IN')}</span>
              </div>
              <Button className="w-full" variant="outline" onClick={() => handlePrintInvoice(viewItem)}><Printer className="w-4 h-4 mr-2" /> Print Invoice</Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
