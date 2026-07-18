import { useState } from 'react';
import { useListItems, useCreateItem, useUpdateItem, useDeleteItem, getListItemsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Edit2, Trash2, Package, Download, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  hsnCode: z.string().min(1, 'HSN code required'),
  taxRate: z.coerce.number().min(0).max(28),
  unit: z.string().min(1, 'Unit required'),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Items() {
  const { data: items = [], isLoading } = useListItems();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateItem();
  const updateMutation = useUpdateItem();
  const deleteMutation = useDeleteItem();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', hsnCode: '', taxRate: 5, unit: 'pkt', description: '' } });

  const openAdd = () => { setEditingId(null); form.reset({ name: '', hsnCode: '', taxRate: 5, unit: 'pkt', description: '' }); setIsOpen(true); };
  const openEdit = (item: any) => {
    setEditingId(item.id);
    form.reset({ name: item.name, hsnCode: item.hsnCode, taxRate: Number(item.taxRate || 0), unit: item.unit, description: item.description || '' });
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    const opts = {
      onSuccess: () => { toast.success(editingId ? 'Item updated' : 'Item created'); queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() }); setIsOpen(false); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    };
    if (editingId) updateMutation.mutate({ id: editingId, data: { ...data, taxRate: String(data.taxRate) } as any }, opts);
    else createMutation.mutate({ data: { ...data, taxRate: String(data.taxRate) } as any }, opts);
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    deleteMutation.mutate({ id }, {
      onSuccess: () => { toast.success('Deleted'); queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() }); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  const filtered = items.filter(i => i.name.toLowerCase().includes(search.toLowerCase()) || i.hsnCode?.includes(search));
  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Package className="w-6 h-6 text-primary" /> Item Master</h1>
            <p className="text-muted-foreground mt-1">Finished goods / SKU catalogue</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('items.csv', filtered.map(i => ({ Name: i.name, HSN: i.hsnCode, 'Tax%': i.taxRate, Unit: i.unit, 'Production Stock': i.productionStock })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Item</Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search by name or HSN..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Name</TableHead>
                <TableHead>HSN Code</TableHead>
                <TableHead>Tax Rate</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Production Stock</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Package className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No items found</p>
                </TableCell></TableRow>
              ) : filtered.map(item => (
                <TableRow key={item.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{item.name}</TableCell>
                  <TableCell><Badge variant="secondary" className="font-mono text-xs">{item.hsnCode}</Badge></TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{item.taxRate}%</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{item.unit}</TableCell>
                  <TableCell className="font-mono text-primary font-bold">{Number(item.productionStock || 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(item)}><Eye className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(item)}><Edit2 className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => handleDelete(item.id, item.name)}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditingId(null); form.reset(); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{editingId ? 'Edit Item' : 'Add Finished Item'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Product Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Frozen Alphonso Mango 250g" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-3 gap-4">
                <FormField control={form.control} name="hsnCode" render={({ field }) => (
                  <FormItem><FormLabel>HSN Code <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="20089200" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="taxRate" render={({ field }) => (
                  <FormItem><FormLabel>Tax Rate %</FormLabel><FormControl><Input type="number" min={0} max={28} step={0.5} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="unit" render={({ field }) => (
                  <FormItem><FormLabel>Unit <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="pkt / kg" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea placeholder="Optional product notes..." rows={2} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={isPending}>{isPending ? 'Saving…' : 'Save Item'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Package className="w-5 h-5 text-primary" />{viewItem?.name}</SheetTitle>
            <SheetDescription>Finished item / SKU details</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['HSN Code', viewItem.hsnCode], ['Tax Rate', `${viewItem.taxRate}%`], ['Unit', viewItem.unit], ['Production Stock', `${Number(viewItem.productionStock || 0).toLocaleString()} ${viewItem.unit}`], ['Description', viewItem.description || '—']].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
              <Button className="w-full mt-2" onClick={() => { setViewItem(null); openEdit(viewItem); }}><Edit2 className="w-4 h-4 mr-2" /> Edit</Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
