import { useState } from 'react';
import {
  useListStockTransfers, useCreateStockTransfer, useListItems,
  useListWarehouses, useListStock, getListStockTransfersQueryKey, useGetCompanySettings,
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
  Plus, Search, Truck, Download, Eye, Calendar, Trash2, Printer,
  PackageOpen, AlertTriangle, Clock, CheckCircle2, XCircle, PackageCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV, printHTML, buildChallanHtml } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const schema = z.object({
  toWarehouseId: z.coerce.number().min(1, 'Destination required'),
  transferDate: z.string().min(1, 'Date required'),
  lineItems: z.array(z.object({
    itemId: z.coerce.number().min(1, 'Select item'),
    quantity: z.coerce.number().min(1, 'Qty > 0'),
  })).min(1, 'Add at least one item'),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

// ── Status badge ──────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  in_transit: { label: 'Pending Approval', color: 'text-amber-400 bg-amber-400/10 border-amber-400/30', icon: <Clock className="w-3 h-3" /> },
  completed:  { label: 'Approved',         color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30', icon: <CheckCircle2 className="w-3 h-3" /> },
  rejected:   { label: 'Rejected',         color: 'text-red-400 bg-red-400/10 border-red-400/30', icon: <XCircle className="w-3 h-3" /> },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, color: 'text-muted-foreground bg-muted/20 border-border', icon: null };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${cfg.color}`}>
      {cfg.icon}{cfg.label}
    </span>
  );
}

// ── Approve dialog ────────────────────────────────────────────────────────────
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
          toast.success('Transfer approved — stock credited to warehouse');
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
          toast.success('Transfer rejected — production stock restored');
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
              <PackageCheck className="w-5 h-5 text-primary" /> Receive & Approve Transfer
            </DialogTitle>
            <DialogDescription>
              Verify the physical stock received at the warehouse. Adjust quantities if anything is short, then approve.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3 p-4 bg-muted/20 rounded-lg border border-border text-sm">
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Challan</p><p className="font-mono font-bold text-primary">{transfer.challanNumber}</p></div>
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Date</p><p>{new Date(transfer.transferDate).toLocaleDateString('en-IN')}</p></div>
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Dispatched From</p><p className="font-medium">Production Unit</p></div>
            <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Receiving At</p><p className="font-medium">{transfer.toName}</p></div>
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
                      <p className="text-xs text-muted-foreground">{(item as any)?.hsnCode ? `HSN: ${(item as any).hsnCode}` : item?.unit ?? ''}</p>
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
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Notes from Production</p>
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
            <DialogTitle className="flex items-center gap-2 text-destructive"><XCircle className="w-5 h-5" />Reject Transfer</DialogTitle>
            <DialogDescription>Stock will be returned to Production Unit. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Textarea rows={3} placeholder="Reason for rejection (e.g. damaged goods, wrong items)…" value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
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
export default function StockTransfers() {
  const perm = usePermission('Stock Transfers');
  const { data: transfers = [], isLoading } = useListStockTransfers();
  const { data: items = [] } = useListItems();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: companySettings } = useGetCompanySettings();
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'all' | 'in_transit' | 'completed' | 'rejected'>('all');
  const [isOpen, setIsOpen] = useState(false);
  const [viewItem, setViewItem] = useState<any>(null);
  const [approveTarget, setApproveTarget] = useState<any>(null);
  const queryClient = useQueryClient();
  const createMutation = useCreateStockTransfer();

  const { data: productionStock = [] } = useListStock({ branchType: 'production' as any, branchId: 1 });
  const stockMap = new Map<number, number>(productionStock.map(s => [s.itemId!, Number(s.quantity ?? 0)]));
  const availableItems = items.filter(it => (stockMap.get(it.id) ?? 0) > 0);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { toWarehouseId: 0, transferDate: new Date().toISOString().split('T')[0], lineItems: [{ itemId: 0, quantity: 1 }], notes: '' },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'lineItems' });

  const onSubmit = (data: FormValues) => {
    createMutation.mutate({ data: { ...data, fromType: 'production', fromId: 1, toType: 'warehouse', toId: data.toWarehouseId } as any }, {
      onSuccess: () => {
        toast.success('Transfer dispatched — warehouse must approve to receive stock');
        queryClient.invalidateQueries({ queryKey: getListStockTransfersQueryKey() });
        setIsOpen(false);
        form.reset();
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const iMap = new Map((items as any[]).map(i => [i.id, i]));

  const handlePrintChallan = (t: any) => {
    const cs = companySettings as any;
    const challanNo = t.challanNumber || `DC-${String(t.id).padStart(4, '0')}`;
    const lineItemsForChallan = (t.lineItems || []).map((li: any) => {
      const item = iMap.get(li.itemId);
      return { name: (item as any)?.name ?? `Item #${li.itemId}`, hsnCode: (item as any)?.hsnCode, quantity: li.quantity, unit: (item as any)?.unit };
    });
    printHTML(buildChallanHtml({
      cs, challanNo,
      date: new Date(t.transferDate).toLocaleDateString('en-IN'),
      fromName: 'Production Unit', fromType: 'Production',
      toName: t.toName || 'Warehouse', toType: t.toType || 'Warehouse',
      lineItems: lineItemsForChallan,
      isInterstate: t.isInterstate,
      status: t.status,
      notes: t.notes,
    }), challanNo);
  };

  // Only show production-sourced transfers on this page
  const productionTransfers = (Array.isArray(transfers) ? transfers : []).filter((t: any) => t.fromType === 'production');
  const searched = productionTransfers.filter((t: any) =>
    t.challanNumber?.toLowerCase().includes(search.toLowerCase()) ||
    t.toName?.toLowerCase().includes(search.toLowerCase())
  );
  const filtered = tab === 'all' ? searched : searched.filter((t: any) => t.status === tab);
  const pendingCount = productionTransfers.filter((t: any) => t.status === 'in_transit').length;

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Stock Transfers.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Truck className="w-6 h-6 text-primary" /> Stock Transfers</h1>
            <p className="text-muted-foreground mt-1">Production → Warehouse dispatches · Warehouse approval required</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={() => downloadCSV('transfers.csv', filtered.map((t: any) => ({ DC: t.challanNumber, Date: t.transferDate, To: t.toName, Items: t.lineItems?.length || 0, Status: t.status, Interstate: t.isInterstate ? 'Yes' : 'No' })))}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            )}
            {perm.canAdd && (
              <Button onClick={() => { form.reset({ toWarehouseId: 0, transferDate: new Date().toISOString().split('T')[0], lineItems: [{ itemId: 0, quantity: 1 }], notes: '' }); setIsOpen(true); }}>
                <Plus className="w-4 h-4 mr-2" /> New Transfer
              </Button>
            )}
          </div>
        </div>

        {/* Pending approvals banner */}
        {pendingCount > 0 && (
          <div className="flex items-center gap-3 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300">
            <Clock className="w-5 h-5 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-sm">{pendingCount} transfer{pendingCount > 1 ? 's' : ''} awaiting warehouse approval</p>
              <p className="text-xs opacity-80">Stock is NOT yet in the warehouse — the receiving manager must verify physical stock and approve.</p>
            </div>
            <Button size="sm" variant="outline" className="border-amber-500/40 text-amber-300 hover:bg-amber-500/20" onClick={() => setTab('in_transit')}>
              Review
            </Button>
          </div>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-col sm:flex-row items-start sm:items-center gap-3 bg-muted/20">
            <Tabs value={tab} onValueChange={v => setTab(v as any)}>
              <TabsList className="h-8">
                <TabsTrigger value="all" className="text-xs px-3">All</TabsTrigger>
                <TabsTrigger value="in_transit" className="text-xs px-3">
                  Pending {pendingCount > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-amber-500 text-black text-[10px] font-bold">{pendingCount}</span>}
                </TabsTrigger>
                <TabsTrigger value="completed" className="text-xs px-3">Approved</TabsTrigger>
                <TabsTrigger value="rejected" className="text-xs px-3">Rejected</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2 flex-1 max-w-sm">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input placeholder="Search challan or destination…" value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Challan #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>To Warehouse</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(3)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                  <Truck className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p>{tab === 'in_transit' ? 'No pending approvals' : 'No transfers found'}</p>
                </TableCell></TableRow>
              ) : filtered.map((t: any) => (
                <TableRow key={t.id} className={`hover:bg-muted/10 ${t.status === 'in_transit' ? 'border-l-2 border-l-amber-500' : ''}`}>
                  <TableCell className="font-mono text-primary font-bold">{t.challanNumber || `DC-${String(t.id).padStart(4, '0')}`}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{new Date(t.transferDate).toLocaleDateString('en-IN')}</div>
                  </TableCell>
                  <TableCell className="font-medium">{t.toName}</TableCell>
                  <TableCell><Badge variant="secondary">{t.lineItems?.length || 0} SKUs</Badge></TableCell>
                  <TableCell><StatusBadge status={t.status} /></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(t)}><Eye className="w-4 h-4" /></Button>
                      {perm.canDownload && <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => handlePrintChallan(t)} title="Print Challan"><Printer className="w-4 h-4" /></Button>}
                      {t.status === 'in_transit' && (
                        <Button size="sm" variant="outline" className="h-8 text-xs border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 px-2" onClick={() => setApproveTarget(t)}>
                          <PackageCheck className="w-3 h-3 mr-1" /> Receive
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* New Transfer dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Stock Transfer</DialogTitle>
            <DialogDescription>
              Stock will be deducted from Production immediately. The destination warehouse must approve before it enters their inventory.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="toWarehouseId" render={({ field }) => (
                  <FormItem><FormLabel>To Warehouse <span className="text-destructive">*</span></FormLabel>
                    <Select onValueChange={v => field.onChange(Number(v))} value={field.value ? String(field.value) : ''}>
                      <FormControl><SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger></FormControl>
                      <SelectContent>{warehouses.map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name} — {w.state}</SelectItem>)}</SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="transferDate" render={({ field }) => (
                  <FormItem><FormLabel>Date <span className="text-destructive">*</span></FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>

              <div>
                {availableItems.length === 0 ? (
                  <div className="p-6 border border-dashed border-amber-500/40 rounded-lg text-center text-amber-500 bg-amber-500/5 flex flex-col items-center gap-2">
                    <PackageOpen className="w-8 h-8 opacity-60" />
                    <p className="font-medium">No production stock available</p>
                    <p className="text-xs text-muted-foreground">Record a production batch first to build stock</p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center mb-3">
                      <p className="font-semibold text-sm">Items to Transfer <span className="text-xs text-muted-foreground font-normal ml-1">({availableItems.length} in stock)</span></p>
                      <Button type="button" variant="outline" size="sm" onClick={() => append({ itemId: 0, quantity: 1 })}><Plus className="w-3 h-3 mr-1" /> Add SKU</Button>
                    </div>
                    <div className="space-y-2">
                      {fields.map((field, i) => {
                        const selItemId = form.watch(`lineItems.${i}.itemId`);
                        const availQty = stockMap.get(selItemId) ?? 0;
                        return (
                          <div key={field.id} className="grid grid-cols-11 gap-2 items-end p-3 bg-muted/20 rounded-lg border border-border">
                            <div className="col-span-7">
                              <FormField control={form.control} name={`lineItems.${i}.itemId`} render={({ field: f }) => (
                                <FormItem><FormLabel className="text-xs">Item</FormLabel>
                                  <Select onValueChange={v => f.onChange(Number(v))} value={f.value ? String(f.value) : ''}>
                                    <FormControl><SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select item" /></SelectTrigger></FormControl>
                                    <SelectContent>
                                      {availableItems.map(it => {
                                        const avail = stockMap.get(it.id) ?? 0;
                                        return <SelectItem key={it.id} value={String(it.id)}>{it.name} — {avail} {it.unit} avail</SelectItem>;
                                      })}
                                    </SelectContent>
                                  </Select></FormItem>
                              )} />
                            </div>
                            <div className="col-span-3">
                              <FormField control={form.control} name={`lineItems.${i}.quantity`} render={({ field: f }) => (
                                <FormItem>
                                  <FormLabel className="text-xs">Qty {selItemId > 0 && <span className="text-muted-foreground">(max {availQty})</span>}</FormLabel>
                                  <FormControl><Input type="number" min={1} max={selItemId > 0 ? availQty : undefined} className="h-8 text-xs" {...f} /></FormControl>
                                </FormItem>
                              )} />
                            </div>
                            <div className="col-span-1 pb-1 flex justify-end">
                              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => remove(i)} disabled={fields.length === 1}><Trash2 className="w-3 h-3" /></Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea placeholder="Optional dispatch notes…" rows={2} {...field} /></FormControl></FormItem>
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

      {/* Approve / Reject dialog */}
      <ApproveDialog
        transfer={approveTarget}
        items={items as any[]}
        open={!!approveTarget}
        onClose={() => setApproveTarget(null)}
      />

      {/* View detail sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{viewItem?.challanNumber || `DC-${viewItem && String(viewItem.id).padStart(4, '0')}`}</SheetTitle>
            <SheetDescription>Delivery challan details</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4 text-sm">
              <div className="flex justify-center"><StatusBadge status={viewItem.status} /></div>

              <div className="grid grid-cols-2 gap-4">
                {[['Date', new Date(viewItem.transferDate).toLocaleDateString('en-IN')], ['From', 'Production Unit'], ['To', viewItem.toName], ['Type', viewItem.isInterstate ? 'Interstate' : 'Intra-state']].map(([k, v]) => (
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
                    const item = iMap.get(li.itemId);
                    return (
                      <div key={i} className="flex justify-between p-3 bg-muted/20 rounded-lg text-sm border border-border">
                        <span className="font-medium">{item?.name ?? `Item #${li.itemId}`}</span>
                        <span className="font-bold font-mono">{li.quantity} {item?.unit ?? ''}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {viewItem.status === 'completed' && viewItem.receivedLineItems?.length > 0 && (
                <div>
                  <p className="text-sm font-semibold mb-2 text-emerald-400">Actually Received</p>
                  {viewItem.receivedLineItems.map((li: any, i: number) => {
                    const item = iMap.get(li.itemId);
                    const dispatched = viewItem.lineItems.find((d: any) => d.itemId === li.itemId)?.quantity ?? li.quantity;
                    const isShort = li.quantity < dispatched;
                    return (
                      <div key={i} className={`flex justify-between p-3 rounded-lg text-sm mb-2 border ${isShort ? 'border-amber-500/40 bg-amber-500/5' : 'bg-muted/20 border-border'}`}>
                        <span className="font-medium">{item?.name ?? `Item #${li.itemId}`}</span>
                        <span className={`font-bold font-mono ${isShort ? 'text-amber-400' : ''}`}>{li.quantity} {item?.unit ?? ''}{isShort ? ` (${dispatched - li.quantity} short)` : ''}</span>
                      </div>
                    );
                  })}
                  {viewItem.approvedBy && <p className="text-xs text-muted-foreground mt-1">Approved by: {viewItem.approvedBy} · {viewItem.approvedAt ? new Date(viewItem.approvedAt).toLocaleString('en-IN') : ''}</p>}
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
                {perm.canDownload && (
                  <Button className="flex-1" variant="outline" onClick={() => handlePrintChallan(viewItem)}>
                    <Printer className="w-4 h-4 mr-2" /> Print Challan
                  </Button>
                )}
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
