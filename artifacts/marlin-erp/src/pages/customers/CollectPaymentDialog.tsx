import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useReceivablesAging, useCreateSalePayment,
  getReceivablesAgingQueryKey, getCollectionsQueryKey, getListCustomersQueryKey,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { HandCoins } from 'lucide-react';
import { ReceiveIntoSelect } from '@/components/receive-into-select';
import { toast } from 'sonner';

const fmt = (n: unknown) => Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
const dfmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const today = () => new Date().toISOString().split('T')[0];

// Collect payment against a single customer's open invoices. Every receipt is
// posted through the existing POST /api/sales/:id/payments engine — one receipt
// per invoice, sequentially — so outstanding, the customer ledger, cash/bank/UPI
// accounting, Day Book, GL, Trial Balance, Balance Sheet and reconciliation all
// update purely as a consequence of reusing that engine. No allocation engine is
// introduced here.
export function CollectPaymentDialog({
  customerId, customerName, onOpenChange,
}: {
  customerId: number | null;
  customerName?: string;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const createPayment = useCreateSalePayment();
  const { data: recv, isLoading } = useReceivablesAging();

  const customer = customerId != null
    ? ((recv as any)?.customers ?? []).find((c: any) => c.customerId === customerId)
    : null;
  const invoices: any[] = customer?.invoices ?? [];

  // Per-invoice form state, keyed by saleId — supports full and partial amounts.
  const [selected, setSelected] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [ledgerId, setLedgerId] = useState(0);
  const [reference, setReference] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());

  const activeInv = invoices.find((inv) => inv.saleId === selected) ?? null;

  const pick = (inv: any) => {
    setSelected(inv.saleId);
    setAmount(String(inv.balance ?? ''));
    setLedgerId(0);
    setReference('');
    setPaymentDate(today());
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getReceivablesAgingQueryKey() });
    qc.invalidateQueries({ queryKey: getCollectionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListCustomersQueryKey() });
  };

  const submit = () => {
    if (!activeInv) { toast.error('Pick an invoice to collect against'); return; }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a valid amount'); return; }
    if (amt > Number(activeInv.balance) + 0.01) {
      toast.error(`Amount exceeds outstanding (₹${fmt(activeInv.balance)})`); return;
    }
    if (!ledgerId) { toast.error('Pick the Cash / Bank account the money went into'); return; }
    createPayment.mutate(
      { saleId: activeInv.saleId, data: { receivedInLedgerId: ledgerId, amount: amt, referenceNumber: reference.trim() || undefined, paymentDate } },
      {
        onSuccess: () => {
          toast.success(`₹${fmt(amt)} recorded against ${activeInv.invoiceNumber || `Sale #${activeInv.saleId}`}`);
          invalidate();
          setSelected(null);
          setAmount('');
        },
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Could not record the payment'),
      },
    );
  };

  const totalDue = Number(customer?.netDue ?? customer?.totalDue ?? 0);

  return (
    <Dialog open={customerId != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><HandCoins className="w-5 h-5 text-primary" /> Collect Payment</DialogTitle>
          <DialogDescription>
            {customerName || customer?.name || 'Customer'} · Total outstanding <span className="font-mono font-semibold text-foreground">₹{fmt(totalDue)}</span>
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Loading open invoices…</div>
        ) : invoices.length === 0 ? (
          <div className="py-10 text-center">
            <HandCoins className="w-9 h-9 mx-auto text-muted-foreground/40 mb-2" />
            <p className="font-medium text-sm">Nothing outstanding</p>
            <p className="text-xs text-muted-foreground mt-1">All of this customer's invoices are fully settled.</p>
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            {/* Open invoices */}
            <div className="rounded-lg border border-border overflow-hidden max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2">Invoice</th>
                    <th className="text-left px-3 py-2">Date</th>
                    <th className="text-left px-3 py-2">Due</th>
                    <th className="text-right px-3 py-2">Amount</th>
                    <th className="text-right px-3 py-2">Received</th>
                    <th className="text-right px-3 py-2">Outstanding</th>
                    <th className="px-3 py-2 w-20" />
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.saleId} className={`border-t border-border ${selected === inv.saleId ? 'bg-primary/5' : 'hover:bg-muted/10'}`}>
                      <td className="px-3 py-2 font-mono">{inv.invoiceNumber || `Sale #${inv.saleId}`}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{dfmt(inv.saleDate)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {dfmt(inv.dueDate)}
                        {inv.daysOverdue > 0 && (
                          <Badge variant="outline" className="ml-1 font-mono text-[9px] text-red-600 border-red-500/40">{inv.daysOverdue}d</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">₹{fmt(inv.total)}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-600">₹{fmt(inv.paid)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">₹{fmt(inv.balance)}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant={selected === inv.saleId ? 'default' : 'outline'} className="h-6 px-2 text-[11px]" onClick={() => pick(inv)}>
                          {selected === inv.saleId ? 'Selected' : 'Collect'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Collection form for the selected invoice */}
            {activeInv && (
              <div className="rounded-lg border border-border p-4 space-y-4 bg-muted/10">
                <p className="text-sm font-medium">
                  Collecting against <span className="font-mono">{activeInv.invoiceNumber || `Sale #${activeInv.saleId}`}</span>
                  <span className="text-muted-foreground font-normal"> · outstanding ₹{fmt(activeInv.balance)}</span>
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Amount (₹)</label>
                    <Input type="number" min={0} step="0.01" className="font-mono" value={amount} onChange={(e) => setAmount(e.target.value)} />
                    <p className="text-[11px] text-muted-foreground">Full or partial — capped at outstanding.</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Date</label>
                    <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Receive Into <span className="text-muted-foreground font-normal">(Cash / Bank)</span></label>
                    <ReceiveIntoSelect
                      locationType={activeInv.locationType}
                      locationId={activeInv.locationId}
                      value={ledgerId}
                      onChange={setLedgerId}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Reference <span className="text-muted-foreground font-normal">(optional)</span></label>
                    <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / UPI ref / cheque no." />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          {activeInv && (
            <Button onClick={submit} disabled={createPayment.isPending}>
              {createPayment.isPending ? 'Recording…' : 'Record Payment'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
