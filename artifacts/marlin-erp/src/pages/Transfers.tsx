/**
 * Unified Transfers page
 *
 * Headoffice admins — see every transfer; create from HO → Warehouse or
 *   Warehouse → Outlet (items-only); materialType + FEFO batch picker active
 *   only when source = Head Office.
 *
 * Branch employees (warehouse / outlet) — server already scopes the list to
 *   their branch; "From" is locked to their location in the create form.
 */
import { useState, useMemo } from 'react';
import {
  useListStockTransfers, useCreateStockTransfer,
  useListItems, useListRawMaterials, useListMaterials,
  useListWarehouses, useListOutlets, useListStock,
  getListStockTransfersQueryKey, useGetCompanySettings,
  useSuggestBatches, useListStockBatches,
  useGetMe,
  type StockBatch,
} from '@workspace/api-client-react';
import { useApproveTransfer, useRejectTransfer } from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
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
import {
  Plus, Search, Truck, Download, Eye, Calendar, Trash2, FileDown,
  PackageOpen, AlertTriangle, Clock, CheckCircle2, XCircle,
  PackageCheck, Layers, ArrowRightLeft, ShieldOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV, downloadPDFFromEndpoint } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// ── Form schema ───────────────────────────────────────────────────────────────
const schema = z.object({
  fromType: z.enum(['headoffice', 'warehouse', 'outlet']),
  fromId:   z.coerce.number().min(0),
  toType:   z.enum(['warehouse', 'outlet']),
  toId:     z.coerce.number().min(1, 'Destination required'),
  transferDate: z.string().min(1, 'Date required'),
  lineItems: z.array(z.object({
    materialType: z.enum(['item', 'material', 'raw_material']).default('item'),
    itemId: z.coerce.number().min(1, 'Select item'),
    quantity: z.coerce.number().min(1, 'Qty > 0'),
  })).min(1, 'Add at least one item'),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const MAT_LABELS: Record<string, string> = {
  item: 'Item (SKU)',
  material: 'Raw Material',
  raw_material: 'Packing Material',
};

// ── Status badge ──────────────────────────────────────────────────────────────
const STATUS_CFG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  in_transit: { label: 'In Transit',  color: 'text-amber-400 bg-amber-400/10 border-amber-400/30',  icon: <Clock className="w-3 h-3" /> },
  completed:  { label: 'Approved',    color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30', icon: <CheckCircle2 className="w-3 h-3" /> },
  rejected:   { label: 'Rejected',    color: 'text-red-400 bg-red-400/10 border-red-400/30',    icon: <XCircle className="w-3 h-3" /> },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_CFG[status] ?? { label: status, color: 'text-muted-foreground bg-muted/20 border-border', icon: null };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${c.color}`}>
      {c.icon}{c.label}
    </span>
  );
}

// ── FEFO batch picker (headoffice source only) ────────────────────────────────
type BatchOverride = Array<{ batchId: number; quantity: number }>;

function BatchPicker({ itemId, quantity, unit, fromType, fromId, override, onChange }: {
  itemId: number; quantity: number; unit?: string;
  fromType: string; fromId: number;
  override?: BatchOverride;
  onChange: (v?: BatchOverride) => void;
}) {
  const [manual, setManual] = useState(false);
  const { data: suggestion } = useSuggestBatches({
    branchType: fromType as any, branchId: fromId,
    itemId: itemId > 0 ? itemId : undefined,
    quantity: quantity > 0 ? quantity : undefined,
  });
  const { data: allBatches = [] } = useListStockBatches({ branchType: fromType as any, branchId: fromId });
  if (!itemId || !(quantity > 0)) return null;
  const itemBatches = (allBatches as StockBatch[]).filter(b => b.itemId === itemId);
  if (itemBatches.length === 0) return null;

  const plan      = suggestion?.plan ?? [];
  const shortfall = suggestion?.shortfall ?? 0;
  const overrideQty = (batchId: number) => override?.find(o => o.batchId === batchId)?.quantity ?? 0;
  const overrideTotal = (override ?? []).reduce((s, o) => s + Number(o.quantity || 0), 0);
  const fmtExp = (b: { expiryDate?: string | null }) =>
    b.expiryDate ? new Date(b.expiryDate).toLocaleDateString('en-IN') : 'no expiry';

  const startManual = () => {
    const seeded = plan.filter(p => p.batchId != null).map(p => ({ batchId: p.batchId!, quantity: Number(p.quantity) }));
    onChange(seeded.length ? seeded : []); setManual(true);
  };
  const resetFefo = () => { onChange(undefined); setManual(false); };
  const setQty = (batchId: number, q: number) => {
    const rest = (override ?? []).filter(o => o.batchId !== batchId);
    onChange(q > 0 ? [...rest, { batchId, quantity: q }] : rest);
  };

  return (
    <div className="col-span-11 -mt-1 rounded-md border border-dashed border-primary/25 bg-primary/[0.03] px-3 py-2">
      {!manual ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Layers className="w-3 h-3" /> FEFO picks
          </span>
          {plan.length === 0
            ? <span className="text-xs text-muted-foreground">no batch records — dispatch proceeds untracked</span>
            : plan.map((p, idx) => (
              <span key={idx} className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-mono">
                {p.batchNumber} · {Number(p.quantity)} <span className="text-muted-foreground">exp {fmtExp(p)}</span>
              </span>
            ))}
          {shortfall > 0 && <span className="text-[11px] text-amber-500 font-medium">+{shortfall} untracked</span>}
          {itemBatches.length > 1 && (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-primary ml-auto" onClick={startManual}>
              Pick manually
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <Layers className="w-3 h-3" /> Manual batch allocation
            </span>
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={resetFefo}>Use FEFO</Button>
          </div>
          {itemBatches.map(b => (
            <div key={b.id} className="flex items-center gap-2 text-xs">
              <span className="font-mono w-28 truncate">{b.batchNumber}</span>
              <span className="text-muted-foreground flex-1">exp {fmtExp(b)} · {Number(b.quantity)} {b.unit} avail</span>
              <Input
                type="number" min={0} max={Number(b.quantity)} step="any"
                className="h-7 w-24 text-xs font-mono"
                value={overrideQty(b.id) || ''} placeholder="0"
                onChange={e => setQty(b.id, Math.min(Number(e.target.value) || 0, Number(b.quantity)))}
              />
            </div>
          ))}
          <p className={`text-[11px] font-medium ${Math.abs(overrideTotal - quantity) < 0.001 ? 'text-emerald-500' : 'text-amber-500'}`}>
            Allocated {overrideTotal} of {quantity} {unit ?? ''}
            {Math.abs(overrideTotal - quantity) >= 0.001 ? ' — totals must match to dispatch' : ''}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Approve / Reject dialog ───────────────────────────────────────────────────
function ApproveDialog({
  transfer, allItemsMap, open, onClose,
}: { transfer: any; allItemsMap: Map<string, any>; open: boolean; onClose: () => void }) {
  const approveMutation = useApproveTransfer();
  const rejectMutation  = useRejectTransfer();
  const qc = useQueryClient();

  const [received, setReceived] = useState<Record<number, number>>(() => {
    const init: Record<number, number> = {};
    (transfer?.lineItems ?? []).forEach((li: any) => { init[li.itemId] = li.quantity; });
    return init;
  });
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);

  if (!transfer) return null;

  const handleApprove = () => {
    const receivedLineItems = (transfer.lineItems ?? []).map((li: any) => ({
      itemId: li.itemId,
      quantity: received[li.itemId] ?? li.quantity,
      costPrice: li.costPrice ?? 0,
      materialType: li.materialType ?? 'item',
    }));
    approveMutation.mutate(
      { id: transfer.id, receivedLineItems, approvedBy: 'admin' },
      {
        onSuccess: () => {
          toast.success('Transfer approved — stock credited');
          qc.invalidateQueries({ queryKey: getListStockTransfersQueryKey() });
          onClose();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Approval failed'),
      }
    );
  };

  const handleReject = () => {
    rejectMutation.mutate(
      { id: transfer.id, rejectionReason: rejectReason },
      {
        onSuccess: () => {
          toast.success('Transfer rejected — source stock restored');
          qc.invalidateQueries({ queryKey: getListStockTransfersQueryKey() });
          setShowRejectConfirm(false);
          onClose();
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Rejection failed'),
      }
    );
  };

  return (
    <>
      <Dialog open={open && !showRejectConfirm} onOpenChange={v => !v && onClose()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PackageCheck className="w-5 h-5 text-primary" /> Receive &amp; Approve Transfer
            </DialogTitle>
            <DialogDescription>
              Verify the physical stock received. Adjust quantities if anything is short, then approve.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3 p-4 bg-muted/20 rounded-lg border border-border text-sm">
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Challan</p>
              <p className="font-mono font-bold text-primary">{transfer.challanNumber}</p></div>
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Date</p>
              <p>{new Date(transfer.transferDate).toLocaleDateString('en-IN')}</p></div>
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Dispatched From</p>
              <p className="font-medium">{transfer.fromName}<span className="text-muted-foreground capitalize ml-1">({transfer.fromType})</span></p></div>
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Receiving At</p>
              <p className="font-medium">{transfer.toName}<span className="text-muted-foreground capitalize ml-1">({transfer.toType})</span></p></div>
            <div className="col-span-2">
              {(transfer as any).transferType === 'interstate'
                ? <Badge variant="outline" className="text-orange-400 border-orange-400/40 text-xs">Interstate Transfer (IGST)</Badge>
                : (transfer as any).transferType === 'intrastate'
                  ? <Badge variant="outline" className="text-yellow-500 border-yellow-500/40 text-xs">Intrastate Transfer (CGST+SGST)</Badge>
                  : <Badge variant="outline" className="text-blue-400 border-blue-400/40 text-xs">Internal Stock Transfer</Badge>}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <p className="font-semibold text-sm">Items to Receive</p>
              <span className="text-xs text-muted-foreground">— enter actual quantity physically received</span>
            </div>
            <div className="space-y-2">
              {(transfer.lineItems ?? []).map((li: any) => {
                const item = allItemsMap.get(`${li.materialType ?? 'item'}:${li.itemId}`);
                const recvQty = received[li.itemId] ?? li.quantity;
                const isShort = recvQty < li.quantity;
                return (
                  <div key={li.itemId}
                    className={`grid grid-cols-12 gap-3 items-center p-3 rounded-lg border ${isShort ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-muted/20'}`}>
                    <div className="col-span-5">
                      <p className="font-medium text-sm">{item?.name ?? `Item #${li.itemId}`}</p>
                      <p className="text-xs text-muted-foreground">{(item as any)?.hsnCode ? `HSN: ${(item as any).hsnCode}` : item?.unit ?? ''}</p>
                      {Array.isArray(li.batchBreakdown) && li.batchBreakdown.length > 0 && (
                        <p className="text-[10px] font-mono text-muted-foreground mt-1">
                          {li.batchBreakdown.map((bb: any) => `${bb.batchNumber || `#${bb.batchId}`} · ${Number(bb.quantity)}`).join('   ')}
                        </p>
                      )}
                    </div>
                    <div className="col-span-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Dispatched</p>
                      <p className="font-mono font-bold text-sm">{li.quantity}
                        <span className="text-muted-foreground font-normal ml-1 text-xs">{item?.unit ?? ''}</span></p>
                    </div>
                    <div className="col-span-4">
                      <p className="text-xs text-muted-foreground mb-1">Received <span className="text-destructive">*</span></p>
                      <Input
                        type="number" min={0} max={li.quantity} value={recvQty}
                        onChange={e => setReceived(r => ({ ...r, [li.itemId]: Number(e.target.value) }))}
                        className={`h-8 text-sm font-mono ${isShort ? 'border-amber-500 focus-visible:ring-amber-500' : ''}`}
                      />
                      {isShort && (
                        <p className="text-[10px] text-amber-400 mt-1 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />{li.quantity - recvQty} short
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {transfer.notes && (
            <div className="p-3 bg-muted/20 rounded-lg border border-border text-sm">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Notes</p>
              <p>{transfer.notes}</p>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
            <Button variant="destructive" type="button" onClick={() => setShowRejectConfirm(true)}>
              <XCircle className="w-4 h-4 mr-2" /> Reject
            </Button>
            <Button type="button" onClick={handleApprove} disabled={approveMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <CheckCircle2 className="w-4 h-4 mr-2" />
              {approveMutation.isPending ? 'Approving…' : 'Approve & Credit Stock'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRejectConfirm} onOpenChange={v => !v && setShowRejectConfirm(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="w-5 h-5" />Reject Transfer
            </DialogTitle>
            <DialogDescription>
              Stock will be returned to {transfer.fromName}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={3} placeholder="Reason for rejection…" value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRejectConfirm(false)}>Back</Button>
            <Button variant="destructive" onClick={handleReject} disabled={rejectMutation.isPending}>
              {rejectMutation.isPending ? 'Rejecting…' : 'Confirm Rejection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Transfers() {
  // Single permission module controls all transfer access
  const perm = usePermission('HO Transfers');
  const permLoading = perm.isLoading;
  const canView     = perm.canView;
  const canAdd      = perm.canAdd;
  const canDownload = perm.canDownload;

  // User identity
  const { data: user } = useGetMe();
  const userBranchType = (user as any)?.branchType as 'headoffice' | 'warehouse' | 'outlet' | undefined;
  const userBranchId   = (user as any)?.branchId   as number | undefined;
  const userBranchName = (user as any)?.branchName as string | undefined;
  const isEmployee = !!userBranchType && userBranchType !== 'headoffice';

  // Master data
  const { data: transfers = [], isLoading } = useListStockTransfers();
  const { data: items = [] }        = useListItems();
  const { data: rawMaterials = [] } = useListRawMaterials();
  const { data: materials = [] }    = useListMaterials();
  const { data: warehouses = [] }   = useListWarehouses();
  const { data: outlets = [] }      = useListOutlets();
  const { data: companySettings }   = useGetCompanySettings();
  const queryClient = useQueryClient();
  const createMutation = useCreateStockTransfer();

  // Composite item map for name/unit resolution
  const allItemsMap = useMemo(() => new Map<string, any>([
    ...(items as any[]).map(i  => [`item:${i.id}`,          i]  as [string, any]),
    ...(materials as any[]).map(m  => [`material:${m.id}`,  m]  as [string, any]),
    ...(rawMaterials as any[]).map(m => [`raw_material:${m.id}`, m] as [string, any]),
  ]), [items, materials, rawMaterials]);

  // ── List view state ─────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [tab,    setTab]    = useState<'all' | 'in_transit' | 'completed' | 'rejected'>('all');
  const [viewItem,      setViewItem]      = useState<any>(null);
  const [approveTarget, setApproveTarget] = useState<any>(null);
  const [isOpen,        setIsOpen]        = useState(false);

  // Server already scoped the list for employees — just filter UI tabs/search
  const list = (Array.isArray(transfers) ? transfers : []) as any[];
  const searched = list.filter((t: any) =>
    t.challanNumber?.toLowerCase().includes(search.toLowerCase()) ||
    t.fromName?.toLowerCase().includes(search.toLowerCase()) ||
    t.toName?.toLowerCase().includes(search.toLowerCase())
  );
  const filtered     = tab === 'all' ? searched : searched.filter((t: any) => t.status === tab);
  const pendingCount = list.filter((t: any) => t.status === 'in_transit').length;

  // Employee can only approve transfers coming TO their location
  const canReceive = (t: any) =>
    t.status === 'in_transit' && (
      !isEmployee ||
      (t.toType === userBranchType && Number(t.toId) === userBranchId)
    );

  // ── Create form ─────────────────────────────────────────────────────────────
  // Default "from" differs: employees start locked to their branch; admins start at HO
  const defaultFrom = isEmployee
    ? { fromType: userBranchType as 'warehouse' | 'outlet', fromId: userBranchId ?? 0 }
    : { fromType: 'headoffice' as const, fromId: 1 };

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      ...defaultFrom,
      toType: 'warehouse',
      toId: 0,
      transferDate: new Date().toISOString().split('T')[0],
      lineItems: [{ materialType: 'item' as const, itemId: 0, quantity: 1 }],
      notes: '',
    },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const [overrides, setOverrides] = useState<Record<number, BatchOverride | undefined>>({});

  const watchFromType = form.watch('fromType');
  const watchFromId   = form.watch('fromId');
  const watchToType   = form.watch('toType');
  const isFromHO      = watchFromType === 'headoffice';

  // From location options (admin only — employees have it locked)
  const fromTypeOptions = [
    { value: 'headoffice', label: 'Head Office (Production)' },
    { value: 'warehouse',  label: 'Warehouse' },
    { value: 'outlet',     label: 'Outlet' },
  ];
  const fromLocationOptions = watchFromType === 'warehouse' ? warehouses : watchFromType === 'outlet' ? outlets : [];

  // To options based on from
  const toTypeOptions = useMemo(() => {
    if (isFromHO) return [{ value: 'warehouse', label: 'Warehouse' }]; // HO always → Warehouse
    if (watchFromType === 'warehouse') return [{ value: 'outlet', label: 'Outlet' }, { value: 'warehouse', label: 'Warehouse' }];
    return [{ value: 'warehouse', label: 'Warehouse' }]; // outlet → warehouse only
  }, [isFromHO, watchFromType]);

  const toOptions = useMemo(() => {
    if (watchToType === 'outlet') {
      if (watchFromType === 'warehouse' && watchFromId > 0)
        return (outlets as any[]).filter(o => Number(o.warehouseId) === watchFromId);
      if (isEmployee && userBranchType === 'warehouse' && userBranchId)
        return (outlets as any[]).filter(o => Number(o.warehouseId) === userBranchId);
      return outlets;
    }
    // toType === 'warehouse'
    if (watchFromType === 'outlet' && watchFromId > 0) {
      const parentId = (outlets as any[]).find(o => o.id === watchFromId)?.warehouseId;
      if (parentId) return (warehouses as any[]).filter(w => w.id === parentId);
    }
    if (isEmployee && userBranchType === 'outlet' && userBranchId) {
      const parentId = (outlets as any[]).find((o: any) => o.id === userBranchId)?.warehouseId;
      if (parentId) return (warehouses as any[]).filter((w: any) => w.id === parentId);
    }
    return watchFromType === 'warehouse' && watchFromId > 0
      ? (warehouses as any[]).filter((w: any) => w.id !== watchFromId)
      : warehouses;
  }, [watchToType, watchFromType, watchFromId, isEmployee, userBranchType, userBranchId, outlets, warehouses]);

  // Stock available at the chosen source
  const { data: branchStock = [] } = useListStock(
    { branchType: watchFromType as any, branchId: isFromHO ? 1 : watchFromId },
    { query: { enabled: !isFromHO || watchFromType === 'headoffice' } as any }
  );
  const { data: productionStock = [] } = useListStock(
    { branchType: 'headoffice', branchId: 1 },
    { query: { enabled: isFromHO } as any }
  );

  type AvailItem = { id: number; name: string; unit: string; materialType: 'item' | 'material' | 'raw_material'; availQty: number };

  const availableItems: AvailItem[] = useMemo(() => {
    if (isFromHO) {
      const stockMap = new Map<string, number>([
        ...(productionStock as any[]).map(s => [`item:${s.itemId}`, Number(s.quantity ?? 0)] as [string, number]),
        ...(rawMaterials as any[]).filter(m => Number(m.currentStock) > 0).map(m => [`raw_material:${m.id}`, Number(m.currentStock)] as [string, number]),
        ...(materials  as any[]).filter(m => Number(m.currentStock) > 0).map(m => [`material:${m.id}`, Number(m.currentStock)] as [string, number]),
      ]);
      return [
        ...(items        as any[]).filter(i => (stockMap.get(`item:${i.id}`)          ?? 0) > 0).map(i => ({ id: i.id, name: i.name, unit: i.unit, materialType: 'item'         as const, availQty: stockMap.get(`item:${i.id}`)          ?? 0 })),
        ...(materials    as any[]).filter(m => (stockMap.get(`material:${m.id}`)      ?? 0) > 0).map(m => ({ id: m.id, name: m.name, unit: m.unit, materialType: 'material'      as const, availQty: stockMap.get(`material:${m.id}`)      ?? 0 })),
        ...(rawMaterials as any[]).filter(m => (stockMap.get(`raw_material:${m.id}`)  ?? 0) > 0).map(m => ({ id: m.id, name: m.name, unit: m.unit, materialType: 'raw_material'  as const, availQty: stockMap.get(`raw_material:${m.id}`)  ?? 0 })),
      ];
    }
    // Warehouse / outlet source — items only
    const sMap = new Map<number, number>((branchStock as any[]).map(s => [s.itemId!, Number(s.quantity ?? 0)]));
    return (items as any[]).filter(i => (sMap.get(i.id) ?? 0) > 0).map(i => ({
      id: i.id, name: i.name, unit: i.unit, materialType: 'item' as const, availQty: sMap.get(i.id) ?? 0,
    }));
  }, [isFromHO, productionStock, branchStock, items, materials, rawMaterials]);

  const removeLine = (i: number) => {
    remove(i);
    setOverrides(prev => {
      const next: typeof prev = {};
      for (const [k, v] of Object.entries(prev)) {
        const idx = Number(k);
        if (idx < i) next[idx] = v;
        else if (idx > i) next[idx - 1] = v;
      }
      return next;
    });
  };

  const openCreate = () => {
    form.reset({
      ...defaultFrom,
      toType: isFromHO ? 'warehouse' : (userBranchType === 'outlet' ? 'warehouse' : 'outlet'),
      toId: 0,
      transferDate: new Date().toISOString().split('T')[0],
      lineItems: [{ materialType: 'item' as const, itemId: 0, quantity: 1 }],
      notes: '',
    });
    setOverrides({});
    setIsOpen(true);
  };

  const onSubmit = (data: FormValues) => {
    const lineItems = data.lineItems.map((li, i) => {
      const ov = (overrides[i] ?? []).filter(o => Number(o.quantity) > 0);
      if (ov.length === 0) return li;
      return { ...li, batchOverride: ov.map(o => ({ batchId: o.batchId, quantity: Number(o.quantity) })) };
    });
    // Validate batch overrides total
    for (let i = 0; i < lineItems.length; i++) {
      const li: any = lineItems[i];
      if (li.batchOverride) {
        const total = li.batchOverride.reduce((s: number, o: any) => s + o.quantity, 0);
        if (Math.abs(total - Number(li.quantity)) > 0.001) {
          toast.error(`Line ${i + 1}: batch allocation (${total}) must equal transfer quantity (${li.quantity})`);
          return;
        }
      }
    }
    const payload = {
      fromType: data.fromType,
      fromId:   data.fromType === 'headoffice' ? 1 : data.fromId,
      toType:   data.toType,
      toId:     data.toId,
      transferDate: data.transferDate,
      lineItems,
      notes: data.notes,
    };
    createMutation.mutate({ data: payload as any }, {
      onSuccess: () => {
        toast.success('Transfer dispatched — receiving location must approve');
        queryClient.invalidateQueries({ queryKey: getListStockTransfersQueryKey() });
        setIsOpen(false);
        form.reset();
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  // ── PDF download ────────────────────────────────────────────────────────────
  const handleDownloadPDF = async (t: any) => {
    const cs = companySettings as any;
    const lineItems = (t.lineItems || []).map((li: any) => {
      const item = allItemsMap.get(`${li.materialType ?? 'item'}:${li.itemId}`);
      return { name: item?.name ?? `Item #${li.itemId}`, hsnCode: (item as any)?.hsnCode, quantity: li.quantity, unit: item?.unit ?? '' };
    });
    try {
      await downloadPDFFromEndpoint('/api/pdf/challan', {
        cs, challanNo: t.challanNumber,
        date: new Date(t.transferDate).toLocaleDateString('en-IN'),
        fromName: t.fromName, fromType: t.fromType,
        toName: t.toName,     toType: t.toType,
        lineItems, isInterstate: t.isInterstate, status: t.status,
        notes: t.notes, approvedBy: t.approvedBy,
      }, `${t.challanNumber || 'Challan'}.pdf`);
    } catch (e: any) { toast.error(e?.message || 'Failed to generate PDF'); }
  };

  // ── Access denied guard ─────────────────────────────────────────────────────
  if (!permLoading && !canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view transfers.<br />Contact your administrator.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  const sourceOk = isFromHO || watchFromId > 0;

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* ── Header ── */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Truck className="w-6 h-6 text-primary" />
              {isEmployee ? `Transfers — ${userBranchName ?? ''}` : 'Stock Transfers'}
            </h1>
            <p className="text-muted-foreground mt-1">
              {isEmployee
                ? 'Transfers to and from your location'
                : 'Head Office → Warehouse · Warehouse → Outlet movements'}
            </p>
          </div>
          <div className="flex gap-2">
            {canDownload && (
              <Button variant="outline" size="sm"
                onClick={() => downloadCSV('transfers.csv', filtered.map((t: any) => ({
                  Challan: t.challanNumber, Date: t.transferDate,
                  From: t.fromName, 'From Type': t.fromType,
                  To: t.toName, 'To Type': t.toType,
                  Items: t.lineItems?.length || 0, Status: t.status,
                })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {canAdd && (
              <Button onClick={openCreate}>
                <Plus className="w-4 h-4 mr-2" /> New Transfer
              </Button>
            )}
          </div>
        </div>

        {/* ── Pending approvals banner ── */}
        {pendingCount > 0 && (
          <div className="flex items-center gap-3 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300">
            <Clock className="w-5 h-5 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-sm">
                {pendingCount} transfer{pendingCount > 1 ? 's' : ''} awaiting approval
              </p>
              <p className="text-xs opacity-80">
                The receiving location must verify physical stock and approve before it enters their inventory.
              </p>
            </div>
            <Button size="sm" variant="outline" className="border-amber-500/40 text-amber-300 hover:bg-amber-500/20"
              onClick={() => setTab('in_transit')}>
              Review
            </Button>
          </div>
        )}

        {/* ── Transfer list ── */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-col sm:flex-row items-start sm:items-center gap-3 bg-muted/20">
            <Tabs value={tab} onValueChange={v => setTab(v as any)}>
              <TabsList className="h-8">
                <TabsTrigger value="all" className="text-xs px-3">All</TabsTrigger>
                <TabsTrigger value="in_transit" className="text-xs px-3">
                  In Transit {pendingCount > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 rounded-full bg-amber-500 text-black text-[10px] font-bold">{pendingCount}</span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="completed" className="text-xs px-3">Approved</TabsTrigger>
                <TabsTrigger value="rejected"  className="text-xs px-3">Rejected</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2 flex-1 max-w-sm">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input placeholder="Search challan, from or to…" value={search}
                onChange={e => setSearch(e.target.value)}
                className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Challan</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                    <ArrowRightLeft className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>{tab === 'in_transit' ? 'No pending approvals' : 'No transfers found'}</p>
                  </TableCell>
                </TableRow>
              ) : filtered.map((t: any) => (
                <TableRow key={t.id} className={`hover:bg-muted/10 ${t.status === 'in_transit' ? 'border-l-2 border-l-amber-500' : ''}`}>
                  <TableCell className="font-mono text-primary font-bold text-sm">{t.challanNumber || `DC-${String(t.id).padStart(4, '0')}`}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />{new Date(t.transferDate).toLocaleDateString('en-IN')}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{t.fromName}</div>
                    <Badge variant="outline" className="text-[10px] capitalize">{t.fromType}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{t.toName}</div>
                    <Badge variant="outline" className="text-[10px] capitalize">{t.toType}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t.lineItems?.length || 0} item{t.lineItems?.length !== 1 ? 's' : ''}</Badge>
                  </TableCell>
                  <TableCell><StatusBadge status={t.status} /></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(t)}>
                        <Eye className="w-4 h-4" />
                      </Button>
                      {canDownload && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary"
                          onClick={() => void handleDownloadPDF(t)} title="Download PDF">
                          <FileDown className="w-4 h-4" />
                        </Button>
                      )}
                      {canReceive(t) && (
                        <Button size="sm" variant="outline"
                          className="h-8 text-xs border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 px-2"
                          onClick={() => setApproveTarget(t)}>
                          <PackageCheck className="w-3 h-3 mr-1" /> Receive
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {filtered.length > 0 && (
            <div className="p-3 border-t border-border text-xs text-muted-foreground">
              {filtered.length} transfer{filtered.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>

      {/* ── Approve / Reject dialog ── */}
      <ApproveDialog
        transfer={approveTarget}
        allItemsMap={allItemsMap}
        open={!!approveTarget}
        onClose={() => setApproveTarget(null)}
      />

      {/* ── View detail sheet ── */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{viewItem?.challanNumber || `DC-${viewItem && String(viewItem.id).padStart(4, '0')}`}</SheetTitle>
            <SheetDescription>Transfer details</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4 text-sm">
              <div className="flex justify-center"><StatusBadge status={viewItem.status} /></div>

              <div className="grid grid-cols-2 gap-4">
                {[
                  ['Date',  new Date(viewItem.transferDate).toLocaleDateString('en-IN')],
                  ['From',  `${viewItem.fromName} (${viewItem.fromType})`],
                  ['To',    `${viewItem.toName} (${viewItem.toType})`],
                  ['Type',  viewItem.transferType === 'interstate' ? 'Interstate (IGST)' : viewItem.transferType === 'intrastate' ? 'Intrastate (CGST+SGST)' : 'Internal'],
                ].map(([k, v]) => (
                  <div key={String(k)} className="flex flex-col gap-1 border-b border-border pb-3">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                    <span className="font-semibold">{String(v)}</span>
                  </div>
                ))}
              </div>

              <div>
                <p className="text-sm font-semibold mb-2">Dispatched Items</p>
                <div className="space-y-2">
                  {(viewItem.lineItems || []).map((li: any, i: number) => {
                    const matType = li.materialType || 'item';
                    const item = allItemsMap.get(`${matType}:${li.itemId}`);
                    return (
                      <div key={i} className="p-3 bg-muted/20 rounded-lg text-sm border border-border">
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <Badge variant="outline" className="text-[10px] mb-1">{MAT_LABELS[matType] ?? matType}</Badge>
                            <p className="font-medium">{item?.name ?? `#${li.itemId}`}</p>
                          </div>
                          <span className="font-bold font-mono whitespace-nowrap">{li.quantity} {item?.unit ?? ''}</span>
                        </div>
                        {Array.isArray(li.batchBreakdown) && li.batchBreakdown.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {li.batchBreakdown.map((bb: any, j: number) => (
                              <span key={j} className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                                {bb.batchNumber || `#${bb.batchId}`} · {Number(bb.quantity)}{bb.expiryDate ? ` · exp ${new Date(bb.expiryDate).toLocaleDateString('en-IN')}` : ''}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {viewItem.status === 'completed' && (viewItem.receivedLineItems?.length ?? 0) > 0 && (
                <div>
                  <p className="text-sm font-semibold mb-2 text-emerald-400">Actually Received</p>
                  {viewItem.receivedLineItems.map((li: any, i: number) => {
                    const matType = li.materialType || viewItem.lineItems?.find((d: any) => d.itemId === li.itemId)?.materialType || 'item';
                    const item = allItemsMap.get(`${matType}:${li.itemId}`);
                    const dispatched = viewItem.lineItems?.find((d: any) => d.itemId === li.itemId)?.quantity ?? li.quantity;
                    const isShort = li.quantity < dispatched;
                    return (
                      <div key={i} className={`flex justify-between p-3 rounded-lg text-sm mb-2 border ${isShort ? 'border-amber-500/40 bg-amber-500/5' : 'bg-muted/20 border-border'}`}>
                        <span className="font-medium">{item?.name ?? `#${li.itemId}`}</span>
                        <span className={`font-bold font-mono ${isShort ? 'text-amber-400' : ''}`}>
                          {li.quantity} {item?.unit ?? ''}{isShort ? ` (${dispatched - li.quantity} short)` : ''}
                        </span>
                      </div>
                    );
                  })}
                  {viewItem.approvedBy && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Approved by: {viewItem.approvedBy} · {viewItem.approvedAt ? new Date(viewItem.approvedAt).toLocaleString('en-IN') : ''}
                    </p>
                  )}
                </div>
              )}

              {viewItem.status === 'rejected' && viewItem.rejectionReason && (
                <div className="p-3 bg-red-500/5 border border-red-500/30 rounded-lg">
                  <p className="text-xs text-red-400 uppercase tracking-wider mb-1">Rejection Reason</p>
                  <p>{viewItem.rejectionReason}</p>
                </div>
              )}

              {viewItem.notes && (
                <div className="border-b border-border pb-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Notes</p>
                  <p>{viewItem.notes}</p>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                {canDownload && (
                  <Button className="flex-1" variant="outline" onClick={() => void handleDownloadPDF(viewItem)}>
                    <FileDown className="w-4 h-4 mr-2" /> Download PDF
                  </Button>
                )}
                {canReceive(viewItem) && (
                  <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => { setViewItem(null); setApproveTarget(viewItem); }}>
                    <PackageCheck className="w-4 h-4 mr-2" /> Receive
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ── New Transfer dialog ── */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Transfer</DialogTitle>
            <DialogDescription>
              Stock is deducted from the source immediately. The receiving location must approve to credit their inventory.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              {/* From / To */}
              <div className="grid grid-cols-2 gap-4 p-4 bg-muted/20 rounded-lg border border-border">
                {/* ── FROM ── */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">From</p>
                  {isEmployee ? (
                    // Locked for branch employees
                    <div className="p-2.5 rounded-md border border-border bg-muted/30 text-sm font-medium">
                      {userBranchName}
                      <span className="ml-2 text-xs text-muted-foreground capitalize">({userBranchType})</span>
                    </div>
                  ) : (
                    <>
                      {/* Admin: pick from type */}
                      <FormField control={form.control} name="fromType" render={({ field }) => (
                        <FormItem>
                          <Select value={field.value} onValueChange={v => {
                            field.onChange(v);
                            form.setValue('fromId', v === 'headoffice' ? 1 : 0);
                            form.setValue('toType', v === 'headoffice' ? 'warehouse' : v === 'outlet' ? 'warehouse' : 'outlet');
                            form.setValue('toId', 0);
                            form.setValue('lineItems', [{ materialType: 'item' as const, itemId: 0, quantity: 1 }]);
                            setOverrides({});
                          }}>
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              {fromTypeOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )} />
                      {/* From location picker (hidden for HO) */}
                      {!isFromHO && (
                        <FormField control={form.control} name="fromId" render={({ field }) => (
                          <FormItem>
                            <Select value={field.value ? String(field.value) : ''} onValueChange={v => {
                              field.onChange(Number(v));
                              form.setValue('toId', 0);
                              form.setValue('lineItems', [{ materialType: 'item' as const, itemId: 0, quantity: 1 }]);
                            }}>
                              <FormControl><SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger></FormControl>
                              <SelectContent>
                                {(fromLocationOptions as any[]).map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )} />
                      )}
                    </>
                  )}
                </div>

                {/* ── TO ── */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">To</p>
                  {toTypeOptions.length > 1 && (
                    <FormField control={form.control} name="toType" render={({ field }) => (
                      <FormItem>
                        <Select value={field.value} onValueChange={v => { field.onChange(v); form.setValue('toId', 0); }}>
                          <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            {toTypeOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )} />
                  )}
                  <FormField control={form.control} name="toId" render={({ field }) => (
                    <FormItem>
                      <Select value={field.value ? String(field.value) : ''} onValueChange={v => field.onChange(Number(v))}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Select destination" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {(toOptions as any[]).map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
              </div>

              {/* Date */}
              <FormField control={form.control} name="transferDate" render={({ field }) => (
                <FormItem className="max-w-xs">
                  <FormLabel>Transfer Date</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              {/* Items */}
              <div>
                {!sourceOk ? (
                  <div className="p-5 border border-dashed border-border rounded-lg text-center text-muted-foreground text-sm">
                    Select a source location above to see available stock
                  </div>
                ) : availableItems.length === 0 ? (
                  <div className="p-5 border border-dashed border-amber-500/40 rounded-lg text-center text-amber-500 bg-amber-500/5 flex flex-col items-center gap-2">
                    <PackageOpen className="w-7 h-7 opacity-60" />
                    <p className="font-medium text-sm">No stock at this location</p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-3">
                      <p className="font-semibold text-sm">
                        Items <span className="text-xs text-muted-foreground font-normal ml-1">({availableItems.length} in stock)</span>
                      </p>
                      <Button type="button" variant="outline" size="sm"
                        onClick={() => append({ materialType: 'item' as const, itemId: 0, quantity: 1 })}>
                        <Plus className="w-3 h-3 mr-1" /> Add Line
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {fields.map((field, i) => {
                        const selMatType  = (form.watch(`lineItems.${i}.materialType`) ?? 'item') as 'item' | 'material' | 'raw_material';
                        const selItemId   = form.watch(`lineItems.${i}.itemId`);
                        const selQty      = Number(form.watch(`lineItems.${i}.quantity`)) || 0;
                        const typeFiltered = availableItems.filter(it => isFromHO ? it.materialType === selMatType : true);
                        const selItem     = availableItems.find(it => it.id === selItemId && it.materialType === selMatType);
                        const availQty    = selItem?.availQty ?? 0;

                        return (
                          <div key={field.id}>
                            <div className={`grid gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border ${isFromHO ? 'grid-cols-11' : 'grid-cols-8'}`}>
                              {isFromHO && (
                                <div className="col-span-3">
                                  <FormField control={form.control} name={`lineItems.${i}.materialType`} render={({ field: f }) => (
                                    <FormItem>
                                      <FormLabel className="text-xs">Type</FormLabel>
                                      <Select value={f.value ?? 'item'} onValueChange={v => {
                                        f.onChange(v);
                                        form.setValue(`lineItems.${i}.itemId`, 0 as any);
                                        setOverrides(prev => ({ ...prev, [i]: undefined }));
                                      }}>
                                        <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
                                        <SelectContent>
                                          <SelectItem value="item">Item (SKU)</SelectItem>
                                          <SelectItem value="material">Raw Material</SelectItem>
                                          <SelectItem value="raw_material">Packing Material</SelectItem>
                                        </SelectContent>
                                      </Select>
                                    </FormItem>
                                  )} />
                                </div>
                              )}
                              <div className={isFromHO ? 'col-span-4' : 'col-span-5'}>
                                <FormField control={form.control} name={`lineItems.${i}.itemId`} render={({ field: f }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs">Item</FormLabel>
                                    <Select value={f.value ? String(f.value) : ''} onValueChange={v => {
                                      f.onChange(Number(v));
                                      setOverrides(prev => ({ ...prev, [i]: undefined }));
                                    }}>
                                      <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                                      <SelectContent>
                                        {typeFiltered.map(it => (
                                          <SelectItem key={it.id} value={String(it.id)}>
                                            {it.name} — {it.availQty} {it.unit} avail
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </FormItem>
                                )} />
                              </div>
                              <div className={isFromHO ? 'col-span-3' : 'col-span-2'}>
                                <FormField control={form.control} name={`lineItems.${i}.quantity`} render={({ field: f }) => (
                                  <FormItem>
                                    <FormLabel className="text-xs">
                                      Qty {selItemId > 0 && <span className="text-muted-foreground">(max {availQty})</span>}
                                    </FormLabel>
                                    <FormControl>
                                      <Input type="number" min={1} max={selItemId > 0 ? availQty : undefined} className="h-8 text-xs" {...f} />
                                    </FormControl>
                                  </FormItem>
                                )} />
                              </div>
                              <div className="col-span-1 pb-1 flex justify-end">
                                <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                                  onClick={() => removeLine(i)} disabled={fields.length === 1}>
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                              {/* FEFO batch picker — HO source, SKU items only */}
                              {isFromHO && selMatType === 'item' && selItemId > 0 && selQty > 0 && (
                                <BatchPicker
                                  itemId={selItemId} quantity={selQty}
                                  unit={allItemsMap.get(`item:${selItemId}`)?.unit}
                                  fromType="headoffice" fromId={1}
                                  override={overrides[i]}
                                  onChange={v => setOverrides(prev => ({ ...prev, [i]: v }))}
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Textarea placeholder="Optional dispatch notes…" rows={2} {...field} /></FormControl>
                </FormItem>
              )} />

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || (!sourceOk) || availableItems.length === 0}>
                  {createMutation.isPending ? 'Dispatching…' : 'Dispatch Transfer'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
