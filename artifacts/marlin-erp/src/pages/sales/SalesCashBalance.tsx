/**
 * SalesCashBalance — cash balance for the current selling location.
 * Staff can record deposits to bank directly from here (outlet or warehouse).
 */
import { useMemo, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { useLocationContext } from '@/lib/locationContext';
import { useLocationCashBalances } from '@/lib/locationStructure';
import {
  useGetCashDeposits, useCreateCashDeposit, useGetBankLedgers,
} from '@workspace/api-client-react';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { Banknote, Warehouse, Store, RefreshCw, ArrowUpFromLine, CheckCircle2, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { useLocation as useWouter } from 'wouter';

function fmt(n: number) {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function DepositStatusBadge({ status }: { status: string }) {
  if (status === 'reconciled')
    return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Reconciled</Badge>;
  if (status === 'cancelled')
    return <Badge variant="outline" className="text-muted-foreground">Cancelled</Badge>;
  return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20">Pending</Badge>;
}

export default function SalesCashBalance() {
  const perm = usePermission('page:/accounts/cash-in-outlet');
  const { locationState } = useLocationContext();
  const { locationType, locationId, locationName } = locationState;
  const [, navigate] = useWouter();
  const [depositSuccess, setDepositSuccess] = useState<number | null>(null); // amount of last deposit

  const { data: allBalances, isLoading, refetch } = useLocationCashBalances();
  const { data: deposits = [], isLoading: depositsLoading } = useGetCashDeposits(
    locationType === 'outlet' && locationId ? { outletId: locationId } : undefined
  );
  const { data: bankLedgers = [] } = useGetBankLedgers();

  const balance = allBalances.find(
    b => b.locationType === locationType && b.locationId === locationId
  );

  // "Recent" cap (10) stays upstream of sorting so the default order matches
  // the incoming list; sorting only reorders those most-recent rows.
  const recentDeposits = useMemo(() => (deposits as any[]).slice(0, 10), [deposits]);
  const { sorted: sortedDeposits, sort } = useTableSort(recentDeposits, {
    date: (d: any) => d.depositDate,
    reference: (d: any) => d.depositReference,
    bank: (d: any) => d.bankLedgerName,
    amount: (d: any) => Number(d.amount),
    status: (d: any) => d.status,
  });

  // ── Deposit dialog state ───────────────────────────────────────────────────
  const [showDeposit, setShowDeposit]       = useState(false);
  const [depAmount,   setDepAmount]         = useState('');
  const [depDate,     setDepDate]           = useState(new Date().toISOString().split('T')[0]);
  const [depRef,      setDepRef]            = useState('');
  const [depBankId,   setDepBankId]         = useState('');
  const [depNotes,    setDepNotes]          = useState('');
  const createDeposit = useCreateCashDeposit();

  function openDeposit() {
    setDepAmount(balance ? String(balance.availableBalance) : '');
    setDepDate(new Date().toISOString().split('T')[0]);
    setDepRef(''); setDepBankId(''); setDepNotes('');
    setShowDeposit(true);
  }

  async function handleCreateDeposit() {
    const amount = Number(depAmount);
    if (!amount || amount <= 0) { toast.error('Amount must be positive'); return; }
    if (!depDate) { toast.error('Deposit date is required'); return; }
    if (!depBankId) { toast.error('Select a destination bank account'); return; }
    try {
      await createDeposit.mutateAsync({
        ...(locationType === 'warehouse'
          ? { warehouseId: locationId! }
          : { outletId: locationId! }),
        amount,
        depositDate: depDate,
        depositReference: depRef || undefined,
        destinationBankLedgerId: Number(depBankId),
        notes: depNotes || undefined,
      } as any);
      setDepositSuccess(amount);
      setShowDeposit(false);
      refetch();
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Failed to record deposit');
    }
  }

  const LocationIcon = locationType === 'warehouse' ? Warehouse : Store;

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

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-5 max-w-2xl">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Banknote className="w-6 h-6 text-primary" /> Cash Balance
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5">
              <LocationIcon className="w-3.5 h-3.5" />
              {locationName}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {balance && balance.availableBalance > 0 && perm.canAdd && (
              <Button size="sm" onClick={openDeposit}>
                <ArrowUpFromLine className="w-4 h-4 mr-1.5" /> Record Deposit
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* ── Deposit success banner ── */}
        {depositSuccess !== null && (
          <div className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
            <div className="flex-1 text-sm">
              <p className="font-semibold text-emerald-700">
                {fmt(depositSuccess)} deposited to bank — pending confirmation
              </p>
              <p className="text-emerald-600 opacity-80">
                Finance team can reconcile it in Accounts → Reconciliation.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 text-xs"
                onClick={() => navigate('/accounts/reconciliation')}>
                Go to Reconciliation <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Button>
              <button onClick={() => setDepositSuccess(null)} className="text-emerald-600 hover:text-emerald-800 text-lg leading-none px-1">×</button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="py-16 text-center text-muted-foreground">Loading…</div>
        ) : !balance ? (
          <div className="rounded-xl border border-border p-8 text-center space-y-2 text-muted-foreground bg-muted/20">
            <Banknote className="w-10 h-10 mx-auto opacity-30" />
            <p className="font-medium">No cash ledger found</p>
            <p className="text-sm opacity-70">The cash account for this location hasn't been set up yet.</p>
          </div>
        ) : (
          <>
            {/* Balance card */}
            <div className="rounded-xl border border-border bg-card p-5 space-y-4">
              <div className="flex items-center gap-2">
                <LocationIcon className="w-4 h-4 text-muted-foreground" />
                <span className="font-semibold text-sm">{balance.locationName}</span>
                <span className="text-xs text-muted-foreground capitalize bg-muted px-2 py-0.5 rounded-full">
                  {balance.locationType}
                </span>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Cash balance</span>
                  <span className="font-mono font-semibold text-base">{fmt(balance.cashBalance)}</span>
                </div>

                {balance.pendingDeposits > 0 && (
                  <div className="flex justify-between items-center text-amber-600">
                    <span className="text-sm">In transit (deposited, pending bank confirmation)</span>
                    <span className="font-mono text-sm">({fmt(balance.pendingDeposits)})</span>
                  </div>
                )}

                <Separator />

                <div className="flex justify-between items-center font-semibold text-emerald-600">
                  <span className="text-sm">Available</span>
                  <span className="font-mono text-lg">{fmt(balance.availableBalance)}</span>
                </div>
              </div>

              {balance.availableBalance > 0 && perm.canAdd && (
                <Button variant="outline" className="w-full" size="sm" onClick={openDeposit}>
                  <ArrowUpFromLine className="w-4 h-4 mr-1.5" /> Deposit to Bank
                </Button>
              )}
            </div>

            {/* Recent deposits for this location */}
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Recent Deposits</h2>
              {depositsLoading ? (
                <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
              ) : deposits.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-10 text-center text-muted-foreground space-y-1">
                  <ArrowUpFromLine className="w-8 h-8 mx-auto opacity-30" />
                  <p className="text-sm">No deposits recorded yet</p>
                </div>
              ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHead k="date" sort={sort}>Date</SortableHead>
                        <SortableHead k="reference" sort={sort}>Reference</SortableHead>
                        <SortableHead k="bank" sort={sort}>Bank Account</SortableHead>
                        <SortableHead k="amount" sort={sort} className="text-right">Amount</SortableHead>
                        <SortableHead k="status" sort={sort}>Status</SortableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedDeposits.map((d: any) => (
                        <TableRow key={d.id}>
                          <TableCell className="text-sm text-muted-foreground">{d.depositDate}</TableCell>
                          <TableCell className="font-mono text-xs">{d.depositReference ?? '—'}</TableCell>
                          <TableCell className="text-sm">{d.bankLedgerName ?? <span className="text-muted-foreground italic text-xs">Not specified</span>}</TableCell>
                          <TableCell className="text-right font-mono font-semibold text-sm">{fmt(d.amount)}</TableCell>
                          <TableCell><DepositStatusBadge status={d.status} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Deposit Dialog ── */}
      <Dialog open={showDeposit} onOpenChange={setShowDeposit}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Cash Deposit</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Location (read-only) */}
            <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2.5">
              <LocationIcon className="w-4 h-4 text-muted-foreground shrink-0" />
              <div>
                <p className="text-sm font-medium">{locationName}</p>
                <p className="text-[11px] text-muted-foreground capitalize">{locationType}</p>
              </div>
              {balance && (
                <span className="ml-auto text-xs text-muted-foreground">
                  Available: <span className="font-mono font-semibold text-foreground">{fmt(balance.availableBalance)}</span>
                </span>
              )}
            </div>

            <div>
              <Label className="text-sm mb-1.5 block">Amount (₹) <span className="text-destructive">*</span></Label>
              <Input
                type="number" min={0.01} step={0.01}
                value={depAmount} onChange={e => setDepAmount(e.target.value)}
                className="h-9" placeholder="0.00"
              />
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
              <Label className="text-sm mb-1.5 block">
                Destination Bank Account <span className="text-destructive">*</span>
              </Label>
              <Select value={depBankId} onValueChange={setDepBankId}>
                <SelectTrigger className={`h-9 ${!depBankId ? 'border-dashed' : ''}`}>
                  <SelectValue placeholder="Select bank account…" />
                </SelectTrigger>
                <SelectContent>
                  {(bankLedgers as any[]).length === 0
                    ? <SelectItem value="__none__" disabled>No bank accounts configured</SelectItem>
                    : (bankLedgers as any[]).map((l: any) => (
                        <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                      ))
                  }
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Cash will move to Cash-in-Transit and appear in Reconciliation for bank confirmation.
              </p>
            </div>
            <div>
              <Label className="text-sm mb-1.5 block">Notes</Label>
              <Input value={depNotes} onChange={e => setDepNotes(e.target.value)} className="h-9" placeholder="Optional notes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeposit(false)}>Cancel</Button>
            <Button onClick={handleCreateDeposit} disabled={createDeposit.isPending || !depBankId}>
              <CheckCircle2 className="w-4 h-4 mr-1.5" />
              {createDeposit.isPending ? 'Saving…' : 'Deposit to Bank'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
