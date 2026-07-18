import { useState } from 'react';
import { useListStockTransfers, useCreateStockTransfer, useListItems, useListWarehouses, useListOutlets, getListStockTransfersQueryKey } from '@workspace/api-client-react';
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
import { Plus, Search, ArrowRightLeft, Download, Eye, Trash2, Printer, Calendar } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV, printHTML } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  fromType: z.enum(['warehouse', 'outlet']),
  fromId: z.coerce.number().min(1, 'From location required'),
  toType: z.enum(['warehouse', 'outlet']),
  toId: z.coerce.number().min(1, 'To location required'),
  transferDate: z.string().min(1, 'Date required'),
  lineItems: z.array(z.object({ itemId: z.coerce.number().min(1, 'Select item'), quantity: z.coerce.number().min(1, 'Qty > 0') })).min(1, 'Add at least one item'),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function HoTransfers() {
  const { data: transfers = [], isLoading } = useListStockTransfers();
  const { data: items = [] } = useListItems();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateStockTransfer();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { fromType: 'warehouse', fromId: 0, toType: 'warehouse', toId: 0, transferDate: new Date().toISOString().split('T')[0], lineItems: [{ itemId: 0, quantity: 1 }], notes: '' },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const watchFromType = form.watch('fromType');
  const watchToType = form.watch('toType');

  const fromOptions = watchFromType === 'warehouse' ? warehouses : outlets;
  const toOptions = watchToType === 'warehouse' ? warehouses : outlets;

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data: data as any }, {
      onSuccess: () => { toast.success('Transfer created'); queryClient.invalidateQueries({ queryKey: getListStockTransfersQueryKey() }); setIsOpen(false); form.reset(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // Filter to only W-W or W-O or O-W (not production transfers)
  const hoTransfers = (Array.isArray(transfers) ? transfers : []).filter((t: any) => t.fromType !== 'production');
  const filtered = hoTransfers.filter((t: any) => t.challanNumber?.toLowerCase().includes(search.toLowerCase()) || t.fromName?.toLowerCase().includes(search.toLowerCase()) || t.toName?.toLowerCase().includes(search.toLowerCase()));

  const handlePrint = (t: any) => {
    const rows = (t.lineItems || []).map((li: any, i: number) => `<tr><td>${i+1}</td><td>Item #${li.itemId}</td><td>${li.quantity}</td></tr>`).join('');
    printHTML(`<h2>Transfer Challan — ${t.challanNumber}</h2><p>Date: ${new Date(t.transferDate).toLocaleDateString('en-IN')}</p><p>From: ${t.fromName} → To: ${t.toName}</p><table><tr><th>#</th><th>Item</th><th>Qty</th></tr>${rows}</table>`, t.challanNumber);
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ArrowRightLeft className="w-6 h-6 text-primary" /> Internal Transfers</h1>
            <p className="text-muted-foreground mt-1">Warehouse ↔ Outlet stock movements</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('transfers.csv', filtered.map((t: any) => ({ DC: t.challanNumber, Date: t.transferDate, From: t.fromName, To: t.toName, Items: t.lineItems?.length })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => { form.reset({ fromType: 'warehouse', fromId: 0, toType: 'outlet', toId: 0, transferDate: new Date().toISOString().split('T')[0], lineItems: [{ itemId: 0, quantity: 1 }], notes: '' }); setIsOpen(true); }}>
              <Plus className="w-4 h-4 mr-2" /> New Transfer
            </Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search challan or location..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Challan</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Items</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <ArrowRightLeft className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No internal transfers</p>
                </TableCell></TableRow>
              ) : filtered.map((t: any) => (
                <TableRow key={t.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold text-sm">{t.challanNumber}</TableCell>
                  <TableCell className="text-sm text-muted-foreground"><div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(t.transferDate).toLocaleDateString('en-IN')}</div></TableCell>
                  <TableCell><div className="text-sm font-medium">{t.fromName}</div><Badge variant="outline" className="text-[10px] capitalize">{t.fromType}</Badge></TableCell>
                  <TableCell><div className="text-sm font-medium">{t.toName}</div><Badge variant="outline" className="text-[10px] capitalize">{t.toType}</Badge></TableCell>
                  <TableCell><Badge variant="secondary">{t.lineItems?.length || 0} SKUs</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(t)}><Eye className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => handlePrint(t)}><Printer className="w-4 h-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Create Internal Transfer</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <div className="grid grid-cols-2 gap-4 p-4 bg-muted/20 rounded-lg border border-border">
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">From</p>
                  <FormField control={form.control} name="fromType" render={({ field }) => (
                    <FormItem><Select onValueChange={v => { field.onChange(v); form.setValue('fromId', 0); }} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="warehouse">Warehouse</SelectItem><SelectItem value="outlet">Outlet</SelectItem></SelectContent></Select></FormItem>
                  )} />
                  <FormField control={form.control} name="fromId" render={({ field }) => (
                    <FormItem><Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}><FormControl><SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger></FormControl><SelectContent>{fromOptions.map((o: any) => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
                  )} />
                </div>
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">To</p>
                  <FormField control={form.control} name="toType" render={({ field }) => (
                    <FormItem><Select onValueChange={v => { field.onChange(v); form.setValue('toId', 0); }} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="warehouse">Warehouse</SelectItem><SelectItem value="outlet">Outlet</SelectItem></SelectContent></Select></FormItem>
                  )} />
                  <FormField control={form.control} name="toId" render={({ field }) => (
                    <FormItem><Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}><FormControl><SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger></FormControl><SelectContent>{toOptions.map((o: any) => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
                  )} />
                </div>
              </div>
              <FormField control={form.control} name="transferDate" render={({ field }) => (
                <FormItem className="max-w-xs"><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div>
                <div className="flex justify-between items-center mb-3">
                  <p className="font-semibold text-sm">Items</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => append({ itemId: 0, quantity: 1 })}><Plus className="w-3 h-3 mr-1" /> Add</Button>
                </div>
                <div className="space-y-2">
                  {fields.map((field, i) => (
                    <div key={field.id} className="grid grid-cols-11 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                      <div className="col-span-7">
                        <FormField control={form.control} name={`lineItems.${i}.itemId`} render={({ field: f }) => (
                          <FormItem><FormLabel className="text-xs">Item</FormLabel>
                            <Select onValueChange={v => f.onChange(Number(v))} value={f.value ? String(f.value) : ''}><FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger></FormControl><SelectContent>{items.map(it => <SelectItem key={it.id} value={String(it.id)}>{it.name}</SelectItem>)}</SelectContent></Select></FormItem>
                        )} />
                      </div>
                      <div className="col-span-3">
                        <FormField control={form.control} name={`lineItems.${i}.quantity`} render={({ field: f }) => (
                          <FormItem><FormLabel className="text-xs">Qty</FormLabel><FormControl><Input type="number" min={1} className="h-8 text-xs" {...f} /></FormControl></FormItem>
                        )} />
                      </div>
                      <div className="col-span-1 pb-1 flex justify-end">
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(i)} disabled={fields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Creating…' : 'Create Transfer'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader><SheetTitle>{viewItem?.challanNumber}</SheetTitle><SheetDescription>Transfer details</SheetDescription></SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['Date', new Date(viewItem.transferDate).toLocaleDateString('en-IN')], ['From', `${viewItem.fromName} (${viewItem.fromType})`], ['To', `${viewItem.toName} (${viewItem.toType})`], ['Interstate', viewItem.isInterstate ? 'Yes' : 'No']].map(([k, v]) => (
                <div key={String(k)} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{String(v)}</span>
                </div>
              ))}
              <div><p className="text-sm font-semibold mb-2">Items</p>
                {(viewItem.lineItems || []).map((li: any, i: number) => (
                  <div key={i} className="flex justify-between p-3 bg-muted/20 rounded text-sm mb-2"><span>Item #{li.itemId}</span><span className="font-bold">{li.quantity} units</span></div>
                ))}
              </div>
              <Button className="w-full" variant="outline" onClick={() => handlePrint(viewItem)}><Printer className="w-4 h-4 mr-2" /> Print</Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
