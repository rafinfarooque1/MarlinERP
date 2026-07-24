import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { customFetch, useListSales } from '@workspace/api-client-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FileText, Search, Download, Calendar, Warehouse, Store, Factory } from 'lucide-react';
import { downloadCSV } from '@/lib/download';

const fmt = (n: number) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

function LocationBadge({ type }: { type: string }) {
  if (type === 'warehouse') return (
    <Badge variant="outline" className="text-[10px] capitalize gap-1 border-blue-500/40 text-blue-600">
      <Warehouse className="w-2.5 h-2.5" /> Warehouse
    </Badge>
  );
  if (type === 'outlet') return (
    <Badge variant="outline" className="text-[10px] capitalize gap-1 border-emerald-500/40 text-emerald-600">
      <Store className="w-2.5 h-2.5" /> Outlet
    </Badge>
  );
  return (
    <Badge variant="outline" className="text-[10px] capitalize gap-1 border-orange-500/40 text-orange-600">
      <Factory className="w-2.5 h-2.5" /> Production
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    paid: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    partially_paid: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    unpaid: 'bg-red-500/10 text-red-600 border-red-500/20',
  };
  return (
    <Badge className={`text-[10px] capitalize ${map[status] ?? 'bg-muted/20 text-muted-foreground'}`}>
      {status?.replace('_', ' ')}
    </Badge>
  );
}

// ── Sales Tab ─────────────────────────────────────────────────────────────────
function SalesReport() {
  const [search, setSearch] = useState('');
  const { data: allSales = [], isLoading } = useListSales();

  const sales = (allSales as any[]).filter(s =>
    !search ||
    (s.invoiceNumber ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (s.outletName ?? s.locationName ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (s.customerName ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const total = sales.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);
  const paid  = sales.reduce((s, r) => s + Number(r.amountPaid ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-1 max-w-sm bg-muted/20 border border-border rounded-lg px-3 py-1.5">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input placeholder="Search invoice, location, customer…" value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 h-7" />
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadCSV('sales-report.csv', sales.map(s => ({
          Invoice: s.invoiceNumber ?? '',
          Date: s.saleDate,
          'Location Type': s.locationType ?? 'outlet',
          Location: s.outletName ?? s.locationName ?? '',
          Customer: s.customerName ?? 'Walk-in',
          'Total (₹)': Number(s.totalAmount ?? 0).toFixed(2),
          'Paid (₹)': Number(s.amountPaid ?? 0).toFixed(2),
          'Balance (₹)': (Number(s.totalAmount ?? 0) - Number(s.amountPaid ?? 0)).toFixed(2),
          Status: s.paymentStatus ?? '',
        })))} disabled={isLoading}>
          <Download className="w-4 h-4 mr-2" /> Export CSV
        </Button>
      </div>

      {/* Summary strip */}
      {sales.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-card border border-border rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">Total Billed</p>
            <p className="font-bold font-mono">{fmt(total)}</p>
          </div>
          <div className="bg-card border border-border rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">Collected</p>
            <p className="font-bold font-mono text-emerald-600">{fmt(paid)}</p>
          </div>
          <div className="bg-card border border-border rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">Outstanding</p>
            <p className="font-bold font-mono text-red-500">{fmt(total - paid)}</p>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead>Invoice</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? [...Array(5)].map((_, i) => (
              <TableRow key={i}><TableCell colSpan={8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
            )) : sales.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center py-16 text-muted-foreground">No sales found</TableCell></TableRow>
            ) : sales.map((s: any) => (
              <TableRow key={s.id} className="hover:bg-muted/10">
                <TableCell className="font-mono text-xs text-primary font-bold">{s.invoiceNumber ?? `#${s.id}`}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{s.saleDate ? new Date(s.saleDate).toLocaleDateString('en-IN') : '—'}</div>
                </TableCell>
                <TableCell className="text-sm font-medium">{s.outletName ?? s.locationName ?? '—'}</TableCell>
                <TableCell><LocationBadge type={s.locationType ?? 'outlet'} /></TableCell>
                <TableCell className="text-sm text-muted-foreground">{s.customerName ?? <span className="italic text-muted-foreground/60">Walk-in</span>}</TableCell>
                <TableCell className="text-right font-mono font-bold">{fmt(Number(s.totalAmount ?? 0))}</TableCell>
                <TableCell className="text-right font-mono text-emerald-600">{fmt(Number(s.amountPaid ?? 0))}</TableCell>
                <TableCell><StatusBadge status={s.paymentStatus ?? 'unpaid'} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {sales.length > 0 && (
          <div className="p-3 border-t border-border text-xs text-muted-foreground">{sales.length} record{sales.length !== 1 ? 's' : ''}</div>
        )}
      </div>
    </div>
  );
}

// ── Purchases Tab ─────────────────────────────────────────────────────────────
function PurchasesReport() {
  const [search, setSearch] = useState('');
  const { data: purchases = [], isLoading } = useQuery<any[]>({
    queryKey: ['purchases'],
    queryFn: () => customFetch('/api/purchases'),
  });

  const filtered = (purchases as any[]).filter(p =>
    !search ||
    (p.invoiceNumber ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (p.vendorName ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (p.poNumber ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const total = filtered.reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-1 max-w-sm bg-muted/20 border border-border rounded-lg px-3 py-1.5">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input placeholder="Search invoice, vendor…" value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 h-7" />
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadCSV('purchases-report.csv', filtered.map(p => ({
          Invoice: p.invoiceNumber ?? '',
          Date: p.purchaseDate,
          Vendor: p.vendorName ?? '',
          Location: 'Production',
          'Total (₹)': Number(p.totalAmount ?? 0).toFixed(2),
          'Tax (₹)': Number(p.taxTotal ?? 0).toFixed(2),
        })))} disabled={isLoading}>
          <Download className="w-4 h-4 mr-2" /> Export CSV
        </Button>
      </div>

      {filtered.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-3 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{filtered.length} purchase{filtered.length !== 1 ? 's' : ''}</span>
          <span className="font-bold font-mono">{fmt(total)}</span>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead>Invoice / Ref</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? [...Array(5)].map((_, i) => (
              <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
            )) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">No purchases found</TableCell></TableRow>
            ) : filtered.map((p: any) => (
              <TableRow key={p.id} className="hover:bg-muted/10">
                <TableCell className="font-mono text-xs text-primary font-bold">{p.invoiceNumber ?? `#${p.id}`}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{p.purchaseDate ? new Date(p.purchaseDate).toLocaleDateString('en-IN') : '—'}</div>
                </TableCell>
                <TableCell className="text-sm font-medium">{p.vendorName ?? '—'}</TableCell>
                <TableCell><LocationBadge type="production" /></TableCell>
                <TableCell className="text-right font-mono text-amber-600">{fmt(Number(p.taxTotal ?? 0))}</TableCell>
                <TableCell className="text-right font-mono font-bold">{fmt(Number(p.totalAmount ?? 0))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {filtered.length > 0 && (
          <div className="p-3 border-t border-border text-xs text-muted-foreground">{filtered.length} record{filtered.length !== 1 ? 's' : ''}</div>
        )}
      </div>
    </div>
  );
}

// ── Expenses Tab ──────────────────────────────────────────────────────────────
function ExpensesReport() {
  const [search, setSearch] = useState('');
  const { data: allExpenses = [], isLoading } = useQuery<any[]>({
    queryKey: ['location-expenses-all'],
    queryFn: () => customFetch('/api/accounts/location-expenses/all'),
  });

  const filtered = (allExpenses as any[]).filter(e =>
    !search ||
    (e.description ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (e.locationName ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (e.expenseLedgerName ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (e.voucherNumber ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const total = filtered.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-1 max-w-sm bg-muted/20 border border-border rounded-lg px-3 py-1.5">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <Input placeholder="Search description, location, category…" value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0 h-7" />
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadCSV('expenses-report.csv', filtered.map(e => ({
          Voucher: e.voucherNumber ?? '',
          Date: e.expenseDate,
          Location: e.locationName ?? '',
          'Location Type': e.locationType ?? '',
          Category: e.expenseLedgerName ?? '',
          Description: e.description ?? '',
          'Amount (₹)': Number(e.amount ?? 0).toFixed(2),
        })))} disabled={isLoading}>
          <Download className="w-4 h-4 mr-2" /> Export CSV
        </Button>
      </div>

      {filtered.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-3 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{filtered.length} expense{filtered.length !== 1 ? 's' : ''}</span>
          <span className="font-bold font-mono text-red-500">{fmt(total)}</span>
        </div>
      )}

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead>Voucher</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? [...Array(5)].map((_, i) => (
              <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
            )) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">No expenses found</TableCell></TableRow>
            ) : filtered.map((e: any) => (
              <TableRow key={e.id} className="hover:bg-muted/10">
                <TableCell className="font-mono text-xs text-primary font-bold">{e.voucherNumber ?? `#${e.id}`}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <div className="flex items-center gap-1"><Calendar className="w-3 h-3" />{e.expenseDate ? new Date(e.expenseDate).toLocaleDateString('en-IN') : '—'}</div>
                </TableCell>
                <TableCell className="text-sm font-medium">{e.locationName ?? '—'}</TableCell>
                <TableCell><LocationBadge type={e.locationType ?? 'outlet'} /></TableCell>
                <TableCell className="text-sm text-muted-foreground">{e.expenseLedgerName ?? '—'}</TableCell>
                <TableCell className="text-sm max-w-xs truncate">{e.description}</TableCell>
                <TableCell className="text-right font-mono font-bold text-red-500">{fmt(Number(e.amount ?? 0))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {filtered.length > 0 && (
          <div className="p-3 border-t border-border text-xs text-muted-foreground">{filtered.length} record{filtered.length !== 1 ? 's' : ''}</div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Reports() {
  const [tab, setTab] = useState('sales');

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="w-6 h-6 text-primary" />
            Reports
          </h1>
          <p className="text-muted-foreground mt-1">All sales, purchases and expenses with location breakdown</p>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-9">
            <TabsTrigger value="sales" className="text-sm px-4">All Sales</TabsTrigger>
            <TabsTrigger value="purchases" className="text-sm px-4">All Purchases</TabsTrigger>
            <TabsTrigger value="expenses" className="text-sm px-4">All Expenses</TabsTrigger>
          </TabsList>

          <TabsContent value="sales"     className="mt-4"><SalesReport /></TabsContent>
          <TabsContent value="purchases" className="mt-4"><PurchasesReport /></TabsContent>
          <TabsContent value="expenses"  className="mt-4"><ExpensesReport /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
