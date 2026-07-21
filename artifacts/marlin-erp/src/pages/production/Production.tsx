import { useState } from 'react';
import {
  useListProductions, useCreateProduction, useListItems, useListRawMaterials,
  useListMaterials, getListProductionsQueryKey,
  useUpdateProduction, useDeleteProduction,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Factory, Download, Eye, Calendar, Trash2, Edit2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { Label } from '@/components/ui/label';

const schema = z.object({
  itemId: z.coerce.number().min(1, 'Item required'),
  producedQuantity: z.coerce.number().min(1, 'Quantity > 0'),
  productionDate: z.string().min(1, 'Date required'),
  materialUsed: z.array(z.object({
    materialType: z.enum(['material', 'raw_material']),
    materialId: z.coerce.number().min(1, 'Select material'),
    usedQuantity: z.coerce.number().min(0.01, 'Qty > 0'),
  })).min(1, 'Add at least one material'),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const editSchema = z.object({
  productionDate: z.string().min(1, 'Date required'),
  notes: z.string().optional(),
});
type EditFormValues = z.infer<typeof editSchema>;

const defaultLine = { materialType: 'raw_material' as const, materialId: 0, usedQuantity: 1 };
const defaultValues: FormValues = {
  itemId: 0,
  producedQuantity: 1,
  productionDate: new Date().toISOString().split('T')[0],
  materialUsed: [defaultLine],
  notes: '',
};

export default function ProductionList() {
  const perm = usePermission('Production');
  const { data: productions = [], isLoading } = useListProductions();
  const { data: items = [] } = useListItems();
  const { data: rawMaterials = [] } = useListRawMaterials();
  const { data: materials = [] } = useListMaterials();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateProduction();
  const updateMutation = useUpdateProduction();
  const deleteMutation = useDeleteProduction();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues });
  const { fields, append, remove, replace } = useFieldArray({ control: form.control, name: 'materialUsed' });

  const editForm = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { productionDate: '', notes: '' },
  });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data: data as any }, {
      onSuccess: () => {
        toast.success('Production batch recorded');
        queryClient.invalidateQueries({ queryKey: getListProductionsQueryKey() });
        setIsOpen(false);
        form.reset(defaultValues);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const onEditSubmit = (data: EditFormValues) => {
    updateMutation.mutate({ id: editItem.id, data }, {
      onSuccess: () => {
        toast.success('Batch updated');
        setEditItem(null);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success(`Batch B-${String(deleteTarget.id).padStart(4, '0')} deleted`);
        setDeleteTarget(null);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  const filtered = productions.filter(p => p.itemName?.toLowerCase().includes(search.toLowerCase()));
  const matName = (type: string, id: number) => {
    const list = type === 'raw_material' ? rawMaterials : materials;
    return (list as any[]).find(m => m.id === id)?.name ?? `#${id}`;
  };

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Production.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Factory className="w-6 h-6 text-primary" /> Production Batches
            </h1>
            <p className="text-muted-foreground mt-1">Record finished goods production runs</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('production.csv', filtered.map(p => ({
                Batch: `B-${String(p.id).padStart(4, '0')}`, Date: p.productionDate, Item: p.itemName, Qty: p.producedQuantity, Materials: p.materialUsed?.length || 0,
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { form.reset(defaultValues); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Batch
              </Button>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search by item..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Batch</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Qty Produced</TableHead>
                <TableHead>Materials Used</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Factory className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No production batches yet</p>
                </TableCell></TableRow>
              ) : filtered.map(p => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold">B-{String(p.id).padStart(4, '0')}</TableCell>
                  <TableCell className="text-sm text-muted-foreground flex items-center gap-1">
                    <Calendar className="w-3 h-3" />{new Date(p.productionDate).toLocaleDateString('en-IN')}
                  </TableCell>
                  <TableCell className="font-medium">{p.itemName}</TableCell>
                  <TableCell className="font-mono font-bold text-emerald-500">{Number(p.producedQuantity).toLocaleString()}</TableCell>
                  <TableCell><Badge variant="secondary">{p.materialUsed?.length || 0} materials</Badge></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="Edit" onClick={() => {
                          setEditItem(p);
                          editForm.reset({ productionDate: p.productionDate, notes: p.notes || '' });
                        }}><Edit2 className="w-4 h-4" /></Button>
                      )}
                      {perm.canDelete && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" title="Delete" onClick={() => setDeleteTarget(p)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Create Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Record Production Batch</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="itemId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Finished Item <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                      <SelectContent>{items.map(i => <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="producedQuantity" render={({ field }) => (
                  <FormItem><FormLabel>Quantity Produced <span className="text-destructive">*</span></FormLabel><FormControl><Input type="number" min={1} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="productionDate" render={({ field }) => (
                  <FormItem><FormLabel>Production Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>

              <div>
                <div className="flex justify-between items-center mb-3">
                  <p className="font-semibold text-sm">Materials Consumed</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => append(defaultLine)}><Plus className="w-3 h-3 mr-1" /> Add</Button>
                </div>
                <div className="space-y-2">
                  {fields.map((field, i) => {
                    const matType = form.watch(`materialUsed.${i}.materialType`);
                    const opts = matType === 'raw_material' ? rawMaterials : materials;
                    return (
                      <div key={field.id} className="grid grid-cols-11 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                        <div className="col-span-3">
                          <FormField control={form.control} name={`materialUsed.${i}.materialType`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Type</FormLabel>
                              <Select onValueChange={f.onChange} value={f.value}>
                                <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
                                <SelectContent><SelectItem value="raw_material">Raw Material</SelectItem><SelectItem value="material">Packaging</SelectItem></SelectContent>
                              </Select></FormItem>
                          )} />
                        </div>
                        <div className="col-span-5">
                          <FormField control={form.control} name={`materialUsed.${i}.materialId`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Material</FormLabel>
                              <Select onValueChange={v => f.onChange(Number(v))} value={f.value ? String(f.value) : ''}>
                                <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                                <SelectContent>{(opts as any[]).map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent>
                              </Select></FormItem>
                          )} />
                        </div>
                        <div className="col-span-2">
                          <FormField control={form.control} name={`materialUsed.${i}.usedQuantity`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Qty</FormLabel><FormControl><Input type="number" step="0.01" className="h-8 text-xs" {...f} /></FormControl></FormItem>
                          )} />
                        </div>
                        <div className="col-span-1 pb-1 flex justify-end">
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(i)} disabled={fields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea placeholder="Optional batch notes..." rows={2} {...field} /></FormControl></FormItem>
              )} />

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? 'Recording…' : 'Record Batch'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editItem} onOpenChange={v => !v && setEditItem(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Batch B-{editItem && String(editItem.id).padStart(4, '0')}</DialogTitle>
            <DialogDescription>Update the production date or notes. Line items cannot be changed.</DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4 pt-2">
              <FormField control={editForm.control} name="productionDate" render={({ field }) => (
                <FormItem><FormLabel>Production Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={editForm.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea placeholder="Optional notes..." rows={3} {...field} /></FormControl></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setEditItem(null)}>Cancel</Button>
                <Button type="submit" disabled={updateMutation.isPending}>{updateMutation.isPending ? 'Saving…' : 'Save Changes'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" /> Delete Batch
            </DialogTitle>
            <DialogDescription>
              Delete B-{deleteTarget && String(deleteTarget.id).padStart(4, '0')} ({deleteTarget?.itemName}, {deleteTarget?.producedQuantity} units)?
              <br /><span className="text-destructive font-medium">All material stock will be reversed. This cannot be undone.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting…' : 'Delete & Reverse Stock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>B-{viewItem && String(viewItem.id).padStart(4, '0')}</SheetTitle>
            <SheetDescription>Production batch details</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                {[['Item', viewItem.itemName], ['Date', new Date(viewItem.productionDate).toLocaleDateString('en-IN')], ['Qty Produced', viewItem.producedQuantity]].map(([k, v]) => (
                  <div key={String(k)} className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                    <span className="font-semibold">{String(v)}</span>
                  </div>
                ))}
              </div>
              <div>
                <p className="text-sm font-semibold mb-2">Materials Consumed</p>
                <div className="space-y-2">
                  {(viewItem.materialUsed || []).map((m: any, i: number) => (
                    <div key={i} className="flex justify-between items-center p-3 bg-muted/20 rounded-lg text-sm">
                      <div>
                        <Badge variant="secondary" className="text-xs mr-2">{m.materialType === 'raw_material' ? 'Raw' : 'Pkg'}</Badge>
                        {matName(m.materialType, m.materialId)}
                      </div>
                      <span className="font-bold">{m.usedQuantity} units</span>
                    </div>
                  ))}
                </div>
              </div>
              {viewItem.notes && <div><span className="text-xs text-muted-foreground">Notes</span><p className="mt-1">{viewItem.notes}</p></div>}
              {perm.canEdit && (
                <Button className="w-full" variant="outline" onClick={() => { setViewItem(null); setEditItem(viewItem); editForm.reset({ productionDate: viewItem.productionDate, notes: viewItem.notes || '' }); }}>
                  <Edit2 className="w-4 h-4 mr-2" /> Edit Batch
                </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
