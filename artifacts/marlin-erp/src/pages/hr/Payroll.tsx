import { useState } from 'react';
import {
  useListEnrichedPayroll, useGeneratePayroll, getEnrichedPayrollQueryKey,
  getListPayrollQueryKey,
} from '@workspace/api-client-react';
import { useMarkPayrollPaid } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Search, DollarSign, Download, Eye, CheckCircle, Zap, RefreshCw, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV, printHTML } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function Payroll() {
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [search, setSearch] = useState('');
  const [viewItem, setViewItem] = useState<any>(null);
  const [generating, setGenerating] = useState(false);

  const { data: payroll = [], isLoading } = useListEnrichedPayroll({ year: Number(year), month: Number(month) });
  const queryClient = useQueryClient();
  const markPaidMutation = useMarkPayrollPaid();
  const generateMutation = useGeneratePayroll();

  const handleMarkPaid = (id: number, name: string) => {
    if (!confirm(`Mark payroll as paid for ${name}?`)) return;
    markPaidMutation.mutate({ id }, {
      onSuccess: () => {
        toast.success('Marked as paid');
        queryClient.invalidateQueries({ queryKey: getEnrichedPayrollQueryKey({ year: Number(year), month: Number(month) }) });
        queryClient.invalidateQueries({ queryKey: getListPayrollQueryKey() });
        setViewItem(null);
      },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const handleGenerate = (forceRegenerate = false) => {
    setGenerating(true);
    generateMutation.mutate(
      { month: Number(month), year: Number(year), forceRegenerate },
      {
        onSuccess: (data) => {
          toast.success(`Generated payroll for ${data.length} employee(s)`);
          queryClient.invalidateQueries({ queryKey: getEnrichedPayrollQueryKey({ year: Number(year), month: Number(month) }) });
          queryClient.invalidateQueries({ queryKey: getListPayrollQueryKey() });
          setGenerating(false);
        },
        onError: (e: any) => { toast.error(e?.message || 'Failed to generate payroll'); setGenerating(false); },
      }
    );
  };

  // Escape user-supplied strings before interpolating into HTML to prevent XSS
  const esc = (s: string) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const handlePrintPayslip = (p: any) => {
    const monthLabel = `${MONTHS[p.month - 1]} ${p.year}`;
    const allowLines = (p.allowancesBreakdown || []).map((a: any) =>
      `<tr><td>${esc(a.name)}</td><td class="text-right green">₹${Number(a.amount).toFixed(2)}</td></tr>`).join('');
    const dedLines = (p.deductionsBreakdown || []).map((d: any) =>
      `<tr><td>${esc(d.name)}</td><td class="text-right red">₹${Number(d.amount).toFixed(2)}</td></tr>`).join('');
    printHTML(`
      <style>
        body{font-family:sans-serif;font-size:12px;color:#222}
        h2{margin:0 0 4px;font-size:18px} p{margin:2px 0;color:#555}
        table{width:100%;border-collapse:collapse;margin:8px 0}
        th,td{padding:5px 8px;border:1px solid #ddd;font-size:11px}
        th{background:#f5f5f5;font-weight:600}
        .text-right{text-align:right} .green{color:#16a34a} .red{color:#dc2626}
        .bold{font-weight:700} .total-row td{font-weight:700;border-top:2px solid #aaa}
        .section{font-weight:600;background:#f0f0f0;padding:4px 8px;margin:10px 0 4px;border-radius:4px}
      </style>
      <h2>Payslip — ${esc(monthLabel)}</h2>
      <table>
        <tr><td><b>Employee:</b> ${esc(p.employeeName)}</td><td><b>Branch:</b> ${esc(p.branchName)}</td></tr>
        <tr><td><b>Working Days:</b> ${p.workingDays}</td><td><b>Present Days:</b> ${p.presentDays}</td></tr>
        ${p.lopDays > 0 ? `<tr><td><b>LOP Days:</b> <span style="color:#dc2626">${p.lopDays}</span></td><td><b>LOP Deduction:</b> <span style="color:#dc2626">₹${Number(p.lopDeduction).toFixed(2)}</span></td></tr>` : ''}
      </table>
      <div class="section">Earnings</div>
      <table>
        <tr><th>Component</th><th class="text-right">Amount</th></tr>
        <tr><td>Basic Salary</td><td class="text-right">₹${Number(p.baseSalary).toFixed(2)}</td></tr>
        ${p.lopDays > 0 ? `<tr><td style="color:#dc2626">Less: LOP</td><td class="text-right red">-₹${Number(p.lopDeduction).toFixed(2)}</td></tr>` : ''}
        ${allowLines}
        <tr class="total-row"><td>Gross Pay</td><td class="text-right green">₹${Number(p.grossPay).toFixed(2)}</td></tr>
      </table>
      <div class="section">Deductions</div>
      <table>
        <tr><th>Component</th><th class="text-right">Amount</th></tr>
        ${dedLines || '<tr><td colspan="2">No deductions</td></tr>'}
        <tr class="total-row"><td>Total Deductions</td><td class="text-right red">₹${Number(p.deductions).toFixed(2)}</td></tr>
      </table>
      <table style="margin-top:8px;border:2px solid #333">
        <tr style="background:#e8f5e9"><td class="bold" style="font-size:14px">NET PAY</td><td class="text-right bold green" style="font-size:14px">₹${Number(p.netPay).toFixed(2)}</td></tr>
      </table>
      <p style="margin-top:12px;color:#777;font-size:10px">Status: ${p.isPaid ? 'PAID' : 'PENDING'} ${p.paidDate ? '| Paid on: ' + new Date(p.paidDate).toLocaleDateString('en-IN') : ''}</p>
    `, `Payslip-${esc(p.employeeName)}-${esc(monthLabel)}`);
  };

  const filtered = payroll.filter(p => p.employeeName?.toLowerCase().includes(search.toLowerCase()));
  const totalPaid = filtered.filter(p => p.isPaid).reduce((s, p) => s + Number(p.netPay || 0), 0);
  const totalPending = filtered.filter(p => !p.isPaid).reduce((s, p) => s + Number(p.netPay || 0), 0);
  const years = Array.from({ length: 5 }, (_, i) => String(now.getFullYear() - i));
  const monthLabel = `${MONTHS[Number(month)-1]} ${year}`;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><DollarSign className="w-6 h-6 text-primary" /> Payroll</h1>
            <p className="text-muted-foreground mt-1">Monthly salary computation with allowances, deductions & LOP</p>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            <Button variant="outline" size="sm" onClick={() => downloadCSV('payroll.csv', filtered.map(p => ({
              Employee: p.employeeName, Month: monthLabel,
              'Basic Salary': p.baseSalary, 'LOP Days': p.lopDays, 'LOP Deduction': p.lopDeduction,
              'Gross Pay': p.grossPay, Allowances: p.allowancesTotal, Deductions: p.deductions,
              'Net Pay': p.netPay, Paid: p.isPaid ? 'Yes' : 'No',
            })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
            {payroll.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => handleGenerate(true)} disabled={generating}>
                <RefreshCw className={`w-4 h-4 mr-2 ${generating ? 'animate-spin' : ''}`} /> Recalculate
              </Button>
            )}
            <Button size="sm" onClick={() => handleGenerate(false)} disabled={generating}>
              <Zap className="w-4 h-4 mr-2" /> {payroll.length === 0 ? 'Generate Payroll' : 'Run for New Employees'}
            </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Paid</p>
            <p className="text-2xl font-bold text-emerald-500 font-mono mt-1">₹{totalPaid.toLocaleString('en-IN')}</p>
            <p className="text-xs text-muted-foreground">{filtered.filter(p => p.isPaid).length} employees</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Pending</p>
            <p className="text-2xl font-bold text-amber-500 font-mono mt-1">₹{totalPending.toLocaleString('en-IN')}</p>
            <p className="text-xs text-muted-foreground">{filtered.filter(p => !p.isPaid).length} employees</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Payroll</p>
            <p className="text-2xl font-bold text-primary font-mono mt-1">₹{(totalPaid + totalPending).toLocaleString('en-IN')}</p>
            <p className="text-xs text-muted-foreground">{filtered.length} employees</p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[160px]">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search employee..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>{MONTHS.map((m, i) => <SelectItem key={i} value={String(i+1)}>{m}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>{years.map(y => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          {payroll.length === 0 && !isLoading ? (
            <div className="py-16 text-center space-y-4">
              <DollarSign className="w-12 h-12 mx-auto text-muted-foreground/30" />
              <p className="text-muted-foreground">No payroll for {monthLabel}</p>
              <Button onClick={() => handleGenerate(false)} disabled={generating}>
                <Zap className="w-4 h-4 mr-2" /> Generate Payroll for {monthLabel}
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Employee</TableHead>
                  <TableHead className="text-right">Basic</TableHead>
                  <TableHead className="text-center text-xs">LOP</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right text-emerald-600">Allowances</TableHead>
                  <TableHead className="text-right text-red-500">Deductions</TableHead>
                  <TableHead className="text-right font-bold">Net Pay</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? [...Array(4)].map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                )) : filtered.map(p => (
                  <TableRow key={p.id} className="hover:bg-muted/10">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-7 w-7"><AvatarFallback className="bg-primary/10 text-primary text-xs font-bold">{p.employeeName?.charAt(0)}</AvatarFallback></Avatar>
                        <div>
                          <div className="font-semibold text-sm">{p.employeeName}</div>
                          <div className="text-xs text-muted-foreground">{p.branchName}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">₹{Number(p.baseSalary || 0).toLocaleString('en-IN')}</TableCell>
                    <TableCell className="text-center">
                      {p.lopDays > 0
                        ? <Badge variant="outline" className="text-red-500 border-red-500/30 text-xs">{p.lopDays}d</Badge>
                        : <span className="text-muted-foreground text-xs">—</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">₹{Number(p.grossPay || 0).toLocaleString('en-IN')}</TableCell>
                    <TableCell className="text-right font-mono text-sm text-emerald-500">+₹{Number(p.allowancesTotal || 0).toLocaleString('en-IN')}</TableCell>
                    <TableCell className="text-right font-mono text-sm text-red-500">-₹{Number(p.deductions || 0).toLocaleString('en-IN')}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-primary">₹{Number(p.netPay || 0).toLocaleString('en-IN')}</TableCell>
                    <TableCell>
                      <Badge variant={p.isPaid ? 'default' : 'outline'} className={p.isPaid ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'text-amber-500 border-amber-500/30'}>
                        {p.isPaid ? 'Paid' : 'Pending'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => setViewItem(p)}><Eye className="w-4 h-4" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-primary" onClick={() => handlePrintPayslip(p)} title="Print payslip"><Printer className="w-4 h-4" /></Button>
                        {!p.isPaid && (
                          <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-500" onClick={() => handleMarkPaid(p.id, p.employeeName || '')} title="Mark as Paid"><CheckCircle className="w-4 h-4" /></Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* Payslip Detail Sheet */}
      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-3">
              <Avatar className="h-9 w-9"><AvatarFallback className="bg-primary/10 text-primary font-bold">{viewItem?.employeeName?.charAt(0)}</AvatarFallback></Avatar>
              {viewItem?.employeeName}
            </SheetTitle>
            <SheetDescription>{monthLabel} · {viewItem?.branchName}</SheetDescription>
          </SheetHeader>

          {viewItem && (
            <div className="mt-6 space-y-5">
              {/* Attendance summary */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-muted/20 rounded-lg p-2">
                  <p className="text-xs text-muted-foreground">Working Days</p>
                  <p className="font-bold text-lg">{viewItem.workingDays}</p>
                </div>
                <div className="bg-muted/20 rounded-lg p-2">
                  <p className="text-xs text-muted-foreground">Present</p>
                  <p className="font-bold text-lg text-emerald-500">{viewItem.presentDays}</p>
                </div>
                <div className="bg-muted/20 rounded-lg p-2">
                  <p className="text-xs text-muted-foreground">LOP Days</p>
                  <p className={`font-bold text-lg ${viewItem.lopDays > 0 ? 'text-red-500' : 'text-muted-foreground'}`}>{viewItem.lopDays}</p>
                </div>
              </div>

              {/* Earnings */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Earnings</p>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span>Basic Salary</span>
                    <span className="font-mono">₹{Number(viewItem.baseSalary).toLocaleString('en-IN')}</span>
                  </div>
                  {viewItem.lopDays > 0 && (
                    <div className="flex justify-between text-red-500">
                      <span>Less: LOP ({viewItem.lopDays} days)</span>
                      <span className="font-mono">-₹{Number(viewItem.lopDeduction).toFixed(2)}</span>
                    </div>
                  )}
                  {(viewItem.allowancesBreakdown || []).map((a: any, i: number) => (
                    <div key={i} className="flex justify-between text-emerald-600">
                      <span>{a.name}</span>
                      <span className="font-mono">+₹{Number(a.amount).toFixed(2)}</span>
                    </div>
                  ))}
                  <Separator className="my-1" />
                  <div className="flex justify-between font-semibold">
                    <span>Gross Pay</span>
                    <span className="font-mono">₹{Number(viewItem.grossPay).toLocaleString('en-IN')}</span>
                  </div>
                </div>
              </div>

              {/* Deductions */}
              {(viewItem.deductionsBreakdown || []).length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Deductions</p>
                  <div className="space-y-1 text-sm">
                    {(viewItem.deductionsBreakdown || []).map((d: any, i: number) => (
                      <div key={i} className="flex justify-between text-red-500">
                        <span>{d.name}</span>
                        <span className="font-mono">-₹{Number(d.amount).toFixed(2)}</span>
                      </div>
                    ))}
                    <Separator className="my-1" />
                    <div className="flex justify-between font-semibold text-red-500">
                      <span>Total Deductions</span>
                      <span className="font-mono">-₹{Number(viewItem.deductions).toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Net Pay */}
              <div className="p-4 bg-primary/5 rounded-xl border border-primary/20">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-base">Net Pay</span>
                  <span className="font-mono font-bold text-xl text-primary">₹{Number(viewItem.netPay).toLocaleString('en-IN')}</span>
                </div>
                <div className="flex justify-between items-center mt-1">
                  <Badge variant={viewItem.isPaid ? 'default' : 'outline'} className={viewItem.isPaid ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20 mt-1' : 'text-amber-500 border-amber-500/30 mt-1'}>
                    {viewItem.isPaid ? `Paid${viewItem.paidDate ? ' · ' + new Date(viewItem.paidDate).toLocaleDateString('en-IN') : ''}` : 'Pending'}
                  </Badge>
                </div>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => handlePrintPayslip(viewItem)}>
                  <Printer className="w-4 h-4 mr-2" /> Print Payslip
                </Button>
                {!viewItem.isPaid && (
                  <Button className="flex-1" onClick={() => handleMarkPaid(viewItem.id, viewItem.employeeName || '')}>
                    <CheckCircle className="w-4 h-4 mr-2" /> Mark Paid
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
