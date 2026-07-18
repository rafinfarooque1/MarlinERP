import { useState } from 'react';
import { useListMaterials, useCreateMaterial, useUpdateMaterial, useDeleteMaterial, getListMaterialsQueryKey } from '@workspace/api-client-react';
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
import { Plus, Search, Edit2, Trash2, Box, Download, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  unit: z.string().min(1, 'Unit is required'),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Materials() {
  const { data: materials = [], isLoading } = useListMaterials();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateMaterial();
  const updateMutation = useUpdateMaterial();
  const deleteMutation = useDeleteMaterial();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', unit: '', description: '' } });

  const openAdd = () => { setEditingId(null); form.reset({ name: '', unit: '', description: '' }); setIsOpen(true); };
  const openEdit = (m: any) => { setEditingId(m.id); form.reset({ name: m.name, unit: m.unit, description: m.description || '' }); setIsOpen(true); };

  const onSubmit = (data: FormValues) => {
    const opts = {
      onSuccess: () => {
        toast.success(editingId ? 'Material updated' : 'Material added');
        queryClient.invalidateQueries({ queryKey: getListMaterialsQueryKey() });
        setIsOpen(false);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    };
    if (editingId) updateMutation.mutate({ id: editingId, data }, opts);
    else createMutation.mutate({ data }, opts);
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    deleteMutation.mutate({ id }, {
      onSuccess: () => { toast.success('Deleted'); queryClient.invalidateQueries({ queryKey: getListMaterialsQueryKey() }); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  const filtered = materials.filter(m => m.name.toLowerCase().includes(search.toLowerCase()));
  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Box className="w-6 h-6 text-primary" /> Materials</h1>
            <p className="text-muted-foreground mt-1">Packaging & production material master</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('materials.csv', filtered.map(m => ({ Name: m.name, Unit: m.unit, 'Current Stock': m.currentStock, Description: m.description || '' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Material</Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search materials..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>#</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Box className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No materials found</p>
                </TableCell></TableRow>
              ) : filtered.map((m, i) => (
                <TableRow key={m.id} className="hover:bg-muted/10">
                  <TableCell className="text-muted-foreground text-xs">{i + 1}</TableCell>
                  <TableCell className="font-semibold">{m.name}</TableCell>
                  <TableCell><Badge variant="outline" className="font-mono text-xs">{m.unit}</Badge></TableCell>
                  <TableCell className="font-mono text-primary font-bold">{Number(m.currentStock || 0).toLocaleString()}</TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">{m.description || '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(m)}><Eye className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(m)}><Edit2 className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => handleDelete(m.id, m.name)}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditingId(null); form.reset(); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{editingId ? 'Edit Material' : 'Add Material'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. PP Pouches 250g" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="unit" render={({ field }) => (
                <FormItem><FormLabel>Unit <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. pcs, kg, rolls" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea placeholder="Optional notes..." rows={2} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={isPending}>{isPending ? 'Saving…' : 'Save'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* View Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Box className="w-5 h-5 text-primary" /> {viewItem?.name}</SheetTitle>
            <SheetDescription>Material details</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['Unit', viewItem.unit], ['Current Stock', `${Number(viewItem.currentStock || 0).toLocaleString()} ${viewItem.unit}`], ['Description', viewItem.description || '—']].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
              <div className="flex gap-2 pt-2">
                <Button className="flex-1" onClick={() => { setViewItem(null); openEdit(viewItem); }}><Edit2 className="w-4 h-4 mr-2" /> Edit</Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
