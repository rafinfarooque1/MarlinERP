/**
 * Asset Register — every asset the company holds, one row per purchase entry.
 *
 * The register row carries the asset's CURRENT location and status: transfers
 * move it, disposals close it. Edits here are limited to the descriptive,
 * non-financial fields — money figures are fixed at purchase time because a
 * voucher was posted from them.
 */
import { useMemo, useState } from 'react';
import {
  useAssetPurchases, useUpdateAssetPurchase, useAssetCategories,
  useCreateAssetTransfer, useCreateAssetDisposal,
  attachmentViewUrl,
  type AssetPurchase, type AssetDisposalType,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Search, Edit2, Eye, ArrowRightLeft, Archive, ClipboardList, Download } from 'lucide-react';
import { usePermission } from '@/lib/usePermission';
import { toast } from 'sonner';
import { downloadCSV } from '@/lib/download';
import { AttachmentField } from '@/components/AttachmentField';
import { fmt, fmtDate } from '@/pages/reports/shared';
import {
  AssetsAccessDenied, AssetStatusBadge, useAssetLocationOptions, locKey,
  ASSET_STATUS_LABELS, PAYMENT_MODE_LABELS, PAYMENT_STATUS_LABELS,
} from './shared';
import { Link } from 'wouter';

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function AssetRegister() {
  const perm = usePermission('page:/assets/register');
  const transferPerm = usePermission('page:/assets/transfers');
  const disposalPerm = usePermission('page:/assets/disposal');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [locationFilter, setLocationFilter] = useState('all');

  const filters = useMemo(() => {
    const [lt, li] = locationFilter !== 'all' ? locationFilter.split(':') : [];
    return {
      q: search.trim() || undefined,
      status: statusFilter !== 'all' ? statusFilter : undefined,
      categoryId: categoryFilter !== 'all' ? categoryFilter : undefined,
      locationType: lt || undefined,
      locationId: li || undefined,
      locationBasis: 'current' as const,
    };
  }, [search, statusFilter, categoryFilter, locationFilter]);

  const { data: assets = [], isLoading } = useAssetPurchases(filters);
  const { data: categories = [] } = useAssetCategories();
  const updateAsset = useUpdateAssetPurchase();
  const createTransfer = useCreateAssetTransfer();
  const createDisposal = useCreateAssetDisposal();
  const locationOptions = useAssetLocationOptions();

  const [viewTarget, setViewTarget] = useState<AssetPurchase | null>(null);
  const [editTarget, setEditTarget] = useState<AssetPurchase | null>(null);
  const [transferTarget, setTransferTarget] = useState<AssetPurchase | null>(null);
  const [disposeTarget, setDisposeTarget] = useState<AssetPurchase | null>(null);

  // Edit dialog state (descriptive fields only)
  const [edit, setEdit] = useState({
    categoryId: '0', invoiceNumber: '', serialNumber: '', assetTag: '',
    warrantyStart: '', warrantyEnd: '', usefulLifeMonths: '', paymentStatus: 'paid',
    notes: '', attachmentPath: null as string | null,
  });

  // Transfer dialog state
  const [xfer, setXfer] = useState({ to: '', transferDate: todayIso(), approvedBy: '', reason: '' });
  // Disposal dialog state
  const [disp, setDisp] = useState({ disposalType: 'sold' as AssetDisposalType, disposalDate: todayIso(), reason: '' });

  const openEdit = (a: AssetPurchase) => {
    setEdit({
      categoryId: a.categoryId ? String(a.categoryId) : '0',
      invoiceNumber: a.invoiceNumber || '',
      serialNumber: a.serialNumber || '',
      assetTag: a.assetTag || '',
      warrantyStart: a.warrantyStart || '',
      warrantyEnd: a.warrantyEnd || '',
      usefulLifeMonths: a.usefulLifeMonths != null ? String(a.usefulLifeMonths) : '',
      paymentStatus: a.paymentStatus,
      notes: a.notes || '',
      attachmentPath: a.attachmentPath,
    });
    setEditTarget(a);
  };

  const submitEdit = () => {
    if (!editTarget) return;
    updateAsset.mutate({
      id: editTarget.id,
      categoryId: Number(edit.categoryId) > 0 ? Number(edit.categoryId) : undefined,
      invoiceNumber: edit.invoiceNumber.trim() || undefined,
      serialNumber: edit.serialNumber.trim() || null,
      assetTag: edit.assetTag.trim() || null,
      warrantyStart: edit.warrantyStart || null,
      warrantyEnd: edit.warrantyEnd || null,
      usefulLifeMonths: edit.usefulLifeMonths.trim() ? Number(edit.usefulLifeMonths) : null,
      paymentStatus: edit.paymentStatus as AssetPurchase['paymentStatus'],
      notes: edit.notes.trim() || null,
      attachmentPath: edit.attachmentPath,
    }, {
      onSuccess: () => { toast.success('Asset updated'); setEditTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Update failed'),
    });
  };

  const openTransfer = (a: AssetPurchase) => {
    setXfer({ to: '', transferDate: todayIso(), approvedBy: '', reason: '' });
    setTransferTarget(a);
  };

  const submitTransfer = () => {
    if (!transferTarget) return;
    if (!xfer.to) { toast.error('Select a destination'); return; }
    const [toType, toId] = xfer.to.split(':');
    createTransfer.mutate({
      assetPurchaseId: transferTarget.id,
      toType, toId: Number(toId),
      transferDate: xfer.transferDate,
      approvedBy: xfer.approvedBy.trim() || undefined,
      reason: xfer.reason.trim() || undefined,
    }, {
      onSuccess: () => { toast.success('Asset transferred'); setTransferTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Transfer failed'),
    });
  };

  const openDispose = (a: AssetPurchase) => {
    setDisp({ disposalType: 'sold', disposalDate: todayIso(), reason: '' });
    setDisposeTarget(a);
  };

  const submitDisposal = () => {
    if (!disposeTarget) return;
    createDisposal.mutate({
      assetPurchaseId: disposeTarget.id,
      disposalType: disp.disposalType,
      disposalDate: disp.disposalDate,
      reason: disp.reason.trim() || undefined,
    }, {
      onSuccess: () => { toast.success('Asset marked as disposed'); setDisposeTarget(null); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Disposal failed'),
    });
  };

  const exportCSV = () => downloadCSV('asset-register.csv', assets.map(a => ({
    Code: a.assetCode, Asset: a.assetName, Category: a.categoryName || '',
    'Purchase Date': a.purchaseDate, 'Current Location': a.currentLocationName || '',
    Vendor: a.vendorName || '', 'Serial No.': a.serialNumber || '', 'Asset Tag': a.assetTag || '',
    Qty: a.quantity, 'Total Cost': a.totalCost,
    Status: ASSET_STATUS_LABELS[a.status] ?? a.status, 'Warranty End': a.warrantyEnd || '',
  })));

  if (!perm.isLoading && !perm.canView) return <AssetsAccessDenied />;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ClipboardList className="w-6 h-6 text-primary" /> Asset Register</h1>
            <p className="text-muted-foreground mt-1">Every company asset with its current location and status.</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={exportCSV}><Download className="w-4 h-4 mr-2" /> Export</Button>
            )}
            {perm.canAdd && (
              <Link href="/assets/purchases"><Button><Plus className="w-4 h-4 mr-2" /> New Asset Purchase</Button></Link>
            )}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[160px]">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input placeholder="Search code, name, serial, tag..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <Select value={locationFilter} onValueChange={setLocationFilter}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {locationOptions.map(o => <SelectItem key={locKey(o.type, o.id)} value={locKey(o.type, o.id)}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {Object.entries(ASSET_STATUS_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Code</TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Purchased</TableHead>
                <TableHead>Current Location</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Serial No.</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Warranty</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={12}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : assets.length === 0 ? (
                <TableRow><TableCell colSpan={12} className="text-center py-16 text-muted-foreground">
                  <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No assets found</p>
                </TableCell></TableRow>
              ) : assets.map(a => {
                const warrantyExpired = a.warrantyEnd && a.warrantyEnd < todayIso();
                return (
                <TableRow key={a.id} className={`hover:bg-muted/10 ${a.status === 'active' ? '' : 'opacity-70'}`}>
                  <TableCell className="font-mono text-sm font-semibold whitespace-nowrap">{a.assetCode}</TableCell>
                  <TableCell className="font-medium">{a.assetName}{a.assetTag && <div className="text-[10px] text-muted-foreground font-mono">{a.assetTag}</div>}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.categoryName || '—'}</TableCell>
                  <TableCell className="text-sm whitespace-nowrap">{fmtDate(a.purchaseDate)}</TableCell>
                  <TableCell className="text-sm">{a.currentLocationName || '—'}</TableCell>
                  <TableCell className="text-sm">{a.vendorName || '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{a.serialNumber || '—'}</TableCell>
                  <TableCell className="text-right font-mono">{Number(a.quantity)}</TableCell>
                  <TableCell className="text-right font-mono font-bold">{fmt(a.totalCost)}</TableCell>
                  <TableCell><AssetStatusBadge status={a.status} /></TableCell>
                  <TableCell className={`text-sm whitespace-nowrap ${warrantyExpired ? 'text-red-500' : ''}`}>{a.warrantyEnd ? fmtDate(a.warrantyEnd) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="View" onClick={() => setViewTarget(a)}><Eye className="w-4 h-4" /></Button>
                      {perm.canEdit && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="Edit" onClick={() => openEdit(a)}><Edit2 className="w-4 h-4" /></Button>
                      )}
                      {transferPerm.canAdd && a.status === 'active' && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" title="Transfer" onClick={() => openTransfer(a)}><ArrowRightLeft className="w-4 h-4" /></Button>
                      )}
                      {disposalPerm.canAdd && a.status === 'active' && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" title="Dispose" onClick={() => openDispose(a)}><Archive className="w-4 h-4" /></Button>
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
      </div>

      {/* View sheet */}
      <Sheet open={!!viewTarget} onOpenChange={v => !v && setViewTarget(null)}>
        <SheetContent className="overflow-y-auto">
          {viewTarget && (
            <>
              <SheetHeader className="mb-4">
                <SheetTitle>{viewTarget.assetName}</SheetTitle>
                <SheetDescription asChild className="flex flex-wrap items-center gap-2"><div>
                  <span className="font-mono text-xs font-semibold">{viewTarget.assetCode}</span>
                  <AssetStatusBadge status={viewTarget.status} />
                </div></SheetDescription>
              </SheetHeader>
              <div className="space-y-3 text-sm">
                {([
                  ['Category', viewTarget.categoryName || '—'],
                  ['Purchase Date', fmtDate(viewTarget.purchaseDate)],
                  ['Invoice No.', viewTarget.invoiceNumber || '—'],
                  ['Vendor', viewTarget.vendorName || '—'],
                  ['Purchased At', viewTarget.locationName || '—'],
                  ['Current Location', viewTarget.currentLocationName || '—'],
                  ['Quantity', String(Number(viewTarget.quantity))],
                  ['Unit Cost', fmt(viewTarget.acquisitionCost)],
                  ['GST', `${fmt(viewTarget.gstAmount)} (${Number(viewTarget.gstRate)}%)`],
                  ['Total Cost', fmt(viewTarget.totalCost)],
                  ['Payment Mode', PAYMENT_MODE_LABELS[viewTarget.paymentMode] ?? viewTarget.paymentMode],
                  ['Payment Status', PAYMENT_STATUS_LABELS[viewTarget.paymentStatus] ?? viewTarget.paymentStatus],
                  ['Warranty', viewTarget.warrantyStart || viewTarget.warrantyEnd ? `${fmtDate(viewTarget.warrantyStart)} → ${fmtDate(viewTarget.warrantyEnd)}` : '—'],
                  ['Serial Number', viewTarget.serialNumber || '—'],
                  ['Asset Tag', viewTarget.assetTag || '—'],
                  ['Useful Life', viewTarget.usefulLifeMonths != null ? `${viewTarget.usefulLifeMonths} months` : '—'],
                  ['Voucher', viewTarget.voucherNumber || '—'],
                ] as [string, string][]).map(([label, value]) => (
                  <div key={label} className="flex justify-between py-2 border-b border-border gap-4">
                    <span className="text-muted-foreground shrink-0">{label}</span>
                    <span className="font-medium text-right">{value}</span>
                  </div>
                ))}
                {viewTarget.attachmentPath && (
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">Invoice Attachment</span>
                    <a href={attachmentViewUrl(viewTarget.attachmentPath)} target="_blank" rel="noreferrer" className="text-primary hover:underline">View</a>
                  </div>
                )}
                {viewTarget.notes && <div className="py-2"><p className="text-muted-foreground mb-1">Notes</p><p>{viewTarget.notes}</p></div>}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Edit dialog — descriptive fields only */}
      <Dialog open={!!editTarget} onOpenChange={v => !v && setEditTarget(null)}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Asset — {editTarget?.assetCode}</DialogTitle>
            <DialogDescription>Money figures are fixed at purchase time (a voucher was posted from them); descriptive details can change.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Category</label>
              <Select value={edit.categoryId} onValueChange={v => setEdit(s => ({ ...s, categoryId: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">— None —</SelectItem>
                  {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Invoice No.</label>
              <Input className="font-mono" value={edit.invoiceNumber} onChange={e => setEdit(s => ({ ...s, invoiceNumber: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Serial Number</label>
              <Input className="font-mono" value={edit.serialNumber} onChange={e => setEdit(s => ({ ...s, serialNumber: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Asset Tag</label>
              <Input className="font-mono" value={edit.assetTag} onChange={e => setEdit(s => ({ ...s, assetTag: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Warranty Start</label>
              <Input type="date" value={edit.warrantyStart} onChange={e => setEdit(s => ({ ...s, warrantyStart: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Warranty End</label>
              <Input type="date" value={edit.warrantyEnd} onChange={e => setEdit(s => ({ ...s, warrantyEnd: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Useful Life (months)</label>
              <Input type="number" min={0} className="font-mono" value={edit.usefulLifeMonths} onChange={e => setEdit(s => ({ ...s, usefulLifeMonths: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Payment Status</label>
              <Select value={edit.paymentStatus} onValueChange={v => setEdit(s => ({ ...s, paymentStatus: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="unpaid">Unpaid</SelectItem>
                  <SelectItem value="partial">Partial</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-sm font-medium">Notes</label>
              <Textarea rows={2} value={edit.notes} onChange={e => setEdit(s => ({ ...s, notes: e.target.value }))} />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-sm font-medium">Invoice Attachment</label>
              <AttachmentField value={edit.attachmentPath} onChange={p => setEdit(s => ({ ...s, attachmentPath: p }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={updateAsset.isPending}>{updateAsset.isPending ? 'Saving…' : 'Save Changes'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transfer dialog */}
      <Dialog open={!!transferTarget} onOpenChange={v => !v && setTransferTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ArrowRightLeft className="w-5 h-5 text-primary" /> Transfer Asset</DialogTitle>
            <DialogDescription>
              {transferTarget?.assetCode} — {transferTarget?.assetName}, currently at <span className="font-semibold">{transferTarget?.currentLocationName}</span>. No accounting entries; the move is recorded in history.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">To Location <span className="text-destructive">*</span></label>
              <Select value={xfer.to} onValueChange={v => setXfer(s => ({ ...s, to: v }))}>
                <SelectTrigger><SelectValue placeholder="Select destination" /></SelectTrigger>
                <SelectContent>
                  {locationOptions
                    .filter(o => transferTarget ? locKey(o.type, o.id) !== locKey(transferTarget.currentLocationType, transferTarget.currentLocationId) : true)
                    .map(o => <SelectItem key={locKey(o.type, o.id)} value={locKey(o.type, o.id)}>{o.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Transfer Date</label>
              <Input type="date" value={xfer.transferDate} onChange={e => setXfer(s => ({ ...s, transferDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Approved By</label>
              <Input placeholder="Name of the approver" value={xfer.approvedBy} onChange={e => setXfer(s => ({ ...s, approvedBy: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Reason</label>
              <Textarea rows={2} placeholder="Why is the asset moving?" value={xfer.reason} onChange={e => setXfer(s => ({ ...s, reason: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferTarget(null)}>Cancel</Button>
            <Button onClick={submitTransfer} disabled={createTransfer.isPending}>{createTransfer.isPending ? 'Transferring…' : 'Transfer'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disposal dialog */}
      <Dialog open={!!disposeTarget} onOpenChange={v => !v && setDisposeTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive"><Archive className="w-5 h-5" /> Dispose Asset</DialogTitle>
            <DialogDescription>
              {disposeTarget?.assetCode} — {disposeTarget?.assetName}. Disposal closes the asset: no further transfers or edits to its status. No accounting entries are posted yet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Disposal Type <span className="text-destructive">*</span></label>
              <Select value={disp.disposalType} onValueChange={v => setDisp(s => ({ ...s, disposalType: v as AssetDisposalType }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sold">Sold</SelectItem>
                  <SelectItem value="scrapped">Scrapped</SelectItem>
                  <SelectItem value="written_off">Written Off</SelectItem>
                  <SelectItem value="transferred_outside">Transferred Outside</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Disposal Date</label>
              <Input type="date" value={disp.disposalDate} onChange={e => setDisp(s => ({ ...s, disposalDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Reason</label>
              <Textarea rows={2} placeholder="e.g. beyond repair, sold to..." value={disp.reason} onChange={e => setDisp(s => ({ ...s, reason: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisposeTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={submitDisposal} disabled={createDisposal.isPending}>{createDisposal.isPending ? 'Recording…' : 'Dispose Asset'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
