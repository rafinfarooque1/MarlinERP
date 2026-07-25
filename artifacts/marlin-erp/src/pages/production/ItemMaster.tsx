import { useState } from 'react';
import {
  useListMaterials, useCreateMaterial, useUpdateMaterial, useDeleteMaterial, getListMaterialsQueryKey,
  useListRawMaterials, useCreateRawMaterial, useUpdateRawMaterial, useDeleteRawMaterial, getListRawMaterialsQueryKey,
  useListItems, useCreateItem, useUpdateItem, useDeleteItem, getListItemsQueryKey,
} from '@workspace/api-client-react';
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
import { Plus, Search, Edit2, Trash2, Layers, Download, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { useUnits } from '@/lib/useUnits';

type ItemType = 'raw_material' | 'material' | 'item';

const TYPE_LABELS: Record<ItemType, string> = {
  raw_material: 'Raw Material',
  material: 'Material',
  item: 'Finished Item',
};

const TYPE_COLORS: Record<ItemType, string> = {
  raw_material: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  material: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  item: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
};

const schema = z.object({
  itemType:    z.enum(['raw_material', 'material', 'item']),
  name:        z.string().min(1, 'Name required'),
  unit:        z.string().min(1, 'Unit required'),
  hsnCode:     z.string().optional(),
  taxRate:     z.coerce.number().min(0).max(28).optional(),
  mrp:         z.coerce.number().min(0).optional(),
  cost:        z.coerce.number().min(0).optional(),
  reorderLevel: z.coerce.number().min(0).optional(),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function ItemMaster() {
  const { data: rawMaterials = [], isLoading: rmLoading } = useListRawMaterials();
  const { data: materials = [], isLoading: mLoading } = useListMaterials();
  const { data: items = [], isLoading: iLoading } = useListItems();
  const { units } = useUnits();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [isOpen, setIsOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{ id: number; type: ItemType } | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string; type: ItemType } | null>(null);

  const createRM = useCreateRawMaterial(); const updateRM = useUpdateRawMaterial(); const deleteRM = useDeleteRawMaterial();
  const createM = useCreateMaterial(); const updateM = useUpdateMaterial(); const deleteM = useDeleteMaterial();
  const createI = useCreateItem(); const updateI = useUpdateItem(); const deleteI = useDeleteItem();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { itemType: 'raw_material', name: '', unit: '', hsnCode: '', taxRate: 5, mrp: 0, cost: 0, reorderLevel: 10, description: '' },
  });

  const watchType = form.watch('itemType');

  // Combine all into one unified list
  const allItems = [
    ...(rawMaterials as any[]).map(r => ({ ...r, _type: 'raw_material' as ItemType, stock: Number(r.currentStock || 0) })),
    ...(materials as any[]).map(m => ({ ...m, _type: 'material' as ItemType, stock: Number(m.currentStock || 0) })),
    ...(items as any[]).map(i => ({ ...i, _type: 'item' as ItemType, stock: Number(i.productionStock || 0) })),
  ];

  const filtered = allItems.filter(i =>
    (typeFilter === 'all' || i._type === typeFilter) &&
    (i.name.toLowerCase().includes(search.toLowerCase()) || (i.hsnCode || '').includes(search))
  );

  const isLoading = rmLoading || mLoading || iLoading;

  const openAdd = (type?: ItemType) => {
    setEditTarget(null);
    form.reset({ itemType: type || 'raw_material', name: '', unit: units[0] || '', hsnCode: '', taxRate: 5, mrp: 0, cost: 0, reorderLevel: 10, description: '' });
    setIsOpen(true);
  };

  const openEdit = (item: any) => {
    setEditTarget({ id: item.id, type: item._type });
    form.reset({
      itemType: item._type,
      name: item.name,
      unit: item.unit,
      hsnCode: item.hsnCode || '',
      taxRate: Number(item.taxRate ?? 5),
      mrp: Number(item.mrp ?? 0),
      cost: Number(item.cost ?? 0),
      reorderLevel: Number(item.reorderLevel ?? 10),
      description: item.description || '',
    });
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    const type = data.itemType;
    const key = type === 'raw_material' ? getListRawMaterialsQueryKey() : type === 'material' ? getListMaterialsQueryKey() : getListItemsQueryKey();
    const opts = {
      onSuccess: () => {
        toast.success(editTarget ? 'Item updated' : 'Item created');
        queryClient.invalidateQueries({ queryKey: key });
        setIsOpen(false);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    };
    const sharedData = { name: data.name, unit: data.unit, description: data.description, hsnCode: data.hsnCode || '', taxRate: Number(data.taxRate ?? 5), cost: Number(data.cost ?? 0) };
    const itemData = { ...sharedData, mrp: Number(data.mrp ?? 0), reorderLevel: Number(data.reorderLevel ?? 10) };

    if (editTarget) {
      if (type === 'raw_material') updateRM.mutate({ id: editTarget.id, data: sharedData as any }, opts);
      else if (type === 'material') updateM.mutate({ id: editTarget.id, data: sharedData as any }, opts);
      else updateI.mutate({ id: editTarget.id, data: itemData as any }, opts);
    } else {
      if (type === 'raw_material') createRM.mutate({ data: sharedData as any }, opts);
      else if (type === 'material') createM.mutate({ data: sharedData as any }, opts);
      else createI.mutate({ data: itemData as any }, opts);
    }
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    const { id, type } = deleteTarget;
    const key = type === 'raw_material' ? getListRawMaterialsQueryKey() : type === 'material' ? getListMaterialsQueryKey() : getListItemsQueryKey();
    const opts = {
      onSuccess: () => { toast.success('Deleted'); queryClient.invalidateQueries({ queryKey: key }); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    };
    if (type === 'raw_material') deleteRM.mutate({ id } as any, opts);
    else if (type === 'material') deleteM.mutate({ id } as any, opts);
    else deleteI.mutate({ id } as any, opts);
  };

  const isPending = createRM.isPending || updateRM.isPending || createM.isPending || updateM.isPending || createI.isPending || updateI.isPending;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Layers className="w-6 h-6 text-primary" /> Item Master</h1>
            <p className="text-muted-foreground mt-1">All raw materials, materials and finished items in one place</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('items.csv', filtered.map(i => ({
              Type: (TYPE_LABELS as any)[i._type] ?? i._type, Name: i.name, Unit: i.unit,
              HSN: (i as any).hsnCode || '', 'Tax%': (i as any).taxRate || '',
              Stock: i.stock, Description: i.description || '',
            })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={() => openAdd()}><Plus className="w-4 h-4 mr-2" /> Add Item</Button>
          </div>
        </div>

        {/* Summary badges */}
        <div className="grid grid-cols-3 gap-4">
          {(['raw_material', 'material', 'item'] as ItemType[]).map(t => {
            const count = allItems.filter(i => i._type === t).length;
            return (
              <button key={t} onClick={() => setTypeFilter(typeFilter === t ? 'all' : t)}
                className={`bg-card border rounded-xl p-4 text-left transition-all ${typeFilter === t ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/40'}`}>
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{TYPE_LABELS[t]}</p>
                <p className="text-2xl font-bold font-mono mt-1">{count}</p>
              </button>
            );
          })}
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[160px]">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input placeholder="Search name or HSN..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-40"><SelectValue placeholder="All Types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="raw_material">Raw Material</SelectItem>
                <SelectItem value="material">Material</SelectItem>
                <SelectItem value="item">Finished Item</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>HSN</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead className="text-right">Cost (₹)</TableHead>
                <TableHead className="text-right">MRP (₹)</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center py-16 text-muted-foreground">
                  <Layers className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No items found</p>
                </TableCell></TableRow>
              ) : filtered.map(item => (
                <TableRow key={`${item._type}-${item.id}`} className="hover:bg-muted/10">
                  <TableCell>
                    <Badge variant="outline" className={`text-xs capitalize ${(TYPE_COLORS as any)[item._type] ?? ''}`}>
                      {item._type === 'raw_material' ? 'Raw' : item._type === 'material' ? 'Material' : 'Item'}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{item.unit}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{(item as any).hsnCode || '—'}</TableCell>
                  <TableCell className="text-sm">{(item as any).taxRate ? `${Number((item as any).taxRate)}%` : '—'}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {Number((item as any).cost) > 0 ? `₹${Number((item as any).cost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {item._type === 'item' && Number((item as any).mrp) > 0
                      ? `₹${Number((item as any).mrp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold">{Number(item.stock).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(item)}><Eye className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(item)}><Edit2 className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget({ id: item.id, name: item.name, type: item._type })}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditTarget(null); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editTarget ? 'Edit Item' : 'Add New Item'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="itemType" render={({ field }) => (
                <FormItem>
                  <FormLabel>Item Type <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={v => { field.onChange(v); }} value={field.value} disabled={!!editTarget}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="raw_material">Raw Material</SelectItem>
                      <SelectItem value="material">Material (Semi-processed)</SelectItem>
                      <SelectItem value="item">Finished Item (SKU)</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Name <span className="text-destructive">*</span></FormLabel>
                    <FormControl><Input placeholder="Item name" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="unit" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Unit <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select unit" /></SelectTrigger></FormControl>
                      <SelectContent>{units.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="hsnCode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>HSN Code</FormLabel>
                    <FormControl><Input className="font-mono" placeholder="e.g. 09011111" {...field} /></FormControl>
                  </FormItem>
                )} />
                <FormField control={form.control} name="taxRate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>GST Rate %</FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={String(field.value ?? 5)}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {[0, 5, 12, 18, 28].map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )} />
                {/* Cost field — all item types */}
                <FormField control={form.control} name="cost" render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Cost / Rate (₹)
                      {watchType !== 'item' && <span className="ml-1 text-[10px] font-normal text-muted-foreground">(default; updates from purchases)</span>}
                    </FormLabel>
                    <FormControl><Input type="number" min={0} step="0.01" placeholder="0.00" className="font-mono" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                {/* MRP — finished items only */}
                {watchType === 'item' && (
                  <FormField control={form.control} name="mrp" render={({ field }) => (
                    <FormItem>
                      <FormLabel>MRP — Sale Price (₹) <span className="text-[10px] font-normal text-amber-500">auto-fills in sales</span></FormLabel>
                      <FormControl><Input type="number" min={0} step="0.01" placeholder="0.00" className="font-mono" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                {/* Reorder level — finished items only */}
                {watchType === 'item' && (
                  <FormField control={form.control} name="reorderLevel" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reorder Level <span className="text-[10px] font-normal text-muted-foreground">low-stock alert threshold</span></FormLabel>
                      <FormControl><Input type="number" min={0} step="1" placeholder="10" className="font-mono" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}
              </div>
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={isPending}>{isPending ? 'Saving…' : editTarget ? 'Save Changes' : 'Add Item'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          {viewItem && (
            <>
              <SheetHeader className="mb-4">
                <SheetTitle>{viewItem.name}</SheetTitle>
                <SheetDescription>
                  <Badge variant="outline" className={`text-xs ${(TYPE_COLORS as any)[viewItem._type] ?? ''}`}>{(TYPE_LABELS as any)[viewItem._type] ?? viewItem._type}</Badge>
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">Unit</span><span>{viewItem.unit}</span></div>
                {viewItem.hsnCode && <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">HSN Code</span><span className="font-mono">{viewItem.hsnCode}</span></div>}
                {viewItem.taxRate !== undefined && <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">GST Rate</span><span>{Number(viewItem.taxRate)}%</span></div>}
                <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">Current Stock</span><span className="font-mono font-bold">{Number(viewItem.stock).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</span></div>
                {Number(viewItem.cost) > 0 && (
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">Cost / Rate</span>
                    <span className="font-mono font-bold">₹{Number(viewItem.cost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                {viewItem._type === 'item' && Number(viewItem.avgCost) > 0 && (
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">Avg Cost (weighted)</span>
                    <span className="font-mono font-bold">₹{Number(viewItem.avgCost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                {viewItem._type === 'item' && (
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">Reorder Level</span>
                    <span className="font-mono">{Number(viewItem.reorderLevel ?? 10)}</span>
                  </div>
                )}
                {viewItem._type === 'item' && (
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">MRP (Sale Price)</span>
                    <span className={`font-mono font-bold ${Number(viewItem.mrp) > 0 ? 'text-primary' : 'text-muted-foreground'}`}>
                      {Number(viewItem.mrp) > 0 ? `₹${Number(viewItem.mrp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : 'Not set'}
                    </span>
                  </div>
                )}
                {viewItem.description && <div className="py-2"><p className="text-muted-foreground mb-1">Description</p><p>{viewItem.description}</p></div>}
              </div>
              <div className="flex gap-2 mt-6">
                <Button className="flex-1" variant="outline" onClick={() => { setViewItem(null); openEdit(viewItem); }}>
                  <Edit2 className="w-4 h-4 mr-2" /> Edit
                </Button>
                <Button className="flex-1" variant="destructive" onClick={() => { setViewItem(null); setDeleteTarget({ id: viewItem.id, name: viewItem.name, type: viewItem._type }); }}>
                  <Trash2 className="w-4 h-4 mr-2" /> Delete
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Item</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">Delete <Badge variant="outline" className={`text-xs mr-1 ${deleteTarget ? ((TYPE_COLORS as any)[deleteTarget.type] ?? '') : ''}`}>{deleteTarget ? ((TYPE_LABELS as any)[deleteTarget.type] ?? deleteTarget.type) : ''}</Badge>
            <span className="font-semibold text-foreground">{deleteTarget?.name}</span>? This cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}
              disabled={deleteRM.isPending || deleteM.isPending || deleteI.isPending}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
