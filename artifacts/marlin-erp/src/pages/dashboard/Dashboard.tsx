import { useGetDashboardSummary, useGetStockAlerts, useGetRecentActivity } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Activity, AlertTriangle, Box, CreditCard, Users, TrendingUp, ArrowUpRight, ArrowDownRight, Package, ArrowRightLeft, Clock, Building2, Factory, User } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';
import { Button } from 'react-day-picker';

// Mock chart data since API doesn't provide historical data yet
const salesData = [
  { name: 'Mon', total: 12000 },
  { name: 'Tue', total: 18000 },
  { name: 'Wed', total: 15000 },
  { name: 'Thu', total: 22000 },
  { name: 'Fri', total: 28000 },
  { name: 'Sat', total: 35000 },
  { name: 'Sun', total: 42000 },
];

const productionData = [
  { name: 'Week 1', quantity: 400 },
  { name: 'Week 2', quantity: 300 },
  { name: 'Week 3', quantity: 550 },
  { name: 'Week 4', quantity: 450 },
];

export default function Dashboard() {
  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: alerts, isLoading: isLoadingAlerts } = useGetStockAlerts();
  const { data: activity, isLoading: isLoadingActivity } = useGetRecentActivity();

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">System Overview</h1>
            <p className="text-muted-foreground mt-1">Real-time metrics across all operations</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 px-3 py-1">
              <span className="w-2 h-2 rounded-full bg-primary mr-2 animate-pulse" />
              Live Sync Active
            </Badge>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard 
            title="Total Stock Value" 
            value={summary?.totalStockValue ? `₹${summary.totalStockValue.toLocaleString('en-IN')}` : '₹0'} 
            icon={<Box className="w-4 h-4 text-muted-foreground" />} 
            trend="+12.5%" 
            trendUp={true} 
            loading={isLoadingSummary} 
          />
          <KpiCard 
            title="Today's Sales" 
            value={summary?.totalSalesAmount ? `₹${summary.totalSalesAmount.toLocaleString('en-IN')}` : '₹0'} 
            icon={<CreditCard className="w-4 h-4 text-muted-foreground" />} 
            trend="+4.2%" 
            trendUp={true} 
            loading={isLoadingSummary} 
          />
          <KpiCard 
            title="Active Employees" 
            value={summary?.activeEmployees?.toString() || '0'} 
            icon={<Users className="w-4 h-4 text-muted-foreground" />} 
            trend="98% Present" 
            trendUp={true} 
            loading={isLoadingSummary} 
            trendIcon={false}
          />
          <KpiCard 
            title="Pending Transfers" 
            value={summary?.pendingTransfers?.toString() || '0'} 
            icon={<ArrowRightLeft className="w-4 h-4 text-muted-foreground" />} 
            trend="-2 from yesterday" 
            trendUp={true} 
            loading={isLoadingSummary} 
            trendIcon={false}
          />
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="border-card-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Sales Revenue (7 Days)</CardTitle>
              <CardDescription>Daily revenue across all retail outlets</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={salesData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                    <XAxis dataKey="name" stroke="#ffffff50" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis 
                      stroke="#ffffff50" 
                      fontSize={12} 
                      tickLine={false} 
                      axisLine={false} 
                      tickFormatter={(value) => `₹${value/1000}k`}
                    />
                    <Tooltip 
                      cursor={{fill: 'rgba(255,255,255,0.05)'}}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                      formatter={(value: number) => [`₹${value.toLocaleString('en-IN')}`, 'Revenue']}
                    />
                    <Bar dataKey="total" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={50} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="border-card-border bg-card shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Production Output</CardTitle>
              <CardDescription>Weekly items produced</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={productionData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                    <XAxis dataKey="name" stroke="#ffffff50" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#ffffff50" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                    />
                    <Line type="monotone" dataKey="quantity" stroke="hsl(var(--chart-3))" strokeWidth={3} dot={{ r: 4, fill: "hsl(var(--chart-3))", strokeWidth: 0 }} activeDot={{ r: 6 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Bottom Row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2 border-card-border bg-card shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Recent Activity</CardTitle>
                  <CardDescription>Latest actions across the ERP</CardDescription>
                </div>
                <Button variant="outline" size="sm">View All</Button>
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingActivity ? (
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
                <div className="space-y-6">
                  {activity.slice(0, 6).map((item, i) => (
                    <div key={i} className="flex items-start gap-4">
                      <div className="h-10 w-10 rounded-full bg-secondary flex items-center justify-center border border-border shrink-0">
                        {item.type === 'sale' ? <CreditCard className="w-4 h-4 text-primary" /> :
                         item.type === 'production' ? <Factory className="w-4 h-4 text-chart-3" /> :
                         item.type === 'transfer' ? <ArrowRightLeft className="w-4 h-4 text-chart-2" /> :
                         <Activity className="w-4 h-4 text-muted-foreground" />}
                      </div>
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-medium leading-none">{item.description}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <User className="w-3 h-3" /> {item.user}
                          <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                          <Clock className="w-3 h-3" /> {item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Unknown'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-card-border bg-card shadow-sm flex flex-col">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg text-destructive flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5" /> Stock Alerts
                  </CardTitle>
                  <CardDescription>Items below minimum threshold</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto">
              {isLoadingAlerts ? (
                <div className="space-y-3">
                  {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 w-full rounded-md" />)}
                </div>
              ) : !alerts || alerts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground py-8">
                  <Package className="w-12 h-12 mb-2 opacity-20" />
                  <p>Stock levels optimal</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {alerts.map((alert, i) => (
                    <div key={i} className="p-3 rounded-md bg-destructive/5 border border-destructive/20 flex flex-col gap-1 relative overflow-hidden group">
                      <div className="absolute top-0 left-0 w-1 h-full bg-destructive" />
                      <div className="flex justify-between items-start pl-2">
                        <span className="font-medium text-sm text-foreground truncate pr-2">{alert.itemName}</span>
                        <Badge variant="destructive" className="h-5 text-[10px] leading-none px-1.5 shrink-0">
                          {alert.quantity} Left
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 pl-2">
                        <Building2 className="w-3 h-3" /> {alert.branchName} 
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

function KpiCard({ title, value, icon, trend, trendUp, loading, trendIcon = true }: any) {
  return (
    <Card className="border-card-border bg-card shadow-sm overflow-hidden relative group">
      <div className="absolute top-0 right-0 p-4 opacity-5 transform translate-x-2 -translate-y-2 group-hover:scale-110 group-hover:-rotate-12 transition-transform duration-500">
        {icon}
      </div>
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
        <p className={`text-xs mt-1 flex items-center gap-1 ${trendUp ? 'text-emerald-500' : 'text-destructive'}`}>
          {trendIcon && (trendUp ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />)}
          {trend}
        </p>
      </CardContent>
    </Card>
  );
}