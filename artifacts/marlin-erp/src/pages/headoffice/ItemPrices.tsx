import { useState } from 'react';
import { useListItemPrices, useSetItemPrice, useListItems, useListOutlets } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Tag, Download, Edit2, Calendar, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  itemId: z.coerce.number().min(1, 'Item required'),
  outletId: z.coerce.number().min(1, 'Outlet required'),
  price: z.coerce.number().min(0, 'Price ≥ 0'),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function ItemPrices() {
  const perm = usePermission('Item Prices');
  const [outletFilter, setOutletFilter] = useState<string>('all');
  const [itemFilter, setItemFilter] = useState<string>('all');
  const { data: itemPrices = [], isLoading } = useListItemPrices(outletFilter !== 'all' ? { outletId: Number(outletFilter) } : undefined);
  const { data: items = [] } = useListItems();
  const { data: outlets = [] } = useListOutlets();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const queryClient = useQueryClient();
  const upsertMutation = useSetItemPrice();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { itemId: 0, outletId: 0, price: 0, validFrom: '', validTo: '' },
  });

  const openSet = (ip?: any) => {
    form.reset(ip
      ? { itemId: ip.itemId, outletId: ip.outletId, price: Number(ip.price), validFrom: ip.validFrom || '', validTo: ip.validTo || '' }
      : { itemId: 0, outletId: 0, price: 0, validFrom: '', validTo: '' });
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    upsertMutation.mutate({ data: { ...data, price: String(data.price), validFrom: data.validFrom || undefined, validTo: data.validTo || undefined } as any }, {
      onSuccess: () => { toast.success('Price updated'); queryClient.invalidateQueries({ queryKey: ['/api/item-prices'] }); setIsOpen(false); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // Apply filters
  let filtered = itemPrices.filter(ip =>
    ip.itemName?.toLowerCase().includes(search.toLowerCase()) ||
    ip.outletName?.toLowerCase().includes(search.toLowerCase())
  );
  if (itemFilter !== 'all') filtered = filtered.filter(ip => String(ip.itemId) === itemFilter);

  const today = new Date().toISOString().split('T')[0];
  const isPriceActive = (ip: any) => {
    if (!ip.validFrom && !ip.validTo) return true;
    const fromOk = !ip.validFrom || ip.validFrom <= today;
    const toOk = !ip.validTo || ip.validTo >= today;
    return fromOk && toOk;
  };

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Item Prices.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Tag className="w-6 h-6 text-primary" /> Item Pricing</h1>
            <p className="text-muted-foreground mt-1">Set outlet-specific retail prices with optional validity periods</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('item-prices.csv', filtered.map(ip => ({ Item: ip.itemName, Outlet: ip.outletName, 'Price ₹': ip.price, 'Valid From': (ip as any).validFrom || '', 'Valid To': (ip as any).validTo || '' })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => openSet()}><Plus className="w-4 h-4 mr-2" /> Set Price</Button>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[160px]">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search item or outlet..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <Select value={itemFilter} onValueChange={setItemFilter}>
              <SelectTrigger className="w-44"><SelectValue placeholder="All Items" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Items</SelectItem>
                {items.map(i => <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>)}
              </SelectContent>
            </Select>
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
                <TableHead>Item</TableHead>
                <TableHead>Outlet</TableHead>
                <TableHead className="text-right">Price (₹)</TableHead>
                <TableHead>Validity Period</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                {perm.canEdit && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(4)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <Tag className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No prices configured yet</p>
                </TableCell></TableRow>
              ) : filtered.map((ip, i) => {
                const active = isPriceActive(ip);
                return (
                  <TableRow key={i} className="hover:bg-muted/10">
                    <TableCell className="font-semibold">{ip.itemName}</TableCell>
                    <TableCell className="text-muted-foreground">{ip.outletName}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-primary text-lg">₹{Number(ip.price).toLocaleString('en-IN')}</TableCell>
                    <TableCell>
                      {(ip as any).validFrom || (ip as any).validTo ? (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Calendar className="w-3 h-3" />
                          <span>{(ip as any).validFrom || '∞'} → {(ip as any).validTo || '∞'}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Always valid</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {active
                        ? <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs">Active</Badge>
                        : <Badge variant="outline" className="text-xs text-amber-500 border-amber-500/30">Inactive</Badge>
                      }
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{ip.updatedAt ? new Date(ip.updatedAt).toLocaleDateString('en-IN') : '—'}</TableCell>
                    {perm.canEdit && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openSet(ip)}><Edit2 className="w-4 h-4" /></Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Set Item Price</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="itemId" render={({ field }) => (
                <FormItem><FormLabel>Item <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                    <SelectContent>{items.map(i => <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>)}</SelectContent>
                  </Select><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="outletId" render={({ field }) => (
                <FormItem><FormLabel>Outlet <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select outlet" /></SelectTrigger></FormControl>
                    <SelectContent>{outlets.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent>
                  </Select><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="price" render={({ field }) => (
                <FormItem><FormLabel>Selling Price (₹) <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" step="0.01" min={0} placeholder="0.00" className="text-lg font-mono" {...field} /></FormControl><FormMessage /></FormItem>
              )} />

              {/* Optional validity period */}
              <div className="border-t border-border pt-3 space-y-3">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Validity Period (optional)</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormField control={form.control} name="validFrom" render={({ field }) => (
                    <FormItem><FormLabel className="text-xs">Valid From</FormLabel>
                      <FormControl><Input type="date" {...field} value={field.value || ''} /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="validTo" render={({ field }) => (
                    <FormItem><FormLabel className="text-xs">Valid To</FormLabel>
                      <FormControl><Input type="date" {...field} value={field.value || ''} /></FormControl>
                    </FormItem>
                  )} />
                </div>
                <p className="text-xs text-muted-foreground">Leave blank for the price to be always active</p>
              </div>

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={upsertMutation.isPending}>{upsertMutation.isPending ? 'Saving…' : 'Set Price'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
