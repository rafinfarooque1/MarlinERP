import { useMemo, useState } from 'react';
import {
  useListSales, useListPurchases, useListItems,
  useListSalesReturns, useCreateSalesReturn, useUpdateSalesReturn,
  useListPurchaseReturns, useCreatePurchaseReturn, useUpdatePurchaseReturn,
  type SalesReturn, type PurchaseReturn,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { TransactionDialog, TransactionDialogContent } from '@/components/ui/transaction-dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BillCombobox } from '@/components/ui/bill-combobox';
import { Undo2, Plus, Search, Eye, Pencil, PackageX, ShieldOff, Wallet, Receipt, FileDown } from 'lucide-react';
import { downloadPDFFromEndpoint } from '@/lib/download';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateDashboard } from '@/lib/invalidateDashboard';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { StatusBadge } from '@/components/app/status-badge';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { inr } from '@/lib/currency';

const fmt = (n: unknown) => Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
// Paise rounding — must match the API's r2 so estimates equal the note total.
const r2 = (n: number) => Math.round(n * 100) / 100;
const dfmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const today = () => new Date().toISOString().split('T')[0];

// ─── New Sales Return dialog ──────────────────────────────────────────────────

function NewSalesReturnDialog({ open, onOpenChange, editing }: { open: boolean; onOpenChange: (v: boolean) => void; editing?: SalesReturn | null }) {
  const { data: sales = [] } = useListSales();
  const { data: items = [] } = useListItems();
  const { data: allReturns = [] } = useListSalesReturns();
  const createMutation = useCreateSalesReturn();
  const updateMutation = useUpdateSalesReturn();
  const queryClient = useQueryClient();
  const isPending = createMutation.isPending || updateMutation.isPending;

  // Edit mode remounts this component per return (keyed by the caller), so
  // initializing state from `editing` is safe.
  const [saleId, setSaleId] = useState<number>(editing?.saleId ?? 0);
  const [returnDate, setReturnDate] = useState(editing ? String(editing.returnDate).slice(0, 10) : today());
  const [reason, setReason] = useState(editing?.reason ?? '');
  const [qty, setQty] = useState<Record<number, string>>(() =>
    editing
      ? Object.fromEntries((editing.lineItems || []).map((li: any) => [li.lineIndex, String(li.quantity)]))
      : {},
  );

  // Unsaved-data guard: a picked invoice, typed quantities/reason, or (in edit
  // mode) any change from the stored return counts as dirty.
  const dirty = editing
    ? returnDate !== String(editing.returnDate).slice(0, 10)
      || reason !== (editing.reason ?? '')
      || JSON.stringify(qty) !== JSON.stringify(Object.fromEntries((editing.lineItems || []).map((li: any) => [li.lineIndex, String(li.quantity)])))
    : saleId !== 0 || reason !== '' || returnDate !== today() || Object.values(qty).some(v => Number(v) > 0);

  const itemName = (id: number) => (items as any[]).find(i => i.id === id)?.name || `Item #${id}`;

  // Full list, newest first — the combobox searches over all of it and only
  // caps how many rows it renders at once.
  const candidates = useMemo(
    () => [...(sales as any[])].sort((a, b) => b.id - a.id),
    [sales],
  );
  const sale: any = candidates.find(s => s.id === saleId);
  const saleOptions = useMemo(
    () => candidates.map((s: any) => ({
      id: s.id,
      number: s.invoiceNumber || `Sale #${s.id}`,
      party: s.customerName || 'Walk-in',
      amount: s.totalAmount,
      date: s.saleDate,
    })),
    [candidates],
  );

  // Quantities already returned against this sale, per original line index —
  // excluding the return being edited (its own quantities are being replaced).
  const returnedByIx = useMemo(() => {
    const m = new Map<number, number>();
    (allReturns as SalesReturn[]).filter(r => r.saleId === saleId && r.id !== editing?.id).forEach(r =>
      (r.lineItems || []).forEach((li: any) => m.set(li.lineIndex, (m.get(li.lineIndex) ?? 0) + Number(li.quantity))),
    );
    return m;
  }, [allReturns, saleId, editing?.id]);

  const lines: any[] = sale?.lineItems ?? [];
  const rows = lines.map((li, ix) => {
    const sold = Number(li.quantity);
    const returned = returnedByIx.get(ix) ?? 0;
    const remaining = Math.max(0, sold - returned);
    // Mirror the server's credit-note math exactly: the CN prorates the
    // ORIGINAL invoice line's stored money — taxable value (net of every
    // discount) plus its GST legs. Today's item master price plays no part,
    // and neither does the gross unitPrice: a discounted line refunds the
    // discounted value.
    const taxable = Number(li.taxableAmount ?? li.lineSubtotal ?? 0);
    const tax = Number(li.cgst ?? 0) + Number(li.sgst ?? 0) + Number(li.igst ?? 0);
    const lineValue = taxable + tax; // full original line, incl. GST
    const effRate = sold > 0 ? lineValue / sold : 0; // per-unit refund value
    const discount = Number(li.discount ?? 0); // item discount + bill-discount share
    const gstRate = Number(li.taxRate ?? 0);
    return { ix, li, sold, returned, remaining, effRate, discount, gstRate, lineValue };
  });

  // Same per-component paise rounding sequence as the API's create path, so
  // this figure equals the credit note total even on fractional quantities.
  const estRefund = rows.reduce((s, r) => {
    const q = Number(qty[r.ix] || 0);
    if (!(q > 0) || !(r.sold > 0)) return s;
    const frac = q / r.sold;
    const taxable = r2(Number(r.li.taxableAmount ?? r.li.lineSubtotal ?? 0) * frac);
    const tax = r2(r2(Number(r.li.cgst ?? 0) * frac) + r2(Number(r.li.sgst ?? 0) * frac) + r2(Number(r.li.igst ?? 0) * frac));
    return r2(s + r2(taxable + tax));
  }, 0);

  const reset = () => { if (!editing) { setSaleId(0); setReturnDate(today()); setReason(''); setQty({}); } };

  const submit = () => {
    if (!sale) { toast.error('Pick an invoice first'); return; }
    const selected = rows
      .map(r => ({ lineIndex: r.ix, quantity: Number(qty[r.ix] || 0), remaining: r.remaining }))
      .filter(l => l.quantity > 0);
    if (selected.length === 0) { toast.error('Enter a return quantity on at least one line'); return; }
    const bad = selected.find(l => l.quantity > l.remaining);
    if (bad) { toast.error(`Line ${bad.lineIndex + 1}: only ${bad.remaining} left to return`); return; }

    if (editing) {
      updateMutation.mutate(
        { id: editing.id, returnDate, reason: reason.trim() || undefined, lines: selected.map(({ lineIndex, quantity }) => ({ lineIndex, quantity })) },
        {
          onSuccess: (r: any) => {
            toast.success(`${editing.returnNumber} updated — new value ${inr(r?.totalAmount)}`);
            invalidateDashboard(queryClient);
            onOpenChange(false);
          },
          onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not update the return'),
        },
      );
      return;
    }

    createMutation.mutate(
      { saleId: sale.id, returnDate, reason: reason.trim() || undefined, lines: selected.map(({ lineIndex, quantity }) => ({ lineIndex, quantity })) },
      {
        onSuccess: (r: any) => {
          toast.success(
            r?.refundMode === 'cash'
              ? `${r.returnNumber} recorded — cash refund ${inr(r.totalAmount)}`
              : `${r?.returnNumber} recorded — Credit Note ${r?.creditNoteNumber ?? ''} issued`,
          );
          invalidateDashboard(queryClient);
          reset();
          onOpenChange(false);
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not record the return'),
      },
    );
  };

  return (
    <TransactionDialog open={open} dirty={dirty} onOpenChange={v => { if (!v) reset(); onOpenChange(v); }}>
      <TransactionDialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.returnNumber}` : 'New Sales Return'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change the date, reason or quantities. The invoice and the return number stay the same.'
              : 'Pick the original invoice, then enter how many units are coming back.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Invoice</label>
              {editing ? (
                <Input value={editing.invoiceNumber || `Sale #${editing.saleId}`} disabled className="font-mono" />
              ) : (
                <BillCombobox
                  options={saleOptions}
                  value={saleId}
                  onChange={id => { setSaleId(id); setQty({}); }}
                  placeholder="Select invoice…"
                  searchPlaceholder="Search invoice no. or customer…"
                  emptyLabel="No matching invoices"
                  data-testid="select-sales-return-invoice"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Return date</label>
              <Input type="date" value={returnDate} onChange={e => setReturnDate(e.target.value)} />
            </div>
          </div>

          {sale && (
            <>
              <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs flex flex-wrap gap-x-4 gap-y-1">
                <span><span className="text-muted-foreground">Invoice:</span> <strong className="font-mono">{sale.invoiceNumber || `Sale #${sale.id}`}</strong></span>
                <span><span className="text-muted-foreground">Customer:</span> <strong>{sale.customerName || 'Walk-in'}</strong></span>
                <span><span className="text-muted-foreground">Sold on:</span> {dfmt(sale.saleDate)}</span>
                <span><span className="text-muted-foreground">Refund via:</span> <strong>{sale.customerId ? 'Credit Note' : 'Cash refund'}</strong></span>
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] text-xs">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-left px-3 py-2">Item</th>
                      <th className="text-right px-2 py-2">Sold</th>
                      <th className="text-right px-2 py-2">Returned</th>
                      <th className="text-right px-2 py-2">Left</th>
                      <th className="text-right px-2 py-2">Rate</th>
                      <th className="text-right px-2 py-2" title="Item discount plus this line's share of any bill discount (pre-tax)">Line Disc.</th>
                      <th className="text-right px-2 py-2">GST</th>
                      <th className="text-right px-2 py-2" title="Per-unit refund value from the original invoice, incl. GST">Net Rate</th>
                      <th className="text-right px-3 py-2 w-24">Return Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.ix} className={`border-t border-border ${r.remaining === 0 ? 'opacity-50' : ''}`}>
                        <td className="px-3 py-2 font-medium">{r.li.itemName || itemName(Number(r.li.itemId))}</td>
                        <td className="text-right px-2 py-2">{r.sold}</td>
                        <td className="text-right px-2 py-2">{r.returned > 0 ? r.returned : '—'}</td>
                        <td className="text-right px-2 py-2 font-semibold">{r.remaining}</td>
                        <td className="text-right px-2 py-2 font-mono">{inr(r.li.unitPrice)}</td>
                        <td className="text-right px-2 py-2 font-mono">{r.discount > 0 ? `−${inr(r.discount)}` : '—'}</td>
                        <td className="text-right px-2 py-2">{r.gstRate > 0 ? `${r.gstRate}%` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono font-semibold">{inr(r.effRate)}</td>
                        <td className="text-right px-3 py-1.5">
                          <Input
                            type="number" min={0} max={r.remaining} step="any" disabled={r.remaining === 0}
                            className="h-8 text-right font-mono" placeholder="0"
                            value={qty[r.ix] ?? ''}
                            onChange={e => setQty(q => ({ ...q, [r.ix]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Rate, line discounts and GST come from the original invoice — the refund reverses the line values
                actually charged (Net Rate × quantity), never today's item price. Bill-level coupon discounts are
                not prorated into returns.
              </p>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Reason <span className="text-muted-foreground font-normal">(optional)</span></label>
                <Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Damaged in transit, wrong flavour delivered…" />
              </div>
              <div className="flex justify-between items-center rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Approx. refund value (incl. GST)</span>
                <span className="font-mono font-bold text-primary">{inr(estRefund)}</span>
              </div>
            </>
          )}
        </div>
        <DialogFooter className="pt-2">
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={submit} disabled={isPending || !sale} data-testid="button-submit-sales-return">
            {isPending ? 'Saving…' : editing ? 'Save Changes' : 'Record Return'}
          </Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ─── New Purchase Return dialog ───────────────────────────────────────────────

function NewPurchaseReturnDialog({ open, onOpenChange, editing }: { open: boolean; onOpenChange: (v: boolean) => void; editing?: PurchaseReturn | null }) {
  const { data: purchases = [] } = useListPurchases();
  const { data: allReturns = [] } = useListPurchaseReturns();
  const createMutation = useCreatePurchaseReturn();
  const updateMutation = useUpdatePurchaseReturn();
  const queryClient = useQueryClient();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const [purchaseId, setPurchaseId] = useState<number>(editing?.purchaseId ?? 0);
  const [returnDate, setReturnDate] = useState(editing ? String(editing.returnDate).slice(0, 10) : today());
  const [reason, setReason] = useState(editing?.reason ?? '');
  const [qty, setQty] = useState<Record<number, string>>(() =>
    editing
      ? Object.fromEntries((editing.lineItems || []).map((li: any) => [li.lineIndex, String(li.quantity)]))
      : {},
  );

  // Unsaved-data guard: a picked bill, typed quantities/reason, or (in edit
  // mode) any change from the stored return counts as dirty.
  const dirty = editing
    ? returnDate !== String(editing.returnDate).slice(0, 10)
      || reason !== (editing.reason ?? '')
      || JSON.stringify(qty) !== JSON.stringify(Object.fromEntries((editing.lineItems || []).map((li: any) => [li.lineIndex, String(li.quantity)])))
    : purchaseId !== 0 || reason !== '' || returnDate !== today() || Object.values(qty).some(v => Number(v) > 0);

  // Full list, newest first — the combobox searches over all of it and only
  // caps how many rows it renders at once.
  const candidates = useMemo(
    () => [...(purchases as any[])].sort((a, b) => b.id - a.id),
    [purchases],
  );
  const purchase: any = candidates.find(p => p.id === purchaseId);
  const purchaseOptions = useMemo(
    () => candidates.map((p: any) => ({
      id: p.id,
      number: p.invoiceNumber || `PB #${String(p.id).padStart(4, '0')}`,
      party: p.vendorName || 'Vendor',
      amount: p.totalAmount,
      date: p.purchaseDate,
    })),
    [candidates],
  );

  const returnedByIx = useMemo(() => {
    const m = new Map<number, number>();
    (allReturns as PurchaseReturn[]).filter(r => r.purchaseId === purchaseId && r.id !== editing?.id).forEach(r =>
      (r.lineItems || []).forEach((li: any) => m.set(li.lineIndex, (m.get(li.lineIndex) ?? 0) + Number(li.quantity))),
    );
    return m;
  }, [allReturns, purchaseId, editing?.id]);

  const lines: any[] = purchase?.lineItems ?? [];
  const rows = lines.map((li, ix) => {
    const bought = Number(li.quantity);
    const returned = returnedByIx.get(ix) ?? 0;
    const remaining = Math.max(0, bought - returned);
    // Mirror the server's debit-note math exactly: it prorates the ORIGINAL
    // bill line's stored taxable value (net of discount) plus its GST legs —
    // never the current item cost.
    const taxable = Number(li.taxableValue ?? 0);
    const tax = Number(li.cgst ?? 0) + Number(li.sgst ?? 0) + Number(li.igst ?? 0);
    const lineValue = taxable + tax; // full original line, incl. GST
    const effRate = bought > 0 ? lineValue / bought : 0;
    const discount = Number(li.discountAmt ?? li.discount ?? 0);
    const gstRate = Number(li.gstRate ?? 0);
    return { ix, li, bought, returned, remaining, effRate, discount, gstRate, lineValue };
  });

  // Same per-component paise rounding sequence as the API's create path, so
  // this figure equals the debit note total even on fractional quantities.
  const estValue = rows.reduce((s, r) => {
    const q = Number(qty[r.ix] || 0);
    if (!(q > 0) || !(r.bought > 0)) return s;
    const frac = q / r.bought;
    const taxable = r2(Number(r.li.taxableValue ?? 0) * frac);
    const tax = r2(r2(Number(r.li.cgst ?? 0) * frac) + r2(Number(r.li.sgst ?? 0) * frac) + r2(Number(r.li.igst ?? 0) * frac));
    return r2(s + r2(taxable + tax));
  }, 0);

  const reset = () => { if (!editing) { setPurchaseId(0); setReturnDate(today()); setReason(''); setQty({}); } };

  const submit = () => {
    if (!purchase) { toast.error('Pick a purchase bill first'); return; }
    const selected = rows
      .map(r => ({ lineIndex: r.ix, quantity: Number(qty[r.ix] || 0), remaining: r.remaining }))
      .filter(l => l.quantity > 0);
    if (selected.length === 0) { toast.error('Enter a return quantity on at least one line'); return; }
    const bad = selected.find(l => l.quantity > l.remaining);
    if (bad) { toast.error(`Line ${bad.lineIndex + 1}: only ${bad.remaining} left to return`); return; }

    if (editing) {
      updateMutation.mutate(
        { id: editing.id, returnDate, reason: reason.trim() || undefined, lines: selected.map(({ lineIndex, quantity }) => ({ lineIndex, quantity })) },
        {
          onSuccess: (r: any) => {
            toast.success(`${editing.returnNumber} updated — new value ${inr(r?.totalAmount)}`);
            invalidateDashboard(queryClient);
            onOpenChange(false);
          },
          onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not update the return'),
        },
      );
      return;
    }

    createMutation.mutate(
      { purchaseId: purchase.id, returnDate, reason: reason.trim() || undefined, lines: selected.map(({ lineIndex, quantity }) => ({ lineIndex, quantity })) },
      {
        onSuccess: (r: any) => {
          toast.success(`${r?.returnNumber} recorded — Debit Note ${r?.debitNoteNumber ?? ''} issued`);
          invalidateDashboard(queryClient);
          reset();
          onOpenChange(false);
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not record the return'),
      },
    );
  };

  return (
    <TransactionDialog open={open} dirty={dirty} onOpenChange={v => { if (!v) reset(); onOpenChange(v); }}>
      <TransactionDialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.returnNumber}` : 'New Purchase Return'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change the date, reason or quantities. The bill and the return number stay the same.'
              : 'Pick the original purchase bill, then enter the quantities going back to the vendor.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Purchase bill</label>
              {editing ? (
                <Input value={editing.invoiceNumber || `PB #${String(editing.purchaseId).padStart(4, '0')}`} disabled className="font-mono" />
              ) : (
                <BillCombobox
                  options={purchaseOptions}
                  value={purchaseId}
                  onChange={id => { setPurchaseId(id); setQty({}); }}
                  placeholder="Select bill…"
                  searchPlaceholder="Search bill no. or vendor…"
                  emptyLabel="No matching bills"
                  data-testid="select-purchase-return-bill"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Return date</label>
              <Input type="date" value={returnDate} onChange={e => setReturnDate(e.target.value)} />
            </div>
          </div>

          {purchase && (
            <>
              <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs flex flex-wrap gap-x-4 gap-y-1">
                <span><span className="text-muted-foreground">Bill:</span> <strong className="font-mono">{purchase.invoiceNumber || `PB #${String(purchase.id).padStart(4, '0')}`}</strong></span>
                <span><span className="text-muted-foreground">Vendor:</span> <strong>{purchase.vendorName}</strong></span>
                <span><span className="text-muted-foreground">Billed on:</span> {dfmt(purchase.purchaseDate)}</span>
                <span><span className="text-muted-foreground">Adjustment via:</span> <strong>Debit Note</strong></span>
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] text-xs">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-left px-3 py-2">Material</th>
                      <th className="text-right px-2 py-2">Bought</th>
                      <th className="text-right px-2 py-2">Returned</th>
                      <th className="text-right px-2 py-2">Left</th>
                      <th className="text-right px-2 py-2">Rate</th>
                      <th className="text-right px-2 py-2" title="This line's discount on the original bill (pre-tax)">Line Disc.</th>
                      <th className="text-right px-2 py-2">GST</th>
                      <th className="text-right px-2 py-2" title="Per-unit debit value from the original bill, incl. GST">Net Rate</th>
                      <th className="text-right px-3 py-2 w-24">Return Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.ix} className={`border-t border-border ${r.remaining === 0 ? 'opacity-50' : ''}`}>
                        <td className="px-3 py-2 font-medium">
                          {r.li.materialName || `#${r.li.materialId}`}
                          {r.li.batchNumber && (
                            <div className="text-[10px] text-muted-foreground font-mono font-normal">
                              Batch {r.li.batchNumber}{r.li.expiryDate ? ` · exp ${dfmt(r.li.expiryDate)}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="text-right px-2 py-2">{r.bought}</td>
                        <td className="text-right px-2 py-2">{r.returned > 0 ? r.returned : '—'}</td>
                        <td className="text-right px-2 py-2 font-semibold">{r.remaining}</td>
                        <td className="text-right px-2 py-2 font-mono">{inr(r.li.unitCost)}</td>
                        <td className="text-right px-2 py-2 font-mono">{r.discount > 0 ? `−${inr(r.discount)}` : '—'}</td>
                        <td className="text-right px-2 py-2">{r.gstRate > 0 ? `${r.gstRate}%` : '—'}</td>
                        <td className="text-right px-2 py-2 font-mono font-semibold">{inr(r.effRate)}</td>
                        <td className="text-right px-3 py-1.5">
                          <Input
                            type="number" min={0} max={r.remaining} step="any" disabled={r.remaining === 0}
                            className="h-8 text-right font-mono" placeholder="0"
                            value={qty[r.ix] ?? ''}
                            onChange={e => setQty(q => ({ ...q, [r.ix]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Rate, discount and GST come from the original purchase bill — the debit note reverses exactly what
                was billed (Net Rate × quantity), and stock goes out against the original batch and cost.
              </p>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Reason <span className="text-muted-foreground font-normal">(optional)</span></label>
                <Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Quality rejection, short supply…" />
              </div>
              <div className="flex justify-between items-center rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Approx. debit value (incl. GST)</span>
                <span className="font-mono font-bold text-primary">{inr(estValue)}</span>
              </div>
            </>
          )}
        </div>
        <DialogFooter className="pt-2">
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button onClick={submit} disabled={isPending || !purchase} data-testid="button-submit-purchase-return">
            {isPending ? 'Saving…' : editing ? 'Save Changes' : 'Record Return'}
          </Button>
        </DialogFooter>
      </TransactionDialogContent>
    </TransactionDialog>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Returns() {
  const perm = usePermission('page:/returns');
  const [tab, setTab] = useState<'sales' | 'purchase'>('sales');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editSR, setEditSR] = useState<SalesReturn | null>(null);
  const [editPR, setEditPR] = useState<PurchaseReturn | null>(null);
  const [view, setView] = useState<{ kind: 'sales'; doc: SalesReturn } | { kind: 'purchase'; doc: PurchaseReturn } | null>(null);

  const { data: salesReturns = [], isLoading: srLoading } = useListSalesReturns();
  const { data: purchaseReturns = [], isLoading: prLoading } = useListPurchaseReturns();

  const q = search.trim().toLowerCase();
  const filteredSR = (salesReturns as SalesReturn[]).filter(r =>
    !q || [r.returnNumber, r.invoiceNumber, r.customerName, r.creditNoteNumber].some(v => v && String(v).toLowerCase().includes(q)),
  );
  const filteredPR = (purchaseReturns as PurchaseReturn[]).filter(r =>
    !q || [r.returnNumber, r.invoiceNumber, r.vendorName, r.debitNoteNumber].some(v => v && String(v).toLowerCase().includes(q)),
  );

  const isLoading = tab === 'sales' ? srLoading : prLoading;
  const empty = tab === 'sales' ? filteredSR.length === 0 : filteredPR.length === 0;

  // Client-side pagination over the already-filtered sets (furniture only).
  const srPage = useClientPage(filteredSR);
  const prPage = useClientPage(filteredPR);
  const pager = tab === 'sales' ? srPage : prPage;

  const srCount = (salesReturns as SalesReturn[]).length;
  const srTotal = (salesReturns as SalesReturn[]).reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);
  const prCount = (purchaseReturns as PurchaseReturn[]).length;
  const prTotal = (purchaseReturns as PurchaseReturn[]).reduce((s, r) => s + Number(r.totalAmount ?? 0), 0);

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
          title="Returns"
          description="Sales returns restock inventory and issue credit notes; purchase returns raise debit notes on the vendor."
          icon={Undo2}
          actions={perm.canAdd && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> {tab === 'sales' ? 'New Sales Return' : 'New Purchase Return'}
            </Button>
          )}
        />

        <SummaryCardGrid>
          <SummaryCard
            label="Sales Returns"
            value={srCount.toLocaleString('en-IN')}
            sub={`${inr(srTotal)} credited`}
            icon={Receipt}
            tone="info"
            loading={srLoading}
          />
          <SummaryCard
            label="Purchase Returns"
            value={prCount.toLocaleString('en-IN')}
            sub={`${inr(prTotal)} debited`}
            icon={Wallet}
            tone="info"
            loading={prLoading}
          />
        </SummaryCardGrid>

        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/30">
            {([['sales', 'Sales Returns'], ['purchase', 'Purchase Returns']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === k ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[220px] max-w-xs max-md:max-w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search number, party, note…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="p-4">
              <TableSkeleton rows={8} cols={7} />
            </div>
          ) : empty ? (
            <EmptyState
              icon={PackageX}
              title={`No ${tab === 'sales' ? 'sales' : 'purchase'} returns yet`}
              hint={tab === 'sales' ? 'Record one when a customer brings stock back.' : 'Record one when goods go back to a vendor.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-4 py-2.5">Return #</th>
                    <th className="text-left px-3 py-2.5">Date</th>
                    <th className="text-left px-3 py-2.5">{tab === 'sales' ? 'Invoice' : 'Bill'}</th>
                    <th className="text-left px-3 py-2.5">{tab === 'sales' ? 'Customer' : 'Vendor'}</th>
                    <th className="text-right px-3 py-2.5">Amount</th>
                    <th className="text-left px-3 py-2.5">{tab === 'sales' ? 'Refund' : 'Debit Note'}</th>
                    <th className="text-right px-4 py-2.5 w-14"></th>
                  </tr>
                </thead>
                <tbody>
                  {tab === 'sales'
                    ? srPage.pageRows.map(r => (
                        <tr key={r.id} className="border-t border-border hover:bg-muted/10">
                          <td className="px-4 py-2.5 font-mono font-semibold text-primary">{r.returnNumber}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">{dfmt(r.returnDate)}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{r.invoiceNumber || `Sale #${r.saleId}`}</td>
                          <td className="px-3 py-2.5">{r.customerName || 'Walk-in'}</td>
                          <td className="px-3 py-2.5 text-right font-mono font-semibold">{inr(r.totalAmount)}</td>
                          <td className="px-3 py-2.5">
                            {r.refundMode === 'cash'
                              ? <StatusBadge status="partial" label="Cash refund" />
                              : <StatusBadge status="completed" label={r.creditNoteNumber || 'Credit Note'} className="font-mono" />}
                          </td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setView({ kind: 'sales', doc: r })} data-testid={`button-view-sr-${r.id}`}><Eye className="w-4 h-4" /></Button>
                            {perm.canDownload && (
                              <Button variant="ghost" size="icon" className="h-7 w-7" title="Download PDF"
                                onClick={() => downloadPDFFromEndpoint('/api/pdf/sales-return', { id: r.id }, `${r.returnNumber}.pdf`).catch((e: any) => toast.error(e?.message ?? 'PDF failed'))}
                                data-testid={`button-pdf-sr-${r.id}`}><FileDown className="w-4 h-4" /></Button>
                            )}
                            {perm.canEdit && (
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditSR(r)} data-testid={`button-edit-sr-${r.id}`}><Pencil className="w-4 h-4" /></Button>
                            )}
                          </td>
                        </tr>
                      ))
                    : prPage.pageRows.map(r => (
                        <tr key={r.id} className="border-t border-border hover:bg-muted/10">
                          <td className="px-4 py-2.5 font-mono font-semibold text-primary">{r.returnNumber}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">{dfmt(r.returnDate)}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{r.invoiceNumber || `PB #${String(r.purchaseId).padStart(4, '0')}`}</td>
                          <td className="px-3 py-2.5">{r.vendorName}</td>
                          <td className="px-3 py-2.5 text-right font-mono font-semibold">{inr(r.totalAmount)}</td>
                          <td className="px-3 py-2.5"><StatusBadge status="converted" label={r.debitNoteNumber || 'Debit Note'} className="font-mono" /></td>
                          <td className="px-4 py-2.5 text-right whitespace-nowrap">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setView({ kind: 'purchase', doc: r })} data-testid={`button-view-pr-${r.id}`}><Eye className="w-4 h-4" /></Button>
                            {perm.canDownload && (
                              <Button variant="ghost" size="icon" className="h-7 w-7" title="Download PDF"
                                onClick={() => downloadPDFFromEndpoint('/api/pdf/purchase-return', { id: r.id }, `${r.returnNumber}.pdf`).catch((e: any) => toast.error(e?.message ?? 'PDF failed'))}
                                data-testid={`button-pdf-pr-${r.id}`}><FileDown className="w-4 h-4" /></Button>
                            )}
                            {perm.canEdit && (
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditPR(r)} data-testid={`button-edit-pr-${r.id}`}><Pencil className="w-4 h-4" /></Button>
                            )}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {!isLoading && !empty && <TablePager {...pager.pagerProps} />}
      </div>

      {tab === 'sales'
        ? <NewSalesReturnDialog open={createOpen} onOpenChange={setCreateOpen} />
        : <NewPurchaseReturnDialog open={createOpen} onOpenChange={setCreateOpen} />}

      {/* ── Edit dialogs (remounted per return so state prefills cleanly) ── */}
      {editSR && (
        <NewSalesReturnDialog key={`edit-sr-${editSR.id}`} open editing={editSR}
          onOpenChange={v => { if (!v) setEditSR(null); }} />
      )}
      {editPR && (
        <NewPurchaseReturnDialog key={`edit-pr-${editPR.id}`} open editing={editPR}
          onOpenChange={v => { if (!v) setEditPR(null); }} />
      )}

      {/* ── View return sheet ── */}
      <Sheet open={!!view} onOpenChange={v => !v && setView(null)}>
        <SheetContent className="sm:max-w-xl overflow-y-auto">
          {view && (
            <>
              <SheetHeader className="mb-4">
                <SheetTitle className="text-primary font-mono">{view.doc.returnNumber}</SheetTitle>
                <SheetDescription>
                  {view.kind === 'sales'
                    ? `${(view.doc as SalesReturn).customerName || 'Walk-in'} · against ${(view.doc as SalesReturn).invoiceNumber || `Sale #${(view.doc as SalesReturn).saleId}`} · ${dfmt(view.doc.returnDate)}`
                    : `${(view.doc as PurchaseReturn).vendorName} · against ${(view.doc as PurchaseReturn).invoiceNumber || `PB #${(view.doc as PurchaseReturn).purchaseId}`} · ${dfmt(view.doc.returnDate)}`}
                </SheetDescription>
              </SheetHeader>

              <div className="border border-border rounded-lg overflow-hidden mb-4">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-left px-3 py-2">{view.kind === 'sales' ? 'Item' : 'Material'}</th>
                      <th className="text-right px-2 py-2">Qty</th>
                      <th className="text-right px-2 py-2" title="Per-unit value credited/debited, incl. GST — from the original document">Net Rate</th>
                      <th className="text-right px-2 py-2">Tax</th>
                      <th className="text-right px-3 py-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(view.doc.lineItems as any[]).map((li: any, i: number) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-2 font-medium">
                          {view.kind === 'sales' ? (li.itemName || `Item #${li.itemId}`) : (li.materialName || `#${li.materialId}`)}
                          {view.kind === 'sales' && Array.isArray(li.batchRestore) && li.batchRestore.length > 0 && (
                            <span className="block text-[10px] font-mono text-muted-foreground">
                              Restocked: {li.batchRestore.map((b: any) => `${b.batchNumber ?? 'Untracked'} ×${b.quantity}`).join(', ')}
                            </span>
                          )}
                        </td>
                        <td className="text-right px-2 py-2">{li.quantity}</td>
                        <td className="text-right px-2 py-2 font-mono">{inr(
                          Number(li.quantity) > 0 && li.grossAmount != null
                            ? Number(li.grossAmount) / Number(li.quantity)
                            : (li.unitPrice ?? li.unitCost),
                        )}</td>
                        <td className="text-right px-2 py-2 font-mono">{inr(li.taxAmount)}</td>
                        <td className="text-right px-3 py-2 font-mono font-semibold">{inr(li.grossAmount ?? li.lineTotal ?? Number(li.quantity ?? 0) * Number(li.unitPrice ?? li.unitCost ?? 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="bg-muted/20 rounded-lg p-4 space-y-2 text-sm mb-4">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-mono">{inr(view.doc.subtotal)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">GST</span><span className="font-mono">{inr(view.doc.taxTotal)}</span></div>
                <Separator />
                <div className="flex justify-between font-bold"><span>Total</span><span className="font-mono text-primary">{inr(view.doc.totalAmount)}</span></div>
                <div className="flex justify-between text-xs pt-1">
                  <span className="text-muted-foreground">{view.kind === 'sales' ? 'Refund' : 'Adjustment'}</span>
                  <span className="font-mono font-semibold">
                    {view.kind === 'sales'
                      ? ((view.doc as SalesReturn).refundMode === 'cash' ? 'Cash refund' : (view.doc as SalesReturn).creditNoteNumber || 'Credit Note')
                      : (view.doc as PurchaseReturn).debitNoteNumber || 'Debit Note'}
                  </span>
                </div>
              </div>

              {view.doc.reason && <p className="text-sm text-muted-foreground italic">“{view.doc.reason}”</p>}
            </>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
