/**
 * SalesDashboard — daily snapshot for the current sales location.
 * Shows Sales, Stock Transfers and Expenses for the selected date
 * (defaults to today). Each section is a clickable card that expands
 * inline to show the full detail table.
 */
import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import {
  useListSales, useListStockTransfers, customFetch,
} from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  ShoppingCart, ArrowLeftRight, Receipt, ChevronDown, ChevronUp,
  TrendingUp, Package, Wallet, CalendarDays, Store, Warehouse,
  Clock, CheckCircle2, XCircle, ArrowUpRight,
} from 'lucide-react';

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function toDateStr(d: string | Date): string {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return new Date(d).toISOString().split('T')[0];
}

function fmtDate(d: string) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Badges ────────────────────────────────────────────────────────────────────

function PaymentBadge({ status }: { status: string }) {
  if (status === 'paid')
    return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Paid</Badge>;
  if (status === 'partially_paid')
    return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">Partial</Badge>;
  return <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Unpaid</Badge>;
}

function TransferBadge({ status }: { status: string }) {
  if (status === 'completed')
    return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Completed</Badge>;
  if (status === 'rejected')
    return <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Rejected</Badge>;
  return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">In Transit</Badge>;
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({
  icon: Icon, iconColor, label, primary, secondary, open, onClick, accent,
}: {
  icon: React.ElementType;
  iconColor: string;
  label: string;
  primary: string;
  secondary: string;
  open: boolean;
  onClick: () => void;
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border transition-all duration-200 p-4 group
        ${open
          ? `${accent} shadow-md`
          : 'border-border bg-card hover:border-primary/30 hover:shadow-sm'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className={`rounded-lg p-2.5 ${open ? 'bg-white/20 dark:bg-black/20' : 'bg-muted/40'}`}>
          <Icon className={`w-5 h-5 ${iconColor}`} />
        </div>
        {open
          ? <ChevronUp className="w-4 h-4 text-current opacity-60 mt-0.5 shrink-0" />
          : <ChevronDown className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0 group-hover:text-foreground transition-colors" />}
      </div>
      <div className="mt-3">
        <p className={`text-xs font-medium uppercase tracking-wider ${open ? 'opacity-70' : 'text-muted-foreground'}`}>{label}</p>
        <p className={`text-2xl font-bold mt-0.5 ${open ? '' : 'text-foreground'}`}>{primary}</p>
        <p className={`text-xs mt-0.5 ${open ? 'opacity-70' : 'text-muted-foreground'}`}>{secondary}</p>
      </div>
    </button>
  );
}

// ── Section header inside expanded panel ──────────────────────────────────────

function PanelHeader({ icon: Icon, label, onNavigate, navLabel }: {
  icon: React.ElementType; label: string; onNavigate?: () => void; navLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/20">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="w-4 h-4 text-primary" /> {label}
      </div>
      {onNavigate && (
        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={onNavigate}>
          Open full page <ArrowUpRight className="w-3 h-3" />
        </Button>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

type Section = 'sales' | 'transfers' | 'expenses' | null;

export default function SalesDashboard() {
  const [, navigate] = useLocation();
  const { locationState } = useLocationContext();
  const { locationType, locationId, locationName } = locationState;

  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [open, setOpen] = useState<Section>(null);

  useEffect(() => {
    if (!locationType || !locationId) navigate('/sales');
  }, [locationType, locationId]);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data: allSales = [], isLoading: salesLoading } = useListSales();

  const { data: allTransfers = [], isLoading: transfersLoading } = useListStockTransfers();

  const { data: expenseData, isLoading: expensesLoading } = useQuery<{
    cashLedgerId: number; cashLedgerName: string; expenses: any[];
  }>({
    queryKey: ['location-expenses', locationType, locationId],
    queryFn: () => customFetch(`/api/accounts/location-expenses?locationType=${locationType}&locationId=${locationId}`),
    enabled: !!locationType && !!locationId,
  });

  // ── Filter to current location + selected date ─────────────────────────────

  const daySales = (allSales as any[]).filter(s =>
    s.locationType === locationType &&
    Number(s.locationId) === locationId &&
    toDateStr(s.saleDate) === selectedDate
  );

  const dayTransfers = (allTransfers as any[]).filter(t => {
    const fromMatch = t.fromType === locationType && Number(t.fromId) === locationId;
    const toMatch   = t.toType   === locationType && Number(t.toId)   === locationId;
    return (fromMatch || toMatch) && toDateStr(t.transferDate) === selectedDate;
  });

  const allExpenses: any[] = expenseData?.expenses ?? [];
  const dayExpenses = allExpenses.filter(e => toDateStr(e.expenseDate) === selectedDate);

  // ── Totals ─────────────────────────────────────────────────────────────────

  const salesTotal   = daySales.reduce((s: number, x: any) => s + Number(x.totalAmount ?? 0), 0);
  const salesPaid    = daySales.reduce((s: number, x: any) => s + Number(x.amountPaid ?? 0), 0);
  const expenseTotal = dayExpenses.reduce((s: number, x: any) => s + Number(x.amount ?? 0), 0);
  const inTransit    = dayTransfers.filter((t: any) => t.status === 'in_transit').length;

  // ── Toggle helper ──────────────────────────────────────────────────────────

  const toggle = (s: Section) => setOpen(prev => prev === s ? null : s);

  const LocationIcon = locationType === 'warehouse' ? Warehouse : Store;

  if (!locationType || !locationId) return null;

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-5 max-w-5xl">

        {/* ── Page header ── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <TrendingUp className="w-6 h-6 text-primary" /> Dashboard
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5">
              <LocationIcon className="w-3.5 h-3.5" /> {locationName}
            </p>
          </div>

          {/* Date picker */}
          <div className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-muted-foreground" />
            <Input
              type="date"
              value={selectedDate}
              max={new Date().toISOString().split('T')[0]}
              onChange={e => setSelectedDate(e.target.value)}
              className="h-8 w-40 text-sm"
            />
            {selectedDate !== new Date().toISOString().split('T')[0] && (
              <Button
                size="sm" variant="ghost"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => setSelectedDate(new Date().toISOString().split('T')[0])}
              >
                Today
              </Button>
            )}
          </div>
        </div>

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SummaryCard
            icon={ShoppingCart}
            iconColor={open === 'sales' ? 'text-white' : 'text-blue-600'}
            label="Sales"
            primary={salesLoading ? '…' : fmt(salesTotal)}
            secondary={salesLoading ? '' : `${daySales.length} order${daySales.length !== 1 ? 's' : ''} · collected ${fmt(salesPaid)}`}
            open={open === 'sales'}
            onClick={() => toggle('sales')}
            accent="border-blue-500/60 bg-blue-600 text-white"
          />
          <SummaryCard
            icon={ArrowLeftRight}
            iconColor={open === 'transfers' ? 'text-white' : 'text-violet-600'}
            label="Stock Transfers"
            primary={transfersLoading ? '…' : `${dayTransfers.length}`}
            secondary={transfersLoading ? '' : `${inTransit} in transit · ${dayTransfers.length - inTransit} completed`}
            open={open === 'transfers'}
            onClick={() => toggle('transfers')}
            accent="border-violet-500/60 bg-violet-600 text-white"
          />
          <SummaryCard
            icon={Receipt}
            iconColor={open === 'expenses' ? 'text-white' : 'text-rose-600'}
            label="Expenses"
            primary={expensesLoading ? '…' : fmt(expenseTotal)}
            secondary={expensesLoading ? '' : `${dayExpenses.length} expense${dayExpenses.length !== 1 ? 's' : ''}`}
            open={open === 'expenses'}
            onClick={() => toggle('expenses')}
            accent="border-rose-500/60 bg-rose-600 text-white"
          />
        </div>

        {/* ── Expanded panels ── */}

        {/* Sales detail */}
        {open === 'sales' && (
          <div className="rounded-xl border border-border overflow-hidden shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
            <PanelHeader icon={ShoppingCart} label={`Sales on ${fmtDate(selectedDate)}`} onNavigate={() => navigate('/sales/pos')} navLabel="Open POS" />
            {salesLoading ? (
              <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
            ) : daySales.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground space-y-2">
                <ShoppingCart className="w-10 h-10 mx-auto opacity-20" />
                <p className="font-medium">No sales on this date</p>
              </div>
            ) : (
              <>
                {/* Totals bar */}
                <div className="flex flex-wrap gap-4 px-4 py-3 bg-muted/10 text-sm border-b border-border">
                  <span className="text-muted-foreground">Total billed: <strong className="text-foreground">{fmt(salesTotal)}</strong></span>
                  <span className="text-muted-foreground">Collected: <strong className="text-emerald-600">{fmt(salesPaid)}</strong></span>
                  <span className="text-muted-foreground">Balance due: <strong className="text-rose-600">{fmt(salesTotal - salesPaid)}</strong></span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Invoice</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {daySales.map((s: any) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-xs font-bold text-primary">{s.invoiceNumber ?? `#${s.id}`}</TableCell>
                        <TableCell className="text-sm">{s.customerName ?? <span className="text-muted-foreground italic">Walk-in</span>}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold">{fmt(Number(s.totalAmount ?? 0))}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-emerald-600">{fmt(Number(s.amountPaid ?? 0))}</TableCell>
                        <TableCell className="text-right font-mono text-sm text-rose-600">{fmt(Math.max(0, Number(s.totalAmount ?? 0) - Number(s.amountPaid ?? 0)))}</TableCell>
                        <TableCell><PaymentBadge status={s.paymentStatus ?? 'unpaid'} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        )}

        {/* Transfers detail */}
        {open === 'transfers' && (
          <div className="rounded-xl border border-border overflow-hidden shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
            <PanelHeader icon={ArrowLeftRight} label={`Stock Transfers on ${fmtDate(selectedDate)}`} onNavigate={() => navigate('/sales/transfers')} navLabel="Open Transfers" />
            {transfersLoading ? (
              <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
            ) : dayTransfers.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground space-y-2">
                <ArrowLeftRight className="w-10 h-10 mx-auto opacity-20" />
                <p className="font-medium">No transfers on this date</p>
              </div>
            ) : (
              <>
                {/* In-transit banner */}
                {inTransit > 0 && (
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-700 text-sm">
                    <Clock className="w-4 h-4 shrink-0" />
                    <span><strong>{inTransit}</strong> transfer{inTransit > 1 ? 's' : ''} awaiting approval</span>
                  </div>
                )}
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Challan</TableHead>
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dayTransfers.map((t: any) => (
                      <TableRow key={t.id}>
                        <TableCell className="font-mono text-xs font-bold text-primary">{t.challanNumber ?? `#${t.id}`}</TableCell>
                        <TableCell className="text-sm">
                          {t.fromName ?? `${t.fromType} #${t.fromId}`}
                          <span className="text-muted-foreground capitalize text-xs ml-1">({t.fromType})</span>
                        </TableCell>
                        <TableCell className="text-sm">
                          {t.toName ?? `${t.toType} #${t.toId}`}
                          <span className="text-muted-foreground capitalize text-xs ml-1">({t.toType})</span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {(t.lineItems ?? []).length} item{(t.lineItems ?? []).length !== 1 ? 's' : ''}
                        </TableCell>
                        <TableCell><TransferBadge status={t.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        )}

        {/* Expenses detail */}
        {open === 'expenses' && (
          <div className="rounded-xl border border-border overflow-hidden shadow-sm animate-in fade-in slide-in-from-top-2 duration-200">
            <PanelHeader icon={Receipt} label={`Expenses on ${fmtDate(selectedDate)}`} onNavigate={() => navigate('/sales/expenses')} navLabel="Open Expenses" />
            {expensesLoading ? (
              <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
            ) : dayExpenses.length === 0 ? (
              <div className="py-16 text-center text-muted-foreground space-y-2">
                <Receipt className="w-10 h-10 mx-auto opacity-20" />
                <p className="font-medium">No expenses on this date</p>
              </div>
            ) : (
              <>
                <div className="flex gap-4 px-4 py-3 bg-muted/10 border-b border-border text-sm">
                  <span className="text-muted-foreground">Total spent: <strong className="text-rose-600">{fmt(expenseTotal)}</strong></span>
                  <span className="text-muted-foreground">From: <strong className="text-foreground">{expenseData?.cashLedgerName ?? '—'}</strong></span>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Voucher</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dayExpenses.map((e: any) => (
                      <TableRow key={e.id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.voucherNumber ?? `#${e.id}`}</TableCell>
                        <TableCell className="text-sm font-medium">{e.expenseLedgerName}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{e.description ?? '—'}</TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold text-rose-600">{fmt(Number(e.amount))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        )}

        {/* ── All-time summary strip ── */}
        <Separator />
        <div className="grid grid-cols-3 gap-4 text-center text-sm">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">All Sales</p>
            <p className="font-semibold">
              {(allSales as any[]).filter((s: any) =>
                s.locationType === locationType && Number(s.locationId) === locationId
              ).length} orders
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">All Transfers</p>
            <p className="font-semibold">
              {(allTransfers as any[]).filter((t: any) =>
                (t.fromType === locationType && Number(t.fromId) === locationId) ||
                (t.toType   === locationType && Number(t.toId)   === locationId)
              ).length} total
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">All Expenses</p>
            <p className="font-semibold">{allExpenses.length} total</p>
          </div>
        </div>

      </div>
    </AppLayout>
  );
}
