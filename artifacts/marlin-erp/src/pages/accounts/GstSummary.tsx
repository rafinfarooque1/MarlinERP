import { useState } from 'react';
import { useGetGstSummary } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Receipt, Download, TrendingUp, TrendingDown } from 'lucide-react';
import { downloadCSV } from '@/lib/download';

export default function GstSummary() {
  const now = new Date();
  const [fromDate, setFromDate] = useState(`${now.getFullYear()}-04-01`);
  const [toDate, setToDate] = useState(now.toISOString().split('T')[0]);

  const { data: gst, isLoading } = useGetGstSummary({ fromDate, toDate });

  const salesData = gst?.salesByRate || [];
  const purchasesData = gst?.purchasesByRate || [];

  const totalOutputTax = salesData.reduce((s: number, r: any) => s + Number(r.taxAmount || 0), 0);
  const totalInputTax = purchasesData.reduce((s: number, r: any) => s + Number(r.taxAmount || 0), 0);
  const netGst = totalOutputTax - totalInputTax;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Receipt className="w-6 h-6 text-primary" /> GST Summary</h1>
            <p className="text-muted-foreground mt-1">Input / Output tax and net GST liability</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => {
            const rows = [...salesData.map((r: any) => ({ Type: 'Output (Sales)', 'Tax Rate': `${r.taxRate}%`, 'Taxable Value': r.taxableValue, 'Tax Amount': r.taxAmount })),
              ...purchasesData.map((r: any) => ({ Type: 'Input (Purchases)', 'Tax Rate': `${r.taxRate}%`, 'Taxable Value': r.taxableValue, 'Tax Amount': r.taxAmount }))];
            downloadCSV('gst-summary.csv', rows);
          }}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
        </div>

        {/* Date Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-muted-foreground">Period:</span>
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-emerald-500" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Output Tax (Sales)</p>
            </div>
            <p className="text-2xl font-bold text-emerald-500 font-mono">₹{totalOutputTax.toLocaleString('en-IN')}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="w-4 h-4 text-primary" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Input Tax (Purchases)</p>
            </div>
            <p className="text-2xl font-bold text-primary font-mono">₹{totalInputTax.toLocaleString('en-IN')}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <Receipt className="w-4 h-4 text-amber-500" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Net GST Payable</p>
            </div>
            <p className={`text-2xl font-bold font-mono ${netGst > 0 ? 'text-red-500' : 'text-emerald-500'}`}>₹{Math.abs(netGst).toLocaleString('en-IN')} {netGst < 0 ? '(refund)' : ''}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20">
              <h3 className="font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-500" /> Output Tax (Sales)</h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Tax Rate</TableHead>
                  <TableHead className="text-right">Taxable Value</TableHead>
                  <TableHead className="text-right">Tax Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? <TableRow><TableCell colSpan={3}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                  : salesData.length === 0 ? <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">No sales data</TableCell></TableRow>
                  : salesData.map((r: any) => (
                    <TableRow key={r.taxRate} className="hover:bg-muted/10">
                      <TableCell className="font-bold text-primary">{r.taxRate}%</TableCell>
                      <TableCell className="text-right font-mono">₹{Number(r.taxableValue).toLocaleString('en-IN')}</TableCell>
                      <TableCell className="text-right font-mono font-bold text-emerald-500">₹{Number(r.taxAmount).toLocaleString('en-IN')}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>

          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20">
              <h3 className="font-semibold flex items-center gap-2"><TrendingDown className="w-4 h-4 text-primary" /> Input Tax (Purchases)</h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Tax Rate</TableHead>
                  <TableHead className="text-right">Taxable Value</TableHead>
                  <TableHead className="text-right">Tax Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? <TableRow><TableCell colSpan={3}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                  : purchasesData.length === 0 ? <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">No purchase data</TableCell></TableRow>
                  : purchasesData.map((r: any) => (
                    <TableRow key={r.taxRate} className="hover:bg-muted/10">
                      <TableCell className="font-bold text-primary">{r.taxRate}%</TableCell>
                      <TableCell className="text-right font-mono">₹{Number(r.taxableValue).toLocaleString('en-IN')}</TableCell>
                      <TableCell className="text-right font-mono font-bold text-primary">₹{Number(r.taxAmount).toLocaleString('en-IN')}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
