import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { COLLECTION_METHODS, paymentModeLabel } from '@/lib/paymentModes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  useListSales, useListOutlets,
  useGetSalePayments, useCreateSalePayment,
  getListSalesQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { IndianRupee, Search, AlertTriangle, Banknote, Receipt } from 'lucide-react';

function fmt(n: number) {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function PaymentStatusBadge({ status }: { status: string }) {
  if (status === 'paid') return <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Paid</Badge>;
  if (status === 'partially_paid') return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20">Partial</Badge>;
  return <Badge className="bg-red-500/10 text-red-600 border-red-500/20">Unpaid</Badge>;
}

// ── Collect Payment Panel ─────────────────────────────────────────────────────

function CollectPaymentPanel({ sale, onClose, onDone }: { sale: any; onClose: () => void; onDone: (newStatus: string, newPaid: number) => void }) {
  const perm = usePermission('page:/accounts/vouchers');
  const { data: payments = [], isLoading } = useGetSalePayments(sale.id);
  const createPaymentMutation = useCreateSalePayment();

  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState(String(Number(sale.balanceDue ?? 0)));
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [showForm, setShowForm] = useState(Number(sale.balanceDue ?? 0) > 0);

  const totalAmount = Number(sale.totalAmount);
  const amountPaid = Number(sale.amountPaid ?? 0);
  const balanceDue = Math.max(0, totalAmount - amountPaid);

  async function handleSubmit() {
    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) { toast.error('Enter a valid amount'); return; }
    try {
      const result: any = await createPaymentMutation.mutateAsync({
        saleId: sale.id,
        data: { method, amount: parsedAmount, referenceNumber: ref || undefined, paymentDate: date },
      });
      toast.success(`Payment of ${fmt(parsedAmount)} collected`);
      onDone(result.newPaymentStatus, result.newAmountPaid);
      setAmount(''); setRef('');
      setShowForm(false);
    } catch (e: any) {
      toast.error(e?.data?.error || e?.message || 'Failed to collect payment');
    }
  }

  return (
    <div className="space-y-5">
      {/* Sale summary */}
      <div className="rounded-lg border border-border p-3 text-sm space-y-1.5">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Invoice</span>
          <span className="font-mono font-semibold">{sale.invoiceNumber}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Customer</span>
          <span>{sale.customerName || 'Walk-in'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Total Amount</span>
          <span className="font-mono font-semibold">{fmt(totalAmount)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Paid</span>
          <span className="font-mono text-emerald-600">{fmt(amountPaid)}</span>
        </div>
        <Separator />
        <div className="flex justify-between font-semibold text-red-600">
          <span>Balance Due</span>
          <span className="font-mono">{fmt(balanceDue)}</span>
        </div>
      </div>

      {/* Payment history */}
      {isLoading ? (
        <div className="text-center text-sm text-muted-foreground py-4">Loading…</div>
      ) : payments.length > 0 ? (
        <div>
          <p className="text-sm font-semibold mb-2">Payment History</p>
          <div className="space-y-1.5">
            {payments.map((p: any) => (
              <div key={p.id} className="flex justify-between items-center text-xs bg-muted/30 rounded px-3 py-2 border border-border">
                <div className="space-y-0.5">
                  <p className="font-medium">{paymentModeLabel(p.method)}</p>
                  <p className="text-muted-foreground">{p.paymentDate}
                    {p.referenceNumber && <span className="font-mono ml-2">#{p.referenceNumber}</span>}
                  </p>
                  {p.reconciliationStatus === 'pending' && (
                    <p className="text-amber-600 text-[10px]">Pending reconciliation</p>
                  )}
                  {p.reconciliationStatus === 'reconciled' && (
                    <p className="text-emerald-600 text-[10px]">Reconciled {p.batchReference && `— ${p.batchReference}`}</p>
                  )}
                </div>
                <span className="font-mono font-bold">{fmt(Number(p.amount))}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-center text-sm text-muted-foreground py-4 rounded-lg border border-dashed border-border">
          No payments recorded yet
        </div>
      )}

      {/* Collect Payment Form */}
      {balanceDue > 0 && perm.canAdd && (
        <div>
          <p className="text-sm font-semibold mb-3">Collect Payment</p>
          <div className="space-y-3 bg-muted/20 rounded-lg p-3 border border-border">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Method</p>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COLLECTION_METHODS.map(m => (
                      <SelectItem key={m} value={m}>{paymentModeLabel(m)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Amount (₹)</p>
                <Input type="number" min={0.01} step={0.01} value={amount} onChange={e => setAmount(e.target.value)} className="h-8 text-sm font-mono" />
              </div>
            </div>
            {method !== 'cash' && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Reference / UTR (optional)</p>
                <Input value={ref} onChange={e => setRef(e.target.value)} className="h-8 text-sm font-mono" placeholder="e.g. UTR123456" />
              </div>
            )}
            <div>
              <p className="text-xs text-muted-foreground mb-1">Payment Date</p>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="h-8 text-sm" />
            </div>
            {method !== 'cash' && (
              <div className="text-xs text-amber-600 bg-amber-500/5 border border-amber-500/15 rounded px-2.5 py-1.5">
                This payment will appear in Reconciliation until matched to a bank settlement.
              </div>
            )}
            <Button className="w-full h-8 text-sm" onClick={handleSubmit} disabled={createPaymentMutation.isPending}>
              {createPaymentMutation.isPending ? 'Processing…' : `Collect ${fmt(Math.max(0, Number(amount) || 0))}`}
            </Button>
          </div>
        </div>
      )}

      {sale.paymentStatus === 'paid' && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-600 font-medium text-center">
          ✓ This invoice is fully paid
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Payments() {
  const perm = usePermission('page:/accounts/vouchers');
  const qc = useQueryClient();

  const [outletFilter, setOutletFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');

  const { data: outlets = [] } = useListOutlets();
  const { data: sales = [], isLoading } = useListSales(
    outletFilter !== 'all' ? { outletId: Number(outletFilter) } : undefined
  );

  const [selectedSale, setSelectedSale] = useState<any>(null);

  const filtered = (sales as any[])
    .filter(s => {
      const matchStatus = statusFilter === 'all' || (s.paymentStatus ?? 'paid') === statusFilter;
      const matchSearch = !search
        || s.invoiceNumber?.toLowerCase().includes(search.toLowerCase())
        || s.customerName?.toLowerCase().includes(search.toLowerCase());
      return matchStatus && matchSearch;
    })
    .sort((a, b) => {
      // Unpaid first, then partial, then paid
      const order: Record<string, number> = { unpaid: 0, partially_paid: 1, paid: 2 };
      return (order[a.paymentStatus ?? 'paid'] ?? 2) - (order[b.paymentStatus ?? 'paid'] ?? 2);
    });

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Payments.</p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <IndianRupee className="w-6 h-6 text-primary" /> Payments
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">Collect outstanding payments on sales invoices</p>
          </div>
        </div>

        {/* Summary chips */}
        <div className="flex flex-wrap gap-2">
          {(['all', 'unpaid', 'partially_paid', 'paid'] as const).map(s => {
            const count = s === 'all' ? sales.length : (sales as any[]).filter(x => (x.paymentStatus ?? 'paid') === s).length;
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 rounded-full text-sm font-medium border transition-colors ${
                  statusFilter === s
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:border-primary/40'
                }`}
              >
                {s === 'all' ? 'All' : s === 'partially_paid' ? 'Partial' : s.charAt(0).toUpperCase() + s.slice(1)} ({count})
              </button>
            );
          })}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-2 flex-1 min-w-[180px] max-w-sm border border-border rounded-lg px-3 h-9 bg-background">
            <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <input
              placeholder="Search invoice or customer…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Select value={outletFilter} onValueChange={setOutletFilter}>
            <SelectTrigger className="h-9 w-40 text-sm"><SelectValue placeholder="All outlets" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All outlets</SelectItem>
              {outlets.map((o: any) => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="py-12 text-center text-muted-foreground">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground space-y-2">
            <Receipt className="w-10 h-10 mx-auto opacity-30" />
            <p className="font-medium">No sales match these filters</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Outlet</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Balance Due</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s: any) => (
                  <TableRow key={s.id} className={s.paymentStatus !== 'paid' ? 'bg-red-500/2' : ''}>
                    <TableCell className="font-mono text-xs font-semibold">{s.invoiceNumber}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(s.saleDate).toLocaleDateString('en-IN')}</TableCell>
                    <TableCell className="text-sm">{s.customerName || <span className="text-muted-foreground italic">Walk-in</span>}</TableCell>
                    <TableCell className="text-sm">{s.outletName}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmt(Number(s.totalAmount))}</TableCell>
                    <TableCell className="text-right font-mono text-sm text-emerald-600">{fmt(Number(s.amountPaid ?? 0))}</TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold text-red-500">
                      {Number(s.balanceDue ?? 0) > 0 ? fmt(Number(s.balanceDue)) : '—'}
                    </TableCell>
                    <TableCell><PaymentStatusBadge status={s.paymentStatus ?? 'paid'} /></TableCell>
                    <TableCell className="text-right">
                      <Button variant={s.paymentStatus !== 'paid' ? 'default' : 'ghost'} size="sm" onClick={() => setSelectedSale(s)}>
                        {s.paymentStatus !== 'paid' ? <><IndianRupee className="w-3.5 h-3.5 mr-1" /> Collect</> : 'View'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="p-3 border-t border-border flex justify-between text-sm text-muted-foreground">
              <span>{filtered.length} invoices</span>
              <span>Outstanding: <span className="font-bold text-red-500">{fmt(filtered.reduce((s: number, r: any) => s + Number(r.balanceDue ?? 0), 0))}</span></span>
            </div>
          </div>
        )}
      </div>

      {/* Payment collection drawer */}
      <Sheet open={!!selectedSale} onOpenChange={o => { if (!o) setSelectedSale(null); }}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          <SheetHeader className="pb-4">
            <SheetTitle className="flex items-center gap-2">
              <Banknote className="w-5 h-5 text-primary" />
              {selectedSale?.invoiceNumber}
            </SheetTitle>
          </SheetHeader>
          {selectedSale && (
            <CollectPaymentPanel
              sale={selectedSale}
              onClose={() => setSelectedSale(null)}
              onDone={(newStatus, newPaid) => {
                setSelectedSale((prev: any) => prev ? {
                  ...prev,
                  paymentStatus: newStatus,
                  amountPaid: newPaid,
                  balanceDue: Math.max(0, Number(prev.totalAmount) - newPaid),
                } : null);
                qc.invalidateQueries({ queryKey: getListSalesQueryKey() });
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
