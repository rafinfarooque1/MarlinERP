import { useState } from 'react';
import { useListRawMaterials, useCreateRawMaterial, useUpdateRawMaterial, useDeleteRawMaterial, getListRawMaterialsQueryKey } from '@workspace/api-client-react';
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
import { Plus, Search, Edit2, Trash2, Leaf, Download, Eye, Ruler, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { useUnits } from '@/lib/useUnits';
import { Link } from 'wouter';
import { usePermission } from '@/lib/usePermission';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  unit: z.string().min(1, 'Unit is required'),
  description: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function RawMaterials() {
  const perm = usePermission('Raw Materials');
  const { data: rawMaterials = [], isLoading } = useListRawMaterials();
  const { units } = useUnits();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateRawMaterial();
  const updateMutation = useUpdateRawMaterial();
  const deleteMutation = useDeleteRawMaterial();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', unit: '', description: '' } });

  const openAdd = () => { setEditingId(null); form.reset({ name: '', unit: units[0] || '', description: '' }); setIsOpen(true); };
  const openEdit = (m: any) => { setEditingId(m.id); form.reset({ name: m.name, unit: m.unit, description: m.description || '' }); setIsOpen(true); };

  const onSubmit = (data: FormValues) => {
    const opts = {
      onSuccess: () => {
        toast.success(editingId ? 'Updated' : 'Raw material added');
        queryClient.invalidateQueries({ queryKey: getListRawMaterialsQueryKey() });
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
      onSuccess: () => { toast.success('Deleted'); queryClient.invalidateQueries({ queryKey: getListRawMaterialsQueryKey() }); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  const filtered = rawMaterials.filter(m => m.name.toLowerCase().includes(search.toLowerCase()));
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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Leaf className="w-6 h-6 text-primary" /> Packing Materials</h1>
            <p className="text-muted-foreground mt-1">Fruits & raw ingredients master</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('raw-materials.csv', filtered.map(m => ({ Name: m.name, Unit: m.unit, 'Stock': m.currentStock, Description: m.description || '' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Packing Material</Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search raw materials..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
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
                  <Leaf className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No raw materials found</p>
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

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditingId(null); form.reset(); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{editingId ? 'Edit Packing Material' : 'Add Packing Material'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Alphonso Mangoes" {...field} /></FormControl><FormMessage /></FormItem>
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
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea placeholder="Optional..." rows={2} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={isPending}>{isPending ? 'Saving…' : 'Save'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Leaf className="w-5 h-5 text-primary" /> {viewItem?.name}</SheetTitle>
            <SheetDescription>Raw material details</SheetDescription>
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
