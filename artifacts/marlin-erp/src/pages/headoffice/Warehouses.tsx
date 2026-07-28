import { useState } from 'react';
import { useListWarehouses, useCreateWarehouse, useUpdateWarehouse, useDeleteWarehouse, getListWarehousesQueryKey } from '@workspace/api-client-react';
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
import { Plus, Search, Edit2, Trash2, Warehouse, Download, Eye, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  state: z.string().min(1, 'State required'),
  stateCode: z.string().optional(),
  gstNumber: z.string().optional(),
  address: z.string().optional(),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  upiId: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Warehouses() {
  const perm = usePermission('page:/headoffice/warehouses');
  const { data: warehouses = [], isLoading } = useListWarehouses();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateWarehouse();
  const updateMutation = useUpdateWarehouse();
  const deleteMutation = useDeleteWarehouse();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', state: '', stateCode: '', gstNumber: '', address: '', contactPerson: '', phone: '', upiId: '' } });

  const openAdd = () => { setEditingId(null); form.reset({ name: '', state: '', stateCode: '', gstNumber: '', address: '', contactPerson: '', phone: '', upiId: '' }); setIsOpen(true); };
  const openEdit = (w: any) => { setEditingId(w.id); form.reset({ name: w.name, state: w.state, stateCode: (w as any).stateCode || '', gstNumber: w.gstNumber || '', address: w.address || '', contactPerson: w.contactPerson || '', phone: w.phone || '', upiId: (w as any).upiId || '' }); setIsOpen(true); };

  const onSubmit = (data: FormValues) => {
    const opts = {
      onSuccess: () => { toast.success(editingId ? 'Warehouse updated' : 'Warehouse added'); queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() }); setIsOpen(false); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    };
    if (editingId) updateMutation.mutate({ id: editingId, data: data as any }, opts);
    else createMutation.mutate({ data: data as any }, opts);
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    deleteMutation.mutate({ id }, {
      onSuccess: () => { toast.success('Deleted'); queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() }); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = warehouses.filter(w => w.name.toLowerCase().includes(search.toLowerCase()) || w.state?.toLowerCase().includes(search.toLowerCase()));
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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Warehouse className="w-6 h-6 text-primary" /> Warehouses</h1>
            <p className="text-muted-foreground mt-1">Regional distribution centre management</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('warehouses.csv', filtered.map(w => ({ Name: w.name, State: w.state, GST: w.gstNumber || '', Contact: w.contactPerson || '', Phone: w.phone || '' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            )}
            {perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Warehouse</Button>}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search by name or state..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Name</TableHead>
                <TableHead>State</TableHead>
                <TableHead>GST No.</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Warehouse className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No warehouses found</p>
                </TableCell></TableRow>
              ) : filtered.map(w => (
                <TableRow key={w.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{w.name}</TableCell>
                  <TableCell><Badge variant="outline">{w.state}</Badge></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{w.gstNumber || '—'}</TableCell>
                  <TableCell className="text-sm">{w.contactPerson || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{w.phone || '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(w)}><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(w)}><Edit2 className="w-4 h-4" /></Button>}
                      {perm.canDelete && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => handleDelete(w.id, w.name)}><Trash2 className="w-4 h-4" /></Button>}
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
          <DialogHeader><DialogTitle>{editingId ? 'Edit Warehouse' : 'Add Warehouse'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>Warehouse Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Bengaluru Hub" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="state" render={({ field }) => (
                  <FormItem><FormLabel>State <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="Karnataka" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="stateCode" render={({ field }) => (
                  <FormItem><FormLabel>State Code <span className="text-xs text-muted-foreground font-normal">(2-digit GST code)</span></FormLabel><FormControl><Input placeholder="29" maxLength={2} className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="gstNumber" render={({ field }) => (
                  <FormItem className="col-span-2"><FormLabel>GST Number</FormLabel><FormControl><Input placeholder="29AAAAA0000A1ZZ" className="font-mono uppercase" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="contactPerson" render={({ field }) => (
                  <FormItem><FormLabel>Contact Person</FormLabel><FormControl><Input placeholder="Name" {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone</FormLabel><FormControl><Input placeholder="+91 ..." {...field} /></FormControl></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="address" render={({ field }) => (
                <FormItem><FormLabel>Address</FormLabel><FormControl><Textarea placeholder="Full address..." rows={2} {...field} /></FormControl></FormItem>
              )} />
              <FormField control={form.control} name="upiId" render={({ field }) => (
                <FormItem><FormLabel>UPI ID <span className="text-xs text-muted-foreground font-normal">(for invoice QR payment)</span></FormLabel><FormControl><Input placeholder="e.g. warehouse@bank" className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
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
            <SheetTitle className="flex items-center gap-2"><Warehouse className="w-5 h-5 text-primary" />{viewItem?.name}</SheetTitle>
            <SheetDescription>{viewItem?.state}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['State', viewItem.state], ['State Code', (viewItem as any).stateCode || '—'], ['GST Number', viewItem.gstNumber || '—'], ['UPI ID', (viewItem as any).upiId || '—'], ['Contact Person', viewItem.contactPerson || '—'], ['Phone', viewItem.phone || '—'], ['Address', viewItem.address || '—']].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
              {perm.canEdit && <Button className="w-full" onClick={() => { setViewItem(null); openEdit(viewItem); }}><Edit2 className="w-4 h-4 mr-2" /> Edit</Button>}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
