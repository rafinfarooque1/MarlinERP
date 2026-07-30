import { useState, useMemo } from 'react';
import {
  useListMaterials, useCreateMaterial, useUpdateMaterial, useDeleteMaterial, getListMaterialsQueryKey,
  useListRawMaterials, useCreateRawMaterial, useUpdateRawMaterial, useDeleteRawMaterial, getListRawMaterialsQueryKey,
  useListItems, useCreateItem, useUpdateItem, useDeleteItem, getListItemsQueryKey,
  useListBomTemplates, useCreateBomTemplate, useUpdateBomTemplate, useDeleteBomTemplate,
  useListWarehouses, useListOutlets, useListStock,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';
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
import { Plus, Search, Edit2, Trash2, Layers, Download, Eye, ClipboardList, ShieldOff } from 'lucide-react';
import { usePermission } from '@/lib/usePermission';
import { toast } from 'sonner';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { useUnits } from '@/lib/useUnits';
import { useIsHeadOffice, HEAD_OFFICE_ONLY_HINT, isActiveProduct } from '@/lib/productStatus';

type ItemType = 'raw_material' | 'material' | 'item' | 'asset';

const TYPE_LABELS: Record<ItemType, string> = {
  raw_material: 'Packing Material',
  material: 'Raw Material',
  item: 'Item Name (SKU)',
  asset: 'Asset',
};

const TYPE_COLORS: Record<ItemType, string> = {
  raw_material: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  material: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  item: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  asset: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
};

// ── Asset master hooks (assets have their own table; not sale inventory) ──────
// Kept inline (not in the generated api-client) so this page can talk to the
// new /assets endpoints without regenerating the client. Assets carry no MRP,
// GST/HSN or selling price.
interface AssetRow { id: number; name: string; unit: string; description: string; itemCode: string; status: string; }
const ASSETS_KEY = ['assets-master'] as const;
function useListAssets() {
  return useQuery<AssetRow[]>({
    queryKey: ASSETS_KEY,
    queryFn: () => customFetch<AssetRow[]>('/api/inventory/assets'),
  });
}
type AssetPayload = { name: string; unit: string; description?: string; itemCode?: string; status: string };
function useCreateAsset() {
  return useMutation({
    mutationFn: (data: AssetPayload) =>
      customFetch('/api/inventory/assets', { method: 'POST', body: JSON.stringify(data) }),
  });
}
function useUpdateAsset() {
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<AssetPayload> }) =>
      customFetch(`/api/inventory/assets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  });
}
function useDeleteAsset() {
  return useMutation({
    mutationFn: (id: number) =>
      customFetch(`/api/inventory/assets/${id}`, { method: 'DELETE', responseType: 'text' }),
  });
}

const schema = z.object({
  itemType:    z.enum(['raw_material', 'material', 'item', 'asset']),
  name:        z.string().min(1, 'Name required'),
  unit:        z.string().min(1, 'Unit required'),
  hsnCode:     z.string().optional(),
  taxRate:     z.coerce.number().min(0).max(28).optional(),
  cost:        z.coerce.number().min(0).optional(),
  mrp:         z.coerce.number().min(0).optional(),
  reorderLevel: z.coerce.number().min(0).optional(),
  description: z.string().optional(),
  // Left blank, the server issues both from a per-type sequence (FG/RM/PM-0001
  // and a scannable in-store EAN-13). Typed in, they must be unique.
  itemCode:    z.string().trim().max(32, 'Max 32 characters').regex(/^\S*$/, 'No spaces allowed').optional(),
  barcode:     z.string().trim().max(64, 'Max 64 characters').regex(/^\S*$/, 'No spaces allowed').optional(),
  status:      z.enum(['active', 'inactive']),
});
type FormValues = z.infer<typeof schema>;

const bomSchema = z.object({
  lines: z.array(z.object({
    materialType: z.enum(['material', 'raw_material']),
    materialId: z.coerce.number().min(1, 'Select material'),
    quantity: z.coerce.number().min(0.0001, 'Qty > 0'),
  })).min(1, 'Add at least one material line'),
  notes: z.string().optional(),
});
type BomFormValues = z.infer<typeof bomSchema>;

const defaultBomLine = { materialType: 'raw_material' as const, materialId: 0, quantity: 1 };

export default function ItemMaster() {
  const perm = usePermission('page:/production/item-master');
  // Item masters are company-wide, so only Head Office may change them. The
  // server enforces this; here we simply stop offering the controls.
  const { isHeadOffice } = useIsHeadOffice();
  const { data: rawMaterials = [], isLoading: rmLoading } = useListRawMaterials();
  const { data: materials = [], isLoading: mLoading } = useListMaterials();
  const { data: items = [], isLoading: iLoading } = useListItems();
  const { data: assets = [], isLoading: aLoading } = useListAssets();
  const { data: bomTemplates = [] } = useListBomTemplates();
  const { units } = useUnits();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [locType, setLocType] = useState<'all' | 'headoffice' | 'warehouse' | 'outlet'>('all');
  const [locId, setLocId] = useState<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{ id: number; type: ItemType } | null>(null);
  const [viewItem, setViewItem] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string; type: ItemType } | null>(null);
  const [bomTarget, setBomTarget] = useState<any>(null);

  // Location filter data
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  const locStockEnabled = locType !== 'all' && (locType === 'headoffice' || locId != null);
  const locStockParams = locType === 'headoffice'
    ? { branchType: 'headoffice' as const }
    : locId != null
      ? { branchType: locType as 'warehouse' | 'outlet', branchId: locId }
      : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: locStockRaw = [] } = useListStock(locStockParams, {
    query: { enabled: locStockEnabled } as any,
  });
  const stockMap = useMemo(() => {
    if (!locStockEnabled) return null;
    const m = new Map<string, number>();
    (locStockRaw as any[]).forEach(s => {
      m.set(`${s.materialType}:${s.itemId}`, Number(s.quantity ?? 0));
    });
    return m;
  }, [locStockRaw, locStockEnabled]);

  const createRM = useCreateRawMaterial(); const updateRM = useUpdateRawMaterial(); const deleteRM = useDeleteRawMaterial();
  const createM = useCreateMaterial(); const updateM = useUpdateMaterial(); const deleteM = useDeleteMaterial();
  const createI = useCreateItem(); const updateI = useUpdateItem(); const deleteI = useDeleteItem();
  const createA = useCreateAsset(); const updateA = useUpdateAsset(); const deleteA = useDeleteAsset();
  const createBom = useCreateBomTemplate(); const updateBom = useUpdateBomTemplate(); const deleteBom = useDeleteBomTemplate();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { itemType: 'raw_material', name: '', unit: '', hsnCode: '', taxRate: 5, cost: 0, mrp: 0, reorderLevel: 10, description: '' },
  });

  const watchType = form.watch('itemType');

  const bomForm = useForm<BomFormValues>({
    resolver: zodResolver(bomSchema),
    defaultValues: { lines: [defaultBomLine], notes: '' },
  });
  const { fields: bomFields, append: appendBomLine, remove: removeBomLine } = useFieldArray({ control: bomForm.control, name: 'lines' });

  const bomByItem = new Map((bomTemplates as any[]).map(t => [t.itemId, t]));

  // Combine all into one unified list
  const allItems = [
    ...(rawMaterials as any[]).map(r => ({ ...r, _type: 'raw_material' as ItemType, stock: Number(r.currentStock || 0) })),
    ...(materials as any[]).map(m => ({ ...m, _type: 'material' as ItemType, stock: Number(m.currentStock || 0) })),
    ...(items as any[]).map(i => ({ ...i, _type: 'item' as ItemType, stock: Number(i.productionStock || 0) })),
    // Assets are NOT sale inventory and carry no stock counter — shown at 0.
    ...(assets as any[]).map(a => ({ ...a, _type: 'asset' as ItemType, stock: 0 })),
  ];

  const q = search.trim().toLowerCase();
  const filtered = allItems.filter(i =>
    (typeFilter === 'all' || i._type === typeFilter) &&
    (statusFilter === 'all' || (isActiveProduct(i) ? 'active' : 'inactive') === statusFilter) &&
    (q === '' ||
      i.name.toLowerCase().includes(q) ||
      (i.hsnCode || '').toLowerCase().includes(q) ||
      // Codes and barcodes are how the warehouse actually refers to a product,
      // so searching for either has to land.
      (i.itemCode || '').toLowerCase().includes(q) ||
      (i.barcode || '').toLowerCase().includes(q))
  );

  const isLoading = rmLoading || mLoading || iLoading || aLoading;

  const openAdd = (type?: ItemType) => {
    setEditTarget(null);
    form.reset({ itemType: type || 'raw_material', name: '', unit: units[0] || '', hsnCode: '', taxRate: 5, cost: 0, mrp: 0, reorderLevel: 10, description: '', itemCode: '', barcode: '', status: 'active' });
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
      cost: Number(item.cost ?? 0),
      mrp: Number(item.mrp ?? 0),
      reorderLevel: Number(item.reorderLevel ?? 10),
      description: item.description || '',
      itemCode: item.itemCode || '',
      barcode: item.barcode || '',
      status: isActiveProduct(item) ? 'active' : 'inactive',
    });
    setIsOpen(true);
  };

  const openBom = (item: any) => {
    const existing = bomByItem.get(item.id);
    bomForm.reset(existing
      ? { lines: (existing.lines || []).map((l: any) => ({ materialType: l.materialType, materialId: l.materialId, quantity: Number(l.quantity) })), notes: existing.notes || '' }
      : { lines: [defaultBomLine], notes: '' });
    setBomTarget(item);
  };

  const onBomSubmit = (data: BomFormValues) => {
    if (!bomTarget) return;
    const existing = bomByItem.get(bomTarget.id);
    const opts = {
      onSuccess: () => {
        toast.success(existing ? 'BOM template updated' : 'BOM template created');
        setBomTarget(null);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to save BOM'),
    };
    if (existing) {
      updateBom.mutate({ id: existing.id, data: { lines: data.lines as any, notes: data.notes } }, opts);
    } else {
      createBom.mutate({ itemId: bomTarget.id, lines: data.lines as any, notes: data.notes }, opts);
    }
  };

  const handleBomDelete = () => {
    if (!bomTarget) return;
    const existing = bomByItem.get(bomTarget.id);
    if (!existing) return;
    deleteBom.mutate(existing.id, {
      onSuccess: () => { toast.success('BOM template deleted'); setBomTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    });
  };

  const onSubmit = (data: FormValues) => {
    const type = data.itemType;
    const key = type === 'raw_material' ? getListRawMaterialsQueryKey() : type === 'material' ? getListMaterialsQueryKey() : type === 'item' ? getListItemsQueryKey() : ASSETS_KEY;
    const opts = {
      onSuccess: () => {
        toast.success(editTarget ? 'Item updated' : 'Item created');
        queryClient.invalidateQueries({ queryKey: key as any });
        setIsOpen(false);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    };

    // Assets are capital items: only name/unit/description/code/status apply.
    if (type === 'asset') {
      const assetData: AssetPayload = {
        name: data.name, unit: data.unit,
        description: data.description,
        ...(data.itemCode?.trim() ? { itemCode: data.itemCode.trim() } : {}),
        status: data.status,
      };
      if (editTarget) updateA.mutate({ id: editTarget.id, data: assetData }, opts);
      else createA.mutate(assetData, opts);
      return;
    }
    // raw_material / material: production cost auto-derives from purchases; mrp is manually set
    // Blank code/barcode are omitted, not sent as '' — on create that asks the
    // server to issue them, and on edit it leaves the existing values alone.
    const identity = {
      ...(data.itemCode?.trim() ? { itemCode: data.itemCode.trim() } : {}),
      ...(data.barcode?.trim() ? { barcode: data.barcode.trim() } : {}),
      status: data.status,
    };
    const sharedData = { name: data.name, unit: data.unit, description: data.description, hsnCode: data.hsnCode || '', taxRate: Number(data.taxRate ?? 5), mrp: Number(data.mrp ?? 0), ...identity };
    const itemData = { ...sharedData, cost: Number(data.cost ?? 0), reorderLevel: Number(data.reorderLevel ?? 10) };

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
    const key = type === 'raw_material' ? getListRawMaterialsQueryKey() : type === 'material' ? getListMaterialsQueryKey() : type === 'item' ? getListItemsQueryKey() : ASSETS_KEY;
    const opts = {
      onSuccess: () => { toast.success('Deleted'); queryClient.invalidateQueries({ queryKey: key as any }); setDeleteTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Delete failed'),
    };
    if (type === 'raw_material') deleteRM.mutate({ id } as any, opts);
    else if (type === 'material') deleteM.mutate({ id } as any, opts);
    else if (type === 'item') deleteI.mutate({ id } as any, opts);
    else deleteA.mutate(id, opts);
  };

  const isPending = createRM.isPending || updateRM.isPending || createM.isPending || updateM.isPending || createI.isPending || updateI.isPending || createA.isPending || updateA.isPending;
  const bomExisting = bomTarget ? bomByItem.get(bomTarget.id) : null;

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">You don't have permission to view this page.<br />Contact your administrator to request access.</p>
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
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Layers className="w-6 h-6 text-primary" /> Item Master</h1>
            <p className="text-muted-foreground mt-1">
              {isHeadOffice
                ? 'All packing materials, raw materials and Item Name (SKU) in one place'
                : HEAD_OFFICE_ONLY_HINT}
            </p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('items.csv', filtered.map(i => ({
              Code: (i as any).itemCode || '', Barcode: (i as any).barcode || '',
              Type: (TYPE_LABELS as any)[i._type] ?? i._type, Name: i.name, Unit: i.unit,
              HSN: (i as any).hsnCode || '', 'Tax%': (i as any).taxRate || '',
              Stock: i.stock, Status: isActiveProduct(i) ? 'Active' : 'Inactive',
              Description: i.description || '',
            })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            )}
            {isHeadOffice && perm.canAdd && <Button onClick={() => openAdd()}><Plus className="w-4 h-4 mr-2" /> Add Item</Button>}
          </div>
        </div>

        {/* Summary badges */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {(['raw_material', 'material', 'item', 'asset'] as ItemType[]).map(t => {
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

            {/* Cascading location filter — step 1: branch type */}
            <Select
              value={locType}
              onValueChange={v => {
                setLocType(v as typeof locType);
                setLocId(null); // reset second select when type changes
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                <SelectItem value="headoffice">Head Office</SelectItem>
                <SelectItem value="warehouse">Warehouse</SelectItem>
                {/* Retired outlets hold no stock of their own — it moved to their
                    parent warehouses — so the filter is withdrawn while off. */}
                {outletsEnabled && <SelectItem value="outlet">Outlet</SelectItem>}
              </SelectContent>
            </Select>

            {/* Step 2: specific branch (only for warehouse / outlet) */}
            {locType === 'warehouse' && (
              <Select
                value={locId != null ? String(locId) : ''}
                onValueChange={v => setLocId(Number(v))}
              >
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Select warehouse…" />
                </SelectTrigger>
                <SelectContent>
                  {(warehouses as any[]).map((w: any) => (
                    <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {locType === 'outlet' && (
              <Select
                value={locId != null ? String(locId) : ''}
                onValueChange={v => setLocId(Number(v))}
              >
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Select outlet…" />
                </SelectTrigger>
                <SelectContent>
                  {(outlets as any[]).map((o: any) => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Item type filter */}
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-40"><SelectValue placeholder="All Types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="raw_material">Packing Material</SelectItem>
                <SelectItem value="material">Raw Material</SelectItem>
                <SelectItem value="item">Item Name (SKU)</SelectItem>
                <SelectItem value="asset">Asset</SelectItem>
              </SelectContent>
            </Select>

            {/* Status filter — inactive products stay listed here but are kept
                out of every new sale, purchase, transfer and production run. */}
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36"><SelectValue placeholder="All Statuses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="active">Active only</SelectItem>
                <SelectItem value="inactive">Inactive only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Type</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>HSN</TableHead>
                <TableHead>Tax</TableHead>
                <TableHead className="text-right">MRP (₹)</TableHead>
                <TableHead className="text-right">
                  {locType === 'all' ? 'Stock' :
                   locType === 'headoffice' ? 'HO Stock' :
                   locType === 'warehouse' && locId != null ? `${(warehouses as any[]).find((w: any) => w.id === locId)?.name ?? 'Warehouse'} Stock` :
                   locType === 'outlet' && locId != null ? `${(outlets as any[]).find((o: any) => o.id === locId)?.name ?? 'Outlet'} Stock` :
                   'Stock'}
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={10}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={10} className="text-center py-16 text-muted-foreground">
                  <Layers className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No items found</p>
                </TableCell></TableRow>
              ) : filtered.map(item => {
                // Show mrp for all types
                const displayCost = Number((item as any).mrp ?? 0);
                const active = isActiveProduct(item);
                return (
                <TableRow key={`${item._type}-${item.id}`} className={`hover:bg-muted/10 ${active ? '' : 'opacity-60'}`}>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${(TYPE_COLORS as any)[item._type] ?? ''}`}>
                      {TYPE_LABELS[item._type as ItemType] ?? item._type}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="font-mono text-sm font-semibold">{(item as any).itemCode || '—'}</div>
                    {(item as any).barcode && (
                      <div className="font-mono text-[10px] text-muted-foreground tracking-tight">{(item as any).barcode}</div>
                    )}
                  </TableCell>
                  <TableCell className="font-medium">
                    {item.name}
                    {item._type === 'item' && bomByItem.has(item.id) && (
                      <Badge variant="outline" className="ml-2 text-[10px] bg-primary/5 text-primary border-primary/30">BOM</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{item.unit}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{(item as any).hsnCode || '—'}</TableCell>
                  <TableCell className="text-sm">{(item as any).taxRate ? `${Number((item as any).taxRate)}%` : '—'}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {displayCost > 0 ? `₹${displayCost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold">
                    {(() => {
                      const qty = stockMap
                        ? (stockMap.get(`${item._type}:${item.id}`) ?? 0)
                        : item.stock;
                      return qty > 0
                        ? qty.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })
                        : <span className="text-muted-foreground font-normal">0</span>;
                    })()}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs ${active
                      ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                      : 'bg-muted text-muted-foreground border-border'}`}>
                      {active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {item._type === 'item' && perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title={bomByItem.has(item.id) ? 'Edit BOM template' : 'Set BOM template'} onClick={() => openBom(item)}>
                          <ClipboardList className="w-4 h-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(item)}><Eye className="w-4 h-4" /></Button>
                      {isHeadOffice && perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => openEdit(item)}><Edit2 className="w-4 h-4" /></Button>
                      )}
                      {isHeadOffice && perm.canDelete && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => setDeleteTarget({ id: item.id, name: item.name, type: item._type })}><Trash2 className="w-4 h-4" /></Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                );
              })}
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
                      <SelectItem value="raw_material">Packing Material</SelectItem>
                      <SelectItem value="material">Raw Material</SelectItem>
                      <SelectItem value="item">Item Name (SKU)</SelectItem>
                      <SelectItem value="asset">Asset</SelectItem>
                    </SelectContent>
                  </Select>
                  {watchType === 'asset' && (
                    <p className="text-[11px] text-muted-foreground">
                      Assets are capital items (e.g. freezers), not sale inventory — no MRP, GST/HSN or selling price. Purchase them on the Purchases page.
                    </p>
                  )}
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
                {watchType !== 'asset' && (
                <FormField control={form.control} name="hsnCode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>HSN Code</FormLabel>
                    <FormControl><Input className="font-mono" placeholder="e.g. 09011111" {...field} /></FormControl>
                  </FormItem>
                )} />
                )}
                {watchType !== 'asset' && (
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
                )}
                {/* Cost / Rate — SKUs only (production cost, auto-derived for materials) */}
                {watchType === 'item' && (
                  <FormField control={form.control} name="cost" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Cost / Rate (₹)</FormLabel>
                      <FormControl><Input type="number" min={0} step="0.01" placeholder="0.00" className="font-mono" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                {/* MRP — sale-inventory types only (assets carry no selling price) */}
                {watchType !== 'asset' && (
                <FormField control={form.control} name="mrp" render={({ field }) => (
                  <FormItem>
                    <FormLabel>MRP (₹)</FormLabel>
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
              {/* Identification — left blank, the server issues both */}
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="itemCode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Item Code</FormLabel>
                    <FormControl>
                      <Input className="font-mono" placeholder={editTarget ? '' : 'Auto (FG/RM/PM-0001)'} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="barcode" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Barcode</FormLabel>
                    <FormControl>
                      <Input className="font-mono" placeholder={editTarget ? '' : 'Auto (EAN-13)'} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="status" render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="active">Active — available everywhere</SelectItem>
                        <SelectItem value="inactive">Inactive — kept out of new entries</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground">
                      Inactive products stay on past records and reports; they just can't be added to a new sale, purchase, transfer or production run.
                    </p>
                    <FormMessage />
                  </FormItem>
                )} />
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

      {/* BOM Template Dialog */}
      <Dialog open={!!bomTarget} onOpenChange={v => !v && setBomTarget(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ClipboardList className="w-5 h-5 text-primary" /> BOM Template — {bomTarget?.name}</DialogTitle>
            <DialogDescription>
              Materials required to produce <span className="font-semibold text-foreground">one {bomTarget?.unit || 'unit'}</span> of this item.
              Production entry warns when a batch consumes more than the template allows.
            </DialogDescription>
          </DialogHeader>
          <Form {...bomForm}>
            <form onSubmit={bomForm.handleSubmit(onBomSubmit)} className="space-y-5">
              <div>
                <div className="flex justify-between items-center mb-3">
                  <p className="font-semibold text-sm">Materials per unit produced</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => appendBomLine(defaultBomLine)}><Plus className="w-3 h-3 mr-1" /> Add</Button>
                </div>
                <div className="space-y-2">
                  {bomFields.map((field, i) => {
                    const matType = bomForm.watch(`lines.${i}.materialType`);
                    const opts = matType === 'raw_material' ? rawMaterials : materials;
                    return (
                      <div key={field.id} className="grid grid-cols-11 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                        <div className="col-span-3">
                          <FormField control={bomForm.control} name={`lines.${i}.materialType`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Type</FormLabel>
                              <Select onValueChange={f.onChange} value={f.value}>
                                <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
                                <SelectContent><SelectItem value="raw_material">Packing Material</SelectItem><SelectItem value="material">Raw Material</SelectItem></SelectContent>
                              </Select></FormItem>
                          )} />
                        </div>
                        <div className="col-span-5">
                          <FormField control={bomForm.control} name={`lines.${i}.materialId`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">{matType === 'raw_material' ? 'Packing Material' : 'Raw Material'}</FormLabel>
                              <Select onValueChange={v => f.onChange(Number(v))} value={f.value ? String(f.value) : ''}>
                                <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                                <SelectContent>{(opts as any[]).map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}</SelectContent>
                              </Select><FormMessage /></FormItem>
                          )} />
                        </div>
                        <div className="col-span-2">
                          <FormField control={bomForm.control} name={`lines.${i}.quantity`} render={({ field: f }) => (
                            <FormItem><FormLabel className="text-xs">Qty / unit</FormLabel><FormControl><Input type="number" step="0.0001" className="h-8 text-xs font-mono" {...f} /></FormControl><FormMessage /></FormItem>
                          )} />
                        </div>
                        <div className="col-span-1 pb-1 flex justify-end">
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeBomLine(i)} disabled={bomFields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <FormField control={bomForm.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea placeholder="e.g. Standard recipe for 1 kg pack…" rows={2} {...field} /></FormControl></FormItem>
              )} />

              <DialogFooter className="gap-2 sm:justify-between">
                <div>
                  {bomExisting && (
                    <Button type="button" variant="outline" className="text-destructive border-destructive/40 hover:bg-destructive/10" onClick={handleBomDelete} disabled={deleteBom.isPending}>
                      <Trash2 className="w-4 h-4 mr-1.5" /> {deleteBom.isPending ? 'Deleting…' : 'Delete BOM'}
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" type="button" onClick={() => setBomTarget(null)}>Cancel</Button>
                  <Button type="submit" disabled={createBom.isPending || updateBom.isPending}>
                    {(createBom.isPending || updateBom.isPending) ? 'Saving…' : bomExisting ? 'Update BOM' : 'Save BOM'}
                  </Button>
                </div>
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
                {/* asChild → renders a div: Badge is a div and can't sit inside a p */}
                <SheetDescription asChild className="flex flex-wrap items-center gap-2"><div>
                  <Badge variant="outline" className={`text-xs ${(TYPE_COLORS as any)[viewItem._type] ?? ''}`}>{(TYPE_LABELS as any)[viewItem._type] ?? viewItem._type}</Badge>
                  <Badge variant="outline" className={`text-xs ${isActiveProduct(viewItem)
                    ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                    : 'bg-muted text-muted-foreground border-border'}`}>
                    {isActiveProduct(viewItem) ? 'Active' : 'Inactive'}
                  </Badge>
                </div></SheetDescription>
              </SheetHeader>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">Item Code</span><span className="font-mono font-semibold">{viewItem.itemCode || '—'}</span></div>
                <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">Barcode</span><span className="font-mono">{viewItem.barcode || '—'}</span></div>
                <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">Unit</span><span>{viewItem.unit}</span></div>
                {viewItem.hsnCode && <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">HSN Code</span><span className="font-mono">{viewItem.hsnCode}</span></div>}
                {viewItem.taxRate !== undefined && <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">GST Rate</span><span>{Number(viewItem.taxRate)}%</span></div>}
                <div className="flex justify-between py-2 border-b border-border"><span className="text-muted-foreground">Current Stock</span><span className="font-mono font-bold">{Number(viewItem.stock).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</span></div>
                {viewItem._type === 'item' ? (
                  <>
                    {Number(viewItem.cost) > 0 && (
                      <div className="flex justify-between py-2 border-b border-border">
                        <span className="text-muted-foreground">Cost / Rate</span>
                        <span className="font-mono font-bold">₹{Number(viewItem.cost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                    )}
                    {Number(viewItem.avgCost) > 0 && (
                      <div className="flex justify-between py-2 border-b border-border">
                        <span className="text-muted-foreground">Avg Cost (weighted)</span>
                        <span className="font-mono font-bold">₹{Number(viewItem.avgCost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      </div>
                    )}
                    <div className="flex justify-between py-2 border-b border-border">
                      <span className="text-muted-foreground">Reorder Level</span>
                      <span className="font-mono">{Number(viewItem.reorderLevel ?? 10)}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-border items-center">
                      <span className="text-muted-foreground">BOM Template</span>
                      {bomByItem.has(viewItem.id)
                        ? <Badge variant="outline" className="text-xs bg-primary/5 text-primary border-primary/30">{(bomByItem.get(viewItem.id) as any).lines?.length ?? 0} inputs / unit</Badge>
                        : <span className="text-muted-foreground text-xs">Not set</span>}
                    </div>
                  </>
                ) : (
                  /* raw_material / material — cost auto-derives from purchases */
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">Avg Cost (from purchases)</span>
                    <span className="font-mono font-bold">
                      {Number(viewItem.avgCost) > 0
                        ? `₹${Number(viewItem.avgCost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                        : <span className="text-muted-foreground text-xs">No purchases yet</span>}
                    </span>
                  </div>
                )}
                {viewItem.description && <div className="py-2"><p className="text-muted-foreground mb-1">Description</p><p>{viewItem.description}</p></div>}
              </div>
              <div className="flex flex-col gap-2 mt-6">
                {viewItem._type === 'item' && perm.canEdit && (
                  <div className="flex gap-2">
                    <Button className="flex-1" variant="outline" onClick={() => { const it = viewItem; setViewItem(null); openBom(it); }}>
                      <ClipboardList className="w-4 h-4 mr-2" /> BOM
                    </Button>
                  </div>
                )}
                {isHeadOffice && (perm.canEdit || perm.canDelete) && (
                  <div className="flex gap-2">
                    {perm.canEdit && (
                      <Button className="flex-1" variant="outline" onClick={() => { setViewItem(null); openEdit(viewItem); }}>
                        <Edit2 className="w-4 h-4 mr-2" /> Edit
                      </Button>
                    )}
                    {perm.canDelete && (
                      <Button className="flex-1" variant="destructive" onClick={() => { setViewItem(null); setDeleteTarget({ id: viewItem.id, name: viewItem.name, type: viewItem._type }); }}>
                        <Trash2 className="w-4 h-4 mr-2" /> Delete
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={v => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-destructive flex items-center gap-2"><Trash2 className="w-5 h-5" />Delete Item</DialogTitle></DialogHeader>
          {/* div, not p: Badge renders a div and nesting one inside a p is invalid HTML */}
          <div className="text-sm text-muted-foreground py-2">Delete <Badge variant="outline" className={`text-xs mr-1 ${deleteTarget ? ((TYPE_COLORS as any)[deleteTarget.type] ?? '') : ''}`}>{deleteTarget ? ((TYPE_LABELS as any)[deleteTarget.type] ?? deleteTarget.type) : ''}</Badge>
            <span className="font-semibold text-foreground">{deleteTarget?.name}</span>? This cannot be undone.</div>
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
