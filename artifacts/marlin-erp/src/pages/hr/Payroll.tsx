import { useState } from 'react';
import { useListPayroll, useMarkPayrollPaid, getListPayrollQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Search, DollarSign, Download, Eye, CheckCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function Payroll() {
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [search, setSearch] = useState('');
  const [viewItem, setViewItem] = useState<any>(null);

  const { data: payroll = [], isLoading } = useListPayroll({ year: Number(year), month: Number(month) });
  const queryClient = useQueryClient();
  const markPaidMutation = useMarkPayrollPaid();

  const handleMarkPaid = (id: number, name: string) => {
    if (!confirm(`Mark payroll as paid for ${name}?`)) return;
    markPaidMutation.mutate({ id }, {
      onSuccess: () => { toast.success('Marked as paid'); queryClient.invalidateQueries({ queryKey: getListPayrollQueryKey() }); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
    });
  };

  const filtered = payroll.filter(p => p.employeeName?.toLowerCase().includes(search.toLowerCase()));
  const totalPaid = filtered.filter(p => p.isPaid).reduce((s, p) => s + Number(p.netPay || 0), 0);
  const totalPending = filtered.filter(p => !p.isPaid).reduce((s, p) => s + Number(p.netPay || 0), 0);

  const years = Array.from({ length: 5 }, (_, i) => String(now.getFullYear() - i));

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><DollarSign className="w-6 h-6 text-primary" /> Payroll</h1>
            <p className="text-muted-foreground mt-1">Monthly salary disbursement tracking</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => downloadCSV('payroll.csv', filtered.map(p => ({ Employee: p.employeeName, Month: `${MONTHS[Number(month)-1]} ${year}`, 'Basic Pay': p.basicPay, Allowances: p.allowances, Deductions: p.deductions, 'Net Pay': p.netPay, Paid: p.isPaid ? 'Yes' : 'No' })))}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
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
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Total</p>
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
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Basic Pay</TableHead>
                <TableHead className="text-right">Allowances</TableHead>
                <TableHead className="text-right">Deductions</TableHead>
                <TableHead className="text-right">Net Pay</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(4)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                  <DollarSign className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No payroll records for this period</p>
                </TableCell></TableRow>
              ) : filtered.map(p => (
                <TableRow key={p.id} className="hover:bg-muted/10">
                  <TableCell className="font-semibold">{p.employeeName}</TableCell>
                  <TableCell className="text-right font-mono text-sm">₹{Number(p.basicPay || 0).toLocaleString('en-IN')}</TableCell>
                  <TableCell className="text-right font-mono text-sm text-emerald-500">+₹{Number(p.allowances || 0).toLocaleString('en-IN')}</TableCell>
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
                      {!p.isPaid && (
                        <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-emerald-500" onClick={() => handleMarkPaid(p.id, p.employeeName || '')} title="Mark as Paid"><CheckCircle className="w-4 h-4" /></Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Sheet open={!!viewItem} onOpenChange={v => !v && setViewItem(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{viewItem?.employeeName}</SheetTitle>
            <SheetDescription>Payroll — {MONTHS[Number(month)-1]} {year}</SheetDescription>
          </SheetHeader>
          {viewItem && (
            <div className="mt-6 space-y-4">
              {[['Basic Pay', `₹${Number(viewItem.basicPay || 0).toLocaleString('en-IN')}`], ['Allowances', `+₹${Number(viewItem.allowances || 0).toLocaleString('en-IN')}`], ['Deductions', `-₹${Number(viewItem.deductions || 0).toLocaleString('en-IN')}`], ['Net Pay', `₹${Number(viewItem.netPay || 0).toLocaleString('en-IN')}`], ['Status', viewItem.isPaid ? 'Paid' : 'Pending'], ['Paid On', viewItem.paidAt ? new Date(viewItem.paidAt).toLocaleDateString('en-IN') : '—']].map(([k, v]) => (
                <div key={k} className="flex justify-between items-center border-b border-border pb-3">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                  <span className="font-semibold">{v}</span>
                </div>
              ))}
              {!viewItem.isPaid && (
                <Button className="w-full" onClick={() => { handleMarkPaid(viewItem.id, viewItem.employeeName || ''); setViewItem(null); }}>
                  <CheckCircle className="w-4 h-4 mr-2" /> Mark as Paid
                </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
