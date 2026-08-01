/**
 * Asset Disposal — mark an asset Sold / Scrapped / Written Off / Transferred
 * Outside, with full history.
 *
 * Disposal closes the asset on the register. No accounting entries are posted
 * yet — the data model leaves room for disposal accounting and depreciation
 * later, but for now the books keep the asset at cost.
 */
import { useMemo, useState } from 'react';
import {
  useAssetPurchases, useAssetDisposals, useCreateAssetDisposal,
  type AssetPurchase, type AssetDisposalType,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Archive, Download } from 'lucide-react';
import { usePermission } from '@/lib/usePermission';
import { toast } from 'sonner';
import { downloadCSV } from '@/lib/download';
import { fmt, fmtDate } from '@/pages/reports/shared';
import { AssetsAccessDenied, ASSET_STATUS_LABELS } from './shared';

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const TYPE_CLS: Record<string, string> = {
  sold: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  scrapped: 'bg-red-500/10 text-red-600 border-red-500/20',
  written_off: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  transferred_outside: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
};

export default function AssetDisposal() {
  const perm = usePermission('page:/assets/disposal');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const params = useMemo(() => ({
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
  }), [fromDate, toDate]);

  const { data: disposals = [], isLoading } = useAssetDisposals(params);
  const { data: activeAssets = [] } = useAssetPurchases({ status: 'active' });
  const createDisposal = useCreateAssetDisposal();

  const [form, setForm] = useState({
    assetId: '', disposalType: 'sold' as AssetDisposalType, disposalDate: todayIso(), reason: '',
  });
  const selectedAsset: AssetPurchase | undefined = (activeAssets as AssetPurchase[]).find(a => String(a.id) === form.assetId);

  const openAdd = () => {
    setForm({ assetId: '', disposalType: 'sold', disposalDate: todayIso(), reason: '' });
    setIsOpen(true);
  };

  const onSubmit = () => {
    if (!form.assetId) { toast.error('Select an asset'); return; }
    createDisposal.mutate({
      assetPurchaseId: Number(form.assetId),
      disposalType: form.disposalType,
      disposalDate: form.disposalDate,
      reason: form.reason.trim() || undefined,
    }, {
      onSuccess: () => { toast.success('Asset marked as disposed'); setIsOpen(false); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Disposal failed'),
    });
  };

  const exportCSV = () => downloadCSV('asset-disposals.csv', disposals.map(d => ({
    Date: d.disposalDate, Code: d.assetCode, Asset: d.assetName,
    Type: ASSET_STATUS_LABELS[d.disposalType] ?? d.disposalType,
    Reason: d.reason || '', 'Recorded By': d.createdBy || '',
  })));

  if (!perm.isLoading && !perm.canView) return <AssetsAccessDenied />;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Archive className="w-6 h-6 text-primary" /> Asset Disposal</h1>
            <p className="text-muted-foreground mt-1">Sold, scrapped, written-off or transferred-outside assets — with history.</p>
          </div>
          <div className="flex gap-2">
            {perm.canDownload && (
              <Button variant="outline" size="sm" onClick={exportCSV}><Download className="w-4 h-4 mr-2" /> Export</Button>
            )}
            {perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> Record Disposal</Button>}
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20 items-center">
            <span className="text-xs text-muted-foreground">Disposal date</span>
            <div className="flex items-center gap-1.5">
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-9 text-xs w-36" />
              <span className="text-muted-foreground text-xs">to</span>
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-9 text-xs w-36" />
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Date</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Asset Cost</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Recorded By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : disposals.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <Archive className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No disposals recorded</p>
                </TableCell></TableRow>
              ) : disposals.map(d => (
                <TableRow key={d.id} className="hover:bg-muted/10">
                  <TableCell className="whitespace-nowrap text-sm">{fmtDate(d.disposalDate)}</TableCell>
                  <TableCell className="font-mono text-sm font-semibold whitespace-nowrap">{d.assetCode}</TableCell>
                  <TableCell className="font-medium">{d.assetName}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`text-xs whitespace-nowrap ${TYPE_CLS[d.disposalType] ?? ''}`}>
                      {ASSET_STATUS_LABELS[d.disposalType] ?? d.disposalType}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">{d.totalCost != null ? fmt(d.totalCost) : '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[280px] truncate" title={d.reason || undefined}>{d.reason || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{d.createdBy || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive"><Archive className="w-5 h-5" /> Record Disposal</DialogTitle>
            <DialogDescription>Closes the asset on the register. No accounting entries are posted yet.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Asset <span className="text-destructive">*</span></label>
              <Select value={form.assetId} onValueChange={v => setForm(s => ({ ...s, assetId: v }))}>
                <SelectTrigger><SelectValue placeholder="Select asset" /></SelectTrigger>
                <SelectContent>
                  {(activeAssets as AssetPurchase[]).map(a => (
                    <SelectItem key={a.id} value={String(a.id)}>{a.assetCode} — {a.assetName} ({a.currentLocationName})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedAsset && (
                <p className="text-xs text-muted-foreground">Cost {fmt(selectedAsset.totalCost)} · at {selectedAsset.currentLocationName}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Disposal Type <span className="text-destructive">*</span></label>
              <Select value={form.disposalType} onValueChange={v => setForm(s => ({ ...s, disposalType: v as AssetDisposalType }))}>
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
              <Input type="date" value={form.disposalDate} onChange={e => setForm(s => ({ ...s, disposalDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Reason</label>
              <Textarea rows={2} placeholder="e.g. beyond repair, sold to…" value={form.reason} onChange={e => setForm(s => ({ ...s, reason: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={onSubmit} disabled={createDisposal.isPending}>{createDisposal.isPending ? 'Recording…' : 'Dispose Asset'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
