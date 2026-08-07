/**
 * SalesDashboard — daily snapshot for the current sales location,
 * or an all-locations overview when locationType === 'all'.
 */
import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import {
  useListSales, useListStockTransfers, customFetch,
} from '@workspace/api-client-react';
import { useAllOutlets, useIsLocationKindEnabled } from '@/lib/locationStructure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import {
  ShoppingCart, ArrowLeftRight, Receipt, ChevronDown, ChevronUp,
  TrendingUp, Package, Wallet, CalendarDays, Store, Warehouse,
  Clock, CheckCircle2, XCircle, ArrowUpRight, Layers, ShieldOff,
} from 'lucide-react';
import { usePermission } from '@/lib/usePermission';

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function toDateStr(d: string | Date): string {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return new Date(d).toISOString().split('T')[0];
}

function fmtDate(d: string) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Badges ────────────────────────────────────────────────────────────────────

function PaymentBadge({ status }: { status: string }) {
  if (status === 'paid')
    return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Paid</Badge>;
  if (status === 'partially_paid')
    return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">Partial</Badge>;
  return <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Unpaid</Badge>;
}

function TransferBadge({ status }: { status: string }) {
  if (status === 'completed')
    return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Completed</Badge>;
  if (status === 'rejected')
    return <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Rejected</Badge>;
  return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">In Transit</Badge>;
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({
  icon: Icon, iconColor, label, primary, secondary, open, onClick, accent,
}: {
  icon: React.ElementType; iconColor: string; label: string;
  primary: string; secondary: string; open: boolean; onClick: () => void; accent: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border transition-all duration-200 p-4 group
        ${open ? `${accent} shadow-md` : 'border-border bg-card hover:border-primary/30 hover:shadow-sm'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className={`rounded-lg p-2.5 ${open ? 'bg-white/20 dark:bg-black/20' : 'bg-muted/40'}`}>
          <Icon className={`w-5 h-5 ${iconColor}`} />
        </div>
        {open
          ? <ChevronUp className="w-4 h-4 text-current opacity-60 mt-0.5 shrink-0" />
          : <ChevronDown className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0 group-hover:text-foreground transition-colors" />}
      </div>
      <div className="mt-3">
        <p className={`text-xs font-medium uppercase tracking-wider ${open ? 'opacity-70' : 'text-muted-foreground'}`}>{label}</p>
        <p className={`text-2xl font-bold mt-0.5 ${open ? '' : 'text-foreground'}`}>{primary}</p>
        <p className={`text-xs mt-0.5 ${open ? 'opacity-70' : 'text-muted-foreground'}`}>{secondary}</p>
      </div>
    </button>
  );
}

// ── Panel header ──────────────────────────────────────────────────────────────

function PanelHeader({ icon: Icon, label, onNavigate }: {
  icon: React.ElementType; label: string; onNavigate?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/20">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="w-4 h-4 text-primary" /> {label}
      </div>
      {onNavigate && (
        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={onNavigate}>
          Open full page <ArrowUpRight className="w-3 h-3" />
        </Button>
      )}
    </div>
  );
}

// ── Location section header inside expanded panels ────────────────────────────

function LocationSection({ type, name, children }: { type: string; name: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-2 bg-muted/30 border-b border-border">
        {type === 'warehouse'
          ? <Warehouse className="w-3.5 h-3.5 text-blue-500" />
          : <Store className="w-3.5 h-3.5 text-emerald-500" />}
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{name}</span>
      </div>
      {children}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

type Section = 'sales' | 'transfers' | 'expenses' | null;

export default function SalesDashboard() {
  const perm = usePermission('page:/');
  const [, navigate] = useLocation();
  const { locationState } = useLocationContext();
  const { locationType, locationId, locationName } = locationState;

  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [open, setOpen] = useState<Section>(null);

  const isAll = locationType === 'all';
  // Warehouse mode: a specific warehouse is selected (not 'all') — show this warehouse + its child outlets
  const isWarehouseMode = locationType === 'warehouse' && !!locationId && !isAll;

  useEffect(() => {
    if (!locationType) navigate('/sales');
  }, [locationType]);

  // ── Data fetching ─────────────────────────────────────────────────────────

  const { data: allSales = [], isLoading: salesLoading } = useListSales();
  const { data: allTransfers = [], isLoading: transfersLoading } = useListStockTransfers();
  // Historical aggregation, not a selector: a warehouse's day must keep counting
  // sales, transfers and expenses at its child outlets even while outlets are
  // hidden, or the figures on screen quietly drop.
  const { data: allOutlets = [] } = useAllOutlets();
  const outletsVisible = useIsLocationKindEnabled('outlet');

  // Child outlets of the selected warehouse (empty set when not in warehouse mode)
  const childOutletIds = new Set(
    isWarehouseMode
      ? (allOutlets as any[]).filter(o => Number(o.warehouseId) === locationId).map(o => o.id)
      : []
  );
  const childOutlets = isWarehouseMode
    ? (allOutlets as any[]).filter(o => Number(o.warehouseId) === locationId)
    : [];

  // Single-location expenses (warehouse's own cash ledger)
  const { data: expenseData, isLoading: expensesLoadingSingle } = useQuery<{
    cashLedgerId: number; cashLedgerName: string; expenses: any[];
  }>({
    queryKey: ['location-expenses', locationType, locationId],
    queryFn: () => customFetch(`/api/accounts/location-expenses?locationType=${locationType}&locationId=${locationId}`),
    enabled: !isAll && !!locationType && !!locationId,
  });

  // All-locations expenses — used in 'all' mode AND warehouse mode (to include child outlets)
  const { data: allLocExpenses = [], isLoading: expensesLoadingAll } = useQuery<any[]>({
    queryKey: ['location-expenses-all'],
    queryFn: () => customFetch('/api/accounts/location-expenses/all'),
    enabled: isAll || isWarehouseMode,
  });

  const expensesLoading = (isAll || isWarehouseMode) ? expensesLoadingAll : expensesLoadingSingle;

  // ── Filter helpers ────────────────────────────────────────────────────────

  const daySales = (allSales as any[]).filter(s => {
    if (toDateStr(s.saleDate) !== selectedDate) return false;
    if (isAll) return true;
    // Own sales
    if (s.locationType === locationType && Number(s.locationId) === locationId) return true;
    // Warehouse mode: also include child outlet sales
    if (isWarehouseMode && s.locationType === 'outlet' && childOutletIds.has(Number(s.locationId))) return true;
    return false;
  });

  const dayTransfers = (allTransfers as any[]).filter(t => {
    if (toDateStr(t.transferDate) !== selectedDate) return false;
    if (isAll) return true;
    const directMatch =
      (t.fromType === locationType && Number(t.fromId) === locationId) ||
      (t.toType   === locationType && Number(t.toId)   === locationId);
    if (directMatch) return true;
    // Warehouse mode: also include child outlet transfers
    if (isWarehouseMode) {
      if ((t.fromType === 'outlet' && childOutletIds.has(Number(t.fromId))) ||
          (t.toType   === 'outlet' && childOutletIds.has(Number(t.toId)))) return true;
    }
    return false;
  });

  const singleExpenses: any[] = expenseData?.expenses ?? [];
  const dayExpenses = isAll
    ? allLocExpenses.filter(e => toDateStr(e.expenseDate) === selectedDate)
    : isWarehouseMode
      ? allLocExpenses.filter(e => {
          if (toDateStr(e.expenseDate) !== selectedDate) return false;
          // Include warehouse's own expenses + child outlet expenses
          if (e.locationType === 'warehouse' && Number(e.locationId) === locationId) return true;
          if (e.locationType === 'outlet' && childOutletIds.has(Number(e.locationId))) return true;
          return false;
        })
      : singleExpenses.filter(e => toDateStr(e.expenseDate) === selectedDate);

  // ── Totals ────────────────────────────────────────────────────────────────

  // Cancelled invoices stay visible in the table (with their badge) but are
  // excluded from the money totals: their Due is 0 by definition, so counting
  // their billed/collected figures would make the three totals disagree.
  const activeSales  = daySales.filter(x => !x.isCancelled);
  const salesTotal   = activeSales.reduce((s, x) => s + Number(x.totalAmount ?? 0), 0);
  const salesPaid    = activeSales.reduce((s, x) => s + Number(x.amountPaid ?? 0), 0);
  // Server-derived outstanding (credit-note and cancellation aware) — never
  // recompute total − paid locally, it diverges the moment a credit note exists.
  const salesDue     = activeSales.reduce((s, x) => s + Number(x.balanceDue ?? 0), 0);
  const expenseTotal = dayExpenses.reduce((s, x) => s + Number(x.amount ?? 0), 0);
  const inTransit    = dayTransfers.filter(t => t.status === 'in_transit').length;

  const toggle = (s: Section) => setOpen(prev => prev === s ? null : s);

  // Sorting for the single-location (non-grouped) detail tables. The grouped
  // (all/warehouse) views are hierarchical location sections and are left as-is.
  const salesSort = useTableSort(daySales, {
    invoice: (s: any) => s.invoiceNumber ?? `#${s.id}`,
    customer: (s: any) => s.customerName,
    amount: (s: any) => Number(s.totalAmount ?? 0),
    paid: (s: any) => Number(s.amountPaid ?? 0),
    balance: (s: any) => Number(s.balanceDue ?? 0),
    status: (s: any) => s.paymentStatus ?? 'unpaid',
  });
  const transfersSort = useTableSort(dayTransfers, {
    challan: (t: any) => t.challanNumber ?? `#${t.id}`,
    from: (t: any) => t.fromName ?? `${t.fromType} #${t.fromId}`,
    to: (t: any) => t.toName ?? `${t.toType} #${t.toId}`,
    items: (t: any) => (t.lineItems ?? []).length,
    status: (t: any) => t.status,
  });
  const expensesSort = useTableSort(dayExpenses, {
    voucher: (e: any) => e.voucherNumber ?? `#${e.id}`,
    category: (e: any) => e.expenseLedgerName,
    description: (e: any) => e.description,
    amount: (e: any) => Number(e.amount),
  });

  // ── All-mode / Warehouse-mode: group by location ──────────────────────────

  function groupByLocation<T extends { locationType?: string; locationId?: number; locationName?: string }>(items: T[]) {
    const map = new Map<string, { type: string; name: string; items: T[] }>();
    for (const item of items) {
      const key = `${item.locationType}-${item.locationId}`;
      if (!map.has(key)) map.set(key, { type: item.locationType!, name: item.locationName ?? '', items: [] });
      map.get(key)!.items.push(item);
    }
    // Sort: warehouses first, then outlets; alphabetically within each group
    return [...map.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'warehouse' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  const useGrouped = isAll || isWarehouseMode;

  const salesByLocation     = useGrouped ? groupByLocation(daySales.map(s => ({ ...s, locationType: s.locationType, locationId: Number(s.locationId), locationName: s.locationName ?? s.outletName ?? s.warehouseName ?? '' }))) : [];
  const transfersByLocation = useGrouped ? groupByLocation(dayTransfers.map(t => {
    return { ...t, locationType: t.fromType, locationId: Number(t.fromId), locationName: t.fromName ?? '' };
  })) : [];
  const expensesByLocation  = useGrouped ? groupByLocation(dayExpenses) : [];

  const LocationIcon = isAll ? Layers : (locationType === 'warehouse' ? Warehouse : Store);

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">You don't have permission to view this page.<br />Contact your administrator to request access.</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!locationType) return null;

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-5 max-w-5xl">

        {/* ── Page header ── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <TrendingUp className="w-6 h-6 text-primary" /> Dashboard
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5">
              <LocationIcon className="w-3.5 h-3.5" /> {locationName}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-muted-foreground" />
            <Input
              type="date"
              value={selectedDate}
              max={new Date().toISOString().split('T')[0]}
              onChange={e => setSelectedDate(e.target.value)}
              className="h-8 w-40 text-sm"
            />
            {selectedDate !== new Date().toISOString().split('T')[0] && (
              <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground"
                onClick={() => setSelectedDate(new Date().toISOString().split('T')[0])}>
                Today
              </Button>
            )}
          </div>
        </div>

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SummaryCard
            icon={ShoppingCart} iconColor={open === 'sales' ? 'text-white' : 'text-blue-600'}
            label="Sales" primary={salesLoading ? '…' : fmt(salesTotal)}
            secondary={salesLoading ? '' : `${daySales.length} order${daySales.length !== 1 ? 's' : ''} · collected ${fmt(salesPaid)}`}
            open={open === 'sales'} onClick={() => toggle('sales')}
            accent="border-blue-500/60 bg-blue-600 text-white"
          />
          <SummaryCard
            icon={ArrowLeftRight} iconColor={open === 'transfers' ? 'text-white' : 'text-violet-600'}
            label="Stock Transfers" primary={transfersLoading ? '…' : `${dayTransfers.length}`}
            secondary={transfersLoading ? '' : `${inTransit} in transit · ${dayTransfers.length - inTransit} completed`}
            open={open === 'transfers'} onClick={() => toggle('transfers')}
            accent="border-violet-500/60 bg-violet-600 text-white"
          />
          <SummaryCard
            icon={Receipt} iconColor={open === 'expenses' ? 'text-white' : 'text-rose-600'}
            label="Expenses" primary={expensesLoading ? '…' : fmt(expenseTotal)}
            secondary={expensesLoading ? '' : `${dayExpenses.length} expense${dayExpenses.length !== 1 ? 's' : ''}`}
            open={open === 'expenses'} onClick={() => toggle('expenses')}
            accent="border-rose-500/60 bg-rose-600 text-white"
          />
        </div>

        {/* ── Expanded panels ── */}

        {/* Sales detail */}
        {open === 'sales' && (
          <div className="rounded-xl border border-border overflow-hidden shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
            <PanelHeader icon={ShoppingCart} label={`Sales on ${fmtDate(selectedDate)}`}
              onNavigate={!isAll ? () => navigate('/sales/pos') : undefined} />
            {salesLoading ? (
              <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
            ) : daySales.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground space-y-2">
                <ShoppingCart className="w-10 h-10 mx-auto opacity-20" />
                <p className="font-medium">No sales on this date</p>
              </div>
            ) : useGrouped ? (
              /* All-locations or Warehouse+outlets: grouped by location */
              <div>
                {/* Grand total bar */}
                <div className="flex flex-wrap gap-4 px-4 py-3 bg-blue-500/5 text-sm border-b border-border">
                  <span className="text-muted-foreground">Total billed: <strong className="text-foreground">{fmt(salesTotal)}</strong></span>
                  <span className="text-muted-foreground">Collected: <strong className="text-emerald-600">{fmt(salesPaid)}</strong></span>
                  <span className="text-muted-foreground">Balance due: <strong className="text-rose-600">{fmt(salesDue)}</strong></span>
                  {isWarehouseMode && outletsVisible && childOutlets.length > 0 && (
                    <span className="text-muted-foreground text-xs">Includes {childOutlets.length} outlet{childOutlets.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
                {salesByLocation.map(loc => {
                  const locActive = loc.items.filter((x: any) => !x.isCancelled);
                  const locTotal = locActive.reduce((s: number, x: any) => s + Number(x.totalAmount ?? 0), 0);
                  const locPaid  = locActive.reduce((s: number, x: any) => s + Number(x.amountPaid ?? 0), 0);
                  const locDue   = locActive.reduce((s: number, x: any) => s + Number(x.balanceDue ?? 0), 0);
                  return (
                    <LocationSection key={`${loc.type}-${loc.items[0]?.locationId}`} type={loc.type} name={`${loc.name} — ${fmt(locTotal)}`}>
                      <div className="flex gap-4 px-4 py-2 bg-muted/5 border-b border-border/50 text-xs text-muted-foreground">
                        <span>{loc.items.length} order{loc.items.length !== 1 ? 's' : ''}</span>
                        <span>Collected: <strong className="text-emerald-600">{fmt(locPaid)}</strong></span>
                        <span>Due: <strong className="text-rose-600">{fmt(locDue)}</strong></span>
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/10">
                            <TableHead>Invoice</TableHead>
                            <TableHead>Customer</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead className="text-right">Paid</TableHead>
                            <TableHead>Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {loc.items.map((s: any) => (
                            <TableRow key={s.id}>
                              <TableCell className="font-mono text-xs font-bold text-primary">{s.invoiceNumber ?? `#${s.id}`}</TableCell>
                              <TableCell className="text-sm">{s.customerName ?? <span className="text-muted-foreground italic">Walk-in</span>}</TableCell>
                              <TableCell className="text-right font-mono text-sm font-semibold">{fmt(Number(s.totalAmount ?? 0))}</TableCell>
                              <TableCell className="text-right font-mono text-sm text-emerald-600">{fmt(Number(s.amountPaid ?? 0))}</TableCell>
                              <TableCell><PaymentBadge status={s.paymentStatus ?? 'unpaid'} /></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </LocationSection>
                  );
                })}
              </div>
            ) : (
              /* Single-location */
              <>
                <div className="flex flex-wrap gap-4 px-4 py-3 bg-muted/10 text-sm border-b border-border">
                  <span className="text-muted-foreground">Total billed: <strong className="text-foreground">{fmt(salesTotal)}</strong></span>
                  <span className="text-muted-foreground">Collected: <strong className="text-emerald-600">{fmt(salesPaid)}</strong></span>
                  <span className="text-muted-foreground">Balance due: <strong className="text-rose-600">{fmt(salesDue)}</strong></span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <SortableHead k="invoice" sort={salesSort.sort}>Invoice</SortableHead>
                      <SortableHead k="customer" sort={salesSort.sort}>Customer</SortableHead>
                      <SortableHead k="amount" sort={salesSort.sort} className="text-right">Amount</SortableHead>
                      <SortableHead k="paid" sort={salesSort.sort} className="text-right">Paid</SortableHead>
                      <SortableHead k="balance" sort={salesSort.sort} className="text-right">Balance</SortableHead>
                      <SortableHead k="status" sort={salesSort.sort}>Status</SortableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {salesSort.sorted.map((s: any) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-xs font-bold text-primary">{s.invoiceNumber ?? `#${s.id}`}</TableCell>
                        <TableCell className="text-sm">{s.customerName ?? <span className="text-muted-foreground italic">Walk-in</span>}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold">{fmt(Number(s.totalAmount ?? 0))}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-emerald-600">{fmt(Number(s.amountPaid ?? 0))}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-rose-600">{fmt(Number(s.balanceDue ?? 0))}</TableCell>
                        <TableCell><PaymentBadge status={s.paymentStatus ?? 'unpaid'} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        )}

        {/* Transfers detail */}
        {open === 'transfers' && (
          <div className="rounded-xl border border-border overflow-hidden shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
            <PanelHeader icon={ArrowLeftRight} label={`Stock Transfers on ${fmtDate(selectedDate)}`}
              onNavigate={!isAll ? () => navigate('/sales/transfers') : undefined} />
            {transfersLoading ? (
              <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
            ) : dayTransfers.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground space-y-2">
                <ArrowLeftRight className="w-10 h-10 mx-auto opacity-20" />
                <p className="font-medium">No transfers on this date</p>
              </div>
            ) : (
              <>
                {inTransit > 0 && (
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-700 text-sm">
                    <Clock className="w-4 h-4 shrink-0" />
                    <span><strong>{inTransit}</strong> transfer{inTransit > 1 ? 's' : ''} awaiting approval</span>
                  </div>
                )}
                {useGrouped ? (
                  /* grouped by source location */
                  transfersByLocation.map(loc => (
                    <LocationSection key={`${loc.type}-${loc.items[0]?.fromId}`} type={loc.type} name={`${loc.name} — ${loc.items.length} transfer${loc.items.length !== 1 ? 's' : ''}`}>
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/10">
                            <TableHead>Challan</TableHead>
                            <TableHead>From</TableHead>
                            <TableHead>To</TableHead>
                            <TableHead>Items</TableHead>
                            <TableHead>Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {loc.items.map((t: any) => (
                            <TableRow key={t.id}>
                              <TableCell className="font-mono text-xs font-bold text-primary">{t.challanNumber ?? `#${t.id}`}</TableCell>
                              <TableCell className="text-sm">{t.fromName ?? `${t.fromType} #${t.fromId}`}<span className="text-muted-foreground capitalize text-xs ml-1">({t.fromType})</span></TableCell>
                              <TableCell className="text-sm">{t.toName ?? `${t.toType} #${t.toId}`}<span className="text-muted-foreground capitalize text-xs ml-1">({t.toType})</span></TableCell>
                              <TableCell className="text-sm text-muted-foreground">{(t.lineItems ?? []).length} item{(t.lineItems ?? []).length !== 1 ? 's' : ''}</TableCell>
                              <TableCell><TransferBadge status={t.status} /></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </LocationSection>
                  ))
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/10">
                        <SortableHead k="challan" sort={transfersSort.sort}>Challan</SortableHead>
                        <SortableHead k="from" sort={transfersSort.sort}>From</SortableHead>
                        <SortableHead k="to" sort={transfersSort.sort}>To</SortableHead>
                        <SortableHead k="items" sort={transfersSort.sort}>Items</SortableHead>
                        <SortableHead k="status" sort={transfersSort.sort}>Status</SortableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {transfersSort.sorted.map((t: any) => (
                        <TableRow key={t.id}>
                          <TableCell className="font-mono text-xs font-bold text-primary">{t.challanNumber ?? `#${t.id}`}</TableCell>
                          <TableCell className="text-sm">{t.fromName ?? `${t.fromType} #${t.fromId}`}<span className="text-muted-foreground capitalize text-xs ml-1">({t.fromType})</span></TableCell>
                          <TableCell className="text-sm">{t.toName ?? `${t.toType} #${t.toId}`}<span className="text-muted-foreground capitalize text-xs ml-1">({t.toType})</span></TableCell>
                          <TableCell className="text-sm text-muted-foreground">{(t.lineItems ?? []).length} item{(t.lineItems ?? []).length !== 1 ? 's' : ''}</TableCell>
                          <TableCell><TransferBadge status={t.status} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </>
            )}
          </div>
        )}

        {/* Expenses detail */}
        {open === 'expenses' && (
          <div className="rounded-xl border border-border overflow-hidden shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
            <PanelHeader icon={Receipt} label={`Expenses on ${fmtDate(selectedDate)}`}
              onNavigate={!isAll ? () => navigate('/sales/expenses') : undefined} />
            {expensesLoading ? (
              <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
            ) : dayExpenses.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground space-y-2">
                <Receipt className="w-10 h-10 mx-auto opacity-20" />
                <p className="font-medium">No expenses on this date</p>
              </div>
            ) : useGrouped ? (
              <div>
                <div className="flex gap-4 px-4 py-3 bg-rose-500/5 border-b border-border text-sm">
                  <span className="text-muted-foreground">Total spent: <strong className="text-rose-600">{fmt(expenseTotal)}</strong></span>
                  <span className="text-muted-foreground">{dayExpenses.length} expense{dayExpenses.length !== 1 ? 's' : ''}{isAll ? ' across all locations' : ''}</span>
                </div>
                {expensesByLocation.map(loc => {
                  const locTotal = loc.items.reduce((s, x) => s + Number(x.amount ?? 0), 0);
                  return (
                    <LocationSection key={`${loc.type}-${loc.items[0]?.locationId}`} type={loc.type} name={`${loc.name} — ${fmt(locTotal)}`}>
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/10">
                            <TableHead>Voucher</TableHead>
                            <TableHead>Category</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {loc.items.map((e: any) => (
                            <TableRow key={e.id}>
                              <TableCell className="font-mono text-xs text-muted-foreground">{e.voucherNumber ?? `#${e.id}`}</TableCell>
                              <TableCell className="text-sm font-medium">{e.expenseLedgerName}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{e.description ?? '—'}</TableCell>
                              <TableCell className="text-right font-mono text-sm font-semibold text-rose-600">{fmt(Number(e.amount))}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </LocationSection>
                  );
                })}
              </div>
            ) : (
              <>
                <div className="flex gap-4 px-4 py-3 bg-muted/10 border-b border-border text-sm">
                  <span className="text-muted-foreground">Total spent: <strong className="text-rose-600">{fmt(expenseTotal)}</strong></span>
                  <span className="text-muted-foreground">From: <strong className="text-foreground">{expenseData?.cashLedgerName ?? '—'}</strong></span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <SortableHead k="voucher" sort={expensesSort.sort}>Voucher</SortableHead>
                      <SortableHead k="category" sort={expensesSort.sort}>Category</SortableHead>
                      <SortableHead k="description" sort={expensesSort.sort}>Description</SortableHead>
                      <SortableHead k="amount" sort={expensesSort.sort} className="text-right">Amount</SortableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expensesSort.sorted.map((e: any) => (
                      <TableRow key={e.id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.voucherNumber ?? `#${e.id}`}</TableCell>
                        <TableCell className="text-sm font-medium">{e.expenseLedgerName}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{e.description ?? '—'}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold text-rose-600">{fmt(Number(e.amount))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        )}

        {/* ── All-time summary strip ── */}
        <Separator />
        <div className="grid grid-cols-3 gap-4 text-center text-sm">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">All Sales</p>
            <p className="font-semibold">
              {(allSales as any[]).filter((s: any) =>
                isAll ||
                (s.locationType === locationType && Number(s.locationId) === locationId) ||
                (isWarehouseMode && s.locationType === 'outlet' && childOutletIds.has(Number(s.locationId)))
              ).length} orders
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">All Transfers</p>
            <p className="font-semibold">
              {(allTransfers as any[]).filter((t: any) =>
                isAll ||
                (t.fromType === locationType && Number(t.fromId) === locationId) ||
                (t.toType   === locationType && Number(t.toId)   === locationId) ||
                (isWarehouseMode && ((t.fromType === 'outlet' && childOutletIds.has(Number(t.fromId))) || (t.toType === 'outlet' && childOutletIds.has(Number(t.toId)))))
              ).length} total
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">All Expenses</p>
            <p className="font-semibold">
              {isAll ? allLocExpenses.length : isWarehouseMode
                ? allLocExpenses.filter((e: any) =>
                    (e.locationType === 'warehouse' && Number(e.locationId) === locationId) ||
                    (e.locationType === 'outlet' && childOutletIds.has(Number(e.locationId)))
                  ).length
                : singleExpenses.length} total
            </p>
          </div>
        </div>

      </div>
    </AppLayout>
  );
}
