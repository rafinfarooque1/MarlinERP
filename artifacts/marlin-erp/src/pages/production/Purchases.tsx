import { useState } from 'react';
import { useListPurchases, useCreatePurchase, useListVendors, useListMaterials, useListRawMaterials, getListPurchasesQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Trash2, ShoppingCart, Download, Eye, Calendar } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

const lineSchema = z.object({
  materialType: z.enum(['material', 'raw_material']),
  materialId: z.coerce.number().min(1, 'Select a material'),
  quantity: z.coerce.number().min(0.01, 'Qty > 0'),
  unitCost: z.coerce.number().min(0, 'Cost ≥ 0'),
});

const schema = z.object({
  vendorId: z.coerce.number().min(1, 'Vendor required'),
  purchaseDate: z.string().min(1, 'Date required'),
  invoiceNumber: z.string().optional(),
  lineItems: z.array(lineSchema).min(1, 'Add at least one item'),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Purchases() {
  const { data: purchases = [], isLoading } = useListPurchases();
  const { data: vendors = [] } = useListVendors();
  const { data: materials = [] } = useListMaterials();
  const { data: rawMaterials = [] } = useListRawMaterials();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreatePurchase();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', lineItems: [{ materialType: 'raw_material', materialId: 0, quantity: 1, unitCost: 0 }], notes: '' },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data: data as any }, {
      onSuccess: () => { toast.success('Purchase order created'); queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = purchases.filter(p =>
    p.vendorName?.toLowerCase().includes(search.toLowerCase()) ||
    p.invoiceNumber?.toLowerCase().includes(search.toLowerCase())
  );

  const lineTotal = (fields: any[]) => fields.reduce((s, _, i) => {
    const q = form.watch(`lineItems.${i}.quantity`) || 0;
    const c = form.watch(`lineItems.${i}.unitCost`) || 0;
    return s + q * c;
  }, 0);

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ShoppingCart className="w-6 h-6 text-primary" /> Purchase Orders</h1>
            <p className="text-muted-foreground mt-1">Incoming materials from vendors</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('purchases.csv', filtered.map(p => ({ 'PO#': `PO-${String(p.id).padStart(4,'0')}`, Date: p.purchaseDate, Vendor: p.vendorName, Invoice: p.invoiceNumber || '', Items: p.lineItems?.length || 0, Total: p.totalAmount })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset({ vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', lineItems: [{ materialType: 'raw_material', materialId: 0, quantity: 1, unitCost: 0 }], notes: '' }); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> New Purchase
            </Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search vendor or invoice..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>PO #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Items</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <ShoppingCart className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No purchase orders yet</p>
                </TableCell></TableRow>
              ) : filtered.map(p => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold text-sm">PO-{String(p.id).padStart(4, '0')}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(p.purchaseDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="font-medium">{p.vendorName}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{p.invoiceNumber || '—'}</TableCell>
                  <TableCell><Badge variant="secondary">{p.lineItems?.length || 0} items</Badge></TableCell>
                  <TableCell className="text-right font-mono font-bold text-emerald-500">₹{Number(p.totalAmount).toLocaleString('en-IN')}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Create Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Create Purchase Order</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem><FormLabel>Vendor <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger></FormControl>
                      <SelectContent>{vendors.map(v => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="purchaseDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="invoiceNumber" render={({ field }) => (
                  <FormItem><FormLabel>Invoice Number</FormLabel><FormControl><Input placeholder="Optional" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>

              <div>
                <div className="flex justify-between items-center mb-3">
                  <p className="font-semibold text-sm">Line Items</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => append({ materialType: 'raw_material', materialId: 0, quantity: 1, unitCost: 0 })}>
                    <Plus className="w-3 h-3 mr-1" /> Add Item
                  </Button>
                </div>
                <div className="space-y-3">
                  {fields.map((field, i) => {
                    const matType = form.watch(`lineItems.${i}.materialType`);
                    const options = matType === 'raw_material' ? rawMaterials : materials;
                    const q = form.watch(`lineItems.${i}.quantity`) || 0;
                    const c = form.watch(`lineItems.${i}.unitCost`) || 0;
                    return (
                      <div key={field.id} className="grid grid-cols-12 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                        <div className="col-span-3">
                          <FormField control={form.control} name={`lineItems.${i}.materialType`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Type</FormLabel>
                              <Select onValueChange={f.onChange} value={f.value}>
                                <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
                                <SelectContent><SelectItem value="raw_material">Raw Material</SelectItem><SelectItem value="material">Packaging</SelectItem></SelectContent>
                              </Select></FormItem>
                          )} />
                        </div>
                        <div className="col-span-4">
                          <FormField control={form.control} name={`lineItems.${i}.materialId`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Item</FormLabel>
                              <Select onValueChange={v => f.onChange(Number(v))} value={f.value ? String(f.value) : ''}>
                                <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                                <SelectContent>{options.map((o: any) => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent>
                              </Select></FormItem>
                          )} />
                        </div>
                        <div className="col-span-2">
                          <FormField control={form.control} name={`lineItems.${i}.quantity`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Qty</FormLabel><FormControl><Input type="number" step="0.01" className="h-8 text-xs" {...f} /></FormControl></FormItem>
                          )} />
                        </div>
                        <div className="col-span-2">
                          <FormField control={form.control} name={`lineItems.${i}.unitCost`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Unit Cost ₹</FormLabel><FormControl><Input type="number" step="0.01" className="h-8 text-xs" {...f} /></FormControl></FormItem>
                          )} />
                        </div>
                        <div className="col-span-1 flex flex-col items-end gap-1">
                          <p className="text-[10px] text-muted-foreground">₹{(q * c).toFixed(0)}</p>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(i)} disabled={fields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea placeholder="Optional..." rows={2} {...field} /></FormControl></FormItem>
              )} />

              <DialogFooter className="flex items-center justify-between w-full">
                <p className="text-sm font-bold text-primary">Total: ₹{lineTotal(fields).toLocaleString('en-IN')}</p>
                <div className="flex gap-2">
                  <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Creating…' : 'Create PO'}</Button>
                </div>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>PO-{viewItem && String(viewItem.id).padStart(4, '0')}</SheetTitle>
            <SheetDescription>Purchase order details</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                {[['Vendor', viewItem.vendorName], ['Date', new Date(viewItem.purchaseDate).toLocaleDateString('en-IN')], ['Invoice', viewItem.invoiceNumber || '—'], ['Total', `₹${Number(viewItem.totalAmount).toLocaleString('en-IN')}`]].map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                    <span className="font-semibold">{v}</span>
                  </div>
                ))}
              </div>
              <div>
                <p className="text-sm font-semibold mb-2">Line Items</p>
                <div className="space-y-2">
                  {(viewItem.lineItems || []).map((li: any, i: number) => (
                    <div key={i} className="flex justify-between items-center p-3 bg-muted/20 rounded-lg text-sm">
                      <div>
                        <Badge variant="secondary" className="text-xs mr-2">{li.materialType === 'raw_material' ? 'Raw' : 'Pkg'}</Badge>
                        <span className="font-medium">ID #{li.materialId}</span>
                      </div>
                      <div className="text-right text-muted-foreground">
                        {li.quantity} × ₹{li.unitCost} = <span className="text-foreground font-bold">₹{(li.quantity * li.unitCost).toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {viewItem.notes && <div><span className="text-xs text-muted-foreground uppercase">Notes</span><p className="mt-1">{viewItem.notes}</p></div>}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
