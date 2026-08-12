import { useState } from 'react';
import {
  useListWarehouses, useCreateWarehouse, useUpdateWarehouse, getListWarehousesQueryKey,
  useGetMe, useListHierarchies,
  useDisableWarehouse, useEnableWarehouse, useWarehouseDeleteSummary, usePermanentDeleteWarehouse,
  type Warehouse as WarehouseRow, type WarehouseDeleteSummary,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { StateCombobox } from '@/components/ui/state-combobox';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Edit2, Trash2, Warehouse, Download, Eye, ShieldOff, AlertTriangle, CheckCircle2, Ban, Power, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

// Every pattern below mirrors api-server/src/lib/billingProfile.ts so a bad
// value is caught in the form instead of coming back as a toast. When one side
// changes the other has to change with it — they describe the same column.
const UPI_PATTERN = /^[A-Za-z0-9.\-_]{2,64}@[A-Za-z][A-Za-z0-9.\-]{1,63}$/;
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PIN_PATTERN = /^\d{6}$/;
const FSSAI_PATTERN = /^\d{14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATE_CODE_PATTERN = /^\d{2}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9]{5,25}$/;

/** Optional field: blank is always allowed and clears the stored value. */
const optionalMatching = (pattern: RegExp, message: string) =>
  z.string().trim().refine(v => v === '' || pattern.test(v), { message }).optional();

const schema = z.object({
  // General
  name: z.string().trim().min(1, 'Name required'),
  contactPerson: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  email: optionalMatching(EMAIL_PATTERN, 'Enter a valid email address'),
  // Legal & tax
  billingName: z.string().trim().max(120).optional(),
  gstNumber: z.string().trim().min(1, 'GSTIN required')
    .refine(v => GSTIN_PATTERN.test(v.toUpperCase()), { message: 'Enter a valid 15-character GSTIN, e.g. 29ABCDE1234F1Z5' }),
  fssaiNumber: optionalMatching(FSSAI_PATTERN, 'FSSAI licence number must be exactly 14 digits'),
  // Address
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(80).optional(),
  district: z.string().trim().max(80).optional(),
  state: z.string().trim().min(1, 'State required'),
  stateCode: optionalMatching(STATE_CODE_PATTERN, 'Two-digit GST state code, e.g. 29'),
  pincode: optionalMatching(PIN_PATTERN, 'PIN code must be exactly 6 digits'),
  // Bank
  bankAccountHolder: z.string().trim().max(120).optional(),
  bankName: z.string().trim().max(80).optional(),
  bankBranch: z.string().trim().max(80).optional(),
  bankAccountNumber: optionalMatching(ACCOUNT_PATTERN, '5-25 letters or digits, no spaces'),
  ifscCode: optionalMatching(IFSC_PATTERN, 'IFSC must be 11 characters, e.g. HDFC0001234'),
  // Digital payment
  upiId: optionalMatching(UPI_PATTERN, 'Enter a valid UPI ID, e.g. warehouse@okhdfcbank'),
  // Invoice settings
  invoiceFooter: z.string().trim().max(500).optional(),
  authorizedSignatory: z.string().trim().max(120).optional(),
});
type FormValues = z.infer<typeof schema>;

const EMPTY: FormValues = {
  name: '', contactPerson: '', phone: '', email: '',
  billingName: '', gstNumber: '', fssaiNumber: '',
  address: '', city: '', district: '', state: '', stateCode: '', pincode: '',
  bankAccountHolder: '', bankName: '', bankBranch: '', bankAccountNumber: '', ifscCode: '',
  upiId: '',
  invoiceFooter: '', authorizedSignatory: '',
};

/**
 * What is missing before this warehouse can raise a complete tax invoice.
 *
 * Mirrors `gapsFor` on the server. Shown as a badge rather than enforced,
 * because a half-filled profile still has to be saveable on the way to a
 * complete one.
 */
/**
 * Billing fields still missing from what this warehouse will print on an
 * invoice, as reported by the server.
 *
 * Deliberately not recomputed here. The seller identity is assembled with
 * fallbacks the client cannot see — the trade name falls back to the warehouse
 * name, and the bank and UPI fall back to company settings — so a check against
 * the warehouse's own columns would warn about details that appear on the
 * document perfectly well.
 */
function billingGaps(w: Partial<Record<string, unknown>>): string[] {
  const gaps = w['billingIncomplete'];
  return Array.isArray(gaps) ? gaps.filter((g): g is string => typeof g === 'string') : [];
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2 border-b border-border pb-1.5">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">{children}</div>
    </section>
  );
}

const req = <span className="text-destructive">*</span>;

export default function Warehouses() {
  const perm = usePermission('page:/headoffice/warehouses');
  const { data: warehouses = [], isLoading } = useListWarehouses();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewItem, setViewItem] = useState<WarehouseRow | null>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateWarehouse();
  const updateMutation = useUpdateWarehouse();

  // Lifecycle actions (disable / enable / permanent delete) are restricted to
  // the level-1 administrator — the server enforces this too; hiding the
  // buttons just keeps the page honest about what will succeed.
  const { data: me } = useGetMe();
  const { data: hierarchies = [] } = useListHierarchies();
  const myLevel = hierarchies.find(h => h.id === (me as any)?.hierarchyId)?.level;
  const isSuperAdmin = myLevel === 1;

  const enableMutation = useEnableWarehouse();
  const [flowWh, setFlowWh] = useState<WarehouseRow | null>(null);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  const openAdd = () => { setEditingId(null); form.reset(EMPTY); setIsOpen(true); };
  const openEdit = (w: WarehouseRow) => {
    setEditingId(w.id);
    // Spread over EMPTY so a column the server has not filled in yet arrives as
    // '' rather than undefined, which React would treat as an uncontrolled input.
    const src = w as unknown as Record<string, unknown>;
    const next = { ...EMPTY };
    for (const k of Object.keys(EMPTY) as (keyof FormValues)[]) {
      const v = src[k];
      next[k] = typeof v === 'string' ? v : '';
    }
    form.reset(next);
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    const opts = {
      onSuccess: () => {
        toast.success(editingId ? 'Warehouse updated' : 'Warehouse added');
        queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() });
        setIsOpen(false);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    };
    const payload = { ...data, gstNumber: data.gstNumber.toUpperCase(), ifscCode: (data.ifscCode || '').toUpperCase() };
    if (editingId) updateMutation.mutate({ id: editingId, data: payload as any }, opts);
    else createMutation.mutate({ data: payload as any }, opts);
  };

  const handleEnable = (id: number, name: string) => {
    enableMutation.mutate({ id }, {
      onSuccess: () => { toast.success(`"${name}" re-enabled — new transactions are allowed again`); queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() }); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = warehouses.filter(w => w.name.toLowerCase().includes(search.toLowerCase()) || w.state?.toLowerCase().includes(search.toLowerCase()));
  const { sorted, sort } = useTableSort(filtered, {
    name: w => w.name,
    billingName: w => (w as any).billingName,
    state: w => w.state,
    gstNumber: w => w.gstNumber,
    phone: w => w.phone,
    billingProfile: w => billingGaps(w as any).length,
  });
  const isPending = createMutation.isPending || updateMutation.isPending;
  const incompleteCount = warehouses.filter(w => billingGaps(w as any).length > 0).length;

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
          title="Warehouses"
          description="Regional distribution centres and the billing identity they invoice under"
          icon={Warehouse}
          actions={
            <>
              {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('warehouses.csv', filtered.map(w => ({
                Name: w.name, 'Billing Name': (w as any).billingName || '', State: w.state, 'State Code': (w as any).stateCode || '',
                GSTIN: w.gstNumber || '', FSSAI: (w as any).fssaiNumber || '', City: (w as any).city || '', Pincode: (w as any).pincode || '',
                Bank: (w as any).bankName || '', 'Account No.': (w as any).bankAccountNumber || '', IFSC: (w as any).ifscCode || '',
                UPI: (w as any).upiId || '', Contact: w.contactPerson || '', Phone: w.phone || '',
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
              )}
              {perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Add Warehouse</Button>}
            </>
          }
        />

        <SummaryCardGrid>
          <SummaryCard label="Total Warehouses" value={warehouses.length} icon={Warehouse} loading={isLoading} />
          <SummaryCard label="Billing Complete" value={warehouses.length - incompleteCount} icon={CheckCircle2} tone="positive" loading={isLoading} />
          <SummaryCard label="Billing Incomplete" value={incompleteCount} icon={AlertTriangle} tone="warning" loading={isLoading} />
        </SummaryCardGrid>

        {incompleteCount > 0 && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-200">
              {incompleteCount === 1 ? 'One warehouse is' : `${incompleteCount} warehouses are`} missing billing details.
              Invoices raised there will print without them — open the warehouse to complete its profile.
            </p>
          </div>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search by name or state..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-xs max-md:max-w-full" />
          </div>
          <div className="overflow-x-auto">
          {isLoading ? (
            <TableSkeleton rows={3} cols={7} />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="name" sort={sort}>Name</SortableHead>
                <SortableHead k="billingName" sort={sort}>Billing Name</SortableHead>
                <SortableHead k="state" sort={sort}>State</SortableHead>
                <SortableHead k="gstNumber" sort={sort}>GSTIN</SortableHead>
                <SortableHead k="phone" sort={sort}>Phone</SortableHead>
                <SortableHead k="billingProfile" sort={sort}>Billing Profile</SortableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="p-0">
                  <EmptyState icon={Warehouse} title="No warehouses found" compact />
                </TableCell></TableRow>
              ) : sorted.map(w => {
                const gaps = billingGaps(w as any);
                return (
                <TableRow key={w.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">
                    <span className="inline-flex items-center gap-2">
                      {w.name}
                      {(w as any).disabledAt && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="destructive" className="uppercase tracking-wide text-[10px]" data-testid={`badge-disabled-${w.id}`}>Disabled</Badge>
                          </TooltipTrigger>
                          <TooltipContent>New transactions are blocked. History stays viewable and printable.</TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">{(w as any).billingName || <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell><Badge variant="outline">{w.state}{(w as any).stateCode ? ` · ${(w as any).stateCode}` : ''}</Badge></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{w.gstNumber || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{w.phone || '—'}</TableCell>
                  <TableCell>
                    {gaps.length === 0 ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Complete
                      </span>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 cursor-help">
                            <AlertTriangle className="w-3.5 h-3.5" /> {gaps.length} missing
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Missing: {gaps.join(', ')}</TooltipContent>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(w)}><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(w)}><Edit2 className="w-4 h-4" /></Button>}
                      {isSuperAdmin && (w as any).disabledAt && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-600" data-testid={`button-enable-${w.id}`} onClick={() => handleEnable(w.id, w.name)} disabled={enableMutation.isPending}><Power className="w-4 h-4" /></Button>
                          </TooltipTrigger>
                          <TooltipContent>Re-enable this warehouse</TooltipContent>
                        </Tooltip>
                      )}
                      {isSuperAdmin && perm.canDelete && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" data-testid={`button-remove-${w.id}`} onClick={() => setFlowWh(w)}><Trash2 className="w-4 h-4" /></Button>
                          </TooltipTrigger>
                          <TooltipContent>Disable or delete this warehouse</TooltipContent>
                        </Tooltip>
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
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditingId(null); form.reset(EMPTY); } }}>
        <DialogContent className="sm:max-w-3xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Warehouse' : 'Add Warehouse'}</DialogTitle>
            <DialogDescription>
              These details appear as the seller on every tax invoice raised from this warehouse.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 pt-2">

              <Section title="General">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem className="sm:col-span-2"><FormLabel>Warehouse Name {req}</FormLabel><FormControl><Input placeholder="e.g. Bengaluru Cold Store" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="contactPerson" render={({ field }) => (
                  <FormItem><FormLabel>Contact Person</FormLabel><FormControl><Input placeholder="Name" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="phone" render={({ field }) => (
                  <FormItem><FormLabel>Phone</FormLabel><FormControl><Input placeholder="+91 ..." {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem className="sm:col-span-2"><FormLabel>Email</FormLabel><FormControl><Input placeholder="billing@company.in" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </Section>

              <Section title="Legal & Tax" hint="printed as the seller on the invoice">
                <FormField control={form.control} name="billingName" render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Billing / Trade Name</FormLabel>
                    <FormControl><Input placeholder="Registered name on the GST certificate" {...field} /></FormControl>
                    <p className="text-xs text-muted-foreground">Leave blank to print the warehouse name instead.</p>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="gstNumber" render={({ field }) => (
                  <FormItem><FormLabel>GSTIN {req}</FormLabel><FormControl><Input placeholder="29ABCDE1234F1Z5" className="font-mono uppercase" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="fssaiNumber" render={({ field }) => (
                  <FormItem><FormLabel>FSSAI Licence No.</FormLabel><FormControl><Input placeholder="14 digits" className="font-mono" maxLength={14} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </Section>

              <Section title="Address">
                <FormField control={form.control} name="address" render={({ field }) => (
                  <FormItem className="sm:col-span-2"><FormLabel>Street Address</FormLabel><FormControl><Textarea placeholder="Building, street, area…" rows={2} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="city" render={({ field }) => (
                  <FormItem><FormLabel>City</FormLabel><FormControl><Input placeholder="Bengaluru" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="district" render={({ field }) => (
                  <FormItem><FormLabel>District</FormLabel><FormControl><Input placeholder="Bengaluru Urban" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="state" render={({ field }) => (
                  <FormItem><FormLabel>State {req}</FormLabel><FormControl><StateCombobox value={field.value || ''} onChange={field.onChange} data-testid="select-warehouse-state" /></FormControl><FormMessage /></FormItem>
                )} />
                {/* Derived, not entered: the server takes this from the GSTIN's
                    first two digits on every save, so an edit here would be
                    discarded. Plain markup rather than FormItem/FormLabel —
                    those read react-hook-form context that only FormField
                    provides, and this field is not part of the form. */}
                <div className="space-y-2">
                  <span className="text-sm font-medium leading-none">State Code</span>
                  <Input
                    readOnly tabIndex={-1} aria-label="State Code"
                    className="font-mono bg-muted text-muted-foreground"
                    value={(form.watch('gstNumber') ?? '').slice(0, 2)}
                    placeholder="29"
                  />
                  <p className="text-xs text-muted-foreground">Taken from the GSTIN — not editable.</p>
                </div>
                <FormField control={form.control} name="pincode" render={({ field }) => (
                  <FormItem><FormLabel>PIN Code</FormLabel><FormControl><Input placeholder="560099" maxLength={6} className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </Section>

              <Section title="Bank Details" hint="shown in the payment panel of the invoice">
                <FormField control={form.control} name="bankAccountHolder" render={({ field }) => (
                  <FormItem className="sm:col-span-2"><FormLabel>Account Holder</FormLabel><FormControl><Input placeholder="Name as per bank records" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="bankName" render={({ field }) => (
                  <FormItem><FormLabel>Bank Name</FormLabel><FormControl><Input placeholder="HDFC Bank" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="bankBranch" render={({ field }) => (
                  <FormItem><FormLabel>Branch</FormLabel><FormControl><Input placeholder="Bommasandra" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="bankAccountNumber" render={({ field }) => (
                  <FormItem><FormLabel>Account Number</FormLabel><FormControl><Input placeholder="50200012345678" className="font-mono" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="ifscCode" render={({ field }) => (
                  <FormItem><FormLabel>IFSC</FormLabel><FormControl><Input placeholder="HDFC0001234" maxLength={11} className="font-mono uppercase" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </Section>

              <Section title="Digital Payment">
                <FormField control={form.control} name="upiId" render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>UPI ID</FormLabel>
                    <FormControl><Input placeholder="warehouse@okhdfcbank" className="font-mono" {...field} /></FormControl>
                    <p className="text-xs text-muted-foreground">Used to build the “Scan &amp; Pay” QR code on unpaid invoices.</p>
                    <FormMessage />
                  </FormItem>
                )} />
              </Section>

              <Section title="Invoice Settings">
                <FormField control={form.control} name="authorizedSignatory" render={({ field }) => (
                  <FormItem className="sm:col-span-2"><FormLabel>Authorised Signatory</FormLabel><FormControl><Input placeholder="Name printed above the signature line" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="invoiceFooter" render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Invoice Footer</FormLabel>
                    <FormControl><Textarea placeholder="Terms, jurisdiction, declarations…" rows={2} {...field} /></FormControl>
                    <p className="text-xs text-muted-foreground">Falls back to the company footer when blank.</p>
                    <FormMessage />
                  </FormItem>
                )} />
              </Section>

              <DialogFooter className="sticky bottom-0 bg-background pt-3">
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={isPending}>{isPending ? 'Saving…' : 'Save'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {flowWh && (
        <WarehouseRemoveFlow
          wh={flowWh}
          onClose={() => setFlowWh(null)}
          onChanged={() => queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() })}
        />
      )}

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Warehouse className="w-5 h-5 text-primary" />{viewItem?.name}</SheetTitle>
            <SheetDescription>{(viewItem as any)?.billingName || viewItem?.state}</SheetDescription>
          </SheetHeader>
          {viewItem && (() => {
            const v = viewItem as Record<string, any>;
            const gaps = billingGaps(v);
            const groups: [string, [string, string][]][] = [
              ['General', [['Contact Person', v.contactPerson], ['Phone', v.phone], ['Email', v.email]]],
              ['Legal & Tax', [['Billing Name', v.billingName], ['GSTIN', v.gstNumber], ['FSSAI Licence', v.fssaiNumber]]],
              ['Address', [['Street', v.address], ['City', v.city], ['District', v.district], ['State', v.state], ['State Code', v.stateCode], ['PIN Code', v.pincode]]],
              ['Bank Details', [['Account Holder', v.bankAccountHolder], ['Bank', v.bankName], ['Branch', v.bankBranch], ['Account No.', v.bankAccountNumber], ['IFSC', v.ifscCode]]],
              ['Digital Payment', [['UPI ID', v.upiId]]],
              ['Invoice Settings', [['Authorised Signatory', v.authorizedSignatory], ['Invoice Footer', v.invoiceFooter]]],
            ];
            return (
              <div className="mt-6 space-y-6">
                {gaps.length > 0 && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
                    <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                    <span className="text-amber-900 dark:text-amber-200">Invoices from here will print without: {gaps.join(', ')}.</span>
                  </div>
                )}
                {groups.map(([title, rows]) => (
                  <div key={title} className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border pb-1">{title}</h4>
                    {rows.map(([k, val]) => (
                      <div key={k} className="flex justify-between gap-4 py-1 text-sm">
                        <span className="text-muted-foreground shrink-0">{k}</span>
                        <span className="font-medium text-right break-words">{val || '—'}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {perm.canEdit && <Button className="w-full" onClick={() => { setViewItem(null); openEdit(viewItem); }}><Edit2 className="w-4 h-4 mr-2" /> Edit</Button>}
              </div>
            );
          })()}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}

// ── Two-stage removal flow ───────────────────────────────────────────────────
// Stage 1 (choice): recommends disabling — reversible, keeps history — and
// shows exactly what a permanent delete would erase, plus any blockers.
// Stage 2 (confirm): the administrator must type "DELETE <name>" exactly
// before the destructive button arms. The server re-checks everything.
function WarehouseRemoveFlow({ wh, onClose, onChanged }: { wh: WarehouseRow; onClose: () => void; onChanged: () => void }) {
  const [step, setStep] = useState<'choice' | 'confirm'>('choice');
  const [confirmText, setConfirmText] = useState('');
  const [serverFailures, setServerFailures] = useState<string[]>([]);
  const { data: summary, isLoading } = useWarehouseDeleteSummary(wh.id);
  const disableMutation = useDisableWarehouse();
  const deleteMutation = usePermanentDeleteWarehouse();

  const alreadyDisabled = !!(wh as any).disabledAt;
  const blockers = summary?.blockers ?? [];
  const phrase = summary?.confirmationPhrase ?? `DELETE ${wh.name}`;
  const armed = confirmText === phrase;

  const fmtMoney = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const countRows: [string, number | string][] = summary ? [
    ['Sales invoices', summary.counts.sales],
    ['Purchase bills', summary.counts.purchases],
    ['Quotations', summary.counts.quotations],
    ['Production batches', summary.counts.productions],
    ['Receipts & payments', summary.counts.receipts + summary.counts.payments],
    ['Journal vouchers', summary.counts.journalVouchers],
    ['Expenses', summary.counts.expenses],
    ['Returns (sales + purchase)', summary.counts.salesReturns + summary.counts.purchaseReturns],
    ['Customers & vendors here', summary.counts.customers + summary.counts.vendors],
    ['Ledger entries', summary.counts.ledgerEntries],
    ['Stock items on hand', summary.counts.inventoryItems],
    ['Stock value', fmtMoney(summary.counts.stockValue)],
    ['Cash & bank accounts', summary.counts.cashAccounts + summary.counts.bankAccounts],
    ['Rent records', summary.counts.rentRecords],
  ].filter(([, v]) => v !== 0 && v !== fmtMoney(0)) as [string, number | string][] : [];

  const doDisable = () => {
    disableMutation.mutate({ id: wh.id }, {
      onSuccess: () => { toast.success(`"${wh.name}" disabled — new transactions are blocked, history is untouched`); onChanged(); onClose(); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const doPermanentDelete = () => {
    if (!armed) return;
    setServerFailures([]);
    deleteMutation.mutate({ id: wh.id, confirmation: confirmText }, {
      onSuccess: () => { toast.success(`"${wh.name}" and all its records were permanently deleted`); onChanged(); onClose(); },
      onError: (e: any) => {
        const failures = e?.data?.failures;
        if (Array.isArray(failures) && failures.length > 0) setServerFailures(failures);
        toast.error(e?.data?.error || e.message || 'Deletion failed — nothing was removed');
      },
    });
  };

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[88vh] overflow-y-auto">
        {step === 'choice' ? (
          <>
            <DialogHeader>
              <DialogTitle>Remove “{wh.name}”?</DialogTitle>
              <DialogDescription>
                Disabling is recommended: it blocks all new transactions while every past
                invoice, report and ledger stays viewable and printable. You can re-enable it any time.
              </DialogDescription>
            </DialogHeader>

            {isLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Checking this warehouse's records…</div>
            ) : (
              <div className="space-y-4">
                {countRows.length > 0 ? (
                  <div className="rounded-lg border border-border">
                    <p className="px-3 pt-2.5 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">A permanent delete would erase</p>
                    <div className="px-3 pb-2.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                      {countRows.map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-3 py-0.5 text-sm">
                          <span className="text-muted-foreground">{k}</span>
                          <span className="font-medium tabular-nums">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">This warehouse has no recorded transactions.</p>
                )}

                {blockers.length > 0 && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 space-y-1.5">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0" /> Permanent deletion is not possible</p>
                    <ul className="list-disc pl-5 text-sm text-amber-900/90 dark:text-amber-200/90 space-y-1">
                      {blockers.map(b => <li key={b}>{b}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <DialogFooter className="flex-col sm:flex-col gap-2 sm:space-x-0">
              {!alreadyDisabled && (
                <Button className="w-full" onClick={doDisable} disabled={disableMutation.isPending} data-testid="button-disable-warehouse">
                  <Ban className="w-4 h-4 mr-2" /> {disableMutation.isPending ? 'Disabling…' : 'Disable warehouse (recommended)'}
                </Button>
              )}
              <Button
                variant="outline" className="w-full text-destructive hover:text-destructive"
                disabled={isLoading || blockers.length > 0}
                onClick={() => { setConfirmText(''); setServerFailures([]); setStep('confirm'); }}
                data-testid="button-permanent-delete-step"
              >
                <Trash2 className="w-4 h-4 mr-2" /> Permanently delete instead…
              </Button>
              <Button variant="ghost" className="w-full" onClick={onClose}>Cancel</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-destructive">Permanently delete “{wh.name}”</DialogTitle>
              <DialogDescription>
                This cannot be undone. Every sale, purchase, voucher, ledger entry and stock record
                listed on the previous step will be erased in a single all-or-nothing operation.
                If any safety check fails, nothing is deleted.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="confirm-delete-input">
                  Type <span className="font-mono font-semibold">{phrase}</span> to confirm
                </label>
                <Input
                  id="confirm-delete-input" autoFocus autoComplete="off" spellCheck={false}
                  value={confirmText} onChange={e => setConfirmText(e.target.value)}
                  placeholder={phrase} className="font-mono"
                  data-testid="input-confirm-delete"
                />
              </div>
              {serverFailures.length > 0 && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 space-y-1.5">
                  <p className="text-sm font-medium text-destructive">Nothing was deleted — the server refused:</p>
                  <ul className="list-disc pl-5 text-sm text-destructive/90 space-y-1">
                    {serverFailures.map(f => <li key={f}>{f}</li>)}
                  </ul>
                </div>
              )}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setStep('choice')} disabled={deleteMutation.isPending}>Back</Button>
              <Button
                variant="destructive" disabled={!armed || deleteMutation.isPending}
                onClick={doPermanentDelete}
                data-testid="button-permanent-delete-confirm"
              >
                {deleteMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting…</> : 'Delete permanently'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
