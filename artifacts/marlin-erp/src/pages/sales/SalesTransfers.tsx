import { useEffect, useState, useMemo } from 'react';
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import {
  useListStockTransfers, useListItems, useGetCompanySettings,
  useApproveTransfer, useRejectTransfer, getListStockTransfersQueryKey,
  useCreateStockTransfer, useListWarehouses, useListOutlets, useListStock,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { toast } from 'sonner';
import { ArrowLeftRight, Calendar, Eye, FileDown, PackageCheck, CheckCircle2, XCircle, AlertTriangle, Clock, Download, Plus, Trash2, PackageOpen } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { downloadPDFFromEndpoint, downloadCSV } from '@/lib/download';

// ── New transfer form schema ───────────────────────────────────────────────────
const newTransferSchema = z.object({
  toType: z.enum(['warehouse', 'outlet']),
  toId: z.coerce.number().min(1, 'Destination required'),
  transferDate: z.string().min(1, 'Date required'),
  lineItems: z.array(z.object({
    itemId: z.coerce.number().min(1, 'Select item'),
    quantity: z.coerce.number().min(1, 'Qty > 0'),
  })).min(1, 'Add at least one item'),
  notes: z.string().optional(),
});
type NewTransferValues = z.infer<typeof newTransferSchema>;

// ── Status badge ──────────────────────────────────────────────────────────────
function statusBadge(status: string) {
  if (status === 'completed') return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Completed</Badge>;
  if (status === 'rejected')  return <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Rejected</Badge>;
  return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">In Transit</Badge>;
}

// ── Approve / Reject dialog (same pattern as HoTransfers) ────────────────────
function ApproveDialog({
  transfer, items, open, onClose,
}: { transfer: any; items: any[]; open: boolean; onClose: () => void }) {
  const approveMutation = useApproveTransfer();
  const rejectMutation  = useRejectTransfer();
  const qc = useQueryClient();

  const iMap = new Map(items.map((i: any) => [i.id, i]));
  const [received, setReceived] = useState<Record<number, number>>(() => {
    const init: Record<number, number> = {};
    (transfer?.lineItems ?? []).forEach((li: any) => { init[li.itemId] = li.quantity; });
    return init;
  });
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);

  useEffect(() => {
    if (transfer) {
      const init: Record<number, number> = {};
      (transfer.lineItems ?? []).forEach((li: any) => { init[li.itemId] = li.quantity; });
      setReceived(init);
      setRejectReason('');
      setShowRejectConfirm(false);
    }
  }, [transfer?.id]);

  if (!transfer) return null;

  const handleApprove = () => {
    const receivedLineItems = (transfer.lineItems ?? []).map((li: any) => ({
      itemId: li.itemId,
      quantity: received[li.itemId] ?? li.quantity,
      costPrice: li.costPrice ?? 0,
    }));
    approveMutation.mutate(
      { id: transfer.id, receivedLineItems, approvedBy: 'admin' },
      {
        onSuccess: () => {
          toast.success('Transfer approved — stock credited to this location');
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
              Verify the physical stock received. Adjust quantities if any items are short-shipped, then approve.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3 p-4 bg-muted/20 rounded-lg border border-border text-sm">
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Challan</p><p className="font-mono font-bold text-primary">{transfer.challanNumber}</p></div>
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Date</p><p>{new Date(transfer.transferDate).toLocaleDateString('en-IN')}</p></div>
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Dispatched From</p><p className="font-medium">{transfer.fromName}<span className="text-muted-foreground capitalize ml-1">({transfer.fromType})</span></p></div>
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Receiving At</p><p className="font-medium">{transfer.toName}<span className="text-muted-foreground capitalize ml-1">({transfer.toType})</span></p></div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <p className="font-semibold text-sm">Items to Receive</p>
              <span className="text-xs text-muted-foreground">— enter actual quantity physically received</span>
            </div>
            <div className="space-y-2">
              {(transfer.lineItems ?? []).map((li: any) => {
                const item = iMap.get(li.itemId);
                const recvQty = received[li.itemId] ?? li.quantity;
                const isShort = recvQty < li.quantity;
                return (
                  <div key={li.itemId} className={`grid grid-cols-12 gap-3 items-center p-3 rounded-lg border ${isShort ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-muted/20'}`}>
                    <div className="col-span-5">
                      <p className="font-medium text-sm">{item?.name ?? `Item #${li.itemId}`}</p>
                      <p className="text-xs text-muted-foreground">{item?.unit ?? ''}</p>
                    </div>
                    <div className="col-span-3 text-center">
                      <p className="text-xs text-muted-foreground mb-1">Dispatched</p>
                      <p className="font-mono font-bold text-sm">{li.quantity}<span className="text-muted-foreground font-normal ml-1 text-xs">{item?.unit}</span></p>
                    </div>
                    <div className="col-span-4">
                      <p className="text-xs text-muted-foreground mb-1">Received <span className="text-destructive">*</span></p>
                      <Input
                        type="number" min={0} max={li.quantity}
                        value={recvQty}
                        onChange={e => setReceived(r => ({ ...r, [li.itemId]: Number(e.target.value) }))}
                        className={`h-8 text-sm font-mono ${isShort ? 'border-amber-500 focus-visible:ring-amber-500' : ''}`}
                      />
                      {isShort && <p className="text-[10px] text-amber-400 mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{li.quantity - recvQty} short</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {transfer.notes && (
            <div className="p-3 bg-muted/20 rounded-lg border border-border text-sm">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Notes from sender</p>
              <p>{transfer.notes}</p>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
            <Button variant="destructive" type="button" onClick={() => setShowRejectConfirm(true)}>
              <XCircle className="w-4 h-4 mr-2" /> Reject Transfer
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
            <DialogTitle className="flex items-center gap-2 text-destructive"><XCircle className="w-5 h-5" />Reject Transfer</DialogTitle>
            <DialogDescription>This will reverse the stock deduction from {transfer.fromName}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Provide a reason for rejection (optional):</p>
            <Textarea rows={3} placeholder="e.g. Items damaged in transit, wrong items received…" value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
          </div>
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
export default function SalesTransfers() {
  const [, navigate] = useLocation();
  const { locationState } = useLocationContext();

  useEffect(() => {
    if (!locationState.locationType || !locationState.locationId) {
      navigate('/sales');
    }
  }, [locationState, navigate]);

  const { data: allTransfers = [], isLoading } = useListStockTransfers();
  const { data: items = [] } = useListItems();
  const { data: companySettings } = useGetCompanySettings();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();

  const [viewItem, setViewItem]           = useState<any>(null);
  const [approveTarget, setApproveTarget] = useState<any>(null);
  const [isOpen, setIsOpen]               = useState(false);

  const queryClient = useQueryClient();
  const createMutation = useCreateStockTransfer();

  const { locationType, locationId, locationName } = locationState;

  // New-transfer form — "from" is always this location
  const form = useForm<NewTransferValues>({
    resolver: zodResolver(newTransferSchema),
    defaultValues: { toType: 'warehouse', toId: 0, transferDate: new Date().toISOString().split('T')[0], lineItems: [{ itemId: 0, quantity: 1 }], notes: '' },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });
  const watchToType = form.watch('toType');


  // Stock available at this location
  const { data: fromStock = [] } = useListStock(
    { branchType: locationType as any, branchId: locationId! },
    { query: { enabled: !!locationType && !!locationId } as any }
  );
  const stockMap = new Map<number, number>(
    (fromStock as any[]).map((s: any) => [s.itemId, Number(s.quantity ?? 0)])
  );
  const availableItems = (items as any[]).filter(it => (stockMap.get(it.id) ?? 0) > 0);

  // Smart "To" options enforcing business rules:
  // warehouse → outlet: only this warehouse's child outlets
  // outlet   → warehouse: only this outlet's parent warehouse
  // warehouse → warehouse: all warehouses (excluding self)
  const toOptions = useMemo(() => {
    if (watchToType === 'outlet') {
      if (locationType === 'warehouse' && locationId) {
        return (outlets as any[]).filter(o => Number(o.warehouseId) === locationId);
      }
      return outlets;
    }
    // toType === 'warehouse'
    if (locationType === 'outlet' && locationId) {
      const parentWHId = (outlets as any[]).find(o => o.id === locationId)?.warehouseId;
      if (parentWHId) return (warehouses as any[]).filter(w => w.id === parentWHId);
    }
    return locationType === 'warehouse' && locationId
      ? (warehouses as any[]).filter(w => w.id !== locationId)
      : warehouses;
  }, [watchToType, locationType, locationId, outlets, warehouses]);

  const openCreate = () => {
    form.reset({ toType: 'warehouse', toId: 0, transferDate: new Date().toISOString().split('T')[0], lineItems: [{ itemId: 0, quantity: 1 }], notes: '' });
    setIsOpen(true);
  };

  const onSubmit = (data: NewTransferValues) => {
    createMutation.mutate({
      data: {
        fromType: locationType,
        fromId: locationId,
        toType: data.toType,
        toId: data.toId,
        transferDate: data.transferDate,
        lineItems: data.lineItems,
        notes: data.notes,
      } as any,
    }, {
      onSuccess: () => {
        toast.success('Transfer dispatched — awaiting receiver approval');
        queryClient.invalidateQueries({ queryKey: getListStockTransfersQueryKey() });
        setIsOpen(false);
        form.reset();
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const iMap = new Map((items as any[]).map((i: any) => [i.id, i]));

  // Filter transfers where this location is the source or destination
  const transfers = (allTransfers as any[]).filter(t => {
    const fromMatch = t.fromType === locationType && Number(t.fromId) === locationId;
    const toMatch   = t.toType   === locationType && Number(t.toId)   === locationId;
    return fromMatch || toMatch;
  });

  const pendingCount = transfers.filter((t: any) => t.status === 'in_transit').length;

  if (!locationType || !locationId) return null;

  const handleDownloadPDF = async (t: any) => {
    const cs = companySettings as any;
    const lineItems = (t.lineItems ?? []).map((li: any) => {
      const item = iMap.get(li.itemId);
      return { name: item?.name ?? `Item #${li.itemId}`, hsnCode: (item as any)?.hsnCode, quantity: li.quantity, unit: item?.unit };
    });
    try {
      await downloadPDFFromEndpoint('/api/pdf/challan', {
        cs, challanNo: t.challanNumber,
        date: new Date(t.transferDate).toLocaleDateString('en-IN'),
        fromName: t.fromName, fromType: t.fromType,
        toName: t.toName, toType: t.toType,
        lineItems, isInterstate: t.isInterstate, status: t.status,
        notes: t.notes, approvedBy: t.approvedBy,
      }, `${t.challanNumber || 'Challan'}.pdf`);
    } catch (e: any) { toast.error(e?.message || 'Failed to generate PDF'); }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ArrowLeftRight className="w-6 h-6 text-primary" />
              Transfers — {locationName}
            </h1>
            <p className="text-muted-foreground mt-1">Stock movements involving this location</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                downloadCSV(
                  `transfers-${locationName?.replace(/\s+/g, '-').toLowerCase()}.csv`,
                  transfers.map((t: any) => ({
                    Challan: t.challanNumber ?? `#${t.id}`,
                    Date: t.transferDate ? new Date(t.transferDate).toLocaleDateString('en-IN') : '—',
                    From: t.fromName ?? `${t.fromType} #${t.fromId}`,
                    'From Type': t.fromType,
                    To: t.toName ?? `${t.toType} #${t.toId}`,
                    'To Type': t.toType,
                    Status: t.status,
                    Items: (t.lineItems ?? t.items ?? []).length,
                    Notes: t.notes ?? '',
                  })),
                )
              }
              disabled={transfers.length === 0}
            >
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-2" /> New Transfer
            </Button>
          </div>
        </div>

        {/* Pending approvals banner */}
        {pendingCount > 0 && (
          <div className="flex items-center gap-3 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-600">
            <Clock className="w-5 h-5 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-sm">{pendingCount} transfer{pendingCount > 1 ? 's' : ''} awaiting your approval</p>
              <p className="text-xs opacity-80">Verify the physical stock received and approve to credit your inventory.</p>
            </div>
          </div>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Challan</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Items</TableHead>
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
              ) : transfers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                    <ArrowLeftRight className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>No transfers involving {locationName}</p>
                  </TableCell>
                </TableRow>
              ) : transfers.map((t: any) => (
                <TableRow key={t.id} className={`hover:bg-muted/10 ${t.status === 'in_transit' ? 'border-l-2 border-l-amber-500' : ''}`}>
                  <TableCell className="font-mono text-xs text-primary font-bold">{t.challanNumber ?? `#${t.id}`}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {t.transferDate ? new Date(t.transferDate).toLocaleDateString('en-IN') : '—'}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{t.fromName ?? `${t.fromType} #${t.fromId}`}</TableCell>
                  <TableCell className="text-sm">{t.toName ?? `${t.toType} #${t.toId}`}</TableCell>
                  <TableCell>{statusBadge(t.status)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{(t.lineItems ?? t.items ?? []).length} item(s)</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(t)}>
                        <Eye className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => void handleDownloadPDF(t)} title="Download PDF">
                        <FileDown className="w-4 h-4" />
                      </Button>
                      {t.status === 'in_transit' && (
                        <Button size="sm" variant="outline" className="h-8 text-xs border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 px-2" onClick={() => setApproveTarget(t)}>
                          <PackageCheck className="w-3 h-3 mr-1" /> Receive
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {transfers.length > 0 && (
            <div className="p-3 border-t border-border text-sm text-muted-foreground">
              {transfers.length} transfer(s) total
            </div>
          )}
        </div>
      </div>

      {/* Approve / Reject dialog */}
      <ApproveDialog
        transfer={approveTarget}
        items={items as any[]}
        open={!!approveTarget}
        onClose={() => setApproveTarget(null)}
      />

      {/* View detail Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{viewItem?.challanNumber}</SheetTitle>
            <SheetDescription>Transfer details</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4 text-sm">
              <div className="flex justify-center">{statusBadge(viewItem.status)}</div>

              {[
                ['Date', new Date(viewItem.transferDate).toLocaleDateString('en-IN')],
                ['From', `${viewItem.fromName} (${viewItem.fromType})`],
                ['To',   `${viewItem.toName} (${viewItem.toType})`],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-medium">{String(v)}</span>
                </div>
              ))}

              <div>
                <p className="text-sm font-semibold mb-2">Dispatched Items</p>
                {(viewItem.lineItems ?? []).map((li: any, i: number) => {
                  const item = iMap.get(li.itemId);
                  return (
                    <div key={i} className="flex justify-between p-3 bg-muted/20 rounded text-sm mb-2 border border-border">
                      <span className="font-medium">{item?.name ?? `Item #${li.itemId}`}</span>
                      <span className="font-bold font-mono">{li.quantity} {item?.unit ?? ''}</span>
                    </div>
                  );
                })}
              </div>

              {viewItem.status === 'completed' && (viewItem.receivedLineItems?.length ?? 0) > 0 && (
                <div>
                  <p className="text-sm font-semibold mb-2 text-emerald-600">Actually Received</p>
                  {viewItem.receivedLineItems.map((li: any, i: number) => {
                    const item = iMap.get(li.itemId);
                    const dispatched = viewItem.lineItems?.find((d: any) => d.itemId === li.itemId)?.quantity ?? li.quantity;
                    const isShort = li.quantity < dispatched;
                    return (
                      <div key={i} className={`flex justify-between p-3 rounded text-sm mb-2 border ${isShort ? 'border-amber-500/40 bg-amber-500/5' : 'bg-muted/20 border-border'}`}>
                        <span className="font-medium">{item?.name ?? `Item #${li.itemId}`}</span>
                        <span className={`font-bold font-mono ${isShort ? 'text-amber-500' : ''}`}>{li.quantity} {item?.unit ?? ''}{isShort ? ` (${dispatched - li.quantity} short)` : ''}</span>
                      </div>
                    );
                  })}
                  {viewItem.approvedBy && <p className="text-xs text-muted-foreground">Approved by: {viewItem.approvedBy}</p>}
                </div>
              )}

              {viewItem.status === 'rejected' && viewItem.rejectionReason && (
                <div className="p-3 bg-red-500/5 border border-red-500/30 rounded-lg">
                  <p className="text-xs text-red-500 uppercase tracking-wider mb-1">Rejection Reason</p>
                  <p>{viewItem.rejectionReason}</p>
                </div>
              )}

              {viewItem.notes && (
                <div className="flex flex-col gap-1 border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">Notes</span>
                  <span>{viewItem.notes}</span>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button className="flex-1" variant="outline" onClick={() => void handleDownloadPDF(viewItem)}>
                  <FileDown className="w-4 h-4 mr-2" /> Download PDF
                </Button>
                {viewItem.status === 'in_transit' && (
                  <Button className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => { setViewItem(null); setApproveTarget(viewItem); }}>
                    <PackageCheck className="w-4 h-4 mr-2" /> Receive
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ── New Transfer dialog ────────────────────────────────────────── */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Transfer from {locationName}</DialogTitle>
            <DialogDescription>
              Stock will be deducted from <strong>{locationName}</strong> immediately. The receiving location must approve to credit their inventory.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">

              {/* From (locked) + To */}
              <div className="grid grid-cols-2 gap-4 p-4 bg-muted/20 rounded-lg border border-border">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">From</p>
                  <div className="p-2.5 rounded-md border border-border bg-muted/30 text-sm font-medium">
                    {locationName}
                    <span className="ml-2 text-xs text-muted-foreground capitalize">({locationType})</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">To</p>
                  <FormField control={form.control} name="toType" render={({ field }) => (
                    <FormItem>
                      <Select onValueChange={v => { field.onChange(v); form.setValue('toId', 0); }} value={field.value}>
                        <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="warehouse">Warehouse</SelectItem>
                          <SelectItem value="outlet">Outlet</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="toId" render={({ field }) => (
                    <FormItem>
                      <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                        <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select destination" /></SelectTrigger></FormControl>
                        <SelectContent>
                          {(toOptions as any[]).map((o: any) => (
                            <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                          ))}
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
                  <FormLabel>Date</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              {/* Line items */}
              <div>
                {availableItems.length === 0 ? (
                  <div className="p-5 border border-dashed border-amber-500/40 rounded-lg text-center text-amber-600 bg-amber-500/5 flex flex-col items-center gap-2">
                    <PackageOpen className="w-7 h-7 opacity-60" />
                    <p className="font-medium text-sm">No stock available at {locationName}</p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-3">
                      <p className="font-semibold text-sm">
                        Items <span className="text-xs text-muted-foreground font-normal ml-1">({availableItems.length} in stock)</span>
                      </p>
                      <Button type="button" variant="outline" size="sm" onClick={() => append({ itemId: 0, quantity: 1 })}>
                        <Plus className="w-3 h-3 mr-1" /> Add
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {fields.map((field, i) => {
                        const selItemId = form.watch(`lineItems.${i}.itemId`);
                        const availQty = stockMap.get(selItemId) ?? 0;
                        return (
                          <div key={field.id} className="grid grid-cols-11 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                            <div className="col-span-7">
                              <FormField control={form.control} name={`lineItems.${i}.itemId`} render={({ field: f }) => (
                                <FormItem>
                                  <FormLabel className="text-xs">Item</FormLabel>
                                  <Select onValueChange={v => f.onChange(Number(v))} value={f.value ? String(f.value) : ''}>
                                    <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                                    <SelectContent>
                                      {availableItems.map((it: any) => (
                                        <SelectItem key={it.id} value={String(it.id)}>
                                          {it.name} — {stockMap.get(it.id) ?? 0} {it.unit} avail
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </FormItem>
                              )} />
                            </div>
                            <div className="col-span-3">
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
                              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(i)} disabled={fields.length === 1}>
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              {/* Notes */}
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Textarea rows={2} placeholder="Optional dispatch notes…" {...field} /></FormControl>
                </FormItem>
              )} />

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMutation.isPending || availableItems.length === 0}>
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
