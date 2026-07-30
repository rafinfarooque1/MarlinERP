import { useMemo, useState } from 'react';
import {
  useGetDashboardBi,
  useListWarehouses,
  useListOutlets,
  type DashboardBiFilters,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { useOutletsEnabled, useClearOutletSelection } from '@/lib/useFeatureFlags';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ShieldOff, TrendingUp, ShoppingCart, Factory, Boxes,
  Landmark, Trophy, Users, AlertTriangle, Clock, MapPin,
  Warehouse, Store, ArrowUpRight, ArrowDownRight, Wallet,
} from 'lucide-react';
import {
  fmt, num, fmtDate, periodLabel,
  useDateRange, RangeBar, SummaryCards, LocationBadge,
  type CardTone,
} from '@/pages/reports/shared';

// ── Small helpers ───────────────────────────────────────────────────────────

const WAREHOUSE_COLOR = 'hsl(var(--primary))';
const OUTLET_COLOR = 'hsl(var(--chart-2))';

const PAY_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card', upi: 'UPI',
  bank_transfer: 'Bank', credit: 'Credit', unknown: 'Other',
};

/** Horizontal CSS bar row — used for trends and breakdowns. */
function BarRow({ label, sub, value, max, color, valueLabel }: {
  label: string; sub?: string; value: number; max: number; color: string; valueLabel: string;
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate font-medium">{label}</span>
        <span className="font-mono text-xs shrink-0">{valueLabel}</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SectionCard({ title, icon, description, children }: {
  title: string; icon: React.ReactNode; description?: string; children: React.ReactNode;
}) {
  return (
    <Card className="border-card-border bg-card shadow-sm flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">{icon}{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="h-full min-h-[140px] flex flex-col items-center justify-center text-muted-foreground py-6">
      <Boxes className="w-8 h-8 mb-2 opacity-20" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const dashPerm = usePermission('page:/');
  const range = useDateRange('month');
  const [loc, setLoc] = useState('all'); // 'all' | 'warehouse:<id>' | 'outlet:<id>'
  useClearOutletSelection(loc.startsWith('outlet:'), () => setLoc('all'));

  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();

  const filters = useMemo<DashboardBiFilters>(() => {
    const f: DashboardBiFilters = {};
    if (range.from) f.fromDate = range.from;
    if (range.to) f.toDate = range.to;
    if (loc.startsWith('warehouse:')) { f.locationType = 'warehouse'; f.locationId = Number(loc.slice(10)); }
    else if (loc.startsWith('outlet:')) { f.locationType = 'outlet'; f.locationId = Number(loc.slice(7)); }
    return f;
  }, [range.from, range.to, loc]);

  const { data: bi, isLoading, isError } = useGetDashboardBi(filters);

  const isHeadOffice = bi?.scope.isHeadOffice ?? true;
  const pLabel = periodLabel(range.from || undefined, range.to || undefined);

  // Permission gate
  if (!dashPerm.isLoading && !dashPerm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view the Dashboard.<br />
              Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  const s = bi?.sales;
  const salesDayMax = Math.max(0, ...(s?.byDay.map(d => d.total) ?? [0]));
  const prodDayMax = Math.max(0, ...(bi?.production.byDay.map(d => d.qty) ?? [0]));
  const payMax = Math.max(0, ...(s?.byPaymentMode.map(p => p.total) ?? [0]));
  const locMax = Math.max(0, ...(s?.byLocation.map(l => l.total) ?? [0]));
  const topItemMax = Math.max(0, ...(bi?.topItems.map(i => i.revenue) ?? [0]));

  const summaryCards: { label: string; value: React.ReactNode; tone?: CardTone }[] = [
    { label: 'Sales', value: fmt(s?.total ?? 0), tone: 'accent' },
    // Expenses and Bank Balance come from the accounting postings, which carry
    // no location. The API returns null for a single-location login rather
    // than passing off a company-wide number as that branch's — render the
    // gap instead of a misleading zero.
    {
      label: 'Expenses',
      value: bi?.expenses?.total == null ? '—' : fmt(bi.expenses.total),
      tone: (bi?.expenses?.total ?? 0) > 0 ? 'neg' : 'default',
    },
    {
      label: 'Bank Balance',
      value: bi?.bank?.balance == null ? '—' : fmt(bi.bank.balance),
      tone: bi?.bank?.balance == null ? 'default' : bi.bank.balance >= 0 ? 'pos' : 'neg',
    },
    { label: 'Purchases', value: fmt(bi?.purchases.total ?? 0) },
    // Hidden entirely for employees without the inventory-valuation right —
    // the server omits the figure, so there is nothing honest to show.
    ...(bi?.canViewValuation ? [{ label: 'Inventory Value', value: fmt(bi.inventory.valuation ?? 0) }] : []),
    // Receivables, Payables and Cash Balance are Balance Sheet positions taken
    // from the accounting ledgers, so they carry no location and read '—' for a
    // single-location login, exactly like Expenses and Bank Balance above.
    {
      label: 'Receivables',
      value: bi?.receivables?.total == null ? '—' : fmt(bi.receivables.total),
      tone: (bi?.receivables?.overdue ?? 0) > 0 ? 'warn' : 'default',
    },
    {
      label: 'Payables',
      value: bi?.payables?.total == null ? '—' : fmt(bi.payables.total),
      tone: bi?.payables?.total == null ? 'default' : 'neg',
    },
    {
      label: 'Cash Balance',
      value: bi?.cash?.balance == null ? '—' : fmt(bi.cash.balance),
      tone: bi?.cash?.balance == null ? 'default' : bi.cash.balance >= 0 ? 'pos' : 'neg',
    },
  ];

  return (
    <AppLayout>
      <div className="space-y-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Business Dashboard</h1>
            <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-sm">
              <MapPin className="w-3.5 h-3.5" />
              {bi?.scope.label ?? '…'} · {pLabel}
            </p>
          </div>
          <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 px-3 py-1">
            <span className="w-2 h-2 rounded-full bg-primary mr-2 animate-pulse" />
            Live Sync Active
          </Badge>
        </div>

        {/* ── Controls: date range + location ────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          <RangeBar range={range} />
          <Select value={loc} onValueChange={setLoc} disabled={!isHeadOffice}>
            <SelectTrigger className="w-56 h-9 bg-card">
              <SelectValue placeholder="All locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {(warehouses as any[]).length > 0 && (
                <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Warehouses
                </div>
              )}
              {(warehouses as any[]).map((w: any) => (
                <SelectItem key={`w${w.id}`} value={`warehouse:${w.id}`}>{w.name}</SelectItem>
              ))}
              {outletsEnabled && (outlets as any[]).length > 0 && (
                <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Outlets
                </div>
              )}
              {outletsEnabled && (outlets as any[]).map((o: any) => (
                <SelectItem key={`o${o.id}`} value={`outlet:${o.id}`}>{o.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!isHeadOffice && (
            <span className="text-xs text-muted-foreground">Scoped to your location</span>
          )}
        </div>

        {isError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Could not load dashboard figures. Please try again.
          </div>
        )}

        {/* ── Summary cards ──────────────────────────────────────────────── */}
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-[68px] rounded-lg" />)}
          </div>
        ) : (
          <>
            <SummaryCards cards={summaryCards} />
            {bi && bi.expenses?.total == null && (
              <p className="text-xs text-muted-foreground">
                Expenses and Bank Balance are company-level accounting figures and are not
                broken down by location, so they are not shown for a single-location view.
              </p>
            )}
          </>
        )}

        {/* ── Sales trend + payment mix ──────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <SectionCard
              title="Sales Trend"
              icon={<TrendingUp className="w-5 h-5 text-primary" />}
              description={s ? `${fmt(s.total)} across ${num(s.count)} invoice${s.count !== 1 ? 's' : ''}` : undefined}
            >
              {isLoading ? (
                <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
              ) : !s || s.byDay.length === 0 ? (
                <Empty message="No sales in this period" />
              ) : (
                <div className="space-y-3">
                  {s.byDay.map(d => (
                    <BarRow
                      key={d.date}
                      label={fmtDate(d.date)}
                      value={d.total}
                      max={salesDayMax}
                      color={WAREHOUSE_COLOR}
                      valueLabel={`${fmt(d.total)} · ${d.count}`}
                    />
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <SectionCard title="Payment Mix" icon={<Wallet className="w-5 h-5 text-chart-2" />}>
            {isLoading ? (
              <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
            ) : !s || s.byPaymentMode.length === 0 ? (
              <Empty message="No payments in this period" />
            ) : (
              <div className="space-y-3">
                {s.byPaymentMode.map(p => (
                  <BarRow
                    key={p.mode}
                    label={PAY_LABEL[p.mode] ?? p.mode}
                    value={p.total}
                    max={payMax}
                    color={OUTLET_COLOR}
                    valueLabel={fmt(p.total)}
                    sub={`${p.count} invoice${p.count !== 1 ? 's' : ''}`}
                  />
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* ── Sales by location (HO) + Top items ─────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SectionCard
            title="Sales by Location"
            icon={<Trophy className="w-5 h-5 text-amber-500" />}
            description={`Ranked by revenue — ${pLabel}`}
          >
            {isLoading ? (
              <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : !s || s.byLocation.length === 0 ? (
              <Empty message="No sales in this period" />
            ) : (
              <div className="space-y-3">
                {s.byLocation.map(l => (
                  <div key={`${l.locationType}:${l.locationId}`} className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {l.locationType === 'warehouse'
                          ? <Warehouse className="w-3.5 h-3.5 text-primary shrink-0" />
                          : <Store className="w-3.5 h-3.5 text-chart-2 shrink-0" />}
                        <span className="font-medium text-sm truncate">{l.name}</span>
                        <LocationBadge type={l.locationType} />
                      </div>
                      <span className="font-bold text-sm font-mono shrink-0">{fmt(l.total)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{
                        width: `${locMax > 0 ? Math.max(2, (l.total / locMax) * 100) : 0}%`,
                        background: l.locationType === 'warehouse' ? WAREHOUSE_COLOR : OUTLET_COLOR,
                      }} />
                    </div>
                    <p className="text-[10px] text-muted-foreground">{l.count} invoice{l.count !== 1 ? 's' : ''}</p>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Top Items"
            icon={<ShoppingCart className="w-5 h-5 text-primary" />}
            description="Best sellers by revenue"
          >
            {isLoading ? (
              <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
            ) : !bi || bi.topItems.length === 0 ? (
              <Empty message="No item sales in this period" />
            ) : (
              <div className="space-y-3">
                {bi.topItems.map(i => (
                  <BarRow
                    key={i.itemId}
                    label={i.name}
                    value={i.revenue}
                    max={topItemMax}
                    color="hsl(var(--chart-3))"
                    valueLabel={fmt(i.revenue)}
                    sub={`${num(i.qty)} sold`}
                  />
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* ── Production + inventory + top customers ──────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <SectionCard
            title="Production"
            icon={<Factory className="w-5 h-5 text-chart-3" />}
            description={bi ? `${num(bi.production.batches)} batch${bi.production.batches !== 1 ? 'es' : ''}` : undefined}
          >
            {isLoading ? (
              <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
            ) : !bi || bi.production.byDay.length === 0 ? (
              <Empty message="No production in this period" />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  <div className="rounded-lg border border-border bg-muted/10 p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Output</p>
                    <p className="font-bold font-mono text-sm">{num(bi.production.outputQty)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/10 p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Wastage</p>
                    <p className="font-bold font-mono text-sm text-amber-600">
                      {num(bi.production.wastageQty)} ({bi.production.wastagePct}%)
                    </p>
                  </div>
                </div>
                <div className="space-y-3">
                  {bi.production.byDay.map(d => (
                    <BarRow
                      key={d.date}
                      label={fmtDate(d.date)}
                      value={d.qty}
                      max={prodDayMax}
                      color="hsl(var(--chart-3))"
                      valueLabel={num(d.qty)}
                    />
                  ))}
                </div>
              </>
            )}
          </SectionCard>

          <SectionCard title="Inventory" icon={<Boxes className="w-5 h-5 text-primary" />}>
            {isLoading ? (
              <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : !bi ? (
              <Empty message="No inventory data" />
            ) : (
              <div className="space-y-2.5">
                {bi.canViewValuation && (
                  <StatRow icon={<Landmark className="w-4 h-4 text-primary" />} label="Valuation" value={fmt(bi.inventory.valuation ?? 0)} />
                )}
                <StatRow icon={<Boxes className="w-4 h-4 text-muted-foreground" />} label="Products in stock" value={num(bi.inventory.itemCount)} />
                <StatRow
                  icon={<AlertTriangle className="w-4 h-4 text-destructive" />}
                  label="Low-stock alerts"
                  value={num(bi.inventory.lowStockCount)}
                  tone={bi.inventory.lowStockCount > 0 ? 'neg' : undefined}
                />
                <StatRow
                  icon={<Clock className="w-4 h-4 text-amber-600" />}
                  label="Expiring ≤ 30 days"
                  value={num(bi.inventory.expiringSoonCount)}
                  tone={bi.inventory.expiringSoonCount > 0 ? 'warn' : undefined}
                />
                <div className="pt-2 mt-2 border-t border-border space-y-2.5">
                  <StatRow icon={<ArrowUpRight className="w-4 h-4 text-emerald-600" />} label="Cash inflow" value={fmt(bi.cash.inflow)} tone="pos" />
                  <StatRow icon={<ArrowDownRight className="w-4 h-4 text-red-500" />} label="Cash outflow" value={fmt(bi.cash.outflow)} tone="neg" />
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Top Customers"
            icon={<Users className="w-5 h-5 text-chart-2" />}
            description="By revenue"
          >
            {isLoading ? (
              <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
            ) : !bi || bi.topCustomers.length === 0 ? (
              <Empty message="No customer sales in this period" />
            ) : (
              <div className="space-y-2">
                {bi.topCustomers.map((c, i) => (
                  <div key={c.customerId} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-border bg-muted/10">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-muted-foreground w-4 shrink-0">#{i + 1}</span>
                      <span className="font-medium text-sm truncate">{c.name}</span>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-bold text-sm font-mono">{fmt(c.revenue)}</p>
                      <p className="text-[10px] text-muted-foreground">{c.count} order{c.count !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </AppLayout>
  );
}

function StatRow({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; tone?: 'pos' | 'neg' | 'warn';
}) {
  const cls = tone === 'pos' ? 'text-emerald-600' : tone === 'neg' ? 'text-red-500' : tone === 'warn' ? 'text-amber-600' : '';
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">{icon}{label}</span>
      <span className={`font-bold font-mono text-sm ${cls}`}>{value}</span>
    </div>
  );
}
