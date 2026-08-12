import { useState, useMemo } from 'react';
import {
  useListRentAgreements, useUpdateRentAgreement, useListRentAccruals,
  useListRentPeriods, useApproveRentPeriod, usePayRentPeriod,
  useListRentPayments, useRentDashboard, useListRentLedgerPostings,
  getRentAgreementsQueryKey, getRentPeriodsQueryKey, getRentPaymentsQueryKey,
  getRentDashboardQueryKey, getRentAccrualsQueryKey, getRentLedgerPostingsQueryKey,
  type RentAgreement, type RentPeriod,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import {
  Building2, Download, Printer, BadgeCheck, Wallet, IndianRupee, AlertTriangle,
  Pencil, RefreshCw, FileText, CalendarClock, TrendingUp, Clock,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadCSV, printHTML } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { useIsHeadOffice } from '@/lib/productStatus';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const inr = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inr0 = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const dmy = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const today = () => new Date().toISOString().split('T')[0];

/** Days until a due date — negative once it has passed. */
function daysUntil(due: string): number {
  const d = new Date(due + 'T00:00:00');
  const now = new Date(today() + 'T00:00:00');
  return Math.round((d.getTime() - now.getTime()) / 86_400_000);
}

type Tab = 'overview' | 'agreements' | 'periods' | 'payments' | 'reports';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview',   label: 'Overview' },
  { key: 'agreements', label: 'Agreements' },
  { key: 'periods',    label: 'Approvals & Payments' },
  { key: 'payments',   label: 'Payment History' },
  { key: 'reports',    label: 'Reports' },
];

type ReportKey = 'register' | 'warehouse' | 'monthly' | 'outstanding' | 'paid' | 'pending' | 'ledger';
const REPORTS: Array<{ key: ReportKey; label: string; hint: string }> = [
  { key: 'register',    label: 'Rent Register',    hint: 'Every daily accrual, warehouse by warehouse' },
  { key: 'warehouse',   label: 'Warehouse Wise',   hint: 'Accrued, paid and outstanding per warehouse' },
  { key: 'monthly',     label: 'Monthly Summary',  hint: 'One row per warehouse per month' },
  { key: 'outstanding', label: 'Outstanding',      hint: 'Months with rent still unpaid' },
  { key: 'paid',        label: 'Paid',             hint: 'Months settled in full' },
  { key: 'pending',     label: 'Pending Approval', hint: 'Accrued months awaiting sign-off' },
  { key: 'ledger',      label: 'Ledger Posting',   hint: 'The exact Dr/Cr pairs behind the books' },
];

function statusBadge(p: RentPeriod) {
  if (p.status === 'paid') return <StatusBadge status="paid" />;
  if (p.status === 'approved') {
    return p.paid > 0
      ? <StatusBadge status="partial" label="Part Paid" />
      : <StatusBadge status="approved" />;
  }
  return <StatusBadge status={p.accrualComplete ? 'awaiting_approval' : 'accruing'} label={p.accrualComplete ? 'Awaiting Approval' : 'Accruing'} />;
}

export default function RentManagement() {
  const perm = usePermission('page:/hr/rent');
  // Rent terms, approval and payment are Head Office decisions — the server
  // refuses them from anywhere else, so the buttons must not be offered either.
  // Warehouse users keep full read access to their own warehouse's rent.
  const { isHeadOffice } = useIsHeadOffice();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');

  const now = new Date();
  const [year, setYear] = useState<number>(now.getFullYear());
  const [warehouseFilter, setWarehouseFilter] = useState<string>('all');
  const [report, setReport] = useState<ReportKey>('register');

  const whId = warehouseFilter === 'all' ? undefined : Number(warehouseFilter);

  const { data: agreements = [], isLoading: loadingAgr } = useListRentAgreements();
  const { data: dashboard, isLoading: loadingDash } = useRentDashboard();
  const { data: periods = [], isLoading: loadingPer } = useListRentPeriods({ year, warehouseId: whId });
  const { data: payments = [] } = useListRentPayments({ year, warehouseId: whId });
  const { data: accruals = [] } = useListRentAccruals(
    { year, warehouseId: whId },
    { query: { enabled: tab === 'reports' && report === 'register' } },
  );
  const { data: ledgerPostings = [] } = useListRentLedgerPostings(
    { year, warehouseId: whId },
    { query: { enabled: tab === 'reports' && report === 'ledger' } },
  );

  const updateAgreement = useUpdateRentAgreement();
  const approvePeriod = useApproveRentPeriod();
  const payPeriod = usePayRentPeriod();

  const refreshAll = () => {
    for (const k of [
      getRentAgreementsQueryKey(), getRentDashboardQueryKey(),
      ['/api/rent/periods'], ['/api/rent/payments'], ['/api/rent/accruals'], ['/api/rent/ledger-postings'],
    ]) qc.invalidateQueries({ queryKey: k });
  };

  // ── Agreement editing ─────────────────────────────────────────────────────
  const [editing, setEditing] = useState<RentAgreement | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});

  const openEdit = (a: RentAgreement) => {
    setEditing(a);
    setForm({
      monthlyRent: String(a.monthlyRent ?? 0),
      securityDeposit: String(a.securityDeposit ?? 0),
      agreementNumber: a.agreementNumber ?? '',
      landlordName: a.landlordName ?? '',
      landlordPhone: a.landlordPhone ?? '',
      landlordEmail: a.landlordEmail ?? '',
      landlordAddress: a.landlordAddress ?? '',
      startDate: a.startDate ?? '',
      endDate: a.endDate ?? '',
      dueDay: String(a.dueDay ?? 5),
      status: a.status ?? 'inactive',
      revisionReason: '',
    });
  };

  const saveAgreement = async () => {
    if (!editing) return;
    const rent = Number(form.monthlyRent);
    if (!Number.isFinite(rent) || rent < 0) { toast.error('Monthly rent must be a positive amount'); return; }
    if (form.status === 'active' && rent <= 0) { toast.error('An active agreement needs a monthly rent above zero'); return; }
    if (form.status === 'active' && !form.startDate) { toast.error('An active agreement needs a start date to accrue from'); return; }
    if (form.startDate && form.endDate && form.endDate < form.startDate) { toast.error('The end date cannot fall before the start date'); return; }
    try {
      await updateAgreement.mutateAsync({
        warehouseId: editing.warehouseId,
        data: {
          monthlyRent: rent,
          securityDeposit: Number(form.securityDeposit) || 0,
          agreementNumber: form.agreementNumber,
          landlordName: form.landlordName,
          landlordPhone: form.landlordPhone,
          landlordEmail: form.landlordEmail,
          landlordAddress: form.landlordAddress,
          startDate: form.startDate || null,
          endDate: form.endDate || null,
          dueDay: Number(form.dueDay) || 5,
          status: form.status as 'active' | 'inactive',
          // Kept with the recalculation audit entry when the rent or the start
          // date changes; ignored otherwise.
          revisionReason: form.revisionReason?.trim() || undefined,
        } as any,
      });
      toast.success(`Rent agreement saved for ${editing.warehouseName}`);
      setEditing(null);
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save the agreement');
    }
  };

  // ── Approve ───────────────────────────────────────────────────────────────
  const doApprove = async (p: RentPeriod) => {
    try {
      await approvePeriod.mutateAsync({ warehouseId: p.warehouseId, year: p.year, month: p.month });
      toast.success(`${MONTHS[p.month - 1]} ${p.year} approved for ${p.warehouseName}`);
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not approve this month');
    }
  };

  // ── Pay ───────────────────────────────────────────────────────────────────
  const [paying, setPaying] = useState<RentPeriod | null>(null);
  const [payForm, setPayForm] = useState({ amount: '', paymentMode: 'bank', paymentDate: today(), referenceNumber: '', remarks: '' });

  const openPay = (p: RentPeriod) => {
    setPaying(p);
    setPayForm({ amount: String(p.outstanding), paymentMode: 'bank', paymentDate: today(), referenceNumber: '', remarks: '' });
  };

  const doPay = async () => {
    if (!paying) return;
    const amt = Number(payForm.amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a payment amount above zero'); return; }
    if (amt > paying.outstanding + 0.01) { toast.error(`That is more than the ${inr(paying.outstanding)} still outstanding for this month`); return; }
    try {
      await payPeriod.mutateAsync({
        warehouseId: paying.warehouseId, year: paying.year, month: paying.month,
        data: {
          amount: amt, paymentMode: payForm.paymentMode, paymentDate: payForm.paymentDate,
          referenceNumber: payForm.referenceNumber, remarks: payForm.remarks,
        },
      });
      toast.success(`${inr(amt)} paid for ${MONTHS[paying.month - 1]} ${paying.year}`);
      setPaying(null);
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not record the payment');
    }
  };

  // ── Due-date reminders ────────────────────────────────────────────────────
  // Surfaced in the page rather than emailed: rent is approved and paid from
  // here, so the reminder belongs where the action is taken.
  const reminders = useMemo(() => {
    const out: { period: RentPeriod; days: number }[] = [];
    for (const p of periods) {
      if (p.status === 'paid' || p.outstanding <= 0) continue;
      const d = daysUntil(p.dueDate);
      if (d <= 7) out.push({ period: p, days: d });
    }
    return out.sort((a, b) => a.days - b.days);
  }, [periods]);

  // ── Report rows ───────────────────────────────────────────────────────────
  const reportRows = useMemo((): Record<string, unknown>[] => {
    switch (report) {
      case 'register':
        return accruals.map(a => ({
          Date: dmy(a.accrualDate), Warehouse: a.warehouseName,
          Month: `${MONTHS[a.month - 1]} ${a.year}`,
          'Monthly Rent': a.monthlyRent, 'Days in Month': a.daysInMonth, 'Accrued': a.amount,
        }));
      case 'warehouse':
        return (dashboard?.warehouseWise ?? []).map(w => ({
          Warehouse: w.warehouseName, 'This Month': w.monthAccrued,
          'Total Accrued': w.totalAccrued, 'Total Paid': w.totalPaid, Outstanding: w.outstanding,
        }));
      case 'monthly':
        return periods.map(p => ({
          Warehouse: p.warehouseName, Month: `${MONTHS[p.month - 1]} ${p.year}`,
          'Days Accrued': `${p.daysAccrued}/${p.daysInMonth}`,
          Accrued: p.accrued, Paid: p.paid, Outstanding: p.outstanding,
          Status: p.status, 'Due Date': dmy(p.dueDate),
        }));
      case 'outstanding':
        return periods.filter(p => p.outstanding > 0).map(p => ({
          Warehouse: p.warehouseName, Month: `${MONTHS[p.month - 1]} ${p.year}`,
          Accrued: p.accrued, Paid: p.paid, Outstanding: p.outstanding,
          'Due Date': dmy(p.dueDate), Status: p.status,
        }));
      case 'paid':
        return payments.map(p => ({
          'Payment Date': dmy(p.paymentDate), Warehouse: p.warehouseName,
          Month: `${MONTHS[p.month - 1]} ${p.year}`, Amount: p.amount,
          Mode: p.paymentMode, Reference: p.referenceNumber, Voucher: p.voucherNumber, 'Recorded By': p.createdBy,
        }));
      case 'pending':
        return periods.filter(p => p.status === 'pending' && p.accrualComplete).map(p => ({
          Warehouse: p.warehouseName, Month: `${MONTHS[p.month - 1]} ${p.year}`,
          Accrued: p.accrued, 'Due Date': dmy(p.dueDate),
        }));
      case 'ledger':
        return ledgerPostings.map(l => ({
          Date: dmy(l.date), Warehouse: l.warehouseName, Type: l.kind,
          Voucher: l.voucherNumber || '—', Narration: l.narration,
          'Debit Ledger': l.debitLedger, 'Credit Ledger': l.creditLedger, Amount: l.amount,
        }));
    }
  }, [report, accruals, dashboard, periods, payments, ledgerPostings]);

  const reportMeta = REPORTS.find(r => r.key === report)!;

  // ── Sortable listing tables (filters/scope stay upstream) ──────────────────
  const agreementsSort = useTableSort(agreements, {
    warehouse: (a) => a.warehouseName,
    agreement: (a) => a.agreementNumber,
    landlord: (a) => a.landlordName,
    monthlyRent: (a) => Number(a.monthlyRent) || null,
    deposit: (a) => Number(a.securityDeposit) || null,
    period: (a) => a.startDate,
    dueDay: (a) => Number(a.dueDay),
    outstanding: (a) => Number(a.totalOutstanding) || null,
    status: (a) => a.status,
  });
  const periodsSort = useTableSort(periods, {
    warehouse: (p) => p.warehouseName,
    month: (p) => p.year * 100 + p.month,
    days: (p) => Number(p.daysAccrued),
    accrued: (p) => Number(p.accrued),
    paid: (p) => Number(p.paid),
    outstanding: (p) => Number(p.outstanding),
    due: (p) => p.dueDate,
    status: (p) => p.status,
  });
  const paymentsSort = useTableSort(payments, {
    date: (p) => p.paymentDate,
    warehouse: (p) => p.warehouseName,
    month: (p) => p.year * 100 + p.month,
    amount: (p) => Number(p.amount),
    mode: (p) => p.paymentMode,
    reference: (p) => p.referenceNumber,
    voucher: (p) => p.voucherNumber,
    recordedBy: (p) => p.createdBy,
  });

  const exportReport = () => {
    if (!reportRows.length) { toast.error('Nothing to export for this report'); return; }
    downloadCSV(`rent-${report}-${year}.csv`, reportRows);
  };

  const printReport = () => {
    if (!reportRows.length) { toast.error('Nothing to print for this report'); return; }
    const keys = Object.keys(reportRows[0]);
    const scope = warehouseFilter === 'all'
      ? 'All warehouses'
      : agreements.find(a => a.warehouseId === whId)?.warehouseName ?? '';
    printHTML(
      `<h2>${reportMeta.label}</h2>
       <h3>${scope} — ${year}</h3>
       <p class="small center">${reportMeta.hint}</p>
       <table><thead><tr>${keys.map(k => `<th>${k}</th>`).join('')}</tr></thead>
       <tbody>${reportRows.map(r => `<tr>${keys.map(k => {
         const v = r[k];
         const num = typeof v === 'number';
         return `<td class="${num ? 'right' : ''}">${num ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : String(v ?? '')}</td>`;
       }).join('')}</tr>`).join('')}</tbody></table>`,
      `${reportMeta.label} ${year}`,
    );
  };

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="p-8 text-center text-muted-foreground">
          You do not have permission to view Rent Management.
        </div>
      </AppLayout>
    );
  }

  const activeCount = agreements.filter(a => a.status === 'active').length;
  const yearOptions = [now.getFullYear() + 1, now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2];

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <PageHeader
          title="Rent Management"
          description="Warehouse rent accrues daily and posts straight to the books — approval releases payment, it does not create the expense."
          icon={Building2}
          actions={
            <Button variant="outline" size="sm" onClick={refreshAll}>
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh
            </Button>
          }
        />

        {/* Due reminders */}
        {reminders.length > 0 && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
              <CalendarClock className="w-4 h-4" /> Rent due
            </div>
            <ul className="mt-2 space-y-1 text-sm">
              {reminders.slice(0, 6).map(({ period: p, days }) => (
                <li key={`${p.warehouseId}-${p.year}-${p.month}`} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{p.warehouseName}</span>
                  <span className="text-muted-foreground">{MONTHS[p.month - 1]} {p.year}</span>
                  <span>{inr(p.outstanding)}</span>
                  <span className={days < 0 ? 'text-red-600 font-medium' : 'text-amber-700 dark:text-amber-400'}>
                    {days < 0 ? `overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`
                      : days === 0 ? 'due today' : `due in ${days} day${days === 1 ? '' : 's'}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Tabs */}
        <div className="flex flex-wrap gap-1 border-b border-border">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Scope filters (not needed on the overview, which is always current-month/all) */}
        {tab !== 'overview' && (
          <div className="flex flex-wrap items-end gap-3 bg-card border border-border rounded-xl p-4">
            <div>
              <Label className="text-xs">Year</Label>
              <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
                <SelectTrigger className="w-32 mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {yearOptions.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Warehouse</Label>
              <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                <SelectTrigger className="w-64 mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All warehouses</SelectItem>
                  {agreements.map(a => (
                    <SelectItem key={a.warehouseId} value={String(a.warehouseId)}>{a.warehouseName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {/* ── Overview ───────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div className="space-y-6">
            {/* Until the figures land, show placeholders rather than zeros: a
                tile reading "₹0" is a claim, and it is the wrong one. */}
            {!dashboard ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="bg-card border border-border rounded-xl p-4">
                    <div className="h-4 w-32 bg-muted rounded animate-pulse" />
                    <div className="h-7 w-24 bg-muted rounded animate-pulse mt-3" />
                    <div className="h-3 w-20 bg-muted rounded animate-pulse mt-3" />
                  </div>
                ))}
              </div>
            ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Tile icon={IndianRupee} label="Monthly Rent Committed" value={inr0(dashboard?.monthlyRentCommitted ?? 0)} hint={`${activeCount} active agreement${activeCount === 1 ? '' : 's'}`} />
              <Tile icon={Building2} label="Active Agreements" value={String(dashboard?.activeAgreements ?? 0)} hint={`of ${agreements.length} warehouses`} />
              <Tile icon={TrendingUp} label="Accrued This Month" value={inr(dashboard?.accruedThisMonth ?? 0)} hint={`${MONTHS[(dashboard?.month ?? 1) - 1]} ${dashboard?.year ?? ''}`} />
              <Tile icon={Wallet} label="Paid This Month" value={inr(dashboard?.paidThisMonth ?? 0)} hint="Cash and bank outflow" />
              <Tile icon={AlertTriangle} label="Total Outstanding" value={inr(dashboard?.totalOutstanding ?? 0)} hint="Rent Payable balance" tone={((dashboard?.totalOutstanding ?? 0) > 0) ? 'warn' : undefined} />
              <Tile icon={Clock} label="Pending Approvals" value={String(dashboard?.pendingApprovals ?? 0)} hint="Months awaiting sign-off" tone={((dashboard?.pendingApprovals ?? 0) > 0) ? 'warn' : undefined} />
            </div>
            )}

            <div className="bg-card border border-border rounded-xl p-4">
              <h2 className="font-semibold mb-3">Warehouse-wise rent</h2>
              {!dashboard ? (
                <div className="h-[300px] bg-muted/40 rounded animate-pulse" />
              ) : (dashboard?.warehouseWise?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No rent has accrued yet. Set a monthly rent and start date on the Agreements tab.
                </p>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={dashboard!.warehouseWise}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                    <XAxis dataKey="warehouseName" tick={{ fontSize: 11 }} interval={0} angle={-12} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: any) => inr(Number(v))} />
                    <Bar dataKey="totalAccrued" name="Accrued" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="totalPaid" name="Paid" fill="#10b981" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="outstanding" name="Outstanding" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {/* ── Agreements ─────────────────────────────────────────────────── */}
        {tab === 'agreements' && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead k="warehouse" sort={agreementsSort.sort}>Warehouse</SortableHead>
                  <SortableHead k="agreement" sort={agreementsSort.sort}>Agreement</SortableHead>
                  <SortableHead k="landlord" sort={agreementsSort.sort}>Landlord</SortableHead>
                  <SortableHead k="monthlyRent" sort={agreementsSort.sort} className="text-right">Monthly Rent</SortableHead>
                  <SortableHead k="deposit" sort={agreementsSort.sort} className="text-right">Deposit</SortableHead>
                  <SortableHead k="period" sort={agreementsSort.sort}>Period</SortableHead>
                  <SortableHead k="dueDay" sort={agreementsSort.sort} className="text-center">Due Day</SortableHead>
                  <SortableHead k="outstanding" sort={agreementsSort.sort} className="text-right">Outstanding</SortableHead>
                  <SortableHead k="status" sort={agreementsSort.sort}>Status</SortableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingAgr && <TableRow><TableCell colSpan={10} className="p-0"><TableSkeleton rows={6} cols={10} /></TableCell></TableRow>}
                {!loadingAgr && agreements.length === 0 && (
                  <TableRow><TableCell colSpan={10} className="p-0"><EmptyState icon={Building2} title="No warehouses found" hint="Rent agreements appear here once warehouses exist." compact /></TableCell></TableRow>
                )}
                {agreementsSort.sorted.map(a => (
                  <TableRow key={a.warehouseId}>
                    <TableCell className="font-medium">{a.warehouseName}</TableCell>
                    <TableCell className="text-muted-foreground">{a.agreementNumber || '—'}</TableCell>
                    <TableCell>
                      {a.landlordName || '—'}
                      {a.landlordPhone && <div className="text-xs text-muted-foreground">{a.landlordPhone}</div>}
                    </TableCell>
                    <TableCell className="text-right">{a.monthlyRent > 0 ? inr(a.monthlyRent) : '—'}</TableCell>
                    <TableCell className="text-right">{a.securityDeposit > 0 ? inr(a.securityDeposit) : '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {a.startDate ? `${dmy(a.startDate)} → ${a.endDate ? dmy(a.endDate) : 'open'}` : '—'}
                    </TableCell>
                    <TableCell className="text-center">{a.dueDay}</TableCell>
                    <TableCell className={`text-right ${a.totalOutstanding > 0 ? 'text-amber-600 font-medium' : ''}`}>
                      {inr(a.totalOutstanding)}
                    </TableCell>
                    <TableCell>
                      {a.status === 'active'
                        ? <StatusBadge status="active" />
                        : <StatusBadge status="inactive" />}
                    </TableCell>
                    <TableCell className="text-right">
                      {perm.canEdit && isHeadOffice && (
                        <Button variant="ghost" size="sm" onClick={() => openEdit(a)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* ── Periods: approve & pay ─────────────────────────────────────── */}
        {tab === 'periods' && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead k="warehouse" sort={periodsSort.sort}>Warehouse</SortableHead>
                  <SortableHead k="month" sort={periodsSort.sort}>Month</SortableHead>
                  <SortableHead k="days" sort={periodsSort.sort} className="text-center">Days</SortableHead>
                  <SortableHead k="accrued" sort={periodsSort.sort} className="text-right">Accrued</SortableHead>
                  <SortableHead k="paid" sort={periodsSort.sort} className="text-right">Paid</SortableHead>
                  <SortableHead k="outstanding" sort={periodsSort.sort} className="text-right">Outstanding</SortableHead>
                  <SortableHead k="due" sort={periodsSort.sort}>Due</SortableHead>
                  <SortableHead k="status" sort={periodsSort.sort}>Status</SortableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingPer && <TableRow><TableCell colSpan={9} className="p-0"><TableSkeleton rows={6} cols={9} /></TableCell></TableRow>}
                {!loadingPer && periods.length === 0 && (
                  <TableRow><TableCell colSpan={9} className="p-0">
                    <EmptyState icon={CalendarClock} title={`No rent accrued in ${year}`} hint="Activate an agreement to start accruing." compact />
                  </TableCell></TableRow>
                )}
                {periodsSort.sorted.map(p => (
                  <TableRow key={`${p.warehouseId}-${p.year}-${p.month}`}>
                    <TableCell className="font-medium">{p.warehouseName}</TableCell>
                    <TableCell>{MONTHS[p.month - 1]} {p.year}</TableCell>
                    <TableCell className="text-center text-xs text-muted-foreground">{p.daysAccrued}/{p.daysInMonth}</TableCell>
                    <TableCell className="text-right">{inr(p.accrued)}</TableCell>
                    <TableCell className="text-right">{inr(p.paid)}</TableCell>
                    <TableCell className={`text-right ${p.outstanding > 0 ? 'text-amber-600 font-medium' : ''}`}>{inr(p.outstanding)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{dmy(p.dueDate)}</TableCell>
                    <TableCell>{statusBadge(p)}</TableCell>
                    <TableCell className="text-right space-x-1">
                      {p.status === 'pending' && perm.canEdit && isHeadOffice && (
                        <Button
                          size="sm" variant="outline"
                          disabled={!p.accrualComplete || approvePeriod.isPending}
                          title={p.accrualComplete ? 'Approve this month' : 'This month is still accruing'}
                          onClick={() => doApprove(p)}
                        >
                          <BadgeCheck className="w-4 h-4 mr-1" /> Approve
                        </Button>
                      )}
                      {p.status !== 'pending' && p.outstanding > 0 && perm.canAdd && isHeadOffice && (
                        <Button size="sm" onClick={() => openPay(p)}>
                          <Wallet className="w-4 h-4 mr-1" /> Pay
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* ── Payment history ────────────────────────────────────────────── */}
        {tab === 'payments' && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead k="date" sort={paymentsSort.sort}>Date</SortableHead>
                  <SortableHead k="warehouse" sort={paymentsSort.sort}>Warehouse</SortableHead>
                  <SortableHead k="month" sort={paymentsSort.sort}>For Month</SortableHead>
                  <SortableHead k="amount" sort={paymentsSort.sort} className="text-right">Amount</SortableHead>
                  <SortableHead k="mode" sort={paymentsSort.sort}>Mode</SortableHead>
                  <SortableHead k="reference" sort={paymentsSort.sort}>Reference</SortableHead>
                  <SortableHead k="voucher" sort={paymentsSort.sort}>Voucher</SortableHead>
                  <SortableHead k="recordedBy" sort={paymentsSort.sort}>Recorded By</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="p-0"><EmptyState icon={Wallet} title={`No rent payments in ${year}`} hint="Payments recorded against approved months will appear here." compact /></TableCell></TableRow>
                )}
                {paymentsSort.sorted.map(p => (
                  <TableRow key={p.id}>
                    <TableCell>{dmy(p.paymentDate)}</TableCell>
                    <TableCell className="font-medium">{p.warehouseName}</TableCell>
                    <TableCell>{MONTHS[p.month - 1]} {p.year}</TableCell>
                    <TableCell className="text-right">{inr(p.amount)}</TableCell>
                    <TableCell className="capitalize">{p.paymentMode}</TableCell>
                    <TableCell className="text-muted-foreground">{p.referenceNumber || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{p.voucherNumber || '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{p.createdBy || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* ── Reports ────────────────────────────────────────────────────── */}
        {tab === 'reports' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {REPORTS.map(r => (
                <button
                  key={r.key}
                  onClick={() => setReport(r.key)}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                    report === r.key ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted/40'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 p-4 border-b border-border">
                <div>
                  <h2 className="font-semibold flex items-center gap-2"><FileText className="w-4 h-4" /> {reportMeta.label}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{reportMeta.hint} · {reportRows.length} row{reportRows.length === 1 ? '' : 's'}</p>
                </div>
                <div className="flex gap-2">
                  {perm.canDownload && (
                    <Button variant="outline" size="sm" onClick={exportReport}>
                      <Download className="w-4 h-4 mr-2" /> Excel (CSV)
                    </Button>
                  )}
                  {perm.canDownload && (
                    <Button variant="outline" size="sm" onClick={printReport}>
                      <Printer className="w-4 h-4 mr-2" /> Print / PDF
                    </Button>
                  )}
                </div>
              </div>

              {reportRows.length === 0 ? (
                <EmptyState icon={FileText} title="Nothing to show" hint="No rows for this report and selection." compact />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {Object.keys(reportRows[0]).map(k => (
                          <TableHead key={k} className={typeof reportRows[0][k] === 'number' ? 'text-right' : ''}>{k}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reportRows.map((r, i) => (
                        <TableRow key={i}>
                          {Object.keys(reportRows[0]).map(k => (
                            <TableCell key={k} className={typeof r[k] === 'number' ? 'text-right' : ''}>
                              {typeof r[k] === 'number' ? inr(r[k] as number) : String(r[k] ?? '—')}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Edit agreement sheet ──────────────────────────────────────────── */}
      <Sheet open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Rent agreement — {editing?.warehouseName}</SheetTitle>
            <SheetDescription>
              Rent accrues every day from the start date while the agreement is active.
              Setting it inactive stops future accrual and leaves the history untouched.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-4 mt-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Monthly Rent (₹)"><Input type="number" min="0" step="0.01" value={form.monthlyRent ?? ''} onChange={e => setForm({ ...form, monthlyRent: e.target.value })} /></Field>
              <Field label="Security Deposit (₹)"><Input type="number" min="0" step="0.01" value={form.securityDeposit ?? ''} onChange={e => setForm({ ...form, securityDeposit: e.target.value })} /></Field>
            </div>
            <Field label="Agreement Number"><Input value={form.agreementNumber ?? ''} onChange={e => setForm({ ...form, agreementNumber: e.target.value })} /></Field>

            <Separator />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Landlord</p>
            <Field label="Name"><Input value={form.landlordName ?? ''} onChange={e => setForm({ ...form, landlordName: e.target.value })} /></Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Phone"><Input value={form.landlordPhone ?? ''} onChange={e => setForm({ ...form, landlordPhone: e.target.value })} /></Field>
              <Field label="Email"><Input type="email" value={form.landlordEmail ?? ''} onChange={e => setForm({ ...form, landlordEmail: e.target.value })} /></Field>
            </div>
            <Field label="Address"><Textarea rows={2} value={form.landlordAddress ?? ''} onChange={e => setForm({ ...form, landlordAddress: e.target.value })} /></Field>

            <Separator />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Term</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Start Date"><Input type="date" value={form.startDate ?? ''} onChange={e => setForm({ ...form, startDate: e.target.value })} /></Field>
              <Field label="End Date"><Input type="date" value={form.endDate ?? ''} onChange={e => setForm({ ...form, endDate: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Due Day of Month">
                <Input type="number" min="1" max="31" value={form.dueDay ?? ''} onChange={e => setForm({ ...form, dueDay: e.target.value })} />
              </Field>
              <Field label="Status">
                <Select value={form.status ?? 'inactive'} onValueChange={v => setForm({ ...form, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active — accruing</SelectItem>
                    <SelectItem value="inactive">Inactive — stopped</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Separator />
            <Field label="Reason for Revision (optional)">
              <Textarea
                rows={2}
                placeholder="e.g. escalation clause, renegotiated with landlord"
                value={form.revisionReason ?? ''}
                onChange={e => setForm({ ...form, revisionReason: e.target.value })}
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              Changing the monthly rent or the start date recalculates every month that has not been
              approved yet at the new figure, and records who changed it, when, and why. Approved and
              paid months are financially final and are left alone.
            </p>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              <Button onClick={saveAgreement} disabled={updateAgreement.isPending}>
                {updateAgreement.isPending ? 'Saving…' : 'Save agreement'}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Pay dialog ────────────────────────────────────────────────────── */}
      <Dialog open={!!paying} onOpenChange={o => !o && setPaying(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record rent payment</DialogTitle>
            <DialogDescription>
              {paying && <>{paying.warehouseName} — {MONTHS[paying.month - 1]} {paying.year}. {inr(paying.outstanding)} outstanding.</>}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Amount (₹)">
                <Input type="number" min="0" step="0.01" value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} />
              </Field>
              <Field label="Payment Date">
                <Input type="date" value={payForm.paymentDate} onChange={e => setPayForm({ ...payForm, paymentDate: e.target.value })} />
              </Field>
            </div>
            <Field label="Mode">
              <Select value={payForm.paymentMode} onValueChange={v => setPayForm({ ...payForm, paymentMode: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank">Bank</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="upi">UPI</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Reference Number">
              <Input value={payForm.referenceNumber} onChange={e => setPayForm({ ...payForm, referenceNumber: e.target.value })} placeholder="Cheque / UTR / txn id" />
            </Field>
            <Field label="Remarks">
              <Textarea rows={2} value={payForm.remarks} onChange={e => setPayForm({ ...payForm, remarks: e.target.value })} />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPaying(null)}>Cancel</Button>
            <Button onClick={doPay} disabled={payPeriod.isPending}>
              {payPeriod.isPending ? 'Posting…' : 'Post payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Tile({ icon: Icon, label, value, hint, tone }: {
  icon: React.ElementType; label: string; value: string; hint?: string; tone?: 'warn';
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className={`w-4 h-4 ${tone === 'warn' ? 'text-amber-600' : 'text-primary'}`} />
      </div>
      <div className={`text-2xl font-bold mt-2 ${tone === 'warn' ? 'text-amber-600' : ''}`}>{value}</div>
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}
