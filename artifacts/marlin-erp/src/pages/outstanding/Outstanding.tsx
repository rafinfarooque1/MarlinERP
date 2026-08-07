import { Fragment, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useReceivablesAging, usePayablesAging, useCollections, useCreateSalePayment,
  getReceivablesAgingQueryKey, getPayablesAgingQueryKey, getCollectionsQueryKey,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { ReceiveIntoSelect } from '@/components/receive-into-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { HandCoins, ChevronDown, ChevronRight, Search, Wallet, Phone, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';

const fmt = (n: unknown) => Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
const fmt0 = (n: unknown) => Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const dfmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const today = () => new Date().toISOString().split('T')[0];

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

// ─── Record payment dialog (collections) ─────────────────────────────────────

function CollectPaymentDialog({ item, onOpenChange }: { item: any | null; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const createPayment = useCreateSalePayment();
  const [amount, setAmount] = useState('');
  const [ledgerId, setLedgerId] = useState(0);
  const [reference, setReference] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());

  // Sync form when a new invoice is picked
  const [lastId, setLastId] = useState<number | null>(null);
  if (item && item.saleId !== lastId) {
    setLastId(item.saleId);
    setAmount(String(item.balanceDue ?? ''));
    setLedgerId(0);
    setReference('');
    setPaymentDate(today());
  }

  const submit = () => {
    if (!item) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a valid amount'); return; }
    if (amt > Number(item.balanceDue) + 0.01) { toast.error(`Amount exceeds balance due (₹${fmt(item.balanceDue)})`); return; }
    if (!ledgerId) { toast.error('Pick the Cash / Bank account the money went into'); return; }
    createPayment.mutate(
      { saleId: item.saleId, data: { receivedInLedgerId: ledgerId, amount: amt, referenceNumber: reference.trim() || undefined, paymentDate } },
      {
        onSuccess: () => {
          toast.success(`₹${fmt(amt)} recorded against ${item.invoiceNumber || `Sale #${item.saleId}`}`);
          qc.invalidateQueries({ queryKey: getCollectionsQueryKey() });
          qc.invalidateQueries({ queryKey: getReceivablesAgingQueryKey() });
          qc.invalidateQueries({ queryKey: getPayablesAgingQueryKey() });
          onOpenChange(false);
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not record the payment'),
      },
    );
  };

  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Collect Payment</DialogTitle>
          <DialogDescription>
            {item && <>Against <span className="font-mono">{item.invoiceNumber || `Sale #${item.saleId}`}</span> · {item.customerName || 'Walk-in'} · balance ₹{fmt(item.balanceDue)}</>}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Amount (₹)</label>
              <Input type="number" min={0} step="0.01" className="font-mono" value={amount} onChange={e => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Date</label>
              <Input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Receive Into <span className="text-muted-foreground font-normal">(Cash / Bank)</span></label>
              <ReceiveIntoSelect
                locationType={item?.locationType}
                locationId={item?.locationId}
                value={ledgerId}
                onChange={setLedgerId}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Reference <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Input value={reference} onChange={e => setReference(e.target.value)} placeholder="UTR / cheque no." />
            </div>
          </div>
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={createPayment.isPending}>
            {createPayment.isPending ? 'Recording…' : 'Record Payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Outstanding() {
  const perm = usePermission('page:/outstanding');
  const [tab, setTab] = useState<'receivables' | 'payables' | 'collections'>('receivables');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [collectItem, setCollectItem] = useState<any | null>(null);
  // Historical position: empty = today (the original, current view). Aging is
  // a position, so a single as-of date is the whole date dimension here.
  // Collections is a worklist of what to chase NOW and stays at today.
  const [asOf, setAsOf] = useState('');

  const { data: recv, isLoading: recvLoading } = useReceivablesAging(asOf || undefined);
  const { data: pay, isLoading: payLoading } = usePayablesAging(asOf || undefined);
  const { data: coll, isLoading: collLoading } = useCollections();

  const q = search.trim().toLowerCase();

  const customers = ((recv as any)?.customers ?? []).filter((c: any) => !q || c.name?.toLowerCase().includes(q) || c.phone?.includes(q));
  const vendors = ((pay as any)?.vendors ?? []).filter((v: any) => !q || v.name?.toLowerCase().includes(q) || v.phone?.includes(q));
  const collItems = ((coll as any)?.items ?? []).filter((it: any) =>
    !q || [it.invoiceNumber, it.customerName, it.customerPhone].some((v: any) => v && String(v).toLowerCase().includes(q)),
  );

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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="w-6 h-6 text-primary" /> Outstanding</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Who owes you, whom you owe, and which invoices to chase today.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/30">
            {([['receivables', 'Receivables'], ['payables', 'Payables'], ['collections', 'Collections']] as const).map(([k, label]) => (
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
            <Input className="pl-9" placeholder={tab === 'collections' ? 'Search invoice or customer…' : 'Search party…'} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {tab !== 'collections' && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground whitespace-nowrap">As of</span>
              <Input type="date" className="w-36 h-9" value={asOf} onChange={e => setAsOf(e.target.value)} />
              {asOf && (
                <button onClick={() => setAsOf('')} className="text-xs text-muted-foreground hover:text-foreground underline">
                  Today
                </button>
              )}
            </div>
          )}
        </div>
        {tab !== 'collections' && asOf && (
          <p className="text-xs text-muted-foreground -mt-3">
            Showing the position as it stood on {asOf} — bills, payments and notes after that date are ignored.
          </p>
        )}

        {/* ── Aging summary cards (receivables / payables) ── */}
        {tab !== 'collections' && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Aged Bills</p>
              <p className="text-lg font-bold font-mono mt-1">₹{fmt0(totals?.totalDue)}</p>
            </div>
            {BUCKETS.map(b => (
              <div key={b.key} className="bg-card border border-border rounded-xl p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{b.label}</p>
                <p className={`text-lg font-bold font-mono mt-1 ${b.cls}`}>₹{fmt0(totals?.[b.key])}</p>
              </div>
            ))}
            {/* The control figure. It comes from the party ledgers, so it equals
                Sundry Debtors / Sundry Creditors on the Balance Sheet. The
                buckets to the left show only the part that maps to dated bills. */}
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Balance (ledger)</p>
              <p className="text-lg font-bold font-mono mt-1 text-primary">₹{fmt0(totals?.netDue)}</p>
            </div>
          </div>
        )}

        {/* Anything the ledger says is owed that no dated document explains —
            an opening balance, or a journal raising the liability directly.
            Surfaced rather than dropped so the buckets and the control figure
            can be reconciled by eye. */}
        {tab !== 'collections' && Number((totals as any)?.[tab === 'receivables' ? 'uninvoiced' : 'unbilled']) > 0.004 && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
            <span className="font-medium text-amber-600">
              ₹{fmt((totals as any)[tab === 'receivables' ? 'uninvoiced' : 'unbilled'])}
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
            <div className="p-12 text-center">
              <HandCoins className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
              <p className="font-medium">Nothing outstanding</p>
              <p className="text-sm text-muted-foreground mt-1">All customer invoices are fully paid.</p>
            </div>
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
                                <p className="text-[11px] text-amber-600 dark:text-amber-500">Credit balance (advance): ₹{fmt(c.advance)}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">{Number(c.creditLimit) > 0 ? `₹${fmt0(c.creditLimit)}` : '—'}</td>
                        {BUCKETS.map(b => (
                          <td key={b.key} className={`px-3 py-2.5 text-right font-mono ${Number(c[b.key]) > 0 ? b.cls : 'text-muted-foreground/50'}`}>
                            {Number(c[b.key]) > 0 ? `₹${fmt0(c[b.key])}` : '—'}
                          </td>
                        ))}
                        <td className="px-3 py-2.5 text-right font-mono text-emerald-600">{Number(c.creditNotes) > 0 ? `-₹${fmt0(c.creditNotes)}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-mono font-bold">₹{fmt(c.netDue)}</td>
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
                                    <td className="py-1.5 text-right font-mono">₹{fmt(inv.total)}</td>
                                    <td className="py-1.5 text-right font-mono">₹{fmt(inv.paid)}</td>
                                    <td className="py-1.5 text-right font-mono font-semibold">₹{fmt(inv.balance)}</td>
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
            <div className="p-12 text-center">
              <HandCoins className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
              <p className="font-medium">Nothing outstanding</p>
              <p className="text-sm text-muted-foreground mt-1">All vendor bills are settled.</p>
            </div>
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
                                <p className="text-[11px] text-amber-600 dark:text-amber-500">Advance with vendor: ₹{fmt(v.advance)}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">₹{fmt0(v.totalBilled)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs">₹{fmt0(v.totalPaid)}</td>
                        {BUCKETS.map(b => (
                          <td key={b.key} className={`px-3 py-2.5 text-right font-mono ${Number(v[b.key]) > 0 ? b.cls : 'text-muted-foreground/50'}`}>
                            {Number(v[b.key]) > 0 ? `₹${fmt0(v[b.key])}` : '—'}
                          </td>
                        ))}
                        <td className="px-3 py-2.5 text-right font-mono text-emerald-600">{Number(v.debitNotes) > 0 ? `-₹${fmt0(v.debitNotes)}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-mono font-bold">₹{fmt(v.netDue)}</td>
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
                                    <td className="py-1.5 text-right font-mono">₹{fmt(b.total)}</td>
                                    <td className="py-1.5 text-right font-mono">₹{fmt(b.allocated)}</td>
                                    <td className="py-1.5 text-right font-mono font-semibold">₹{fmt(b.balance)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {Number(v.unallocatedCredit) > 0 && (
                              <p className="text-[11px] text-muted-foreground mt-2">
                                ₹{fmt(v.unallocatedCredit)} paid but not yet allocated to specific bills.
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

          {/* ── COLLECTIONS ── */}
          {tab === 'collections' && (collLoading ? (
            <div className="p-10 text-center text-muted-foreground text-sm">Loading worklist…</div>
          ) : collItems.length === 0 ? (
            <div className="p-12 text-center">
              <HandCoins className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
              <p className="font-medium">Nothing to chase</p>
              <p className="text-sm text-muted-foreground mt-1">No unpaid or partly-paid credit invoices right now.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2.5">Invoice</th>
                    <th className="text-left px-3 py-2.5">Customer</th>
                    <th className="text-left px-3 py-2.5">Due date</th>
                    <th className="text-right px-3 py-2.5">Overdue</th>
                    <th className="text-right px-3 py-2.5">Total</th>
                    <th className="text-right px-3 py-2.5">Paid</th>
                    <th className="text-right px-3 py-2.5">Balance</th>
                    {perm.canAdd && <th className="text-right px-4 py-2.5 w-28"></th>}
                  </tr>
                </thead>
                <tbody>
                  {collItems.map((it: any) => (
                    <tr key={it.saleId} className="border-t border-border hover:bg-muted/10">
                      <td className="px-4 py-2.5">
                        <p className="font-mono font-semibold">{it.invoiceNumber || `Sale #${it.saleId}`}</p>
                        <p className="text-xs text-muted-foreground">{dfmt(it.saleDate)}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium">{it.customerName || 'Walk-in'}</p>
                        {it.customerPhone && <p className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" />{it.customerPhone}</p>}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{dfmt(it.dueDate)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <Badge variant="outline" className={`font-mono text-[10px] ${it.daysOverdue > 60 ? 'text-red-600 border-red-500/40' : it.daysOverdue > 30 ? 'text-orange-600 border-orange-500/40' : it.daysOverdue > 0 ? 'text-amber-600 border-amber-500/40' : 'text-emerald-600 border-emerald-500/40'}`}>
                          {it.daysOverdue > 0 ? `${it.daysOverdue} d` : 'current'}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono">₹{fmt(it.totalAmount)}</td>
                      <td className="px-3 py-2.5 text-right font-mono">₹{fmt(it.amountPaid)}</td>
                      <td className="px-3 py-2.5 text-right font-mono font-bold">₹{fmt(it.balanceDue)}</td>
                      {perm.canAdd && (
                        <td className="px-4 py-2.5 text-right">
                          <Button size="sm" variant="outline" className="h-7" onClick={() => setCollectItem(it)}>
                            <HandCoins className="w-3.5 h-3.5 mr-1.5" /> Collect
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>

      <CollectPaymentDialog item={collectItem} onOpenChange={v => { if (!v) setCollectItem(null); }} />
    </AppLayout>
  );
}
