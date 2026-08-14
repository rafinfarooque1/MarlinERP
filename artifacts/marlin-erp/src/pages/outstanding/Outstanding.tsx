import { Fragment, useState } from 'react';
import { useReceivablesAging, usePayablesAging } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { HandCoins, ChevronDown, ChevronRight, Search, Wallet, Phone, ShieldOff } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/empty-state';
import { inr } from '@/lib/currency';

const dfmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

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
  const [expanded, setExpanded] = useState<number | null>(null);
  // Historical position: empty = today (the original, current view). Aging is
  // a position, so a single as-of date is the whole date dimension here.
  const [asOf, setAsOf] = useState('');

  const { data: recv, isLoading: recvLoading } = useReceivablesAging(asOf || undefined);
  const { data: pay, isLoading: payLoading } = usePayablesAging(asOf || undefined);

  const q = search.trim().toLowerCase();

  const customers = ((recv as any)?.customers ?? []).filter((c: any) => !q || c.name?.toLowerCase().includes(q) || c.phone?.includes(q));
  const vendors = ((pay as any)?.vendors ?? []).filter((v: any) => !q || v.name?.toLowerCase().includes(q) || v.phone?.includes(q));

  const totals: any = tab === 'receivables' ? (recv as any)?.totals : (pay as any)?.totals;

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
                onClick={() => { setTab(k); setExpanded(null); }}
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
            <EmptyState icon={HandCoins} title="Nothing outstanding" hint="All customer invoices are fully paid." />
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
                      <tr className="border-t border-border hover:bg-muted/10 cursor-pointer" onClick={() => setExpanded(expanded === c.customerId ? null : c.customerId)}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            {expanded === c.customerId ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
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
                      {expanded === c.customerId && (
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
                                  <th className="text-right py-1">Balance</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(c.invoices ?? []).map((inv: any) => (
                                  <tr key={inv.saleId} className="border-t border-border/50">
                                    <td className="py-1.5 font-mono">{inv.invoiceNumber || `Sale #${inv.saleId}`}</td>
                                    <td className="py-1.5">{dfmt(inv.saleDate)}</td>
                                    <td className="py-1.5">{dfmt(inv.dueDate)}</td>
                                    <td className="py-1.5 text-right">
                                      <Badge variant="outline" className={`font-mono text-[10px] ${bucketBadge(inv.bucket)}`}>
                                        {inv.daysOverdue > 0 ? `${inv.daysOverdue} d` : 'current'}
                                      </Badge>
                                    </td>
                                    <td className="py-1.5 text-right font-mono">{inr(inv.total)}</td>
                                    <td className="py-1.5 text-right font-mono">{inr(inv.paid)}</td>
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
                      <tr className="border-t border-border hover:bg-muted/10 cursor-pointer" onClick={() => setExpanded(expanded === v.vendorId ? null : v.vendorId)}>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            {expanded === v.vendorId ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
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
                      {expanded === v.vendorId && (
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
