import { useRef, useState } from 'react';
import { useListOutlets, useCreateOutlet, useUpdateOutlet, useDeleteOutlet, useListWarehouses, getListOutletsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useForm } from 'react-hook-form';
import { StateCombobox } from '@/components/ui/state-combobox';
import { EntityCombobox } from '@/components/ui/entity-combobox';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Edit2, Trash2, Store, Download, Eye, ShieldOff, Upload, X, Image as ImageIcon, Loader2 } from 'lucide-react';
import { normaliseLogo, readFileAsDataUrl } from '@/lib/logoUpload';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { useOutletsEnabled, OUTLETS_LEGACY_NOTE } from '@/lib/useFeatureFlags';
import { Archive } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';

const schema = z.object({
  name: z.string().min(1, 'Name required'),
  warehouseId: z.coerce.number().min(1, 'Warehouse required'),
  gstin: z.string().optional(),
  state: z.string().optional(),
  stateCode: z.string().optional(),
  address: z.string().optional(),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email('Enter a valid email').optional().or(z.literal('')),
  fssaiNumber: z.string().optional(),
  upiId: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Outlets() {
  const perm = usePermission('page:/headoffice/outlets');
  // Outlets were folded into warehouses. While the module is off this page is a
  // historical archive: fully readable and exportable, but every write is
  // withdrawn (the backend refuses them too, so this is convenience not
  // security).
  const { outletsEnabled } = useOutletsEnabled();
  const readOnly = !outletsEnabled;
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

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: '', warehouseId: 0, gstin: '', state: '', stateCode: '', address: '', contactPerson: '', phone: '', email: '', fssaiNumber: '', upiId: '' } });

  // The letterhead logo lives outside the RHF string fields: it is an image
  // managed by its own picker, sent alongside the form values on save.
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  const openAdd = () => { setEditingId(null); form.reset({ name: '', warehouseId: 0, gstin: '', state: '', stateCode: '', address: '', contactPerson: '', phone: '', email: '', fssaiNumber: '', upiId: '' }); setLogoDataUrl(null); setIsOpen(true); };
  const openEdit = (o: any) => {
    setEditingId(o.id);
    form.reset({ name: o.name, warehouseId: o.warehouseId, gstin: (o as any).gstin || '', state: (o as any).state || '', stateCode: (o as any).stateCode || '', address: o.address || '', contactPerson: o.contactPerson || '', phone: o.phone || '', email: (o as any).email || '', fssaiNumber: (o as any).fssaiNumber || '', upiId: (o as any).upiId || '' });
    const logo = (o as any).logoUrl;
    setLogoDataUrl(typeof logo === 'string' && logo.startsWith('data:image/') ? logo : null);
    setIsOpen(true);
  };

  const onPickLogo = async (file: File | undefined) => {
    if (!file) return;
    setLogoBusy(true);
    try {
      setLogoDataUrl(await normaliseLogo(await readFileAsDataUrl(file)));
    } catch {
      toast.error('Could not read that image — please choose a PNG or JPEG');
    } finally {
      setLogoBusy(false);
      if (logoInputRef.current) logoInputRef.current.value = '';
    }
  };

  const onSubmit = (data: FormValues) => {
    const opts = {
      onSuccess: () => { toast.success(editingId ? 'Outlet updated' : 'Outlet added'); queryClient.invalidateQueries({ queryKey: getListOutletsQueryKey() }); setIsOpen(false); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    };
    // Empty string clears the stored logo; the server validates the data URI.
    const payload = { ...data, logoUrl: logoDataUrl ?? '' };
    if (editingId) updateMutation.mutate({ id: editingId, data: payload as any }, opts);
    else createMutation.mutate({ data: payload as any }, opts);
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete outlet "${name}"?`)) return;
    deleteMutation.mutate({ id }, {
      onSuccess: () => { toast.success('Outlet deleted'); queryClient.invalidateQueries({ queryKey: getListOutletsQueryKey() }); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = outlets.filter(o => o.name.toLowerCase().includes(search.toLowerCase()) || o.warehouseName?.toLowerCase().includes(search.toLowerCase()));
  const { sorted, sort } = useTableSort(filtered, {
    name: o => o.name,
    warehouseName: o => o.warehouseName,
    contactPerson: o => o.contactPerson,
    phone: o => o.phone,
  });
  const { pageRows, pagerProps } = useClientPage(sorted);
  const warehouseCount = new Set(outlets.map(o => o.warehouseId)).size;
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
          title="Retail Outlets"
          description={readOnly ? 'Historical outlet records, kept for reports and audits' : 'Point-of-sale locations management'}
          icon={Store}
          actions={
            <>
              {readOnly && (
                <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border border-border bg-muted text-muted-foreground font-semibold self-center">
                  Legacy · Read-only
                </span>
              )}
              {perm.canDownload && (
                <Button variant="outline" size="sm" onClick={() => downloadCSV('outlets.csv', filtered.map(o => ({ Name: o.name, Warehouse: o.warehouseName || '', Contact: o.contactPerson || '', Phone: o.phone || '', Address: o.address || '' })))}>
                  <Download className="w-4 h-4 mr-2" /> Export
                </Button>
              )}
              {!readOnly && perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Outlet</Button>}
            </>
          }
        />

        <SummaryCardGrid>
          <SummaryCard label="Total Outlets" value={outlets.length.toLocaleString('en-IN')} icon={Store} loading={isLoading} />
          <SummaryCard label="Linked Warehouses" value={warehouseCount.toLocaleString('en-IN')} icon={Archive} tone="info" loading={isLoading} />
        </SummaryCardGrid>

        {readOnly && (
          <div className="flex items-start gap-3 p-4 rounded-xl border border-border bg-muted/30">
            <Archive className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground">
              <p className="font-medium text-foreground">This module is retired</p>
              <p className="mt-1">{OUTLETS_LEGACY_NOTE}</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 max-w-xs max-md:max-w-full">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input placeholder="Search outlets..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={8} cols={5} />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="name" sort={sort}>Name</SortableHead>
                <SortableHead k="warehouseName" sort={sort}>Warehouse</SortableHead>
                <SortableHead k="contactPerson" sort={sort}>Contact</SortableHead>
                <SortableHead k="phone" sort={sort}>Phone</SortableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="p-0">
                  <EmptyState icon={Store} title="No outlets found" hint="Point-of-sale locations will appear here." compact />
                </TableCell></TableRow>
              ) : pageRows.map(o => (
                <TableRow key={o.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{o.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{o.warehouseName}</TableCell>
                  <TableCell className="text-sm">{o.contactPerson || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{o.phone || '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="View" onClick={() => setViewItem(o)}><Eye className="w-4 h-4" /></Button>
                      {!readOnly && perm.canEdit && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="Edit" onClick={() => openEdit(o)}><Edit2 className="w-4 h-4" /></Button>}
                      {!readOnly && perm.canDelete && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" title="Delete" onClick={() => handleDelete(o.id, o.name)}><Trash2 className="w-4 h-4" /></Button>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </div>
        {!isLoading && filtered.length > 0 && <TablePager {...pagerProps} />}
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
                  <FormControl>
                    <EntityCombobox
                      options={warehouses.map(w => ({ id: w.id, label: w.name }))}
                      value={field.value || null}
                      onChange={id => field.onChange(id ?? 0)}
                      placeholder="Select warehouse"
                    />
                  </FormControl>
                  <FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="state" render={({ field }) => (
                  <FormItem><FormLabel>State</FormLabel><FormControl><StateCombobox value={field.value || ''} onChange={field.onChange} data-testid="select-outlet-state" /></FormControl></FormItem>
                )} />
                <FormField control={form.control} name="stateCode" render={({ field }) => (
                  <FormItem><FormLabel>State Code</FormLabel><FormControl><Input placeholder="29" maxLength={2} className="font-mono" {...field} /></FormControl></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="gstin" render={({ field }) => (
                <FormItem><FormLabel>GSTIN <span className="text-xs text-muted-foreground font-normal">(required for taxable branch transfers)</span></FormLabel><FormControl><Input placeholder="29AAAAA0000A1ZZ" className="font-mono uppercase" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" placeholder="outlet@example.com" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="fssaiNumber" render={({ field }) => (
                  <FormItem><FormLabel>FSSAI Licence No.</FormLabel><FormControl><Input placeholder="e.g. 10012345678901" className="font-mono" {...field} /></FormControl></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="upiId" render={({ field }) => (
                <FormItem><FormLabel>UPI ID <span className="text-xs text-muted-foreground font-normal">(for invoice QR payment)</span></FormLabel><FormControl><Input placeholder="e.g. outlet@bank" className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Letterhead Logo</span>
                <div className="flex items-center gap-3">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
                    {logoDataUrl
                      ? <img src={logoDataUrl} alt="Outlet logo" className="max-h-full max-w-full object-contain" />
                      : <ImageIcon className="h-6 w-6 text-muted-foreground" />}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" size="sm" disabled={logoBusy}
                        onClick={() => logoInputRef.current?.click()}>
                        {logoBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
                        {logoDataUrl ? 'Replace' : 'Upload'}
                      </Button>
                      {logoDataUrl && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => setLogoDataUrl(null)}>
                          <X className="mr-1 h-3.5 w-3.5" />Remove
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">Printed on this outlet’s documents. Falls back to the parent warehouse or company logo when blank.</p>
                  </div>
                  <input ref={logoInputRef} type="file" accept="image/png,image/jpeg" className="hidden"
                    onChange={e => onPickLogo(e.target.files?.[0])} />
                </div>
              </div>
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
              {!readOnly && perm.canEdit && <Button className="w-full" onClick={() => { setViewItem(null); openEdit(viewItem); }}><Edit2 className="w-4 h-4 mr-2" /> Edit</Button>}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
