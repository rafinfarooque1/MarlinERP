import { useState } from 'react';
import {
  useGetDashboardSummary,
  useGetStockAlerts,
  useGetRecentActivity,
  useGetSalesTrend,
  useGetTopItems,
  useGetProductionTrend,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Activity, AlertTriangle, Box, CreditCard, Users,
  ArrowUpRight, ArrowDownRight, Package, ArrowRightLeft,
  Clock, Building2, Factory, User, TrendingDown, Layers,
  Landmark, Wallet,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Cell,
} from 'recharts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(dateStr: string): string {
  // e.g. "2026-07-10" → "Jul 10"
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
}

function fmtRupee(v: number): string {
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000) return `₹${(v / 1000).toFixed(1)}k`;
  return `₹${v.toFixed(0)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

// ── Custom Tooltip ────────────────────────────────────────────────────────────

const tooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  borderColor: 'hsl(var(--border))',
  borderRadius: '8px',
  fontSize: '12px',
};

// ── Main Component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [salesPeriod, setSalesPeriod] = useState<30 | 90>(30);

  const { data: summary,    isLoading: loadingSummary }    = useGetDashboardSummary();
  const { data: alerts,     isLoading: loadingAlerts }     = useGetStockAlerts();
  const { data: activity,   isLoading: loadingActivity }   = useGetRecentActivity();
  const { data: salesTrend, isLoading: loadingSalesTrend } = useGetSalesTrend({ days: salesPeriod });
  const { data: topItems,   isLoading: loadingTopItems }   = useGetTopItems({ days: salesPeriod });
  const { data: prodTrend,  isLoading: loadingProdTrend }  = useGetProductionTrend({ days: 30 });

  // Prepare chart-ready data
  const salesChartData = (salesTrend ?? []).map(p => ({
    ...p,
    label: fmtDate(p.date),
  }));
  const prodChartData = (prodTrend ?? []).map(p => ({
    ...p,
    label: fmtDate(p.date),
  }));
  const topItemsData = (topItems ?? []).map(p => ({
    ...p,
    shortName: truncate(p.item_name, 20),
  }));

  const totalSalesInPeriod = salesChartData.reduce((s, p) => s + p.revenue, 0);
  const totalProduced = prodChartData.reduce((s, p) => s + p.quantity, 0);

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
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

        {/* KPI Cards */}
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

        {/* Sales Trend + Production Trend */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Sales Trend — 2/3 width */}
          <Card className="lg:col-span-2 border-card-border bg-card shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle className="text-lg">Sales Revenue Trend</CardTitle>
                  <CardDescription>
                    {loadingSalesTrend
                      ? 'Loading…'
                      : salesChartData.length > 0
                        ? `${fmtRupee(totalSalesInPeriod)} over last ${salesPeriod} days`
                        : `No sales in last ${salesPeriod} days`}
                  </CardDescription>
                </div>
                <div className="flex gap-1">
                  {([30, 90] as const).map(d => (
                    <Button
                      key={d}
                      variant={salesPeriod === d ? 'default' : 'outline'}
                      size="sm"
                      className="h-7 px-3 text-xs"
                      onClick={() => setSalesPeriod(d)}
                    >
                      {d}d
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loadingSalesTrend ? (
                <Skeleton className="h-[280px] w-full rounded-md" />
              ) : salesChartData.length === 0 ? (
                <EmptyChart message="No sales recorded in this period" height={280} />
              ) : (
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={salesChartData} barCategoryGap="30%">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="label"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={fmtRupee}
                        width={56}
                      />
                      <Tooltip
                        cursor={{ fill: 'hsl(var(--muted)/0.15)' }}
                        contentStyle={tooltipStyle}
                        formatter={(v: number) => [`₹${v.toLocaleString('en-IN')}`, 'Revenue']}
                        labelStyle={{ color: 'hsl(var(--foreground))', marginBottom: 4 }}
                      />
                      <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={40} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Production Trend — 1/3 width */}
          <Card className="border-card-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Production Output</CardTitle>
              <CardDescription>
                {loadingProdTrend
                  ? 'Loading…'
                  : prodChartData.length > 0
                    ? `${totalProduced.toLocaleString('en-IN')} units last 30 days`
                    : 'No production recorded'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingProdTrend ? (
                <Skeleton className="h-[280px] w-full rounded-md" />
              ) : prodChartData.length === 0 ? (
                <EmptyChart message="No production recorded" height={280} />
              ) : (
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={prodChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="label"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        width={40}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v: number) => [v.toLocaleString('en-IN'), 'Units']}
                        labelStyle={{ color: 'hsl(var(--foreground))', marginBottom: 4 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="quantity"
                        stroke="hsl(var(--chart-3))"
                        strokeWidth={2.5}
                        dot={{ r: 3, fill: 'hsl(var(--chart-3))', strokeWidth: 0 }}
                        activeDot={{ r: 5 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Top 10 Items */}
        <Card className="border-card-border bg-card shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-lg">Top 10 Items by Revenue</CardTitle>
                <CardDescription>Best-selling items in the last {salesPeriod} days</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loadingTopItems ? (
              <Skeleton className="h-[280px] w-full rounded-md" />
            ) : topItemsData.length === 0 ? (
              <EmptyChart message="No sales data for this period" height={280} />
            ) : (
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topItemsData} layout="vertical" margin={{ left: 8, right: 32, top: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                    <XAxis
                      type="number"
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={fmtRupee}
                    />
                    <YAxis
                      type="category"
                      dataKey="shortName"
                      width={130}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'hsl(var(--muted)/0.15)' }}
                      contentStyle={tooltipStyle}
                      formatter={(v: number, _name: string, props: any) => [
                        `₹${v.toLocaleString('en-IN')} (${props.payload.quantity?.toLocaleString('en-IN')} units)`,
                        'Revenue',
                      ]}
                      labelFormatter={(label: string) => label}
                      labelStyle={{ color: 'hsl(var(--foreground))', marginBottom: 4 }}
                    />
                    <Bar dataKey="revenue" radius={[0, 4, 4, 0]} maxBarSize={22}>
                      {topItemsData.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Activity + Stock Alerts */}
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

// ── Sub-components ────────────────────────────────────────────────────────────

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
