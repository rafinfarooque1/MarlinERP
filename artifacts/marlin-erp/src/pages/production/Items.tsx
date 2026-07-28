import { useState, useEffect } from 'react';
import { useListItems, useCreateItem, useUpdateItem, useDeleteItem, getListItemsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Edit2, Trash2, Package, Download, Eye, Ruler, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { useUnits } from '@/lib/useUnits';
import { Link } from 'wouter';
import { usePermission } from '@/lib/usePermission';
import { useIsHeadOffice, HEAD_OFFICE_ONLY_HINT, isActiveProduct } from '@/lib/productStatus';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  hsnCode: z.string().min(1, 'HSN code required'),
  taxRate: z.coerce.number().min(0).max(28),
  unit: z.string().min(1, 'Unit required'),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Items() {
  const perm = usePermission('Items');
  // Item masters belong to Head Office. Codes, barcodes and status are shown
  // read-only here — the full editor lives on the combined Item Master page.
  const { isHeadOffice } = useIsHeadOffice();
  const { data: items = [], isLoading } = useListItems();
  const { units } = useUnits();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateItem();
  const updateMutation = useUpdateItem();
  const deleteMutation = useDeleteItem();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', hsnCode: '', taxRate: 5, unit: '', description: '' } });

  const openAdd = () => { setEditingId(null); form.reset({ name: '', hsnCode: '', taxRate: 5, unit: units[0] || '', description: '' }); setIsOpen(true); };
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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Package className="w-6 h-6 text-primary" /> Item Master</h1>
            <p className="text-muted-foreground mt-1">{isHeadOffice ? 'Finished goods / SKU catalogue' : HEAD_OFFICE_ONLY_HINT}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('items.csv', filtered.map(i => ({ Code: (i as any).itemCode || '', Barcode: (i as any).barcode || '', Name: i.name, HSN: i.hsnCode, 'Tax%': i.taxRate, Unit: i.unit, 'Production Stock': i.productionStock, Status: isActiveProduct(i) ? 'Active' : 'Inactive' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            {isHeadOffice && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Item</Button>}
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
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>HSN Code</TableHead>
                <TableHead>Tax Rate</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Production Stock</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-16 text-muted-foreground">
                  <Package className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No items found</p>
                </TableCell></TableRow>
              ) : filtered.map(item => {
                const active = isActiveProduct(item);
                return (
                <TableRow key={item.id} className={`hover:bg-muted/10 ${active ? '' : 'opacity-60'}`}>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-mono text-sm font-semibold">{(item as any).itemCode || '—'}</div>
                    {(item as any).barcode && <div className="font-mono text-[10px] text-muted-foreground">{(item as any).barcode}</div>}
                  </TableCell>
                  <TableCell className="font-semibold">{item.name}</TableCell>
                  <TableCell><Badge variant="secondary" className="font-mono text-xs">{item.hsnCode}</Badge></TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{item.taxRate}%</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{item.unit}</TableCell>
                  <TableCell className="font-mono text-primary font-bold">{Number(item.productionStock || 0).toLocaleString()}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${active
                      ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                      : 'bg-muted text-muted-foreground border-border'}`}>
                      {active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(item)}><Eye className="w-4 h-4" /></Button>
                      {isHeadOffice && (
                        <>
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(item)}><Edit2 className="w-4 h-4" /></Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => handleDelete(item.id, item.name)}><Trash2 className="w-4 h-4" /></Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditingId(null); form.reset(); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{editingId ? 'Edit Item' : 'Add Item Name (SKU)'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Product Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Frozen Alphonso Mango 250g" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-3 gap-4">
                <FormField control={form.control} name="hsnCode" render={({ field }) => (
                  <FormItem><FormLabel>HSN Code <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="08119000" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="taxRate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tax Rate %</FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={String(field.value ?? 5)}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {[0, 5, 12, 18, 28].map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="unit" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center justify-between">
                      Unit <span className="text-destructive">*</span>
                      <Link href="/production/units" className="text-[10px] text-primary hover:underline flex items-center gap-0.5" onClick={() => setIsOpen(false)}>
                        <Ruler className="w-3 h-3" /> Manage
                      </Link>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select unit" /></SelectTrigger></FormControl>
                      <SelectContent>
                        {units.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
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
