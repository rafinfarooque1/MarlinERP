import { useState, useMemo } from 'react';
import {
  useGetDashboardSummary,
  useGetStockAlerts,
  useGetRecentActivity,
  useGetSalesByLocation,
  useListStock,
  useListWarehouses,
  useListOutlets,
  type SalesAnalyticsFilters,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Activity, AlertTriangle, Box, CreditCard, Users,
  ArrowUpRight, ArrowDownRight, Package, ArrowRightLeft,
  Clock, Building2, Factory, User, TrendingDown, Layers,
  Landmark, Wallet, Trophy, Warehouse, Store,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRupee(v: number): string {
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(1)}k`;
  return `₹${v.toFixed(0)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const tooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  borderColor:     'hsl(var(--border))',
  borderRadius:    '8px',
  fontSize:        '12px',
};

const WAREHOUSE_COLOR = 'hsl(var(--primary))';
const OUTLET_COLOR    = 'hsl(var(--chart-2))';

// ── Main Component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [salesPeriod, setSalesPeriod] = useState<30 | 90>(30);
  const [fromDate, setFromDate]   = useState('');
  const [toDate, setToDate]       = useState('');
  const [locFilter, setLocFilter] = useState('all'); // 'all' | 'w:<id>' | 'o:<id>'

  const { data: summary,  isLoading: loadingSummary }  = useGetDashboardSummary();
  const { data: alerts,   isLoading: loadingAlerts }   = useGetStockAlerts();
  const { data: activity, isLoading: loadingActivity } = useGetRecentActivity();
  const { data: allStock  = [], isLoading: loadingStock } = useListStock({});
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] }    = useListOutlets();

  // ── Sales by location (server-aggregated, includes warehouse sales) ───────
  const salesFilters = useMemo<SalesAnalyticsFilters>(() => {
    const f: SalesAnalyticsFilters = {};
    if (fromDate) f.from = fromDate;
    if (toDate)   f.to   = toDate;
    if (!fromDate && !toDate) f.days = salesPeriod;
    if (locFilter.startsWith('w:')) {
      f.warehouseScope = Number(locFilter.slice(2));
    } else if (locFilter.startsWith('o:')) {
      f.locationType = 'outlet';
      f.locationId = Number(locFilter.slice(2));
    }
    return f;
  }, [salesPeriod, fromDate, toDate, locFilter]);

  const { data: locationRows = [], isLoading: loadingSales } = useGetSalesByLocation(salesFilters);

  const salesByLocation = useMemo(() =>
    [...locationRows]
      .map(r => ({ name: r.locationName, type: r.locationType, total: Number(r.revenue), count: Number(r.invoices) }))
      .sort((a, b) => b.total - a.total),
    [locationRows]
  );

  const totalPeriodSales = salesByLocation.reduce((s, loc) => s + loc.total, 0);

  const usingCustomRange = !!(fromDate || toDate);
  const periodLabel = usingCustomRange
    ? `${fromDate || '…'} → ${toDate || 'today'}`
    : `last ${salesPeriod} days`;

  const salesChartData = salesByLocation.map(loc => ({
    name:     truncate(loc.name, 14),
    fullName: loc.name,
    revenue:  loc.total,
    count:    loc.count,
    type:     loc.type,
  }));

  // ── High stock items (aggregate across all locations) ─────────────────────
  const highStockItems = useMemo(() => {
    const map = new Map<string, { name: string; unit: string; total: number; locations: number }>();
    for (const s of allStock as any[]) {
      const key = s.itemName || `Item #${s.itemId}`;
      if (!map.has(key)) map.set(key, { name: key, unit: s.unit || '', total: 0, locations: 0 });
      const grp = map.get(key)!;
      grp.total     += Number(s.quantity ?? 0);
      grp.locations += 1;
    }
    return [...map.values()]
      .filter(i => i.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  }, [allStock]);

  const maxStockQty = highStockItems[0]?.total ?? 1;

  return (
    <AppLayout>
      <div className="space-y-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">System Overview</h1>
            <p className="text-muted-foreground mt-1">Real-time metrics across all operations</p>
          </div>
          <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 px-3 py-1">
            <span className="w-2 h-2 rounded-full bg-primary mr-2 animate-pulse" />
            Live Sync Active
          </Badge>
        </div>

        {/* ── KPI Cards ──────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            title="Total Stock Value"
            value={summary?.totalStockValue ? `₹${summary.totalStockValue.toLocaleString('en-IN')}` : '₹0'}
            icon={<Box className="w-4 h-4 text-muted-foreground" />}
            sub={`${summary?.lowStockCount ?? 0} low-stock alerts`}
            trendUp={true}
            loading={loadingSummary}
          />
          <KpiCard
            title="Total Sales (All Time)"
            value={summary?.totalSalesAmount ? `₹${summary.totalSalesAmount.toLocaleString('en-IN')}` : '₹0'}
            icon={<CreditCard className="w-4 h-4 text-muted-foreground" />}
            sub="Cumulative revenue"
            trendUp={true}
            loading={loadingSummary}
          />
          <KpiCard
            title="Active Employees"
            value={summary?.activeEmployees?.toString() ?? '0'}
            icon={<Users className="w-4 h-4 text-muted-foreground" />}
            sub={`${summary?.todayAttendance ?? 0} present today`}
            trendUp={true}
            loading={loadingSummary}
          />
          <KpiCard
            title="Pending Transfers"
            value={summary?.pendingTransfers?.toString() ?? '0'}
            icon={<ArrowRightLeft className="w-4 h-4 text-muted-foreground" />}
            sub={`${summary?.pendingLeaves ?? 0} leave requests`}
            trendUp={(summary?.pendingTransfers ?? 0) === 0}
            loading={loadingSummary}
          />
          <KpiCard
            title="Total Expense"
            value={summary?.totalExpense ? `₹${summary.totalExpense.toLocaleString('en-IN')}` : '₹0'}
            icon={<TrendingDown className="w-4 h-4 text-muted-foreground" />}
            sub="All recorded expenses"
            trendUp={false}
            loading={loadingSummary}
          />
          <KpiCard
            title="Total Batches Created"
            value={summary?.totalBatchesCreated?.toLocaleString('en-IN') ?? '0'}
            icon={<Layers className="w-4 h-4 text-muted-foreground" />}
            sub={`${(summary?.totalBatchQuantity ?? 0).toLocaleString('en-IN')} units produced`}
            trendUp={true}
            loading={loadingSummary}
          />
          <KpiCard
            title="Bank Balance"
            value={summary?.bankBalance !== undefined ? `₹${summary.bankBalance.toLocaleString('en-IN')}` : '₹0'}
            icon={<Landmark className="w-4 h-4 text-muted-foreground" />}
            sub="Sum of all bank accounts"
            trendUp={(summary?.bankBalance ?? 0) >= 0}
            loading={loadingSummary}
          />
          <KpiCard
            title="Cash Balance"
            value={summary?.cashBalance !== undefined ? `₹${summary.cashBalance.toLocaleString('en-IN')}` : '₹0'}
            icon={<Wallet className="w-4 h-4 text-muted-foreground" />}
            sub="Sum of all cash accounts"
            trendUp={(summary?.cashBalance ?? 0) >= 0}
            loading={loadingSummary}
          />
        </div>

        {/* ── Sales filters (location + date range) ──────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={locFilter} onValueChange={setLocFilter}>
            <SelectTrigger className="w-56 h-9 bg-card"><SelectValue placeholder="All locations" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {(warehouses as any[]).length > 0 && (
                <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Warehouses (incl. their outlets)
                </div>
              )}
              {(warehouses as any[]).map((w: any) => (
                <SelectItem key={`w${w.id}`} value={`w:${w.id}`}>{w.name}</SelectItem>
              ))}
              {(outlets as any[]).length > 0 && (
                <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Outlets
                </div>
              )}
              {(outlets as any[]).map((o: any) => (
                <SelectItem key={`o${o.id}`} value={`o:${o.id}`}>{o.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-[9.5rem] h-9 bg-card" aria-label="From date" />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-[9.5rem] h-9 bg-card" aria-label="To date" />
          {usingCustomRange && (
            <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={() => { setFromDate(''); setToDate(''); }}>
              Clear dates
            </Button>
          )}
        </div>

        {/* ── Sales by Location chart + Top Locations ────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Bar chart — 2/3 width */}
          <Card className="lg:col-span-2 border-card-border bg-card shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="text-lg">Sales by Location</CardTitle>
                  <CardDescription>
                    {loadingSales
                      ? 'Loading…'
                      : salesByLocation.length > 0
                        ? `${fmtRupee(totalPeriodSales)} across ${salesByLocation.length} location${salesByLocation.length !== 1 ? 's' : ''} — ${periodLabel}`
                        : `No sales — ${periodLabel}`}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-3">
                  {/* Legend */}
                  <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: WAREHOUSE_COLOR }} />
                      Warehouse
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: OUTLET_COLOR }} />
                      Outlet
                    </span>
                  </div>
                  {/* Period toggle */}
                  <div className="flex gap-1">
                    {([30, 90] as const).map(d => (
                      <Button
                        key={d}
                        variant={!usingCustomRange && salesPeriod === d ? 'default' : 'outline'}
                        size="sm"
                        className="h-7 px-3 text-xs"
                        onClick={() => { setFromDate(''); setToDate(''); setSalesPeriod(d); }}
                      >
                        {d}d
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loadingSales ? (
                <Skeleton className="h-[300px] w-full rounded-md" />
              ) : salesChartData.length === 0 ? (
                <EmptyChart message="No sales recorded in this period" height={300} />
              ) : (
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={salesChartData} barCategoryGap="28%" margin={{ top: 16, right: 8, bottom: 4, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="name"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                        angle={salesChartData.length > 5 ? -30 : 0}
                        textAnchor={salesChartData.length > 5 ? 'end' : 'middle'}
                        height={salesChartData.length > 5 ? 52 : 28}
                      />
                      <YAxis
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={fmtRupee}
                        width={60}
                      />
                      <Tooltip
                        cursor={{ fill: 'hsl(var(--muted)/0.15)' }}
                        contentStyle={tooltipStyle}
                        formatter={(v: number, _: string, props: any) => [
                          `₹${v.toLocaleString('en-IN')} (${props.payload.count} orders)`,
                          props.payload.type === 'warehouse' ? 'Warehouse' : 'Outlet',
                        ]}
                        labelFormatter={(_: string, payload: any[]) => payload?.[0]?.payload?.fullName ?? _}
                        labelStyle={{ color: 'hsl(var(--foreground))', marginBottom: 4 }}
                      />
                      <Bar dataKey="revenue" radius={[4, 4, 0, 0]} maxBarSize={48}>
                        {salesChartData.map((entry, i) => (
                          <Cell
                            key={i}
                            fill={entry.type === 'warehouse' ? WAREHOUSE_COLOR : OUTLET_COLOR}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top Sale Locations — 1/3 width */}
          <Card className="border-card-border bg-card shadow-sm flex flex-col">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Trophy className="w-5 h-5 text-amber-500" />
                Top Sale Locations
              </CardTitle>
              <CardDescription>Ranked by revenue — {periodLabel}</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto">
              {loadingSales ? (
                <div className="space-y-3">
                  {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-14 w-full rounded-md" />)}
                </div>
              ) : salesByLocation.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground py-8">
                  <CreditCard className="w-10 h-10 mb-2 opacity-20" />
                  <p className="text-sm">No sales this period</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {salesByLocation.slice(0, 8).map((loc, i) => {
                    const pct = totalPeriodSales > 0 ? (loc.total / totalPeriodSales) * 100 : 0;
                    const isWarehouse = loc.type === 'warehouse';
                    const medals = ['🥇', '🥈', '🥉'];
                    return (
                      <div key={i} className="p-3 rounded-lg border border-border bg-muted/10 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-base shrink-0">{medals[i] ?? `#${i + 1}`}</span>
                            {isWarehouse
                              ? <Warehouse className="w-3.5 h-3.5 text-primary shrink-0" />
                              : <Store className="w-3.5 h-3.5 text-chart-2 shrink-0" />}
                            <span className="font-medium text-sm truncate">{loc.name}</span>
                          </div>
                          <span className="font-bold text-sm font-mono shrink-0">
                            {fmtRupee(loc.total)}
                          </span>
                        </div>
                        {/* Progress bar */}
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${pct}%`,
                              background: isWarehouse ? WAREHOUSE_COLOR : OUTLET_COLOR,
                            }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>{loc.count} order{loc.count !== 1 ? 's' : ''}</span>
                          <span>{pct.toFixed(1)}% of total</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── High Stock Items ────────────────────────────────────────────── */}
        <Card className="border-card-border bg-card shadow-sm">
          <CardHeader>
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Package className="w-5 h-5 text-primary" />
                Items with Most Stock
              </CardTitle>
              <CardDescription>Top 10 items by total quantity across all locations</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {loadingStock ? (
              <Skeleton className="h-[300px] w-full rounded-md" />
            ) : highStockItems.length === 0 ? (
              <EmptyChart message="No stock data available" height={300} />
            ) : (
              <div className="h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={highStockItems.map(i => ({ ...i, shortName: truncate(i.name, 22) }))}
                    layout="vertical"
                    margin={{ left: 8, right: 64, top: 4, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                    <XAxis
                      type="number"
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={v => v.toLocaleString('en-IN')}
                    />
                    <YAxis
                      type="category"
                      dataKey="shortName"
                      width={160}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'hsl(var(--muted)/0.15)' }}
                      contentStyle={tooltipStyle}
                      formatter={(v: number, _: string, props: any) => [
                        `${v.toLocaleString('en-IN')} ${props.payload.unit || 'units'} (${props.payload.locations} location${props.payload.locations !== 1 ? 's' : ''})`,
                        'Total Stock',
                      ]}
                      labelFormatter={(_: string, payload: any[]) => payload?.[0]?.payload?.name ?? _}
                      labelStyle={{ color: 'hsl(var(--foreground))', marginBottom: 4 }}
                    />
                    <Bar dataKey="total" radius={[0, 4, 4, 0]} maxBarSize={24} fill="hsl(var(--chart-3))">
                      {highStockItems.map((entry, i) => {
                        const intensity = 0.4 + 0.6 * (1 - i / Math.max(highStockItems.length - 1, 1));
                        return (
                          <Cell
                            key={i}
                            fill={`hsl(var(--chart-3) / ${intensity})`}
                            stroke="hsl(var(--chart-3))"
                            strokeOpacity={i === 0 ? 1 : 0}
                            strokeWidth={2}
                          />
                        );
                      })}
                      <LabelList
                        dataKey="total"
                        position="right"
                        formatter={(v: number) => v.toLocaleString('en-IN')}
                        style={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Recent Activity + Stock Alerts ─────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Recent Activity */}
          <Card className="lg:col-span-2 border-card-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Recent Activity</CardTitle>
              <CardDescription>Latest actions across the ERP</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingActivity ? (
                <div className="space-y-4">
                  {[1, 2, 3, 4, 5].map(i => (
                    <div key={i} className="flex items-center gap-4">
                      <Skeleton className="h-10 w-10 rounded-full" />
                      <div className="space-y-2 flex-1">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/4" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : !activity || activity.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No recent activity</div>
              ) : (
                <div className="space-y-5">
                  {activity.slice(0, 8).map((item, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className="h-9 w-9 rounded-full bg-secondary flex items-center justify-center border border-border shrink-0">
                        {item.type === 'sale'
                          ? <CreditCard className="w-4 h-4 text-primary" />
                          : item.type === 'production'
                          ? <Factory className="w-4 h-4 text-chart-3" />
                          : item.type === 'transfer'
                          ? <ArrowRightLeft className="w-4 h-4 text-chart-2" />
                          : <Activity className="w-4 h-4 text-muted-foreground" />}
                      </div>
                      <div className="flex-1 space-y-0.5 min-w-0">
                        <p className="text-sm font-medium leading-snug truncate">{item.description}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <User className="w-3 h-3 shrink-0" />
                          <span className="truncate">{item.user}</span>
                          <span className="w-1 h-1 rounded-full bg-muted-foreground/30 shrink-0" />
                          <Clock className="w-3 h-3 shrink-0" />
                          <span className="shrink-0">
                            {item.timestamp
                              ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                              : '—'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Stock Alerts */}
          <Card className="border-card-border bg-card shadow-sm flex flex-col">
            <CardHeader>
              <CardTitle className="text-lg text-destructive flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" /> Stock Alerts
              </CardTitle>
              <CardDescription>Items below minimum threshold</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto">
              {loadingAlerts ? (
                <div className="space-y-3">
                  {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-14 w-full rounded-md" />)}
                </div>
              ) : !alerts || alerts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground py-8">
                  <Package className="w-12 h-12 mb-2 opacity-20" />
                  <p className="text-sm">Stock levels optimal</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {alerts.map((alert, i) => (
                    <div key={i} className="p-3 rounded-md bg-destructive/5 border border-destructive/20 flex flex-col gap-1 relative overflow-hidden">
                      <div className="absolute top-0 left-0 w-1 h-full bg-destructive" />
                      <div className="flex justify-between items-start pl-2">
                        <span className="font-medium text-sm text-foreground truncate pr-2">{alert.itemName}</span>
                        <Badge variant="destructive" className="h-5 text-[10px] leading-none px-1.5 shrink-0">
                          {alert.quantity} Left
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 pl-2">
                        <Building2 className="w-3 h-3" />
                        {alert.branchName}
                        <span className="opacity-50 text-[10px]">({alert.branchType})</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function EmptyChart({ message, height }: { message: string; height: number }) {
  return (
    <div
      className="flex flex-col items-center justify-center text-muted-foreground rounded-md border border-dashed border-border bg-muted/20"
      style={{ height }}
    >
      <Package className="w-10 h-10 mb-2 opacity-20" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

function KpiCard({
  title, value, icon, sub, trendUp, loading,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  sub: string;
  trendUp: boolean;
  loading: boolean;
}) {
  return (
    <Card className="border-card-border bg-card shadow-sm overflow-hidden relative group">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className="h-8 w-8 rounded-md bg-secondary flex items-center justify-center border border-border">
          {icon}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-24 mb-2" />
        ) : (
          <div className="text-2xl font-bold font-mono tracking-tight">{value}</div>
        )}
        <p className={`text-xs mt-1 flex items-center gap-1 ${trendUp ? 'text-emerald-500' : 'text-amber-500'}`}>
          {trendUp ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
          {sub}
        </p>
      </CardContent>
    </Card>
  );
}
