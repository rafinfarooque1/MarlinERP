import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  useGetCashInOutlet, useGetCashDeposits, useCreateCashDeposit, useReconcileCashDeposit,
  useGetBankLedgers,
} from '@workspace/api-client-react';
import { toast } from 'sonner';
import { Banknote, ArrowUpFromLine, CheckCircle2, Store, Warehouse } from 'lucide-react';

function fmt(n: number) {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function DepositStatusBadge({ status }: { status: string }) {
  if (status === 'reconciled') return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Reconciled</Badge>;
  if (status === 'cancelled')  return <Badge variant="outline" className="text-muted-foreground">Cancelled</Badge>;
  return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20">Pending</Badge>;
}

function LocationTypeBadge({ type }: { type: string }) {
  if (type === 'warehouse') {
    return (
      <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-400/40 bg-blue-500/5 font-normal flex items-center gap-0.5 px-1.5">
        <Warehouse className="w-2.5 h-2.5" /> Warehouse
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-400/40 bg-emerald-500/5 font-normal flex items-center gap-0.5 px-1.5">
      <Store className="w-2.5 h-2.5" /> Outlet
    </Badge>
  );
}

export default function CashBalance() {
  const perm = usePermission('Cash Balance');
  const [tab, setTab] = useState<'balances' | 'deposits'>('balances');

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <Banknote className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Cash Balance.</p>
        </div>
      </AppLayout>
    );
  }
  const [depositFilter, setDepositFilter] = useState('all');

  const { data: allBalances = [], isLoading: balancesLoading, refetch: refetchBalances } = useGetCashInOutlet();
  const { data: deposits = [], isLoading: depositsLoading } = useGetCashDeposits(
    depositFilter !== 'all' ? { status: depositFilter } : undefined
  );
  const { data: bankLedgers = [] } = useGetBankLedgers();

  // Only outlets can have deposits recorded
  const outletBalances = allBalances.filter(b => b.locationType === 'outlet');

  // Create deposit dialog
  const [showDeposit, setShowDeposit] = useState(false);
  const [depOutletId, setDepOutletId] = useState('');
  const [depAmount, setDepAmount] = useState('');
  const [depDate, setDepDate] = useState(new Date().toISOString().split('T')[0]);
  const [depRef, setDepRef] = useState('');
  const [depBankLedgerId, setDepBankLedgerId] = useState('');
  const [depNotes, setDepNotes] = useState('');
  const createDepositMutation = useCreateCashDeposit();

  const selectedOutletBalance = outletBalances.find(b => b.outletId === Number(depOutletId));

  async function handleCreateDeposit() {
    if (!depOutletId) { toast.error('Select an outlet'); return; }
    const amount = Number(depAmount);
    if (!amount || amount <= 0) { toast.error('Amount must be positive'); return; }
    if (!depDate) { toast.error('Deposit date is required'); return; }
    try {
      await createDepositMutation.mutateAsync({
        outletId: Number(depOutletId),
        amount,
        depositDate: depDate,
        depositReference: depRef || undefined,
        destinationBankLedgerId: depBankLedgerId ? Number(depBankLedgerId) : undefined,
        notes: depNotes || undefined,
      });
      toast.success('Cash deposit recorded');
      setShowDeposit(false);
      setDepOutletId(''); setDepAmount(''); setDepRef(''); setDepNotes(''); setDepBankLedgerId('');
      refetchBalances();
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Failed to record deposit');
    }
  }

  // Reconcile deposit dialog
  const [reconcileDepositId, setReconcileDepositId] = useState<number>(0);
  const [recBankLedgerId, setRecBankLedgerId] = useState('');
  const [recBankRef, setRecBankRef] = useState('');
  const [recCharges, setRecCharges] = useState('0');
  const [recDate, setRecDate] = useState(new Date().toISOString().split('T')[0]);
  const reconcileMutation = useReconcileCashDeposit();

  const selectedDeposit = deposits.find(d => d.id === reconcileDepositId);

  function openReconcile(deposit: any) {
    setReconcileDepositId(deposit.id);
    setRecBankLedgerId(deposit.destinationBankLedgerId ? String(deposit.destinationBankLedgerId) : '');
    setRecBankRef(''); setRecCharges('0');
    setRecDate(new Date().toISOString().split('T')[0]);
  }

  async function handleReconcile() {
    if (!recBankLedgerId) { toast.error('Select a bank account'); return; }
    if (!recDate) { toast.error('Date is required'); return; }
    try {
      await reconcileMutation.mutateAsync({
        id: reconcileDepositId,
        data: {
          destinationBankLedgerId: Number(recBankLedgerId),
          bankReference: recBankRef || undefined,
          charges: Number(recCharges) || 0,
          settlementDate: recDate,
        },
      });
      toast.success('Cash deposit reconciled to bank');
      setReconcileDepositId(0);
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Failed to reconcile deposit');
    }
  }

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Cash Balance</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Track physical cash at each outlet and warehouse, and record bank deposits
            </p>
          </div>
          {tab === 'balances' && (
            <Button size="sm" onClick={() => setShowDeposit(true)} disabled={!perm.canAdd || outletBalances.length === 0}>
              <ArrowUpFromLine className="w-4 h-4 mr-1.5" /> Record Deposit
            </Button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border">
          {(['balances', 'deposits'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium transition-colors capitalize ${tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {t === 'balances' ? 'Cash Balances' : 'Deposits'}
            </button>
          ))}
        </div>

        {/* ── Balances Tab ── */}
        {tab === 'balances' && (
          balancesLoading ? (
            <div className="py-12 text-center text-muted-foreground">Loading…</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {allBalances.map(b => (
                <div key={`${b.locationType}-${b.locationId}`} className="rounded-xl border border-border p-4 space-y-3 bg-card hover:shadow-sm transition-shadow">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-sm">{b.locationName}</p>
                    <LocationTypeBadge type={b.locationType} />
                  </div>

                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cash balance</span>
                      <span className="font-mono font-semibold">{fmt(b.cashBalance)}</span>
                    </div>
                    {b.pendingDeposits > 0 && (
                      <div className="flex justify-between text-amber-600">
                        <span>In transit</span>
                        <span className="font-mono">({fmt(b.pendingDeposits)})</span>
                      </div>
                    )}
                    <Separator />
                    <div className="flex justify-between font-semibold text-emerald-600">
                      <span>Available</span>
                      <span className="font-mono">{fmt(b.availableBalance)}</span>
                    </div>
                  </div>

                  {/* Deposits only for outlets */}
                  {b.locationType === 'outlet' && b.availableBalance > 0 && perm.canAdd && (
                    <Button
                      size="sm" variant="outline" className="w-full h-7 text-xs"
                      onClick={() => {
                        setDepOutletId(String(b.outletId));
                        setDepAmount(String(b.availableBalance));
                        setShowDeposit(true);
                      }}
                    >
                      <ArrowUpFromLine className="w-3 h-3 mr-1" /> Deposit to Bank
                    </Button>
                  )}
                </div>
              ))}
              {allBalances.length === 0 && (
                <div className="col-span-full py-16 text-center text-muted-foreground space-y-2">
                  <Banknote className="w-10 h-10 mx-auto opacity-30" />
                  <p className="font-medium">No cash balance data</p>
                </div>
              )}
            </div>
          )
        )}

        {/* ── Deposits Tab ── */}
        {tab === 'deposits' && (
          <div className="space-y-3">
            <div className="flex gap-2 items-center">
              <Select value={depositFilter} onValueChange={setDepositFilter}>
                <SelectTrigger className="h-8 w-44 text-sm"><SelectValue placeholder="All deposits" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All deposits</SelectItem>
                  <SelectItem value="pending_reconciliation">Pending reconciliation</SelectItem>
                  <SelectItem value="reconciled">Reconciled</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {depositsLoading ? (
              <div className="py-12 text-center text-muted-foreground">Loading…</div>
            ) : deposits.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground space-y-2">
                <ArrowUpFromLine className="w-10 h-10 mx-auto opacity-30" />
                <p className="font-medium">No deposits found</p>
              </div>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Location</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>Bank Account</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deposits.map(d => (
                      <TableRow key={d.id}>
                        <TableCell className="text-sm font-medium">{d.outletName}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{d.depositDate}</TableCell>
                        <TableCell className="font-mono text-xs">{d.depositReference ?? '—'}</TableCell>
                        <TableCell className="text-sm">{d.bankLedgerName ?? <span className="text-muted-foreground italic text-xs">Not specified</span>}</TableCell>
                        <TableCell className="text-right font-mono font-semibold text-sm">{fmt(d.amount)}</TableCell>
                        <TableCell><DepositStatusBadge status={d.status} /></TableCell>
                        <TableCell className="text-right">
                          {d.status === 'pending_reconciliation' && perm.canEdit && (
                            <Button variant="outline" size="sm" onClick={() => openReconcile(d)}>
                              <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Mark Received
                            </Button>
                          )}
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

      {/* ── Create Deposit Dialog (outlets only) ── */}
      <Dialog open={showDeposit} onOpenChange={setShowDeposit}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Cash Deposit</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-sm mb-1.5 block">Outlet <span className="text-destructive">*</span></Label>
              <Select value={depOutletId} onValueChange={setDepOutletId}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select outlet…" /></SelectTrigger>
                <SelectContent>
                  {outletBalances.map(b => (
                    <SelectItem key={b.outletId!} value={String(b.outletId)}>
                      {b.locationName} — available {fmt(b.availableBalance)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm mb-1.5 block">Amount (₹) <span className="text-destructive">*</span></Label>
              <Input type="number" min={0.01} step={0.01} value={depAmount} onChange={e => setDepAmount(e.target.value)} className="h-9" placeholder="0.00" />
              {selectedOutletBalance && (
                <p className="text-xs text-muted-foreground mt-1">Available: {fmt(selectedOutletBalance.availableBalance)}</p>
              )}
            </div>
            <div>
              <Label className="text-sm mb-1.5 block">Deposit Date <span className="text-destructive">*</span></Label>
              <Input type="date" value={depDate} onChange={e => setDepDate(e.target.value)} className="h-9" />
            </div>
            <div>
              <Label className="text-sm mb-1.5 block">Deposit Reference / Slip No.</Label>
              <Input value={depRef} onChange={e => setDepRef(e.target.value)} className="h-9" placeholder="e.g. DEP-001 or slip number" />
            </div>
            <div>
              <Label className="text-sm mb-1.5 block">Destination Bank Account <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
              <Select value={depBankLedgerId} onValueChange={setDepBankLedgerId}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select bank account (optional)…" /></SelectTrigger>
                <SelectContent>
                  {bankLedgers.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm mb-1.5 block">Notes</Label>
              <Input value={depNotes} onChange={e => setDepNotes(e.target.value)} className="h-9" placeholder="Optional notes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeposit(false)}>Cancel</Button>
            <Button onClick={handleCreateDeposit} disabled={createDepositMutation.isPending}>
              {createDepositMutation.isPending ? 'Recording…' : 'Record Deposit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reconcile Deposit Dialog ── */}
      <Dialog open={reconcileDepositId > 0} onOpenChange={o => { if (!o) setReconcileDepositId(0); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm Bank Receipt</DialogTitle>
          </DialogHeader>
          {selectedDeposit && (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border border-border p-3 text-sm space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Outlet</span>
                  <span>{selectedDeposit.outletName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Deposit Amount</span>
                  <span className="font-mono font-semibold">{fmt(selectedDeposit.amount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Deposited</span>
                  <span>{selectedDeposit.depositDate}</span>
                </div>
                {Number(recCharges) > 0 && (
                  <>
                    <Separator />
                    <div className="flex justify-between text-emerald-600 font-semibold">
                      <span>Net to bank</span>
                      <span className="font-mono">{fmt(selectedDeposit.amount - (Number(recCharges) || 0))}</span>
                    </div>
                  </>
                )}
              </div>

              <div>
                <Label className="text-sm mb-1.5 block">Confirmation Date <span className="text-destructive">*</span></Label>
                <Input type="date" value={recDate} onChange={e => setRecDate(e.target.value)} className="h-9" />
              </div>
              <div>
                <Label className="text-sm mb-1.5 block">Bank Account <span className="text-destructive">*</span></Label>
                <Select value={recBankLedgerId} onValueChange={setRecBankLedgerId}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Select bank account…" /></SelectTrigger>
                  <SelectContent>
                    {bankLedgers.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm mb-1.5 block">Bank Transaction Reference</Label>
                <Input value={recBankRef} onChange={e => setRecBankRef(e.target.value)} className="h-9" placeholder="UTR / transaction ID" />
              </div>
              <div>
                <Label className="text-sm mb-1.5 block">Bank Charges (₹)</Label>
                <Input type="number" min={0} step={0.01} value={recCharges} onChange={e => setRecCharges(e.target.value)} className="h-9" placeholder="0.00" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReconcileDepositId(0)}>Cancel</Button>
            <Button onClick={handleReconcile} disabled={reconcileMutation.isPending}>
              {reconcileMutation.isPending ? 'Processing…' : 'Confirm Receipt'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
