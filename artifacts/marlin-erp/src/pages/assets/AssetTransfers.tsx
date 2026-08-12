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
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { EntityCombobox } from '@/components/ui/entity-combobox';
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

  const { pageRows, pagerProps } = useClientPage(sorted);

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
        <PageHeader
          title="Asset Transfers"
          description="Moves between locations — recorded in history, no accounting entries."
          icon={ArrowRightLeft}
          actions={
            <>
              {perm.canDownload && (
                <Button variant="outline" size="sm" onClick={exportCSV}><Download className="w-4 h-4 mr-2" /> Export</Button>
              )}
              {perm.canAdd && <Button onClick={openAdd}><Plus className="w-4 h-4 mr-2" /> New Transfer</Button>}
            </>
          }
        />

        <SummaryCardGrid>
          <SummaryCard label="Transfers" value={String(transfers.length)} icon={ArrowRightLeft} tone="default" loading={isLoading} />
        </SummaryCardGrid>

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
              {isLoading ? (
                <TableRow><TableCell colSpan={8} className="p-0"><TableSkeleton rows={8} cols={8} /></TableCell></TableRow>
              ) : transfers.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="p-0">
                  <EmptyState icon={ArrowRightLeft} title="No transfers recorded" hint="Record an asset move to see it here." compact />
                </TableCell></TableRow>
              ) : pageRows.map(t => (
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
          <div className="px-4 py-2 border-t border-border">
            <TablePager {...pagerProps} />
          </div>
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
              <EntityCombobox
                options={(activeAssets as AssetPurchase[]).map(a => ({ id: a.id, label: `${a.assetCode} — ${a.assetName}`, sublabel: a.currentLocationName }))}
                value={form.assetId ? Number(form.assetId) : null}
                onChange={id => setForm(s => ({ ...s, assetId: id ? String(id) : '', to: '' }))}
                placeholder="Select asset"
                searchPlaceholder="Search assets…"
                emptyLabel="No assets found."
              />
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
