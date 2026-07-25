import { useState } from 'react';
import { useGetGstSummary } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Receipt, Download, TrendingUp, TrendingDown, Info } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export default function GstSummary() {
  const now = new Date();
  const [fromDate, setFromDate] = useState(`${now.getFullYear()}-04-01`);
  const [toDate, setToDate] = useState(now.toISOString().split('T')[0]);

  const { data: gst, isLoading } = useGetGstSummary({ fromDate, toDate });

  const salesData: any[] = (gst as any)?.salesByRate || [];
  const purchasesData: any[] = (gst as any)?.purchasesByRate || [];
  const monthWise: any[] = (gst as any)?.monthWise || [];

  const totalOutputTax = salesData.reduce((s: number, r: any) => s + Number(r.taxAmount || 0), 0);
  const totalInputTax = purchasesData.reduce((s: number, r: any) => s + Number(r.taxAmount || 0), 0);
  const netGst = totalOutputTax - totalInputTax;

  const fmt = (n: number) => `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Receipt className="w-6 h-6 text-primary" /> GST Summary</h1>
            <p className="text-muted-foreground mt-1">Output tax liability vs input tax credit, broken down by rate slab</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => {
            const rows = [
              ...salesData.map((r: any) => ({ Type: 'Output (Sales)', 'Tax Rate': `${r.taxRate}%`, 'Taxable Value': r.taxableValue, 'CGST': r.cgst, 'SGST': r.sgst, 'IGST': r.igst, 'Tax Amount': r.taxAmount })),
              ...purchasesData.map((r: any) => ({ Type: 'Input (Purchases)', 'Tax Rate': `${r.taxRate}%`, 'Taxable Value': r.taxableValue, 'CGST': r.cgst, 'SGST': r.sgst, 'IGST': r.igst, 'Tax Amount': r.taxAmount })),
            ];
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
            <p className="text-2xl font-bold text-emerald-500 font-mono">{fmt(totalOutputTax)}</p>
            <p className="text-xs text-muted-foreground mt-1">Tax collected from customers</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="w-4 h-4 text-primary" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Input Tax Credit (Purchases)</p>
            </div>
            <p className="text-2xl font-bold text-primary font-mono">{fmt(totalInputTax)}</p>
            <p className="text-xs text-muted-foreground mt-1">Tax paid to suppliers</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <Receipt className="w-4 h-4 text-amber-500" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Net GST Payable</p>
            </div>
            <p className={`text-2xl font-bold font-mono ${netGst > 0 ? 'text-red-500' : 'text-emerald-500'}`}>
              {fmt(netGst)}{netGst < 0 ? ' (credit)' : ''}
            </p>
            <p className="text-xs text-muted-foreground mt-1">Output − Input credit</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Output Tax Table */}
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20">
              <h3 className="font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-500" /> Output Tax (Sales)</h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Rate</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">CGST</TableHead>
                  <TableHead className="text-right">SGST</TableHead>
                  <TableHead className="text-right">IGST</TableHead>
                  <TableHead className="text-right">Total Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                ) : salesData.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                    No taxable sales in this period
                  </TableCell></TableRow>
                ) : salesData.map((r: any) => (
                  <TableRow key={r.taxRate} className="hover:bg-muted/10">
                    <TableCell><Badge variant="secondary">{r.taxRate}%</Badge></TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.taxableValue))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.cgst))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.sgst))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.igst))}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-emerald-500">{fmt(Number(r.taxAmount))}</TableCell>
                  </TableRow>
                ))}
                {salesData.length > 1 && (
                  <TableRow className="bg-muted/10 font-bold border-t-2">
                    <TableCell className="text-xs uppercase tracking-wider">Total</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(salesData.reduce((s: number, r: any) => s + Number(r.taxableValue), 0))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(salesData.reduce((s: number, r: any) => s + Number(r.cgst), 0))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(salesData.reduce((s: number, r: any) => s + Number(r.sgst), 0))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(salesData.reduce((s: number, r: any) => s + Number(r.igst), 0))}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-emerald-500">{fmt(totalOutputTax)}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Input Tax Table */}
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20">
              <h3 className="font-semibold flex items-center gap-2">
                <TrendingDown className="w-4 h-4 text-primary" /> Input Tax Credit (Purchases)
              </h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Rate</TableHead>
                  <TableHead className="text-right">Purchase Value</TableHead>
                  <TableHead className="text-right">CGST</TableHead>
                  <TableHead className="text-right">SGST</TableHead>
                  <TableHead className="text-right">IGST</TableHead>
                  <TableHead className="text-right">Total Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                ) : purchasesData.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                    No purchase data in this period
                  </TableCell></TableRow>
                ) : purchasesData.map((r: any, i: number) => (
                  <TableRow key={i} className="hover:bg-muted/10">
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary">{r.taxRate}%</Badge>
                        {r.estimated && (
                          <Tooltip>
                            <TooltipTrigger><Info className="w-3 h-3 text-amber-500" /></TooltipTrigger>
                            <TooltipContent>Estimated at {r.taxRate}% of purchase value (per-line GST not tracked on purchases)</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.taxableValue))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.cgst))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.sgst))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.igst ?? 0))}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-primary">{fmt(Number(r.taxAmount))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Month-wise Breakdown */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-muted/20">
            <h3 className="font-semibold flex items-center gap-2"><Receipt className="w-4 h-4 text-primary" /> Month-wise Breakdown</h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Output Taxable</TableHead>
                <TableHead className="text-right">Output Tax</TableHead>
                <TableHead className="text-right">Input Taxable</TableHead>
                <TableHead className="text-right">Input Tax</TableHead>
                <TableHead className="text-right">Net GST</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              ) : monthWise.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                  No activity in this period
                </TableCell></TableRow>
              ) : monthWise.map((m: any) => (
                <TableRow key={m.month} className="hover:bg-muted/10">
                  <TableCell className="text-sm font-medium">
                    {new Date(`${m.month}-01T00:00:00`).toLocaleString('en-IN', { month: 'short', year: 'numeric' })}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmt(Number(m.outputTaxable))}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-emerald-500">{fmt(Number(m.outputTax))}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmt(Number(m.inputTaxable))}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-primary">{fmt(Number(m.inputTax))}</TableCell>
                  <TableCell className={`text-right font-mono text-xs font-bold ${Number(m.netGst) > 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                    {fmt(Number(m.netGst))}{Number(m.netGst) < 0 ? ' (credit)' : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}
