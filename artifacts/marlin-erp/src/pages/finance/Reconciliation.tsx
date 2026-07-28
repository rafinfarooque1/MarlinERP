import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  useGetPendingPayments, useGetReconciliationBatches, useGetReconciliationBatch,
  useGetBankLedgers, useCreateReconciliationBatch,
  useListOutlets,
} from '@workspace/api-client-react';
import { toast } from 'sonner';
import { CheckSquare, RefreshCw, Layers, Info, IndianRupee, CreditCard } from 'lucide-react';
import { paymentModeLabel } from '@/lib/paymentModes';

// ── Payment method badge ─────────────────────────────────────────────────────

function MethodBadge({ method }: { method: string }) {
  const map: Record<string, string> = {
    upi: 'bg-violet-500/10 text-violet-600 border-violet-500/20',
    // Legacy 'card' / 'bank_transfer' rows read as Bank and share its colour.
    bank: 'bg-teal-500/10 text-teal-600 border-teal-500/20',
    card: 'bg-teal-500/10 text-teal-600 border-teal-500/20',
    bank_transfer: 'bg-teal-500/10 text-teal-600 border-teal-500/20',
    other: 'bg-gray-500/10 text-gray-600 border-gray-500/20',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-medium uppercase ${map[method] ?? map.other}`}>
      {paymentModeLabel(method)}
    </span>
  );
}

function fmt(n: number) {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Reconciliation() {
  const perm = usePermission('Reconciliation');
  const [tab, setTab] = useState<'pending' | 'batches'>('pending');

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <CheckSquare className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Reconciliation.</p>
        </div>
      </AppLayout>
    );
  }

  // Filters for pending tab
  const [outletFilter, setOutletFilter] = useState('all');
  const [methodFilter, setMethodFilter] = useState('all');
  const [search, setSearch] = useState('');

  const { data: outlets = [] } = useListOutlets();
  const { data: pending = [], isLoading: pendingLoading } = useGetPendingPayments({
    outletId: outletFilter !== 'all' ? Number(outletFilter) : undefined,
    method: methodFilter !== 'all' ? methodFilter : undefined,
    search: search || undefined,
  });
  const { data: batches = [], isLoading: batchesLoading } = useGetReconciliationBatches();
  const { data: bankLedgers = [] } = useGetBankLedgers();

  // Multi-select state
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggleRow = (id: number) => setSelected(prev => {
    const s = new Set(prev);
    s.has(id) ? s.delete(id) : s.add(id);
    return s;
  });
  const selectAll = () => setSelected(new Set(pending.map(p => p.id)));
  const clearSel  = () => setSelected(new Set());

  // Reconcile dialog state
  const [showReconcile, setShowReconcile] = useState(false);
  const [bankLedgerId, setBankLedgerId] = useState('');
  const [charges, setCharges] = useState('0');
  const [extRef, setExtRef] = useState('');
  const [settlementDate, setSettlementDate] = useState(new Date().toISOString().split('T')[0]);
  const createBatchMutation = useCreateReconciliationBatch();

  const selectedPayments = pending.filter(p => selected.has(p.id));
  const grossTotal = selectedPayments.reduce((s, p) => s + p.amount, 0);
  const chargesAmt = Math.max(0, Number(charges) || 0);
  const netTotal   = grossTotal - chargesAmt;

  function openReconcileDialog() {
    if (selected.size === 0) { toast.error('Select at least one payment'); return; }
    setShowReconcile(true);
  }

  async function handleReconcile() {
    if (!bankLedgerId) { toast.error('Select a destination bank account'); return; }
    if (netTotal <= 0) { toast.error('Net amount must be positive'); return; }
    try {
      await createBatchMutation.mutateAsync({
        salePaymentIds: Array.from(selected),
        charges: chargesAmt,
        settlementDate,
        destinationBankLedgerId: Number(bankLedgerId),
        externalReference: extRef || undefined,
      });
      toast.success('Reconciliation batch created successfully');
      setShowReconcile(false);
      clearSel();
      setCharges('0');
      setExtRef('');
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Failed to create reconciliation batch');
    }
  }

  // Batch detail drawer
  const [selectedBatchId, setSelectedBatchId] = useState<number>(0);
  const { data: batchDetail, isLoading: batchDetailLoading } = useGetReconciliationBatch(selectedBatchId, { enabled: selectedBatchId > 0 });

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Reconciliation</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Match incoming UPI / Card / Bank payments to bank settlements</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border">
          {(['pending', 'batches'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium transition-colors capitalize ${tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t === 'pending' ? `Pending (${pending.length})` : 'Reconciled Batches'}
            </button>
          ))}
        </div>

        {/* ── Pending Tab ── */}
        {tab === 'pending' && (
          <div className="space-y-3">
            {/* Filters */}
            <div className="flex flex-wrap gap-2 items-center">
              <Input
                placeholder="Search invoice / customer…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-8 w-52 text-sm"
              />
              <Select value={outletFilter} onValueChange={setOutletFilter}>
                <SelectTrigger className="h-8 w-40 text-sm"><SelectValue placeholder="All outlets" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All outlets</SelectItem>
                  {outlets.map((o: any) => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={methodFilter} onValueChange={setMethodFilter}>
                <SelectTrigger className="h-8 w-36 text-sm"><SelectValue placeholder="All methods" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All methods</SelectItem>
                  <SelectItem value="upi">UPI</SelectItem>
                  {/* 'bank' also covers older card / bank-transfer rows */}
                  <SelectItem value="bank">Bank</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>

              <div className="flex-1" />

              {selected.size > 0 ? (
                <>
                  <span className="text-sm text-muted-foreground">{selected.size} selected — {fmt(grossTotal)}</span>
                  <Button size="sm" onClick={openReconcileDialog} disabled={!perm.canAdd}>
                    <CheckSquare className="w-4 h-4 mr-1.5" /> Reconcile Selected
                  </Button>
                  <Button variant="outline" size="sm" onClick={clearSel}>Clear</Button>
                </>
              ) : (
                pending.length > 0 && (
                  <Button variant="outline" size="sm" onClick={selectAll}>Select All ({pending.length})</Button>
                )
              )}
            </div>

            {/* Table */}
            {pendingLoading ? (
              <div className="py-12 text-center text-muted-foreground">Loading…</div>
            ) : pending.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground space-y-2">
                <CheckSquare className="w-10 h-10 mx-auto opacity-30" />
                <p className="font-medium">No pending electronic payments</p>
                <p className="text-xs">UPI, card, and bank transfer payments will appear here once collected.</p>
              </div>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"><Checkbox checked={selected.size === pending.length && pending.length > 0} onCheckedChange={v => v ? selectAll() : clearSel()} /></TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Outlet</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.map(p => (
                      <TableRow key={p.id} className={selected.has(p.id) ? 'bg-primary/5' : ''}>
                        <TableCell><Checkbox checked={selected.has(p.id)} onCheckedChange={() => toggleRow(p.id)} /></TableCell>
                        <TableCell className="font-mono text-xs">{p.invoiceNumber}</TableCell>
                        <TableCell className="text-sm">{p.customerName ?? <span className="text-muted-foreground italic text-xs">Walk-in</span>}</TableCell>
                        <TableCell className="text-sm">{p.outletName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{p.paymentDate}</TableCell>
                        <TableCell><MethodBadge method={p.method} /></TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{p.referenceNumber ?? '—'}</TableCell>
                        <TableCell className="text-right font-mono font-semibold text-sm">{fmt(p.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        {/* ── Batches Tab ── */}
        {tab === 'batches' && (
          <div className="space-y-3">
            {batchesLoading ? (
              <div className="py-12 text-center text-muted-foreground">Loading…</div>
            ) : batches.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground space-y-2">
                <Layers className="w-10 h-10 mx-auto opacity-30" />
                <p className="font-medium">No reconciliation batches yet</p>
                <p className="text-xs">Reconcile pending electronic payments to create your first batch.</p>
              </div>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Batch Ref</TableHead>
                      <TableHead>Settlement Date</TableHead>
                      <TableHead>Bank Account</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">Charges</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                      <TableHead className="text-right">Items</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {batches.map(b => (
                      <TableRow key={b.id}>
                        <TableCell className="font-mono text-xs font-semibold">{b.batchReference}</TableCell>
                        <TableCell className="text-sm">{b.settlementDate}</TableCell>
                        <TableCell className="text-sm">{b.bankLedgerName}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmt(b.grossAmount)}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-destructive">{b.charges > 0 ? `(${fmt(b.charges)})` : '—'}</TableCell>
                        <TableCell className="text-right font-mono font-semibold text-sm text-emerald-600">{fmt(b.netAmount)}</TableCell>
                        <TableCell className="text-right text-sm">{b.itemCount}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => setSelectedBatchId(b.id)}>
                            <Info className="w-3.5 h-3.5 mr-1" /> Details
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Reconcile Dialog ── */}
      <Dialog open={showReconcile} onOpenChange={setShowReconcile}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Reconciliation Batch</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Summary */}
            <div className="rounded-lg border border-border p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Payments selected</span>
                <span className="font-semibold">{selected.size}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Gross amount</span>
                <span className="font-mono font-semibold">{fmt(grossTotal)}</span>
              </div>
              {chargesAmt > 0 && (
                <div className="flex justify-between text-destructive">
                  <span>Charges</span>
                  <span className="font-mono">({fmt(chargesAmt)})</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between font-semibold text-emerald-600">
                <span>Net to bank</span>
                <span className="font-mono">{fmt(netTotal)}</span>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <Label className="text-sm mb-1.5 block">Settlement Date</Label>
                <Input type="date" value={settlementDate} onChange={e => setSettlementDate(e.target.value)} className="h-9" />
              </div>
              <div>
                <Label className="text-sm mb-1.5 block">Destination Bank Account <span className="text-destructive">*</span></Label>
                <Select value={bankLedgerId} onValueChange={setBankLedgerId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select bank account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {bankLedgers.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {bankLedgers.length === 0 && (
                  <p className="text-xs text-amber-500 mt-1">No bank accounts found. Add sub-ledgers under the Bank ledger in Chart of Accounts.</p>
                )}
              </div>
              <div>
                <Label className="text-sm mb-1.5 block">Processor Charges (₹)</Label>
                <Input type="number" min={0} step={0.01} value={charges} onChange={e => setCharges(e.target.value)} className="h-9" placeholder="0.00" />
              </div>
              <div>
                <Label className="text-sm mb-1.5 block">Bank / Settlement Reference</Label>
                <Input value={extRef} onChange={e => setExtRef(e.target.value)} placeholder="e.g. UTR12345 or statement ref" className="h-9" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReconcile(false)}>Cancel</Button>
            <Button onClick={handleReconcile} disabled={createBatchMutation.isPending || netTotal <= 0}>
              {createBatchMutation.isPending ? 'Processing…' : `Reconcile ${fmt(netTotal)}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Batch Detail Drawer ── */}
      <Sheet open={selectedBatchId > 0} onOpenChange={o => { if (!o) setSelectedBatchId(0); }}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader className="pb-4">
            <SheetTitle>Batch Detail</SheetTitle>
          </SheetHeader>
          {batchDetailLoading ? (
            <div className="py-12 text-center text-muted-foreground">Loading…</div>
          ) : batchDetail ? (
            <div className="space-y-4">
              {/* Meta */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm rounded-lg border border-border p-3">
                <span className="text-muted-foreground">Reference</span><span className="font-mono font-semibold">{batchDetail.batchReference}</span>
                <span className="text-muted-foreground">Settlement Date</span><span>{batchDetail.settlementDate}</span>
                <span className="text-muted-foreground">Bank Account</span><span>{batchDetail.bankLedgerName}</span>
                <span className="text-muted-foreground">Gross</span><span className="font-mono">{fmt(batchDetail.grossAmount)}</span>
                <span className="text-muted-foreground">Charges</span><span className="font-mono text-destructive">{batchDetail.charges > 0 ? `(${fmt(batchDetail.charges)})` : '—'}</span>
                <span className="text-muted-foreground font-semibold">Net</span><span className="font-mono font-bold text-emerald-600">{fmt(batchDetail.netAmount)}</span>
                {batchDetail.externalReference && <><span className="text-muted-foreground">Ext. Reference</span><span className="font-mono text-xs">{batchDetail.externalReference}</span></>}
              </div>

              {/* Items */}
              <div>
                <p className="text-sm font-semibold mb-2">{batchDetail.items.length} Payment{batchDetail.items.length !== 1 ? 's' : ''}</p>
                <div className="rounded-lg border border-border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {batchDetail.items.map(i => (
                        <TableRow key={i.id}>
                          <TableCell className="font-mono text-xs">{i.invoiceNumber}</TableCell>
                          <TableCell className="text-xs">{i.customerName ?? <span className="text-muted-foreground italic">Walk-in</span>}</TableCell>
                          <TableCell><MethodBadge method={i.method} /></TableCell>
                          <TableCell className="text-right font-mono text-sm">{fmt(i.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
