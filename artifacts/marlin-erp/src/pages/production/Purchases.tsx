import { Fragment, useEffect, useState } from 'react';
import {
  usePaginatedPurchases, useCreatePurchase, useListVendors, useListMaterials, useListRawMaterials, useListItems,
  getListPurchasesQueryKey, useUpdatePurchase, useDeletePurchase, useGetCompanySettings,
} from '@workspace/api-client-react';
import { downloadPurchaseOrderPDF } from '@/lib/pdfUtils';
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
import { Plus, Search, Trash2, ShoppingCart, Download, Eye, Calendar, FileDown, Edit2, AlertTriangle, X } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { activeProductsWithSelection } from '@/lib/productStatus';
import { useActingLocations, decodeLocation, encodeLocation } from '@/lib/useActingLocation';
import { Separator } from '@/components/ui/separator';

const GST_RATES = [0, 5, 12, 18, 28] as const;

const lineSchema = z.object({
  materialType: z.enum(['material', 'raw_material', 'item']),
  materialId: z.coerce.number().min(1, 'Select item'),
  hsnCode: z.string().optional(),
  quantity: z.coerce.number().min(0.001, 'Qty > 0'),
  unitCost: z.coerce.number().min(0, 'Rate ≥ 0'),
  discount: z.coerce.number().min(0).max(100).default(0),
  gstRate: z.coerce.number().default(0),
  taxType: z.enum(['intra', 'inter']).default('intra'),
  batchNumber: z.string().optional(),
  mfgDate: z.string().optional(),
  expiryDate: z.string().optional(),
});

const schema = z.object({
  vendorId: z.coerce.number().min(1, 'Vendor required'),
  purchaseDate: z.string().min(1, 'Date required'),
  invoiceNumber: z.string().optional(),
  location: z.string().min(1, 'Location required'),
  lineItems: z.array(lineSchema).min(1, 'Add at least one item'),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const defaultLine = { materialType: 'raw_material' as const, materialId: 0, hsnCode: '', quantity: 1, unitCost: 0, discount: 0, gstRate: 5, taxType: 'intra' as const, batchNumber: '', mfgDate: '', expiryDate: '' };

function calcLine(q: number, rate: number, disc: number, gst: number, taxType: string) {
  const lineSubtotal = q * rate;
  const discountAmt = lineSubtotal * disc / 100;
  const taxableValue = lineSubtotal - discountAmt;
  const taxAmount = Math.round(taxableValue * gst / 100 * 100) / 100;
  const intra = taxType === 'intra';
  const cgst = intra ? Math.round(taxAmount / 2 * 100) / 100 : 0;
  const sgst = intra ? Math.round(taxAmount / 2 * 100) / 100 : 0;
  const igst = !intra ? taxAmount : 0;
  return { lineSubtotal, discountAmt, taxableValue, taxAmount, cgst, sgst, igst, lineTotal: taxableValue + taxAmount };
}

function fmt(n: number) { return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ── Asset purchases (fixed-asset acquisition, spec §7) ──────────────────────
// Assets are capital items, NOT sale inventory: they live in their own tables
// and post to the Fixed Asset ledger, never to Purchases/inventory/stock. This
// self-contained section talks to the new /asset-purchases endpoints (kept out
// of the generated api-client). It reuses the Purchases page permission.
interface AssetMasterRow { id: number; name: string; unit: string; status: string; }
interface AssetPurchaseRow {
  id: number; assetId: number; assetName: string; assetUnit: string;
  quantity: number; acquisitionCost: number; totalCost: number;
  vendorId: number | null; vendorName: string; purchaseDate: string; notes: string | null;
  locationType: string; locationId: number; locationName: string;
}

const assetPurchaseSchema = z.object({
  assetId: z.coerce.number().min(1, 'Select an asset'),
  quantity: z.coerce.number().min(0.001, 'Qty > 0'),
  acquisitionCost: z.coerce.number().min(0, 'Cost ≥ 0'),
  vendorId: z.coerce.number().optional(),
  location: z.string().min(1, 'Location required'),
  purchaseDate: z.string().min(1, 'Date required'),
  notes: z.string().optional(),
});
type AssetPurchaseFormValues = z.infer<typeof assetPurchaseSchema>;

function AssetPurchasesSection({ vendors, canAdd, canDownload }: { vendors: any[]; canAdd: boolean; canDownload: boolean }) {
  const queryClient = useQueryClient();
  const locations = useActingLocations();
  const [isOpen, setIsOpen] = useState(false);

  const assetsQuery = useQuery<AssetMasterRow[]>({
    queryKey: ['assets-master', 'active'],
    queryFn: () => customFetch<AssetMasterRow[]>('/api/inventory/assets?status=active'),
  });
  const activeAssets = assetsQuery.data ?? [];

  const purchasesQuery = useQuery<AssetPurchaseRow[]>({
    queryKey: ['asset-purchases'],
    queryFn: () => customFetch<AssetPurchaseRow[]>('/api/asset-purchases'),
  });
  const assetPurchases = purchasesQuery.data ?? [];

  const createMutation = useMutation({
    mutationFn: (data: any) => customFetch('/api/asset-purchases', { method: 'POST', body: JSON.stringify(data) }),
  });

  const form = useForm<AssetPurchaseFormValues>({
    resolver: zodResolver(assetPurchaseSchema),
    defaultValues: { assetId: 0, quantity: 1, acquisitionCost: 0, vendorId: 0, location: locations.defaultValue, purchaseDate: new Date().toISOString().split('T')[0], notes: '' },
  });
  const watchQty = Number(form.watch('quantity')) || 0;
  const watchCost = Number(form.watch('acquisitionCost')) || 0;
  const previewTotal = Math.round(watchQty * watchCost * 100) / 100;

  const openDialog = () => {
    form.reset({ assetId: 0, quantity: 1, acquisitionCost: 0, vendorId: 0, location: locations.defaultValue, purchaseDate: new Date().toISOString().split('T')[0], notes: '' });
    setIsOpen(true);
  };

  const onSubmit = (values: AssetPurchaseFormValues) => {
    const loc = decodeLocation(locations.canChoose ? values.location : locations.defaultValue);
    const payload = {
      assetId: values.assetId,
      quantity: values.quantity,
      acquisitionCost: values.acquisitionCost,
      vendorId: values.vendorId ? values.vendorId : null,
      purchaseDate: values.purchaseDate,
      notes: values.notes || undefined,
      locationType: (loc as any).locationType,
      locationId: (loc as any).locationId,
    };
    createMutation.mutate(payload, {
      onSuccess: () => {
        toast.success('Asset purchase recorded');
        queryClient.invalidateQueries({ queryKey: ['asset-purchases'] });
        setIsOpen(false);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to record asset purchase'),
    });
  };

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 p-4 border-b border-border">
        <div>
          <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2"><ShoppingCart className="w-5 h-5 text-purple-500" /> Asset Purchases</h2>
          <p className="text-muted-foreground text-sm mt-0.5">Acquire fixed assets (e.g. freezers) per location — booked to the Fixed Asset ledger, not inventory</p>
        </div>
        <div className="flex gap-2">
          {canDownload && assetPurchases.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('asset-purchases.csv', assetPurchases.map(a => ({
              'Ref #': a.id, Date: a.purchaseDate, Asset: a.assetName, Location: a.locationName,
              Quantity: a.quantity, 'Cost/Unit': a.acquisitionCost, 'Total': a.totalCost, Vendor: a.vendorName || '',
            })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
          )}
          {canAdd && (
            <Button size="sm" onClick={openDialog}><Plus className="w-4 h-4 mr-2" /> Buy Asset</Button>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ref #</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Asset</TableHead>
            <TableHead>Location</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Cost/Unit</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Vendor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {purchasesQuery.isLoading ? (
            <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>
          ) : assetPurchases.length === 0 ? (
            <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No asset purchases yet.</TableCell></TableRow>
          ) : assetPurchases.map(a => (
            <TableRow key={a.id}>
              <TableCell className="font-mono text-xs">#{String(a.id).padStart(4, '0')}</TableCell>
              <TableCell className="text-sm"><div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(a.purchaseDate).toLocaleDateString('en-IN')}</div></TableCell>
              <TableCell className="font-medium">{a.assetName} <span className="text-xs text-muted-foreground">({a.assetUnit})</span></TableCell>
              <TableCell><Badge variant="outline" className="text-xs">{a.locationName}</Badge></TableCell>
              <TableCell className="text-right font-mono">{a.quantity}</TableCell>
              <TableCell className="text-right font-mono">₹{fmt(a.acquisitionCost)}</TableCell>
              <TableCell className="text-right font-mono font-semibold">₹{fmt(a.totalCost)}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{a.vendorName || '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Buy Asset</DialogTitle>
            <DialogDescription>Records a fixed-asset acquisition. Booked to the Fixed Asset ledger — no depreciation, no stock impact.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="assetId" render={({ field }) => (
                <FormItem>
                  <FormLabel>Asset</FormLabel>
                  <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select an asset" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {activeAssets.length === 0
                        ? <SelectItem value="0" disabled>No active assets — create one in Item Master</SelectItem>
                        : activeAssets.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name} ({a.unit})</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="quantity" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Quantity</FormLabel>
                    <FormControl><Input type="number" min={0} step="0.001" className="font-mono" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="acquisitionCost" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Acquisition Cost / Unit (₹)</FormLabel>
                    <FormControl><Input type="number" min={0} step="0.01" className="font-mono" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              {locations.canChoose && (
                <FormField control={form.control} name="location" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        {locations.options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
              )}
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vendor (optional)</FormLabel>
                    <Select onValueChange={v => field.onChange(v === 'none' ? 0 : Number(v))} value={field.value ? String(field.value) : 'none'}>
                      <FormControl><SelectTrigger><SelectValue placeholder="No vendor" /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="none">No vendor</SelectItem>
                        {(vendors as any[]).map(v => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="purchaseDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Purchase Date</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Textarea rows={2} placeholder="Optional" {...field} /></FormControl>
                </FormItem>
              )} />
              <div className="flex justify-between items-center rounded-lg bg-muted/40 px-3 py-2">
                <span className="text-sm text-muted-foreground">Total acquisition value</span>
                <span className="font-mono font-bold text-primary">₹{fmt(previewTotal)}</span>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || activeAssets.length === 0}>
                  {createMutation.isPending ? 'Saving…' : 'Record Asset Purchase'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Purchases() {
  const perm = usePermission('page:/production/purchase');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  // Debounce the search box — vendor/invoice search runs server-side
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: purchasePage, isLoading, isFetching } = usePaginatedPurchases({
    page, limit: PAGE_SIZE, q: debouncedSearch || undefined,
  });
  const purchases = purchasePage?.rows ?? [];
  const totalPurchases = purchasePage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalPurchases / PAGE_SIZE));

  // Clamp page when the result set shrinks (deletes, concurrent changes)
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const { data: vendors = [] } = useListVendors();
  const { data: materials = [] } = useListMaterials();
  const { data: rawMaterials = [] } = useListRawMaterials();
  const { data: finishedItems = [] } = useListItems();
  const locations = useActingLocations();
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const queryClient = useQueryClient();

  // Purchases change stock levels and dashboard KPIs — refresh them too.
  const invalidateStockDashboards = () =>
    queryClient.invalidateQueries({
      predicate: q => {
        const k = String(q.queryKey[0] ?? '');
        return k.startsWith('/api/dashboard') || k.startsWith('/api/stock');
      },
    });

  const createMutation = useCreatePurchase();
  const updateMutation = useUpdatePurchase();
  const deleteMutation = useDeletePurchase();

  const { data: companySettings } = useGetCompanySettings();

  const getMaterialName = (li: any) => {
    if (li.materialName) return li.materialName; // server-enriched
    if (li.materialType === 'raw_material') return rawMaterials.find((m: any) => m.id === li.materialId)?.name || `Item #${li.materialId}`;
    if (li.materialType === 'item') return (finishedItems as any[]).find((m: any) => m.id === li.materialId)?.name || `Item #${li.materialId}`;
    return materials.find((m: any) => m.id === li.materialId)?.name || `Item #${li.materialId}`;
  };

  const handleDownloadPO = (p: any) => {
    try {
      const matMap = new Map<number, string>((materials as any[]).map((m: any) => [m.id, m.name]));
      const rawMap = new Map<number, string>((rawMaterials as any[]).map((m: any) => [m.id, m.name]));
      const vendorGstin = (vendors as any[]).find((v: any) => v.id === p.vendorId)?.gstNumber;
      downloadPurchaseOrderPDF({ ...p, vendorGstin }, companySettings ?? {}, matMap, rawMap);
    } catch {
      toast.error('Could not generate the PO PDF');
    }
  };

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', location: 'headoffice:1', lineItems: [defaultLine], notes: '' } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const watchLines = form.watch('lineItems');

  // Bill summary
  const billSummary = watchLines.reduce((acc, li) => {
    const calc = calcLine(Number(li.quantity) || 0, Number(li.unitCost) || 0, Number(li.discount) || 0, Number(li.gstRate) || 0, li.taxType);
    acc.subtotal += calc.lineSubtotal;
    acc.discountTotal += calc.discountAmt;
    acc.taxableTotal += calc.taxableValue;
    acc.cgstTotal += calc.cgst;
    acc.sgstTotal += calc.sgst;
    acc.igstTotal += calc.igst;
    acc.taxTotal += calc.taxAmount;
    return acc;
  }, { subtotal: 0, discountTotal: 0, taxableTotal: 0, cgstTotal: 0, sgstTotal: 0, igstTotal: 0, taxTotal: 0 });

  const rawTotal = billSummary.taxableTotal + billSummary.taxTotal;
  const roundOff = Math.round(rawTotal) - rawTotal;
  const grandTotal = Math.round(rawTotal);

  const resetForm = () => form.reset({ vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', location: locations.defaultValue, lineItems: [defaultLine], notes: '' });

  const onSubmit = (form0: FormValues) => {
    const { location, ...rest } = form0;
    // A user who cannot choose is always pinned to their own location, even if
    // the picker had not resolved `me` yet when the dialog opened.
    const data = { ...rest, ...decodeLocation(locations.canChoose ? location : locations.defaultValue) };
    if (editingId !== null) {
      updateMutation.mutate({ id: editingId, data: data as any }, {
        onSuccess: () => {
          toast.success('Purchase bill updated');
          queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
          invalidateStockDashboards();
          setIsOpen(false);
          setEditingId(null);
          resetForm();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    } else {
      createMutation.mutate({ data: data as any }, {
        onSuccess: () => {
          toast.success('Purchase bill created');
          queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
          invalidateStockDashboards();
          setIsOpen(false);
          resetForm();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    }
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => { toast.success(`Bill #${deleteTarget.id} deleted (stock reversed)`); queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() }); invalidateStockDashboards(); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  // Rows already match the server-side search — no client filtering needed
  const filtered = purchases;

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Purchases.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ShoppingCart className="w-6 h-6 text-primary" /> Purchase Bills</h1>
            <p className="text-muted-foreground mt-1">Record purchases with GST, HSN code & discounts</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('purchases.csv', filtered.map(p => ({
                'Bill #': p.id, Date: p.purchaseDate, Vendor: p.vendorName, Invoice: p.invoiceNumber || '',
                Location: (p as any).locationName ?? '',
                Items: (p.lineItems as any[])?.length || 0,
                'Taxable': Number((p as any).discountTotal ? Number(p.totalAmount) - Number((p as any).taxTotal || 0) : p.totalAmount),
                'Tax': Number((p as any).taxTotal || 0),
                'Total': Number(p.totalAmount),
              })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { form.reset({ vendorId: 0, purchaseDate: new Date().toISOString().split('T')[0], invoiceNumber: '', lineItems: [defaultLine], notes: '' }); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Purchase Bill
              </Button>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 bg-muted/20">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <Input placeholder="Search vendor or invoice..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 max-w-sm" />
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Bill #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Invoice Ref</TableHead>
                {locations.isHeadOffice && <TableHead>Location</TableHead>}
                <TableHead>Items</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={locations.isHeadOffice ? 9 : 8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={locations.isHeadOffice ? 9 : 8} className="text-center py-16 text-muted-foreground">
                  <ShoppingCart className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No purchase bills yet</p>
                </TableCell></TableRow>
              ) : filtered.map(p => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-primary font-bold text-sm">#{String(p.id).padStart(4, '0')}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(p.purchaseDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="font-medium">{p.vendorName}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{p.invoiceNumber || '—'}</TableCell>
                  {locations.isHeadOffice && (
                    <TableCell className="text-muted-foreground text-sm">{(p as any).locationName ?? 'Head Office'}</TableCell>
                  )}
                  <TableCell><Badge variant="secondary">{(p.lineItems as any[])?.length || 0} items</Badge></TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {Number((p as any).taxTotal || 0) > 0 ? `₹${fmt(Number((p as any).taxTotal || 0))}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-primary">₹{fmt(Number(p.totalAmount))}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => {
                          setEditingId(p.id);
                          form.reset({
                            vendorId: p.vendorId,
                            purchaseDate: (p.purchaseDate ?? '').substring(0, 10) || new Date().toISOString().split('T')[0],
                            invoiceNumber: p.invoiceNumber || '',
                            location: encodeLocation((p as any).locationType ?? 'headoffice', Number((p as any).locationId ?? 1)),
                            notes: (p as any).notes || '',
                            lineItems: ((p.lineItems as any[]) || []).map((li: any) => ({
                              materialType: li.materialType || 'raw_material',
                              materialId: li.materialId,
                              hsnCode: li.hsnCode || '',
                              quantity: Number(li.quantity),
                              unitCost: Number(li.unitCost),
                              discount: Number(li.discount || 0),
                              gstRate: Number(li.gstRate || 0),
                              taxType: li.taxType || 'intra',
                              batchNumber: li.batchNumber || '',
                              mfgDate: li.mfgDate || '',
                              expiryDate: li.expiryDate || '',
                            })),
                          });
                          setIsOpen(true);
                        }}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                      )}
                      {perm.canDelete && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget(p)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalPurchases > 0 && (
            <div className="p-3 border-t border-border flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalPurchases)} of {totalPurchases} bills
                {isFetching ? ' · refreshing…' : ''}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <span className="px-1 text-xs text-muted-foreground">Page {page}/{totalPages}</span>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>

        {/* ── Asset purchases (fixed assets, separate ledger, no stock) ── */}
        <AssetPurchasesSection vendors={vendors as any[]} canAdd={perm.canAdd} canDownload={perm.canDownload} />
      </div>

      {/* ── New / Edit Purchase Bill Dialog ── */}
      <Dialog open={isOpen} onOpenChange={v => { setIsOpen(v); if (!v) { setEditingId(null); resetForm(); } }}>
        <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId !== null ? `Edit Purchase Bill #${String(editingId).padStart(4, '0')}` : 'New Purchase Bill'}
            </DialogTitle>
            <DialogDescription>Enter purchase details with HSN, GST rate and discount per item</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 pt-2">
              {/* Header */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <FormField control={form.control} name="vendorId" render={({ field }) => (
                  <FormItem><FormLabel>Vendor <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select vendor" /></SelectTrigger></FormControl>
                      <SelectContent>{vendors.map((v: any) => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="purchaseDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="invoiceNumber" render={({ field }) => (
                  <FormItem><FormLabel>Invoice Ref #</FormLabel><FormControl><Input placeholder="Vendor's invoice no." {...field} /></FormControl></FormItem>
                )} />
                {/* Receiving location. Fixed once the bill exists: stock, the
                    vendor payable and input GST all landed there already. */}
                <FormField control={form.control} name="location" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Receiving Location <span className="text-destructive">*</span></FormLabel>
                    {locations.canChoose && editingId === null ? (
                      <>
                        <Select onValueChange={field.onChange} value={field.value || locations.defaultValue}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger></FormControl>
                          <SelectContent>{locations.options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                        </Select>
                        <p className="text-[10px] text-muted-foreground">Stock, input GST and the vendor payable are booked here.</p>
                      </>
                    ) : (
                      <>
                        <div className="h-9 flex items-center px-3 rounded-md border border-border bg-muted/30 text-sm font-medium">
                          {locations.labelFor(field.value)}
                        </div>
                        {editingId !== null && <p className="text-[10px] text-muted-foreground">Cannot be moved after the bill is saved.</p>}
                      </>
                    )}
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              {/* Line Items */}
              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                  <div className="text-sm font-medium">Line Items</div>
                  <p className="text-[11px] text-muted-foreground">
                    Batch number, mfg date and expiry date are required on every line.
                    {editingId !== null && ' Older bills may have been saved without them — fill them in to save.'}
                  </p>
                </div>
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="grid bg-muted/30 text-xs font-medium text-muted-foreground uppercase tracking-wide px-3 py-2" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1fr auto' }}>
                    <span>Item</span><span>HSN</span><span>Qty</span><span>Rate ₹</span><span>Disc %</span><span>GST %</span><span className="text-right">Total ₹</span><span />
                  </div>
                  {fields.map((field, index) => {
                    const li = watchLines[index] || {};
                    const calc = calcLine(Number(li.quantity) || 0, Number(li.unitCost) || 0, Number(li.discount) || 0, Number(li.gstRate) || 0, li.taxType || 'intra');
                    return (
                      <Fragment key={field.id}>
                      <div className="grid items-center gap-2 px-3 py-2 border-t border-border" style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1fr auto' }}>
                        {/* Item type + item selector combined */}
                        <div className="flex gap-1">
                          <Select onValueChange={v => form.setValue(`lineItems.${index}.materialType`, v as any)} value={form.watch(`lineItems.${index}.materialType`)}>
                            <SelectTrigger className="w-[90px] text-xs h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="raw_material">Packing Material</SelectItem>
                              <SelectItem value="material">Raw Material</SelectItem>
                              <SelectItem value="item">Item Name (SKU)</SelectItem>
                            </SelectContent>
                          </Select>
                          <Select onValueChange={v => form.setValue(`lineItems.${index}.materialId`, Number(v))} value={form.watch(`lineItems.${index}.materialId`) ? String(form.watch(`lineItems.${index}.materialId`)) : ''}>
                            <SelectTrigger className="h-8 text-xs flex-1 min-w-0"><SelectValue placeholder="Select" /></SelectTrigger>
                            <SelectContent>
                              {/* Active only for new picks; an already-chosen product stays
                                  listed so editing an old bill can't blank the line. */}
                              {activeProductsWithSelection(
                                (form.watch(`lineItems.${index}.materialType`) === 'raw_material' ? rawMaterials : form.watch(`lineItems.${index}.materialType`) === 'item' ? finishedItems : materials) as any[],
                                Number(form.watch(`lineItems.${index}.materialId`)),
                              ).map((m: any) => (
                                <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Input className="h-8 text-xs font-mono" placeholder="HSN" {...form.register(`lineItems.${index}.hsnCode`)} />
                        <Input className="h-8 text-xs text-right" type="number" min={0} step="0.001" {...form.register(`lineItems.${index}.quantity`)} />
                        <Input className="h-8 text-xs text-right" type="number" min={0} step="0.01" {...form.register(`lineItems.${index}.unitCost`)} />
                        <Input className="h-8 text-xs text-right" type="number" min={0} max={100} step="0.1" placeholder="0" {...form.register(`lineItems.${index}.discount`)} />
                        <div className="flex gap-1 items-center">
                          <Select onValueChange={v => form.setValue(`lineItems.${index}.gstRate`, Number(v))} value={String(form.watch(`lineItems.${index}.gstRate`) ?? 5)}>
                            <SelectTrigger className="h-8 text-xs w-[56px]"><SelectValue /></SelectTrigger>
                            <SelectContent>{GST_RATES.map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
                          </Select>
                          <Select onValueChange={v => form.setValue(`lineItems.${index}.taxType`, v as any)} value={form.watch(`lineItems.${index}.taxType`) || 'intra'}>
                            <SelectTrigger className="h-8 text-xs w-[52px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="intra">Intra</SelectItem>
                              <SelectItem value="inter">Inter</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="text-right text-sm font-mono font-medium">₹{fmt(calc.lineTotal)}</div>
                        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(index)} disabled={fields.length === 1}>
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      {/* Batch identity — required on every line, whatever the kind.
                          Frozen food cannot be traced or expiry-checked without it. */}
                      <div className="flex flex-wrap items-center gap-2 px-3 pb-2 bg-emerald-500/[0.03]">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Batch <span className="text-destructive">*</span>
                        </span>
                        <Input className="h-7 text-xs font-mono w-40" placeholder="Vendor lot / batch no." {...form.register(`lineItems.${index}.batchNumber`)} />
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground ml-2">
                          Mfg <span className="text-destructive">*</span>
                        </span>
                        <Input className="h-7 text-xs w-36" type="date" {...form.register(`lineItems.${index}.mfgDate`)} />
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground ml-2">
                          Expiry <span className="text-destructive">*</span>
                        </span>
                        <Input className="h-7 text-xs w-36" type="date" {...form.register(`lineItems.${index}.expiryDate`)} />
                      </div>
                      </Fragment>
                    );
                  })}
                </div>
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => append({ ...defaultLine })}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Line
                </Button>
              </div>

              {/* Bill Summary */}
              <div className="grid grid-cols-2 gap-6">
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={3} placeholder="Optional notes" {...field} /></FormControl></FormItem>
                )} />
                <div className="bg-muted/20 rounded-lg p-4 space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-mono">₹{fmt(billSummary.subtotal)}</span></div>
                  {billSummary.discountTotal > 0 && (
                    <div className="flex justify-between"><span className="text-muted-foreground">(-) Discount</span><span className="font-mono text-red-500">-₹{fmt(billSummary.discountTotal)}</span></div>
                  )}
                  <div className="flex justify-between"><span className="text-muted-foreground">Taxable Amount</span><span className="font-mono">₹{fmt(billSummary.taxableTotal)}</span></div>
                  <Separator />
                  {billSummary.cgstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">CGST</span><span className="font-mono">₹{fmt(billSummary.cgstTotal)}</span></div>}
                  {billSummary.sgstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">SGST</span><span className="font-mono">₹{fmt(billSummary.sgstTotal)}</span></div>}
                  {billSummary.igstTotal > 0 && <div className="flex justify-between"><span className="text-muted-foreground">IGST</span><span className="font-mono">₹{fmt(billSummary.igstTotal)}</span></div>}
                  {Math.abs(roundOff) > 0.001 && <div className="flex justify-between"><span className="text-muted-foreground">Round Off</span><span className="font-mono">{roundOff > 0 ? '+' : ''}₹{fmt(Math.abs(roundOff))}</span></div>}
                  <Separator />
                  <div className="flex justify-between font-bold text-base pt-1"><span>Grand Total</span><span className="font-mono text-primary">₹{grandTotal.toLocaleString('en-IN')}</span></div>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => { setIsOpen(false); setEditingId(null); resetForm(); }}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {(createMutation.isPending || updateMutation.isPending) ? 'Saving…' : editingId !== null ? 'Save Changes' : 'Save Purchase Bill'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* ── View Bill Sheet ── */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="sm:max-w-2xl overflow-y-auto">
          {viewItem && (
            <>
              <SheetHeader className="mb-4">
                <SheetTitle className="text-primary">Purchase Bill #{String(viewItem.id).padStart(4, '0')}</SheetTitle>
                <SheetDescription>
                  {viewItem.vendorName} · {new Date(viewItem.purchaseDate).toLocaleDateString('en-IN')}
                  {viewItem.invoiceNumber && ` · Ref: ${viewItem.invoiceNumber}`}
                  {` · received at ${(viewItem as any).locationName ?? 'Head Office'}`}
                </SheetDescription>
              </SheetHeader>

              {perm.canDownload && (
                <div className="flex justify-end mb-4">
                  <Button variant="outline" size="sm" onClick={() => handleDownloadPO(viewItem)}>
                    <FileDown className="w-4 h-4 mr-2" /> Download PO PDF
                  </Button>
                </div>
              )}

              {/* Line items table */}
              <div className="border border-border rounded-lg overflow-hidden mb-4">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-left px-3 py-2">Item</th>
                      <th className="text-left px-2 py-2">HSN</th>
                      <th className="text-right px-2 py-2">Qty</th>
                      <th className="text-right px-2 py-2">Rate</th>
                      <th className="text-right px-2 py-2">Disc%</th>
                      <th className="text-right px-2 py-2">Taxable</th>
                      <th className="text-right px-2 py-2">CGST</th>
                      <th className="text-right px-2 py-2">SGST</th>
                      <th className="text-right px-2 py-2">IGST</th>
                      <th className="text-right px-3 py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewItem.lineItems as any[])?.map((li: any, i: number) => (
                      <tr key={i} className="border-t border-border hover:bg-muted/10">
                        <td className="px-3 py-2 font-medium">
                          {getMaterialName(li)}
                          {li.batchNumber && <span className="block text-[10px] font-mono text-muted-foreground">Lot {li.batchNumber}{li.expiryDate ? ` · exp ${new Date(li.expiryDate).toLocaleDateString('en-IN')}` : ''}</span>}
                        </td>
                        <td className="px-2 py-2 font-mono text-muted-foreground">{li.hsnCode || '—'}</td>
                        <td className="text-right px-2 py-2">{li.quantity}</td>
                        <td className="text-right px-2 py-2 font-mono">₹{fmt(Number(li.unitCost))}</td>
                        <td className="text-right px-2 py-2">{Number(li.discount || 0) > 0 ? `${li.discount}%` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">₹{fmt(Number(li.taxableValue || (li.quantity * li.unitCost)))}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.cgst || 0) > 0 ? `₹${fmt(Number(li.cgst))}` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.sgst || 0) > 0 ? `₹${fmt(Number(li.sgst))}` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono">{Number(li.igst || 0) > 0 ? `₹${fmt(Number(li.igst))}` : '—'}</td>
                        <td className="text-right px-3 py-2 font-mono font-bold">₹{fmt(Number(li.lineTotal || li.quantity * li.unitCost))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Summary */}
              <div className="bg-muted/20 rounded-lg p-4 space-y-2 text-sm mb-4">
                {Number(viewItem.discountTotal || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">(-) Discount</span><span className="font-mono text-red-500">-₹{fmt(Number(viewItem.discountTotal))}</span></div>
                )}
                {Number(viewItem.taxTotal || 0) > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span className="font-mono">₹{fmt(Number(viewItem.taxTotal))}</span></div>
                )}
                {Math.abs(Number(viewItem.roundOff || 0)) > 0.001 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Round Off</span><span className="font-mono">₹{fmt(Number(viewItem.roundOff))}</span></div>
                )}
                <Separator />
                <div className="flex justify-between font-bold text-base"><span>Grand Total</span><span className="font-mono text-primary">₹{fmt(Number(viewItem.totalAmount))}</span></div>
              </div>

              {viewItem.notes && <p className="text-sm text-muted-foreground italic mb-4">{viewItem.notes}</p>}
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Delete Confirm ── */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Purchase Bill</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Delete bill <span className="font-semibold text-foreground">#{deleteTarget?.id}</span> from <span className="font-semibold">{deleteTarget?.vendorName}</span>?
            <br /><span className="text-destructive text-xs font-medium mt-1 block">Stock additions from this bill will be reversed.</span>
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? 'Deleting…' : 'Delete & Reverse Stock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
