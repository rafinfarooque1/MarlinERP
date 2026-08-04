import { useMemo, useState } from 'react';
import {
  useListStock,
  useListWarehouses,
  useListOutlets,
  useListStockVerifications,
  useCreateStockVerification,
  type VerificationReason,
  type StockVerification as StockVerificationType,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ClipboardCheck, Info, ShieldOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { useOutletsEnabled, useClearOutletSelection } from '@/lib/useFeatureFlags';

const fmtQty = (n: number | string) => Number(n || 0).toLocaleString('en-IN');
const fmtDate = (d: string) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

const REASON_OPTIONS: { value: VerificationReason; label: string }[] = [
  { value: 'damage', label: 'Damage' },
  { value: 'wastage', label: 'Wastage' },
  { value: 'count_correction', label: 'Count correction' },
  { value: 'expired', label: 'Expired' },
];

const reasonLabel = (r: VerificationReason | null) =>
  r ? REASON_OPTIONS.find(o => o.value === r)?.label ?? r : null;

interface CountRow {
  itemId: number;
  itemName: string;
  unit: string;
  systemQty: number;
  countedQty: string;
  reason: VerificationReason;
}

const VarianceCell = ({ variance }: { variance: number }) => (
  <span
    className={`font-mono font-bold ${
      variance > 0 ? 'text-emerald-500' : variance < 0 ? 'text-red-500' : 'text-muted-foreground'
    }`}
  >
    {variance > 0 ? '+' : ''}
    {fmtQty(variance)}
  </span>
);

function NewCountTab({ canAdd }: { canAdd: boolean }) {
  const today = new Date().toISOString().split('T')[0];
  const [branchType, setBranchType] = useState('');
  const [branchId, setBranchId] = useState('');
  useClearOutletSelection(branchType === 'outlet', () => { setBranchType(''); setBranchId(''); });
  const [verifyDate, setVerifyDate] = useState(today);
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<CountRow[]>([]);
  const [loadedKey, setLoadedKey] = useState('');

  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();

  const branchOptions =
    branchType === 'headoffice'
      ? [{ id: 1, name: 'Head Office' }]
      : branchType === 'warehouse'
        ? warehouses
        : branchType === 'outlet'
          ? outlets
          : [];

  const locationReady = !!branchType && !!branchId;
  const stockParams = locationReady ? { branchType, branchId: Number(branchId) } : undefined;
  const { data: stock = [], isLoading: stockLoading } = useListStock(stockParams as any);

  const createMutation = useCreateStockVerification();

  const currentKey = `${branchType}:${branchId}`;
  // Sync rows to loaded stock when location/stock changes.
  const freshRows = useMemo<CountRow[]>(
    () =>
      stock.map(s => ({
        itemId: Number(s.itemId),
        itemName: s.itemName ?? '',
        unit: s.unit ?? '',
        systemQty: Number(s.quantity) || 0,
        countedQty: String(Number(s.quantity) || 0),
        reason: 'count_correction' as VerificationReason,
      })),
    [stock],
  );

  if (locationReady && !stockLoading && loadedKey !== currentKey) {
    setRows(freshRows);
    setLoadedKey(currentKey);
  }
  if (!locationReady && loadedKey !== '') {
    setRows([]);
    setLoadedKey('');
  }

  const resetToSystem = () => setRows(freshRows);

  const varianceOf = (r: CountRow) => (Number(r.countedQty) || 0) - r.systemQty;
  const diffCount = rows.filter(r => varianceOf(r) !== 0).length;

  const setCounted = (itemId: number, value: string) =>
    setRows(prev => prev.map(r => (r.itemId === itemId ? { ...r, countedQty: value } : r)));
  const setReason = (itemId: number, reason: VerificationReason) =>
    setRows(prev => prev.map(r => (r.itemId === itemId ? { ...r, reason } : r)));

  const submit = () => {
    if (!locationReady || rows.length === 0) return;
    const lines = rows.map(r => {
      const variance = varianceOf(r);
      return {
        itemId: r.itemId,
        countedQty: Number(r.countedQty) || 0,
        ...(variance !== 0 ? { reason: r.reason } : {}),
      };
    });
    createMutation.mutate(
      { branchType, branchId: Number(branchId), verifyDate, notes: notes || undefined, lines },
      {
        onSuccess: res => {
          const n = res.adjustedCount ?? 0;
          toast.success(`${n} item(s) adjusted`);
          resetToSystem();
          setNotes('');
        },
        onError: (e: any) => toast.error(e?.data?.error || e?.message || 'Failed to record verification'),
      },
    );
  };

  return (
    <div className="space-y-4">
      {/* Location pickers */}
      <div className="bg-card border border-border rounded-xl p-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Location type</label>
          <Select value={branchType} onValueChange={v => { setBranchType(v); setBranchId(''); }}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Select type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="headoffice">Head Office</SelectItem>
              <SelectItem value="warehouse">Warehouse</SelectItem>
              {outletsEnabled && <SelectItem value="outlet">Outlet</SelectItem>}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Location</label>
          <Select value={branchId} onValueChange={setBranchId} disabled={!branchType}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Select location" /></SelectTrigger>
            <SelectContent>
              {branchOptions.map((b: any) => (
                <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Verification date</label>
          <Input type="date" value={verifyDate} onChange={e => setVerifyDate(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1.5 flex-1 min-w-[180px]">
          <label className="text-xs text-muted-foreground">Notes (optional)</label>
          <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Month-end physical count" />
        </div>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <p>
          Variances adjust stock immediately — shrinkage consumes the oldest batches first (FEFO); surplus is
          recorded as an auditable ADJ batch.
        </p>
      </div>

      {/* Count sheet */}
      {!locationReady ? (
        <div className="bg-card border border-border rounded-xl py-16 text-center text-muted-foreground">
          <ClipboardCheck className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p className="text-sm">Choose a location to load its count sheet</p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Item</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="text-right">System Qty</TableHead>
                  <TableHead className="text-right">Counted Qty</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead className="w-48">Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stockLoading ? (
                  [...Array(5)].map((_, i) => (
                    <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-16 text-muted-foreground text-sm">
                      No stock recorded at this location
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map(r => {
                    const variance = varianceOf(r);
                    return (
                      <TableRow key={r.itemId} className="hover:bg-muted/10">
                        <TableCell className="font-medium">{r.itemName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.unit}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmtQty(r.systemQty)}</TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            value={r.countedQty}
                            onChange={e => setCounted(r.itemId, e.target.value)}
                            className="w-28 ml-auto text-right font-mono"
                          />
                        </TableCell>
                        <TableCell className="text-right"><VarianceCell variance={variance} /></TableCell>
                        <TableCell>
                          <Select
                            value={r.reason}
                            onValueChange={v => setReason(r.itemId, v as VerificationReason)}
                            disabled={variance === 0}
                          >
                            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {REASON_OPTIONS.map(o => (
                                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {rows.length > 0 && (
            <div className="p-4 border-t border-border flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{diffCount}</span> of{' '}
                <span className="font-semibold text-foreground">{rows.length}</span> items differ from system
              </p>
              {canAdd && (
                <Button onClick={submit} disabled={createMutation.isPending || !locationReady || rows.length === 0}>
                  {createMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Recording…</>
                  ) : (
                    <><ClipboardCheck className="w-4 h-4 mr-2" /> Record Verification</>
                  )}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryTab() {
  const { data: verifications = [], isLoading } = useListStockVerifications();
  const [selected, setSelected] = useState<StockVerificationType | null>(null);

  const { sorted, sort } = useTableSort(verifications, {
    verifyDate:    v => v.verifyDate,
    branchName:    v => v.branchName,
    itemsCounted:  v => Number(v.lineCount ?? v.lines.length),
    adjustedCount: v => Number(v.adjustedCount ?? 0),
    createdBy:     v => v.createdBy,
    notes:         v => v.notes,
  });

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="verifyDate" sort={sort}>Date</SortableHead>
                <SortableHead k="branchName" sort={sort}>Location</SortableHead>
                <SortableHead k="itemsCounted" sort={sort} className="text-right">Items Counted</SortableHead>
                <SortableHead k="adjustedCount" sort={sort} className="text-right">Adjusted</SortableHead>
                <SortableHead k="createdBy" sort={sort}>By</SortableHead>
                <SortableHead k="notes" sort={sort}>Notes</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                ))
              ) : verifications.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-16 text-muted-foreground text-sm">
                    <ClipboardCheck className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    No verifications recorded yet
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map(v => (
                  <TableRow key={v.id} className="hover:bg-muted/10 cursor-pointer" onClick={() => setSelected(v)}>
                    <TableCell className="text-sm">{fmtDate(v.verifyDate)}</TableCell>
                    <TableCell className="font-medium">{v.branchName}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{v.lineCount ?? v.lines.length}</TableCell>
                    <TableCell className="text-right">
                      {(v.adjustedCount ?? 0) > 0 ? (
                        <Badge className="bg-amber-500/15 text-amber-600 hover:bg-amber-500/15 border-0 font-mono">
                          {v.adjustedCount}
                        </Badge>
                      ) : (
                        <span className="font-mono text-sm text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{v.createdBy}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{v.notes || '—'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={!!selected} onOpenChange={o => !o && setSelected(null)}>
        <DialogContent className="max-w-3xl">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Verification #{selected.id} — {selected.branchName}, {fmtDate(selected.verifyDate)}
                </DialogTitle>
              </DialogHeader>
              <div className="overflow-x-auto border border-border rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">System</TableHead>
                      <TableHead className="text-right">Counted</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selected.lines.map((l, i) => (
                      <TableRow key={i} className="hover:bg-muted/10">
                        <TableCell className="font-medium">{l.itemName}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmtQty(l.systemQty)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmtQty(l.countedQty)}</TableCell>
                        <TableCell className="text-right"><VarianceCell variance={Number(l.variance) || 0} /></TableCell>
                        <TableCell>
                          {l.reason ? (
                            <Badge variant="secondary" className="capitalize">{reasonLabel(l.reason)}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function StockVerification() {
  const perms = usePermission('page:/headoffice/stock-verification');
  const [tab, setTab] = useState('new');

  if (!perms.isLoading && !perms.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <ShieldOff className="w-10 h-10 text-muted-foreground mb-3" />
          <h2 className="text-lg font-semibold">No access</h2>
          <p className="text-sm text-muted-foreground mt-1">You don't have permission to view Stock Verification.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardCheck className="w-6 h-6 text-primary" /> Stock Verification
          </h1>
          <p className="text-muted-foreground mt-1">Physical count with automatic variance adjustment</p>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="new">New Count</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="new" className="mt-4">
            <NewCountTab canAdd={perms.canAdd} />
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <HistoryTab />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
