import { useState } from 'react';
import { useGetGstSummary } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Calculator, Download, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function GstSummary() {
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();
  
  const [fromDate, setFromDate] = useState(new Date(currentYear, currentMonth, 1).toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(new Date(currentYear, currentMonth + 1, 0).toISOString().split('T')[0]); // Last day of current month

  const { data: summary, isLoading } = useGetGstSummary({ fromDate, toDate });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Calculator className="w-6 h-6 text-primary" /> GST Summary
            </h1>
            <p className="text-muted-foreground mt-1">Tax liability and input tax credit overview</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 border border-input rounded-md px-2 py-1 bg-card shadow-sm">
              <Calendar className="w-4 h-4 text-muted-foreground" />
              <Input 
                type="date" 
                value={fromDate} 
                onChange={(e) => setFromDate(e.target.value)} 
                className="h-7 w-[130px] border-transparent p-0 bg-transparent focus-visible:ring-0 text-sm"
              />
              <span className="text-muted-foreground text-xs">to</span>
              <Input 
                type="date" 
                value={toDate} 
                onChange={(e) => setToDate(e.target.value)} 
                className="h-7 w-[130px] border-transparent p-0 bg-transparent focus-visible:ring-0 text-sm"
              />
            </div>
            <Button variant="outline" size="sm" className="h-9"><Download className="w-4 h-4 mr-2" /> Export</Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">Calculating GST data...</div>
        ) : summary ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-card border border-border p-4 rounded-md shadow-sm relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:scale-110 transition-transform"><Calculator className="w-12 h-12" /></div>
                <div className="text-sm font-medium text-muted-foreground mb-1">Total Sales</div>
                <div className="text-2xl font-bold font-mono">₹{summary.totalSales?.toLocaleString('en-IN') || 0}</div>
              </div>
              <div className="bg-card border border-border p-4 rounded-md shadow-sm relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:scale-110 transition-transform"><Calculator className="w-12 h-12" /></div>
                <div className="text-sm font-medium text-muted-foreground mb-1">Total Purchases</div>
                <div className="text-2xl font-bold font-mono">₹{summary.totalPurchases?.toLocaleString('en-IN') || 0}</div>
              </div>
              <div className="bg-card border border-border p-4 rounded-md shadow-sm relative overflow-hidden group border-l-4 border-l-destructive">
                <div className="text-sm font-medium text-muted-foreground mb-1">Output Tax (Collected)</div>
                <div className="text-2xl font-bold font-mono text-destructive">₹{summary.totalTaxCollected?.toLocaleString('en-IN') || 0}</div>
              </div>
              <div className="bg-card border border-border p-4 rounded-md shadow-sm relative overflow-hidden group border-l-4 border-l-emerald-500">
                <div className="text-sm font-medium text-muted-foreground mb-1">Input Tax Credit (Paid)</div>
                <div className="text-2xl font-bold font-mono text-emerald-500">₹{summary.totalTaxPaid?.toLocaleString('en-IN') || 0}</div>
              </div>
            </div>

            <div className="bg-card border border-border p-6 rounded-md shadow-sm flex flex-col md:flex-row items-center justify-between gap-6">
              <div>
                <h3 className="text-lg font-bold">Net GST Liability</h3>
                <p className="text-sm text-muted-foreground mt-1">Output Tax - Input Tax Credit for the selected period.</p>
              </div>
              <div className="text-right">
                <div className={`text-4xl font-black font-mono tracking-tighter ${(summary.netGstLiability || 0) > 0 ? 'text-primary' : 'text-emerald-500'}`}>
                  ₹{summary.netGstLiability?.toLocaleString('en-IN') || 0}
                </div>
                {(summary.netGstLiability || 0) <= 0 && <Badge className="mt-2 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 border-none">Net Credit Available</Badge>}
              </div>
            </div>

            <h3 className="text-lg font-bold mt-8 mb-4">Branch-wise Breakdown</h3>
            <div className="bg-card border border-border rounded-md shadow-sm">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Warehouse / Branch</TableHead>
                    <TableHead>GST Number</TableHead>
                    <TableHead className="text-right">Sales Tax Collected</TableHead>
                    <TableHead className="text-right">Purchase Tax Paid</TableHead>
                    <TableHead className="text-right">Net Liability</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!summary.byWarehouse || summary.byWarehouse.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No branch data available</TableCell></TableRow>
                  ) : (
                    summary.byWarehouse.map((branch, idx) => {
                      const net = (branch.salesTax || 0) - (branch.purchaseTax || 0);
                      return (
                        <TableRow key={branch.warehouseId || idx}>
                          <TableCell className="font-medium">{branch.warehouseName}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{branch.gstNumber || '-'}</TableCell>
                          <TableCell className="text-right font-mono text-destructive">₹{branch.salesTax?.toLocaleString('en-IN') || 0}</TableCell>
                          <TableCell className="text-right font-mono text-emerald-500">₹{branch.purchaseTax?.toLocaleString('en-IN') || 0}</TableCell>
                          <TableCell className="text-right font-mono font-bold">₹{net.toLocaleString('en-IN')}</TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-12 border border-dashed border-border rounded-md text-muted-foreground">
            <Calculator className="w-12 h-12 mb-4 opacity-20" />
            <p>Failed to load GST data. Please try adjusting the date range.</p>
          </div>
        )}
      </div>
    </AppLayout>
  );
}