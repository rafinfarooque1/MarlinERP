/**
 * Asset Transfers — move an asset between locations, with full history.
 *
 * A transfer records from/to, date, approver and reason, and updates the
 * asset's current location on the register. There are NO accounting entries:
 * an asset moving between company locations changes nothing in the books.
 */
import { useMemo, useState } from 'react';
import {
  useAssetPurchases, useAssetTransfers, useCreateAssetTransfer,
  type AssetPurchase,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Plus, ArrowRightLeft, Download } from 'lucide-react';
import { usePermission } from '@/lib/usePermission';
import { toast } from 'sonner';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { fmtDate } from '@/pages/reports/shared';
import { AssetsAccessDenied, useAssetLocationOptions, locKey } from './shared';

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function AssetTransfers() {
  const perm = usePermission('page:/assets/transfers');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const params = useMemo(() => ({
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
  }), [fromDate, toDate]);

  const { data: transfers = [], isLoading } = useAssetTransfers(params);
  // Only active assets can move; the picker is scoped to what the caller may see.
  const { data: activeAssets = [] } = useAssetPurchases({ status: 'active' });
  const createTransfer = useCreateAssetTransfer();
  const locationOptions = useAssetLocationOptions();

  const { sorted, sort } = useTableSort(transfers, {
    date: t => t.transferDate,
    code: t => t.assetCode,
    asset: t => t.assetName,
    from: t => t.fromName,
    to: t => t.toName,
    approvedBy: t => t.approvedBy,
    reason: t => t.reason,
    recordedBy: t => t.createdBy,
  });

  const [form, setForm] = useState({ assetId: '', to: '', transferDate: todayIso(), approvedBy: '', reason: '' });
  const selectedAsset: AssetPurchase | undefined = (activeAssets as AssetPurchase[]).find(a => String(a.id) === form.assetId);

  const openAdd = () => {
    setForm({ assetId: '', to: '', transferDate: todayIso(), approvedBy: '', reason: '' });
    setIsOpen(true);
  };

  const onSubmit = () => {
    if (!form.assetId) { toast.error('Select an asset'); return; }
    if (!form.to) { toast.error('Select a destination'); return; }
    const [toType, toId] = form.to.split(':');
    createTransfer.mutate({
      assetPurchaseId: Number(form.assetId),
      toType, toId: Number(toId),
      transferDate: form.transferDate,
      approvedBy: form.approvedBy.trim() || undefined,
      reason: form.reason.trim() || undefined,
    }, {
      onSuccess: () => { toast.success('Asset transferred'); setIsOpen(false); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Transfer failed'),
    });
  };

  const exportCSV = () => downloadCSV('asset-transfers.csv', transfers.map(t => ({
    Date: t.transferDate, Code: t.assetCode, Asset: t.assetName,
    From: t.fromName, To: t.toName,
    'Approved By': t.approvedBy || '', Reason: t.reason || '', 'Recorded By': t.createdBy || '',
  })));

  if (!perm.isLoading && !perm.canView) return <AssetsAccessDenied />;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ArrowRightLeft className="w-6 h-6 text-primary" /> Asset Transfers</h1>
            <p className="text-muted-foreground mt-1">Moves between locations — recorded in history, no accounting entries.</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={exportCSV}><Download className="w-4 h-4 mr-2" /> Export</Button>
            )}
            {perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> New Transfer</Button>}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20 items-center">
            <span className="text-xs text-muted-foreground">Transfer date</span>
            <div className="flex items-center gap-1.5">
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-9 text-xs w-36" />
              <span className="text-muted-foreground text-xs">to</span>
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-9 text-xs w-36" />
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="code" sort={sort}>Code</SortableHead>
                <SortableHead k="asset" sort={sort}>Asset</SortableHead>
                <SortableHead k="from" sort={sort}>From</SortableHead>
                <SortableHead k="to" sort={sort}>To</SortableHead>
                <SortableHead k="approvedBy" sort={sort}>Approved By</SortableHead>
                <SortableHead k="reason" sort={sort}>Reason</SortableHead>
                <SortableHead k="recordedBy" sort={sort}>Recorded By</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : transfers.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-16 text-muted-foreground">
                  <ArrowRightLeft className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No transfers recorded</p>
                </TableCell></TableRow>
              ) : sorted.map(t => (
                <TableRow key={t.id} className="hover:bg-muted/10">
                  <TableCell className="whitespace-nowrap text-sm">{fmtDate(t.transferDate)}</TableCell>
                  <TableCell className="font-mono text-sm font-semibold whitespace-nowrap">{t.assetCode}</TableCell>
                  <TableCell className="font-medium">{t.assetName}</TableCell>
                  <TableCell className="text-sm">{t.fromName}</TableCell>
                  <TableCell className="text-sm font-medium">{t.toName}</TableCell>
                  <TableCell className="text-sm">{t.approvedBy || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[240px] truncate" title={t.reason || undefined}>{t.reason || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{t.createdBy || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ArrowRightLeft className="w-5 h-5 text-primary" /> New Asset Transfer</DialogTitle>
            <DialogDescription>Updates the asset's current location on the register. No accounting entries.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Asset <span className="text-destructive">*</span></label>
              <Select value={form.assetId} onValueChange={v => setForm(s => ({ ...s, assetId: v, to: '' }))}>
                <SelectTrigger><SelectValue placeholder="Select asset" /></SelectTrigger>
                <SelectContent>
                  {(activeAssets as AssetPurchase[]).map(a => (
                    <SelectItem key={a.id} value={String(a.id)}>{a.assetCode} — {a.assetName} ({a.currentLocationName})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedAsset && (
                <p className="text-xs text-muted-foreground">Currently at <span className="font-medium">{selectedAsset.currentLocationName}</span></p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">To Location <span className="text-destructive">*</span></label>
              <Select value={form.to} onValueChange={v => setForm(s => ({ ...s, to: v }))}>
                <SelectTrigger><SelectValue placeholder="Select destination" /></SelectTrigger>
                <SelectContent>
                  {locationOptions
                    .filter(o => selectedAsset ? locKey(o.type, o.id) !== locKey(selectedAsset.currentLocationType, selectedAsset.currentLocationId) : true)
                    .map(o => <SelectItem key={locKey(o.type, o.id)} value={locKey(o.type, o.id)}>{o.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Transfer Date</label>
              <Input type="date" value={form.transferDate} onChange={e => setForm(s => ({ ...s, transferDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Approved By</label>
              <Input placeholder="Name of the approver" value={form.approvedBy} onChange={e => setForm(s => ({ ...s, approvedBy: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Reason</label>
              <Textarea rows={2} placeholder="Why is the asset moving?" value={form.reason} onChange={e => setForm(s => ({ ...s, reason: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
            <Button onClick={onSubmit} disabled={createTransfer.isPending}>{createTransfer.isPending ? 'Transferring…' : 'Transfer'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
