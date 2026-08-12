import { useState, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  useGetCashDeposits, useCreateCashDeposit, useReconcileCashDeposit,
  useGetBankLedgers,
} from '@workspace/api-client-react';
import { toast } from 'sonner';
import { Banknote, ArrowUpFromLine, CheckCircle2, Store, Warehouse, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { buildHierarchy } from '@/lib/locationHierarchy';
import { useLocationCashBalances, useIsLocationKindEnabled } from '@/lib/locationStructure';
import { useClearOutletSelection } from '@/lib/useFeatureFlags';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

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

type SortKey   = 'name' | 'balance' | 'available';
type SortDir   = 'asc' | 'desc';
type TypeFilter = 'all' | 'outlet' | 'warehouse';

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ArrowUpDown className="w-3 h-3 text-muted-foreground/40" />;
  return dir === 'asc'
    ? <ArrowUp className="w-3 h-3 text-primary" />
    : <ArrowDown className="w-3 h-3 text-primary" />;
}

export default function CashBalance() {
  const perm = usePermission('page:/accounts/cash-in-outlet');
  const [tab, setTab] = useState<'balances' | 'deposits'>('balances');
  // Which location types exist for this company — never assumed by this page.
  const outletsVisible = useIsLocationKindEnabled('outlet');

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

  // ── filter / sort state ───────────────────────────────────────────────────
  const [typeFilter, setTypeFilter]       = useState<TypeFilter>('all');
  const [locationId,  setLocationId]      = useState<string>('all');
  const [sortKey,     setSortKey]         = useState<SortKey>('name');
  const [sortDir,     setSortDir]         = useState<SortDir>('asc');
  const [depositFilter, setDepositFilter] = useState('all');

  // Outlet tills are withheld from this list while Outlet Management is off, so
  // the cards, hierarchy, pickers and totals below all follow automatically.
  const { data: allBalances, isLoading: balancesLoading, refetch: refetchBalances } = useLocationCashBalances();
  const { data: deposits = [], isLoading: depositsLoading } = useGetCashDeposits(
    depositFilter !== 'all' ? { status: depositFilter } : undefined
  );
  const { data: bankLedgers = [] } = useGetBankLedgers();

  // A filter still *holding* an outlet keeps scoping the page after the option
  // to clear it disappears, so both selections are reset when outlets go away.
  useClearOutletSelection(typeFilter === 'outlet', () => setTypeFilter('all'));
  useClearOutletSelection(locationId.startsWith('outlet-'), () => setLocationId('all'));

  // ── derived: totals ───────────────────────────────────────────────────────
  const totalCash      = allBalances.reduce((s, b) => s + b.cashBalance,      0);
  const totalTransit   = allBalances.reduce((s, b) => s + b.pendingDeposits,  0);
  const totalAvailable = allBalances.reduce((s, b) => s + b.availableBalance, 0);
  const outletTotal    = allBalances.filter(b => b.locationType === 'outlet').reduce((s, b) => s + b.availableBalance, 0);
  const warehouseTotal = allBalances.filter(b => b.locationType === 'warehouse').reduce((s, b) => s + b.availableBalance, 0);

  // ── derived: warehouse→outlets hierarchy ─────────────────────────────────
  const hierarchy = useMemo(() => buildHierarchy(allBalances), [allBalances]);

  // ── derived: filtered + sorted cards ─────────────────────────────────────
  const displayBalances = useMemo(() => {
    let list = [...allBalances];
    if (typeFilter !== 'all') list = list.filter(b => b.locationType === typeFilter);
    if (locationId !== 'all') list = list.filter(b => `${b.locationType}-${b.locationId}` === locationId);
    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name')      cmp = a.locationName.localeCompare(b.locationName);
      if (sortKey === 'balance')   cmp = a.cashBalance - b.cashBalance;
      if (sortKey === 'available') cmp = a.availableBalance - b.availableBalance;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [allBalances, typeFilter, locationId, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  // reset location picker when type filter changes
  function handleTypeChange(v: TypeFilter) {
    setTypeFilter(v);
    setLocationId('all');
  }

  // Create deposit dialog
  const [showDeposit, setShowDeposit] = useState(false);
  // depLocationUid = "outlet-{id}" | "warehouse-{id}" composite key
  const [depLocationUid, setDepLocationUid] = useState('');
  const [depAmount, setDepAmount] = useState('');
  const [depDate, setDepDate] = useState(new Date().toISOString().split('T')[0]);
  const [depRef, setDepRef] = useState('');
  const [depBankLedgerId, setDepBankLedgerId] = useState('');
  const [depNotes, setDepNotes] = useState('');
  const createDepositMutation = useCreateCashDeposit();

  // Parse selected location uid into type + id
  const [depLocType, depLocId] = depLocationUid.split('-') as [string, string];
  const selectedBalance = allBalances.find(b =>
    b.locationType === depLocType && String(b.locationId) === depLocId
  );

  function openDeposit(b: typeof allBalances[0]) {
    setDepLocationUid(`${b.locationType}-${b.locationId}`);
    setDepAmount(String(b.availableBalance));
    setShowDeposit(true);
  }

  async function handleCreateDeposit() {
    if (!depLocationUid) { toast.error('Select a location'); return; }
    const amount = Number(depAmount);
    if (!amount || amount <= 0) { toast.error('Amount must be positive'); return; }
    if (!depDate) { toast.error('Deposit date is required'); return; }
    try {
      await createDepositMutation.mutateAsync({
        ...(depLocType === 'warehouse'
          ? { warehouseId: Number(depLocId) }
          : { outletId: Number(depLocId) }),
        amount,
        depositDate: depDate,
        depositReference: depRef || undefined,
        destinationBankLedgerId: depBankLedgerId ? Number(depBankLedgerId) : undefined,
        notes: depNotes || undefined,
      } as any);
      toast.success('Cash deposit recorded');
      setShowDeposit(false);
      setDepLocationUid(''); setDepAmount(''); setDepRef(''); setDepNotes(''); setDepBankLedgerId('');
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

  // Deposits table sorting — preserves the server's default order until a
  // header is clicked. Location name merged in so the accessor stays row-local.
  const depositRows = useMemo(() => deposits.map(d => ({
    ...d,
    _locationName: (d as any).locationName ?? (d as any).outletName ?? '',
  })), [deposits]);
  const { sorted: sortedDeposits, sort: depositSort } = useTableSort(depositRows, {
    location: d => (d as any)._locationName,
    date: d => d.depositDate,
    reference: d => d.depositReference,
    bank: d => d.bankLedgerName,
    amount: d => Number(d.amount),
    status: d => d.status,
  });

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
        <PageHeader
          title="Cash Balance"
          description={`Track physical cash at each ${outletsVisible ? 'outlet and warehouse' : 'warehouse'}, and record bank deposits`}
          icon={Banknote}
          actions={tab === 'balances' ? (
            <Button size="sm" onClick={() => setShowDeposit(true)} disabled={!perm.canAdd || allBalances.length === 0}>
              <ArrowUpFromLine className="w-4 h-4 mr-1.5" /> Record Deposit
            </Button>
          ) : undefined}
        />

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
            <div className="space-y-4">

              {/* ── Total summary banner ── */}
              {allBalances.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="rounded-xl border border-border bg-card p-3 space-y-0.5">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Total Cash</p>
                    <p className="text-lg font-bold font-mono">{fmt(totalCash)}</p>
                    <p className="text-[10px] text-muted-foreground">{allBalances.length} location{allBalances.length !== 1 ? 's' : ''}</p>
                  </div>
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 space-y-0.5">
                    <p className="text-[11px] uppercase tracking-wide text-amber-600 font-medium">In Transit</p>
                    <p className="text-lg font-bold font-mono text-amber-600">{fmt(totalTransit)}</p>
                    <p className="text-[10px] text-muted-foreground">pending deposits</p>
                  </div>
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-0.5">
                    <p className="text-[11px] uppercase tracking-wide text-emerald-600 font-medium">Available</p>
                    <p className="text-lg font-bold font-mono text-emerald-600">{fmt(totalAvailable)}</p>
                    <p className="text-[10px] text-muted-foreground">after transit</p>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-3 space-y-0.5">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">Breakdown</p>
                    {outletsVisible && (
                      <div className="flex items-center gap-1.5 pt-0.5">
                        <Store className="w-3 h-3 text-emerald-500 shrink-0" />
                        <span className="text-xs text-muted-foreground">Outlets</span>
                        <span className="ml-auto text-xs font-mono font-semibold">{fmt(outletTotal)}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <Warehouse className="w-3 h-3 text-blue-500 shrink-0" />
                      <span className="text-xs text-muted-foreground">Warehouses</span>
                      <span className="ml-auto text-xs font-mono font-semibold">{fmt(warehouseTotal)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Filter + Sort bar ── */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Type filter */}
                <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1">
                  {(['all', ...(outletsVisible ? ['outlet' as const] : []), 'warehouse'] as TypeFilter[]).map(t => (
                    <button
                      key={t}
                      onClick={() => handleTypeChange(t)}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors
                        ${typeFilter === t ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {t === 'outlet' && <Store className="w-3 h-3" />}
                      {t === 'warehouse' && <Warehouse className="w-3 h-3" />}
                      {t === 'all' ? 'All' : t === 'outlet' ? 'Outlets' : 'Warehouses'}
                    </button>
                  ))}
                </div>

                {/* Location picker — hierarchical */}
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger className="h-8 text-xs w-48">
                    <SelectValue placeholder="All locations" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All locations</SelectItem>
                    {hierarchy.nodes.map(wh => (
                      <SelectGroup key={`wh-${wh.locationId}`}>
                        {(typeFilter === 'all' || typeFilter === 'warehouse') && (
                          <SelectItem value={`warehouse-${wh.locationId}`}>
                            <span className="flex items-center gap-1.5">
                              <Warehouse className="w-3 h-3 text-blue-500 shrink-0" />{wh.locationName}
                            </span>
                          </SelectItem>
                        )}
                        {(typeFilter === 'all' || typeFilter === 'outlet') && wh.outlets.map(o => (
                          <SelectItem key={`outlet-${o.locationId}`} value={`outlet-${o.locationId}`}>
                            <span className="flex items-center gap-1.5 pl-3">
                              <Store className="w-3 h-3 text-emerald-500 shrink-0" />{o.locationName}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                    {(typeFilter === 'all' || typeFilter === 'outlet') && hierarchy.orphanOutlets.map(o => (
                      <SelectItem key={`outlet-${o.locationId}`} value={`outlet-${o.locationId}`}>
                        <span className="flex items-center gap-1.5">
                          <Store className="w-3 h-3 text-emerald-500 shrink-0" />{o.locationName}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Sort buttons */}
                <div className="flex items-center gap-1 ml-auto">
                  <span className="text-[11px] text-muted-foreground mr-0.5">Sort:</span>
                  {([
                    { key: 'name'      as SortKey, label: 'Name' },
                    { key: 'balance'   as SortKey, label: 'Balance' },
                    { key: 'available' as SortKey, label: 'Available' },
                  ]).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => toggleSort(key)}
                      className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors
                        ${sortKey === key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {label}
                      <SortIcon active={sortKey === key} dir={sortDir} />
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Cards grid — hierarchy: warehouse → its outlets ── */}
              {(() => {
                const renderCard = (b: typeof displayBalances[0]) => (
                  <div key={`${b.locationType}-${b.locationId}`} className="rounded-xl border border-border p-4 space-y-3 bg-card hover:shadow-sm transition-shadow">
                    <div className="flex items-center gap-2">
                      {b.locationType === 'warehouse'
                        ? <Warehouse className="w-4 h-4 text-blue-500 shrink-0" />
                        : <Store      className="w-4 h-4 text-emerald-500 shrink-0" />}
                      <p className="font-semibold text-sm">{b.locationName}</p>
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
                    {b.availableBalance > 0 && perm.canAdd && (
                      <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={() => openDeposit(b)}>
                        <ArrowUpFromLine className="w-3 h-3 mr-1" /> Deposit to Bank
                      </Button>
                    )}
                  </div>
                );

                if (displayBalances.length === 0) {
                  return (
                    <EmptyState
                      icon={Banknote}
                      title={allBalances.length === 0 ? 'No cash balance data' : 'No locations match the filter'}
                    />
                  );
                }

                // Single location selected → show just that card
                if (locationId !== 'all') {
                  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{displayBalances.map(renderCard)}</div>;
                }

                // Warehouse-only filter → flat grid
                if (typeFilter === 'warehouse') {
                  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{displayBalances.map(renderCard)}</div>;
                }

                // Outlet-only filter → group outlets by parent warehouse label
                if (typeFilter === 'outlet') {
                  const displaySet = new Set(displayBalances.map(d => d.locationId));
                  return (
                    <div className="space-y-5">
                      {hierarchy.nodes.filter(wh => wh.outlets.some(o => displaySet.has(o.locationId))).map(wh => (
                        <div key={`wh-${wh.locationId}`} className="space-y-3">
                          <div className="flex items-center gap-2">
                            <Warehouse className="w-3.5 h-3.5 text-blue-400" />
                            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{wh.locationName}</p>
                            <div className="flex-1 h-px bg-border" />
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {wh.outlets.filter(o => displaySet.has(o.locationId))
                              .map(o => displayBalances.find(d => d.locationId === o.locationId)!)
                              .map(renderCard)}
                          </div>
                        </div>
                      ))}
                      {hierarchy.orphanOutlets.filter(o => displaySet.has(o.locationId)).length > 0 && (
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Other Outlets</p>
                            <div className="flex-1 h-px bg-border" />
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {hierarchy.orphanOutlets.filter(o => displaySet.has(o.locationId))
                              .map(o => displayBalances.find(d => d.locationId === o.locationId)!)
                              .map(renderCard)}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }

                // All filter → full hierarchy: warehouse card, then its outlet cards indented below
                const displayMap = new Map(displayBalances.map(d => [`${d.locationType}-${d.locationId}`, d]));
                const visibleNodes = hierarchy.nodes
                  .map(wh => ({
                    wh,
                    whBal: displayMap.get(`warehouse-${wh.locationId}`),
                    outletBals: wh.outlets
                      .map(o => displayMap.get(`outlet-${o.locationId}`))
                      .filter(Boolean) as typeof displayBalances,
                  }))
                  .filter(({ whBal, outletBals }) => whBal || outletBals.length > 0);
                return (
                  <div className="space-y-4">
                    {visibleNodes.map(({ wh, whBal, outletBals }) => (
                      <div key={`wh-${wh.locationId}`} className="space-y-2">
                        {whBal && (
                          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {renderCard(whBal)}
                          </div>
                        )}
                        {outletBals.length > 0 && (
                          <div className="ml-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 border-l-2 border-muted pl-4">
                            {outletBals.map(renderCard)}
                          </div>
                        )}
                      </div>
                    ))}
                    {/* Orphan outlets (no parent warehouse) */}
                    {hierarchy.orphanOutlets.map(o => displayMap.get(`outlet-${o.locationId}`)).filter(Boolean).length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Other Outlets</p>
                          <div className="flex-1 h-px bg-border" />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {hierarchy.orphanOutlets
                            .map(o => displayMap.get(`outlet-${o.locationId}`))
                            .filter(Boolean)
                            .map(b => renderCard(b!))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
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
              <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
                <TableSkeleton rows={8} cols={7} />
              </div>
            ) : deposits.length === 0 ? (
              <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
                <EmptyState icon={ArrowUpFromLine} title="No deposits found" />
              </div>
            ) : (
              <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableHead k="location" sort={depositSort}>Location</SortableHead>
                      <SortableHead k="date" sort={depositSort}>Date</SortableHead>
                      <SortableHead k="reference" sort={depositSort}>Reference</SortableHead>
                      <SortableHead k="bank" sort={depositSort}>Bank Account</SortableHead>
                      <SortableHead k="amount" sort={depositSort} className="text-right">Amount</SortableHead>
                      <SortableHead k="status" sort={depositSort}>Status</SortableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedDeposits.map(d => (
                      <TableRow key={d.id}>
                        <TableCell className="text-sm font-medium">
                          <span className="flex items-center gap-1.5">
                            {(d as any).locationType === 'warehouse'
                              ? <Warehouse className="w-3 h-3 text-blue-500 shrink-0" />
                              : <Store className="w-3 h-3 text-emerald-500 shrink-0" />}
                            {(d as any).locationName ?? d.outletName}
                          </span>
                        </TableCell>
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

      {/* ── Create Deposit Dialog ── */}
      <Dialog open={showDeposit} onOpenChange={setShowDeposit}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Cash Deposit</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label className="text-sm mb-1.5 block">Location <span className="text-destructive">*</span></Label>
              <Select value={depLocationUid} onValueChange={setDepLocationUid}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select location…" /></SelectTrigger>
                <SelectContent>
                  {/* Hierarchy: each warehouse then its outlets */}
                  {hierarchy.nodes
                    .map(wh => ({
                      wh,
                      whBal: allBalances.find(b => b.locationType === 'warehouse' && b.locationId === wh.locationId),
                      outletItems: wh.outlets
                        .map(o => ({ o, oBal: allBalances.find(b => b.locationType === 'outlet' && b.locationId === o.locationId) }))
                        .filter((x): x is { o: typeof x.o; oBal: NonNullable<typeof x.oBal> } => !!x.oBal),
                    }))
                    .filter(({ whBal, outletItems }) => whBal || outletItems.length > 0)
                    .map(({ wh, whBal, outletItems }) => (
                      <SelectGroup key={`wh-${wh.locationId}`}>
                        {whBal && (
                          <SelectItem value={`warehouse-${wh.locationId}`}>
                            <span className="flex items-center gap-1.5">
                              <Warehouse className="w-3 h-3 text-blue-500 shrink-0" />
                              {wh.locationName} — {fmt(whBal.availableBalance)}
                            </span>
                          </SelectItem>
                        )}
                        {outletItems.map(({ o, oBal }) => (
                          <SelectItem key={`outlet-${o.locationId}`} value={`outlet-${o.locationId}`}>
                            <span className="flex items-center gap-1.5 pl-4">
                              <Store className="w-3 h-3 text-emerald-500 shrink-0" />
                              {o.locationName} — {fmt(oBal.availableBalance)}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  {/* Orphan outlets */}
                  {hierarchy.orphanOutlets
                    .map(o => ({ o, oBal: allBalances.find(b => b.locationType === 'outlet' && b.locationId === o.locationId) }))
                    .filter((x): x is { o: typeof x.o; oBal: NonNullable<typeof x.oBal> } => !!x.oBal)
                    .map(({ o, oBal }) => (
                      <SelectItem key={`outlet-${o.locationId}`} value={`outlet-${o.locationId}`}>
                        <span className="flex items-center gap-1.5">
                          <Store className="w-3 h-3 text-emerald-500 shrink-0" />
                          {o.locationName} — {fmt(oBal.availableBalance)}
                        </span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm mb-1.5 block">Amount (₹) <span className="text-destructive">*</span></Label>
              <Input type="number" min={0.01} step={0.01} value={depAmount} onChange={e => setDepAmount(e.target.value)} className="h-9" placeholder="0.00" />
              {selectedBalance && (
                <p className="text-xs text-muted-foreground mt-1">Available: {fmt(selectedBalance.availableBalance)}</p>
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
