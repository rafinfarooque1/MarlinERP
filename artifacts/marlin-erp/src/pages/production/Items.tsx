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
import { Plus, Search, Edit2, Trash2, Package, Download, Eye, Ruler, ShieldOff, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { useUnits } from '@/lib/useUnits';
import { Link } from 'wouter';
import { usePermission } from '@/lib/usePermission';
import { useIsHeadOffice, HEAD_OFFICE_ONLY_HINT, isActiveProduct } from '@/lib/productStatus';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  hsnCode: z.string().min(1, 'HSN code required'),
  taxRate: z.coerce.number().min(0).max(28),
  unit: z.string().min(1, 'Unit required'),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Items() {
  const perm = usePermission('page:/production/item-master');
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
  const { sorted, sort } = useTableSort(filtered, {
    code: (i: any) => i.itemCode,
    name: i => i.name,
    hsn: i => i.hsnCode,
    tax: i => Number(i.taxRate),
    unit: i => i.unit,
    stock: i => Number(i.productionStock || 0),
    status: i => isActiveProduct(i) ? 'Active' : 'Inactive',
  });
  const { pageRows, pagerProps } = useClientPage(sorted);
  const activeCount = items.filter(i => isActiveProduct(i)).length;
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
        <PageHeader
          title="Item Master"
          description={isHeadOffice ? 'Finished goods / SKU catalogue' : HEAD_OFFICE_ONLY_HINT}
          icon={Package}
          actions={
            <>
              {perm.canDownload && (
                <Button variant="outline" size="sm" onClick={() => downloadCSV('items.csv', filtered.map(i => ({ Code: (i as any).itemCode || '', Barcode: (i as any).barcode || '', Name: i.name, HSN: i.hsnCode, 'Tax%': i.taxRate, Unit: i.unit, 'Production Stock': i.productionStock, Status: isActiveProduct(i) ? 'Active' : 'Inactive' })))}>
                  <Download className="w-4 h-4 mr-2" /> Export
                </Button>
              )}
              {isHeadOffice && perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Item</Button>}
            </>
          }
        />

        <SummaryCardGrid>
          <SummaryCard label="Total Items" value={items.length.toLocaleString('en-IN')} icon={Package} loading={isLoading} />
          <SummaryCard label="Active" value={activeCount.toLocaleString('en-IN')} icon={CheckCircle2} tone="positive" loading={isLoading} />
          <SummaryCard label="Inactive" value={(items.length - activeCount).toLocaleString('en-IN')} icon={ShieldOff} tone="warning" loading={isLoading} />
        </SummaryCardGrid>

        <div className="flex items-center gap-2 max-w-xs max-md:max-w-full">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input placeholder="Search by name or HSN..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={8} cols={8} />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="code" sort={sort}>Code</SortableHead>
                <SortableHead k="name" sort={sort}>Name</SortableHead>
                <SortableHead k="hsn" sort={sort}>HSN Code</SortableHead>
                <SortableHead k="tax" sort={sort}>Tax Rate</SortableHead>
                <SortableHead k="unit" sort={sort}>Unit</SortableHead>
                <SortableHead k="stock" sort={sort}>Production Stock</SortableHead>
                <SortableHead k="status" sort={sort}>Status</SortableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="p-0">
                  <EmptyState icon={Package} title="No items found" hint="Finished goods and SKUs will appear here." compact />
                </TableCell></TableRow>
              ) : pageRows.map(item => {
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
                    <StatusBadge status={active ? 'active' : 'inactive'} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="View" onClick={() => setViewItem(item)}><Eye className="w-4 h-4" /></Button>
                      {isHeadOffice && perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="Edit" onClick={() => openEdit(item)}><Edit2 className="w-4 h-4" /></Button>
                      )}
                      {isHeadOffice && perm.canDelete && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" title="Delete" onClick={() => handleDelete(item.id, item.name)}><Trash2 className="w-4 h-4" /></Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
          )}
        </div>
        {!isLoading && filtered.length > 0 && <TablePager {...pagerProps} />}
      </div>

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditingId(null); form.reset(); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{editingId ? 'Edit Item' : 'Add Item Name (SKU)'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Product Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Frozen Alphonso Mango 250g" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
              {isHeadOffice && perm.canEdit && (
                <Button className="w-full mt-2" onClick={() => { setViewItem(null); openEdit(viewItem); }}><Edit2 className="w-4 h-4 mr-2" /> Edit</Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
