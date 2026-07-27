import { useState } from 'react';
import { useListOutlets, useCreateOutlet, useUpdateOutlet, useDeleteOutlet, useListWarehouses, getListOutletsQueryKey } from '@workspace/api-client-react';
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
import { Plus, Search, Edit2, Trash2, Store, Download, Eye, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  warehouseId: z.coerce.number().min(1, 'Warehouse required'),
  gstin: z.string().optional(),
  state: z.string().optional(),
  stateCode: z.string().optional(),
  address: z.string().optional(),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  upiId: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Outlets() {
  const perm = usePermission('Outlets');
  const { data: outlets = [], isLoading } = useListOutlets();
  const { data: warehouses = [] } = useListWarehouses();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateOutlet();
  const updateMutation = useUpdateOutlet();
  const deleteMutation = useDeleteOutlet();

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', warehouseId: 0, gstin: '', state: '', stateCode: '', address: '', contactPerson: '', phone: '', upiId: '' } });

  const openAdd = () => { setEditingId(null); form.reset({ name: '', warehouseId: 0, gstin: '', state: '', stateCode: '', address: '', contactPerson: '', phone: '', upiId: '' }); setIsOpen(true); };
  const openEdit = (o: any) => { setEditingId(o.id); form.reset({ name: o.name, warehouseId: o.warehouseId, gstin: (o as any).gstin || '', state: (o as any).state || '', stateCode: (o as any).stateCode || '', address: o.address || '', contactPerson: o.contactPerson || '', phone: o.phone || '', upiId: (o as any).upiId || '' }); setIsOpen(true); };

  const onSubmit = (data: FormValues) => {
    const opts = {
      onSuccess: () => { toast.success(editingId ? 'Outlet updated' : 'Outlet added'); queryClient.invalidateQueries({ queryKey: getListOutletsQueryKey() }); setIsOpen(false); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    };
    if (editingId) updateMutation.mutate({ id: editingId, data }, opts);
    else createMutation.mutate({ data }, opts);
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete outlet "${name}"?`)) return;
    deleteMutation.mutate({ id }, {
      onSuccess: () => { toast.success('Outlet deleted'); queryClient.invalidateQueries({ queryKey: getListOutletsQueryKey() }); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = outlets.filter(o => o.name.toLowerCase().includes(search.toLowerCase()) || o.warehouseName?.toLowerCase().includes(search.toLowerCase()));
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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Store className="w-6 h-6 text-primary" /> Retail Outlets</h1>
            <p className="text-muted-foreground mt-1">Point-of-sale locations management</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('outlets.csv', filtered.map(o => ({ Name: o.name, Warehouse: o.warehouseName || '', Contact: o.contactPerson || '', Phone: o.phone || '', Address: o.address || '' })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Outlet</Button>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search outlets..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Name</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                  <Store className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No outlets found</p>
                </TableCell></TableRow>
              ) : filtered.map(o => (
                <TableRow key={o.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{o.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{o.warehouseName}</TableCell>
                  <TableCell className="text-sm">{o.contactPerson || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{o.phone || '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(o)}><Eye className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(o)}><Edit2 className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => handleDelete(o.id, o.name)}><Trash2 className="w-4 h-4" /></Button>
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
          <DialogHeader><DialogTitle>{editingId ? 'Edit Outlet' : 'Add Outlet'}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Outlet Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="e.g. Indiranagar Store" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="warehouseId" render={({ field }) => (
                <FormItem><FormLabel>Parent Warehouse <span className="text-destructive">*</span></FormLabel>
                  <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger></FormControl>
                    <SelectContent>{warehouses.map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
                  </Select><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="state" render={({ field }) => (
                  <FormItem><FormLabel>State</FormLabel><FormControl><Input placeholder="Karnataka" {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="stateCode" render={({ field }) => (
                  <FormItem><FormLabel>State Code</FormLabel><FormControl><Input placeholder="29" maxLength={2} className="font-mono" {...field} /></FormControl></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="gstin" render={({ field }) => (
                <FormItem><FormLabel>GSTIN <span className="text-xs text-muted-foreground font-normal">(required for taxable branch transfers)</span></FormLabel><FormControl><Input placeholder="29AAAAA0000A1ZZ" className="font-mono uppercase" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="contactPerson" render={({ field }) => (
                  <FormItem><FormLabel>Contact Person</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="address" render={({ field }) => (
                <FormItem><FormLabel>Address</FormLabel><FormControl><Textarea placeholder="Full address..." rows={2} {...field} /></FormControl></FormItem>
              )} />
              <FormField control={form.control} name="upiId" render={({ field }) => (
                <FormItem><FormLabel>UPI ID <span className="text-xs text-muted-foreground font-normal">(for invoice QR payment)</span></FormLabel><FormControl><Input placeholder="e.g. outlet@bank" className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
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
            <SheetTitle className="flex items-center gap-2"><Store className="w-5 h-5 text-primary" />{viewItem?.name}</SheetTitle>
            <SheetDescription>{viewItem?.warehouseName}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['Parent Warehouse', viewItem.warehouseName], ['GSTIN', (viewItem as any).gstin || '—'], ['State', (viewItem as any).state || '—'], ['State Code', (viewItem as any).stateCode || '—'], ['UPI ID', (viewItem as any).upiId || '—'], ['Contact', viewItem.contactPerson || '—'], ['Phone', viewItem.phone || '—'], ['Address', viewItem.address || '—']].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{v}</span>
                </div>
              ))}
              <Button className="w-full" onClick={() => { setViewItem(null); openEdit(viewItem); }}><Edit2 className="w-4 h-4 mr-2" /> Edit</Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
