import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import {
  useListStockTransfers, useListItems, useGetCompanySettings,
  useApproveTransfer, useRejectTransfer, getListStockTransfersQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeftRight, Calendar, Eye, FileDown, PackageCheck, CheckCircle2, XCircle, AlertTriangle, Clock } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { downloadPDFFromEndpoint } from '@/lib/download';

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

  const [viewItem, setViewItem]         = useState<any>(null);
  const [approveTarget, setApproveTarget] = useState<any>(null);

  const { locationType, locationId, locationName } = locationState;

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
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ArrowLeftRight className="w-6 h-6 text-primary" />
            Transfers — {locationName}
          </h1>
          <p className="text-muted-foreground mt-1">Stock movements involving this location</p>
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
    </AppLayout>
  );
}
