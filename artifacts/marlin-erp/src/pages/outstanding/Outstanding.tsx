import { Fragment, useState } from 'react';
import { useReceivablesAging, usePayablesAging } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HandCoins, ChevronDown, ChevronRight, Search, Wallet, Phone, ShieldOff, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/empty-state';
import { inr } from '@/lib/currency';
import { formatDateOrDash } from '@/lib/date';
import { formatSalesInvoiceDisplayNumber } from '@/lib/invoiceNumber';
import { exportReportPdf, exportReportXlsx, type ReportDoc } from '../reports/shared';
import { toast } from 'sonner';

const dfmt = (d?: string | null) => formatDateOrDash(d);

const BUCKETS: Array<{ key: 'b0_30' | 'b31_60' | 'b61_90' | 'b90p'; label: string; cls: string }> = [
  { key: 'b0_30', label: '0–30 d', cls: 'text-emerald-600' },
  { key: 'b31_60', label: '31–60 d', cls: 'text-amber-600' },
  { key: 'b61_90', label: '61–90 d', cls: 'text-orange-600' },
  { key: 'b90p', label: '90+ d', cls: 'text-red-600' },
];

function bucketBadge(bucket: string) {
  const map: Record<string, string> = {
    'b0_30': 'text-emerald-600 border-emerald-500/40',
    'b31_60': 'text-amber-600 border-amber-500/40',
    'b61_90': 'text-orange-600 border-orange-500/40',
    'b90p': 'text-red-600 border-red-500/40',
  };
  return map[bucket] ?? 'text-muted-foreground';
}

// ─── Page ─────────────────────────────────────────────────────────────────────
//
// Receivables and Payables only. The Collect action and Collections worklist
// were retired (owner decision, Aug 2026): Receipt/Payment vouchers are the
// only payment flows, so this page is a read-only aging view. The receivable
// and payable figures are computed exactly as before.

export default function Outstanding() {
  const perm = usePermission('page:/outstanding');
  const [tab, setTab] = useState<'receivables' | 'payables'>('receivables');
  const [search, setSearch] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState<'pdf' | 'excel' | null>(null);
  // Historical position: empty = today (the original, current view). Aging is
  // a position, so a single as-of date is the whole date dimension here.
  const [asOf, setAsOf] = useState('');

  const { data: recv, isLoading: recvLoading } = useReceivablesAging(asOf || undefined);
  const { data: pay, isLoading: payLoading } = usePayablesAging(asOf || undefined);

  const q = search.trim().toLowerCase();

  const customers = ((recv as any)?.customers ?? []).filter((c: any) =>
    (Math.abs(Number(c.netDue ?? 0)) > 0.004 || Number(c.advance ?? 0) > 0.004)
    && (!q || c.name?.toLowerCase().includes(q) || c.phone?.includes(q))
  );
  const vendors = ((pay as any)?.vendors ?? []).filter((v: any) => !q || v.name?.toLowerCase().includes(q) || v.phone?.includes(q));

  const totals: any = tab === 'receivables' ? (recv as any)?.totals : (pay as any)?.totals;
  const visibleParties: any[] = tab === 'receivables' ? customers : vendors;
  const partyKey = (partyTab: 'receivables' | 'payables', id: number | string) =>
    `${partyTab}:${id}`;
  const isExpanded = (id: number | string) => expandedKeys.has(partyKey(tab, id));
  const allVisibleExpanded = visibleParties.length > 0
    && visibleParties.every((party) => isExpanded(tab === 'receivables' ? party.customerId : party.vendorId));

  const toggleAll = () => {
    if (allVisibleExpanded) {
      setExpandedKeys(new Set());
      return;
    }
    setExpandedKeys(new Set(visibleParties.map((party) =>
      partyKey(tab, tab === 'receivables' ? party.customerId : party.vendorId),
    )));
  };

  const buildReportDoc = (): ReportDoc => {
    const rows = tab === 'receivables' ? customers : vendors;
    const hasExpandedParties = rows.some((party: any) => {
      const id = tab === 'receivables' ? party.customerId : party.vendorId;
      return isExpanded(id);
    });
    const detailRows = rows.flatMap((party: any) => {
      const id = tab === 'receivables' ? party.customerId : party.vendorId;
      if (!isExpanded(id)) return [];
      if (tab === 'receivables') {
        return (party.invoices ?? []).map((invoice: any) => [
          party.name,
          formatSalesInvoiceDisplayNumber(invoice.invoiceNumber || `Sale #${invoice.saleId}`),
          dfmt(invoice.saleDate),
          dfmt(invoice.dueDate),
          Number(invoice.daysOverdue) > 0 ? `${invoice.daysOverdue} d` : 'Current',
          Number(invoice.total ?? 0),
          Number(invoice.paid ?? 0),
          Number(invoice.creditNotes ?? 0),
          Number(invoice.balance ?? 0),
        ]);
      }
      return (party.bills ?? []).map((bill: any) => [
        party.name,
        bill.invoiceNumber || `PB #${String(bill.purchaseId ?? bill.assetPurchaseId).padStart(4, '0')}`,
        dfmt(bill.purchaseDate),
        Number(bill.daysOld ?? 0),
        Number(bill.total ?? 0),
        Number(bill.allocated ?? 0),
        Number(bill.balance ?? 0),
      ]);
    });

    const ageRows = BUCKETS.map((bucket) => [bucket.label, Number(totals?.[bucket.key] ?? 0)]);
    const summaryRows: (string | number)[][] = [
      [tab === 'receivables' ? 'Aged bills' : 'Aged bills payable', Number(totals?.totalDue ?? 0)],
      ...ageRows,
      ['Balance (ledger)', Number(totals?.netDue ?? 0)],
      [
        tab === 'receivables' ? 'Ledger balance without dated invoices' : 'Ledger balance without dated bills',
        Number(tab === 'receivables' ? totals?.uninvoiced ?? 0 : totals?.unbilled ?? 0),
      ],
    ];

    const sections: ReportDoc['sections'] = [
      {
        heading: 'Overall aging totals',
        columns: [{ label: 'Measure', width: 2 }, { label: 'Amount', align: 'right', width: 1 }],
        rows: summaryRows,
      },
      {
        heading: tab === 'receivables' ? 'Customer balances' : 'Vendor balances',
        columns: tab === 'receivables' ? [
          { label: 'Customer', width: 2 }, { label: 'Phone', width: 1.2 },
          { label: 'Credit limit', align: 'right', width: 1.1 },
          { label: '0–30 d', align: 'right', width: 1 }, { label: '31–60 d', align: 'right', width: 1 },
          { label: '61–90 d', align: 'right', width: 1 }, { label: '90+ d', align: 'right', width: 1 },
          { label: 'Credit notes', align: 'right', width: 1.1 }, { label: 'Net due', align: 'right', width: 1.1 },
        ] : [
          { label: 'Vendor', width: 2 }, { label: 'Phone', width: 1.2 },
          { label: 'Billed', align: 'right', width: 1.1 }, { label: 'Paid', align: 'right', width: 1.1 },
          { label: '0–30 d', align: 'right', width: 1 }, { label: '31–60 d', align: 'right', width: 1 },
          { label: '61–90 d', align: 'right', width: 1 }, { label: '90+ d', align: 'right', width: 1 },
          { label: 'Debit notes', align: 'right', width: 1.1 }, { label: 'Net due', align: 'right', width: 1.1 },
        ],
        rows: tab === 'receivables'
          ? customers.map((customer: any) => [
            customer.name, customer.phone ?? '', Number(customer.creditLimit ?? 0),
            ...BUCKETS.map((bucket) => Number(customer[bucket.key] ?? 0)),
            Number(customer.creditNotes ?? 0), Number(customer.netDue ?? 0),
          ])
          : vendors.map((vendor: any) => [
            vendor.name, vendor.phone ?? '', Number(vendor.totalBilled ?? 0), Number(vendor.totalPaid ?? 0),
            ...BUCKETS.map((bucket) => Number(vendor[bucket.key] ?? 0)),
            Number(vendor.debitNotes ?? 0), Number(vendor.netDue ?? 0),
          ]),
      },
    ];

    if (hasExpandedParties) {
      sections.push({
        heading: tab === 'receivables' ? 'Expanded invoice details' : 'Expanded bill details',
        columns: tab === 'receivables' ? [
          { label: 'Customer', width: 1.5 }, { label: 'Invoice', width: 1.4 },
          { label: 'Sale date', width: 1 }, { label: 'Due date', width: 1 },
          { label: 'Overdue', align: 'right', width: 0.8 },
          { label: 'Total', align: 'right', width: 1 }, { label: 'Paid', align: 'right', width: 1 },
          { label: 'Credit note', align: 'right', width: 1 }, { label: 'Balance', align: 'right', width: 1 },
        ] : [
          { label: 'Vendor', width: 1.5 }, { label: 'Bill', width: 1.4 },
          { label: 'Date', width: 1 }, { label: 'Age (days)', align: 'right', width: 0.8 },
          { label: 'Total', align: 'right', width: 1 }, { label: 'Allocated', align: 'right', width: 1 },
          { label: 'Balance', align: 'right', width: 1 },
        ],
        rows: detailRows,
      });
    }

    const mode = hasExpandedParties ? 'Expanded details' : 'Collapsed summary';
    const tabLabel = tab === 'receivables' ? 'Receivables' : 'Payables';
    return {
      title: `${tabLabel} Outstanding`,
      subtitle: `As of ${asOf ? dfmt(asOf) : 'Today'} · ${mode}`,
      metaRows: [
        ['As of', asOf ? dfmt(asOf) : 'Today'],
        ['Party rows', String(rows.length)],
        ['Search', q || 'All parties'],
        ['Detail view', mode],
      ],
      orientation: 'landscape',
      sections,
      filename: `${tabLabel.toLowerCase()}-outstanding-${asOf || 'today'}-${mode === 'Expanded details' ? 'expanded' : 'collapsed'}`,
    };
  };

  const runExport = (kind: 'pdf' | 'excel') => {
    if (exporting || !perm.canDownload) return;
    setExporting(kind);
    // Keep PDF generation in the click call stack so its preview window is not
    // blocked by the browser. The document is built from the current UI state.
    try {
      const task = kind === 'pdf' ? exportReportPdf(buildReportDoc()) : exportReportXlsx(buildReportDoc());
      void task
        .catch((error: any) => toast.error(error?.message ?? `Could not export ${kind.toUpperCase()}`))
        .finally(() => setExporting(null));
    } catch (error: any) {
      toast.error(error?.message ?? `Could not export ${kind.toUpperCase()}`);
      setExporting(null);
    }
  };

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view this page.<br />
              Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Outstanding"
          description="Who owes you and whom you owe, aged by how long it has been due."
          icon={Wallet}
        />

        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/30">
            {([['receivables', 'Receivables'], ['payables', 'Payables']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => { setTab(k); setExpandedKeys(new Set()); }}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === k ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[220px] max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search party…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground whitespace-nowrap">As of</span>
            <Input type="date" className="w-36 h-9" value={asOf} onChange={e => setAsOf(e.target.value)} />
            {asOf && (
              <button onClick={() => setAsOf('')} className="text-xs text-muted-foreground hover:text-foreground underline">
                Today
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={toggleAll}
              disabled={visibleParties.length === 0 || (tab === 'receivables' ? recvLoading : payLoading)}
              data-testid="button-toggle-all-outstanding"
              aria-label={allVisibleExpanded ? 'Collapse all parties' : 'Expand all parties'}
            >
              {allVisibleExpanded ? 'Collapse all' : 'Expand all'}
            </Button>
            {perm.canDownload && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => runExport('excel')}
                  disabled={exporting !== null || visibleParties.length === 0 || (tab === 'receivables' ? recvLoading : payLoading)}
                  data-testid="button-export-outstanding-excel"
                >
                  {exporting === 'excel' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                  Excel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => runExport('pdf')}
                  disabled={exporting !== null || visibleParties.length === 0 || (tab === 'receivables' ? recvLoading : payLoading)}
                  data-testid="button-export-outstanding-pdf"
                >
                  {exporting === 'pdf' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
                  PDF
                </Button>
              </>
            )}
          </div>
        </div>
        {asOf && (
          <p className="text-xs text-muted-foreground -mt-3">
            Showing the position as it stood on {asOf} — bills, payments and notes after that date are ignored.
          </p>
        )}

        {/* ── Aging summary cards (receivables / payables) ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-card border border-border rounded-xl p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Aged Bills</p>
            <p className="text-lg font-bold font-mono mt-1">{inr(totals?.totalDue)}</p>
          </div>
          {BUCKETS.map(b => (
            <div key={b.key} className="bg-card border border-border rounded-xl p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{b.label}</p>
              <p className={`text-lg font-bold font-mono mt-1 ${b.cls}`}>{inr(totals?.[b.key])}</p>
            </div>
          ))}
          {/* The control figure. It comes from the party ledgers, so it equals
              Sundry Debtors / Sundry Creditors on the Balance Sheet. The
              buckets to the left show only the part that maps to dated bills. */}
          <div className="bg-card border border-border rounded-xl p-3">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Balance (ledger)</p>
            <p className="text-lg font-bold font-mono mt-1 text-primary">{inr(totals?.netDue)}</p>
          </div>
        </div>

        {/* Anything the ledger says is owed that no dated document explains —
            an opening balance, or a journal raising the liability directly.
            Surfaced rather than dropped so the buckets and the control figure
            can be reconciled by eye. */}
        {Number((totals as any)?.[tab === 'receivables' ? 'uninvoiced' : 'unbilled']) > 0.004 && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
            <span className="font-medium text-amber-600">
              {inr((totals as any)[tab === 'receivables' ? 'uninvoiced' : 'unbilled'])}
            </span>{' '}
            <span className="text-muted-foreground">
              of the ledger balance has no dated {tab === 'receivables' ? 'invoice' : 'bill'} behind it
              (opening balance or journal entry), so it cannot be aged into the buckets above.
            </span>
          </div>
        )}

        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {/* ── RECEIVABLES ── */}
          {tab === 'receivables' && (recvLoading ? (
            <div className="p-10 text-center text-muted-foreground text-sm">Loading receivables…</div>
          ) : customers.length === 0 ? (
            <EmptyState
              icon={HandCoins}
              title={q ? 'No matching customers with an outstanding balance' : 'Nothing outstanding'}
              hint={q ? 'Try a different customer search.' : 'All customer balances are settled.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2.5">Customer</th>
                    <th className="text-right px-3 py-2.5">Credit Limit</th>
                    {BUCKETS.map(b => <th key={b.key} className="text-right px-3 py-2.5">{b.label}</th>)}
                    <th className="text-right px-3 py-2.5">Credit Notes</th>
                    <th className="text-right px-4 py-2.5">Net Due</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c: any) => (
                    <Fragment key={c.customerId}>
                      <tr
                        className="border-t border-border hover:bg-muted/10 cursor-pointer"
                        onClick={() => setExpandedKeys((previous) => {
                          const next = new Set(previous);
                          const key = partyKey('receivables', c.customerId);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })}
                        aria-expanded={isExpanded(c.customerId)}
                        data-testid={`row-outstanding-customer-${c.customerId}`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            {isExpanded(c.customerId) ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                            <div>
                              <p className="font-medium">{c.name}</p>
                              {c.phone && <p className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</p>}
                              {Number(c.advance) > 0 && (
                                <p className="text-[11px] text-amber-600 dark:text-amber-500">Credit balance (advance): {inr(c.advance)}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">{Number(c.creditLimit) > 0 ? `${inr(c.creditLimit)}` : '—'}</td>
                        {BUCKETS.map(b => (
                          <td key={b.key} className={`px-3 py-2.5 text-right font-mono ${Number(c[b.key]) > 0 ? b.cls : 'text-muted-foreground/50'}`}>
                            {Number(c[b.key]) > 0 ? `${inr(c[b.key])}` : '—'}
                          </td>
                        ))}
                        <td className="px-3 py-2.5 text-right font-mono text-emerald-600">{Number(c.creditNotes) > 0 ? `-${inr(c.creditNotes)}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-mono font-bold">{inr(c.netDue)}</td>
                      </tr>
                      {isExpanded(c.customerId) && (
                        <tr className="border-t border-border bg-muted/10">
                          <td colSpan={8} className="px-4 py-3">
                            <table className="w-full text-xs">
                              <thead className="text-muted-foreground">
                                <tr>
                                  <th className="text-left py-1">Invoice</th>
                                  <th className="text-left py-1">Sale date</th>
                                  <th className="text-left py-1">Due date</th>
                                  <th className="text-right py-1">Overdue</th>
                                  <th className="text-right py-1">Total</th>
                                  <th className="text-right py-1">Paid</th>
                                  <th className="text-right py-1">Credit note</th>
                                  <th className="text-right py-1">Balance</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(c.invoices ?? []).map((inv: any) => (
                                  <tr key={inv.saleId} className="border-t border-border/50">
                                    <td className="py-1.5 font-mono">{formatSalesInvoiceDisplayNumber(inv.invoiceNumber || `Sale #${inv.saleId}`)}</td>
                                    <td className="py-1.5">{dfmt(inv.saleDate)}</td>
                                    <td className="py-1.5">{dfmt(inv.dueDate)}</td>
                                    <td className="py-1.5 text-right">
                                      <Badge variant="outline" className={`font-mono text-[10px] ${bucketBadge(inv.bucket)}`}>
                                        {inv.daysOverdue > 0 ? `${inv.daysOverdue} d` : 'current'}
                                      </Badge>
                                    </td>
                                    <td className="py-1.5 text-right font-mono">{inr(inv.total)}</td>
                                    <td className="py-1.5 text-right font-mono">{inr(inv.paid)}</td>
                                    <td className="py-1.5 text-right font-mono text-emerald-600">{Number(inv.creditNotes) > 0 ? `−${inr(inv.creditNotes)}` : '—'}</td>
                                    <td className="py-1.5 text-right font-mono font-semibold">{inr(inv.balance)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {/* ── PAYABLES ── */}
          {tab === 'payables' && (payLoading ? (
            <div className="p-10 text-center text-muted-foreground text-sm">Loading payables…</div>
          ) : vendors.length === 0 ? (
            <EmptyState icon={HandCoins} title="Nothing outstanding" hint="All vendor bills are settled." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2.5">Vendor</th>
                    <th className="text-right px-3 py-2.5">Billed</th>
                    <th className="text-right px-3 py-2.5">Paid</th>
                    {BUCKETS.map(b => <th key={b.key} className="text-right px-3 py-2.5">{b.label}</th>)}
                    <th className="text-right px-3 py-2.5">Debit Notes</th>
                    <th className="text-right px-4 py-2.5">Net Due</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((v: any) => (
                    <Fragment key={v.vendorId}>
                      <tr
                        className="border-t border-border hover:bg-muted/10 cursor-pointer"
                        onClick={() => setExpandedKeys((previous) => {
                          const next = new Set(previous);
                          const key = partyKey('payables', v.vendorId);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })}
                        aria-expanded={isExpanded(v.vendorId)}
                        data-testid={`row-outstanding-vendor-${v.vendorId}`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            {isExpanded(v.vendorId) ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                            <div>
                              <p className="font-medium">{v.name}</p>
                              {v.phone && <p className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" />{v.phone}</p>}
                              {Number(v.advance) > 0 && (
                                <p className="text-[11px] text-amber-600 dark:text-amber-500">Advance with vendor: {inr(v.advance)}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">{inr(v.totalBilled)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">{inr(v.totalPaid)}</td>
                        {BUCKETS.map(b => (
                          <td key={b.key} className={`px-3 py-2.5 text-right font-mono ${Number(v[b.key]) > 0 ? b.cls : 'text-muted-foreground/50'}`}>
                            {Number(v[b.key]) > 0 ? `${inr(v[b.key])}` : '—'}
                          </td>
                        ))}
                        <td className="px-3 py-2.5 text-right font-mono text-emerald-600">{Number(v.debitNotes) > 0 ? `-${inr(v.debitNotes)}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-mono font-bold">{inr(v.netDue)}</td>
                      </tr>
                      {isExpanded(v.vendorId) && (
                        <tr className="border-t border-border bg-muted/10">
                          <td colSpan={9} className="px-4 py-3">
                            <table className="w-full text-xs">
                              <thead className="text-muted-foreground">
                                <tr>
                                  <th className="text-left py-1">Bill</th>
                                  <th className="text-left py-1">Date</th>
                                  <th className="text-right py-1">Age</th>
                                  <th className="text-right py-1">Total</th>
                                  <th className="text-right py-1">Allocated</th>
                                  <th className="text-right py-1">Balance</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(v.bills ?? []).map((b: any) => (
                                  <tr key={b.billKey ?? b.purchaseId} className="border-t border-border/50">
                                    <td className="py-1.5 font-mono">{b.invoiceNumber || `PB #${String(b.purchaseId ?? b.assetPurchaseId).padStart(4, '0')}`}</td>
                                    <td className="py-1.5">{dfmt(b.purchaseDate)}</td>
                                    <td className="py-1.5 text-right">
                                      <Badge variant="outline" className={`font-mono text-[10px] ${bucketBadge(b.bucket)}`}>{b.daysOld} d</Badge>
                                    </td>
                                    <td className="py-1.5 text-right font-mono">{inr(b.total)}</td>
                                    <td className="py-1.5 text-right font-mono">{inr(b.allocated)}</td>
                                    <td className="py-1.5 text-right font-mono font-semibold">{inr(b.balance)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {Number(v.unallocatedCredit) > 0 && (
                              <p className="text-[11px] text-muted-foreground mt-2">
                                {inr(v.unallocatedCredit)} paid but not yet allocated to specific bills.
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
