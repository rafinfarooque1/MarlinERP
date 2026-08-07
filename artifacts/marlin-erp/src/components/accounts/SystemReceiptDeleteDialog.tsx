import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useReceiptDeleteImpact, useSystemDeleteReceipt } from '@workspace/api-client-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, Check, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

const inr = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const STATUS_LABEL: Record<string, string> = {
  paid: 'Paid', partial: 'Partially Paid', unpaid: 'Unpaid', overdue: 'Overdue',
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

/**
 * Admin-only "Delete System Generated Voucher" dialog.
 *
 * Shown only for rows the server flagged `systemDeletable` (sale-sourced
 * receipts, level-1 Administrator). The impact preview comes from the server;
 * the delete re-validates everything under row locks, so this dialog is a
 * window onto the server's verdict — never the verdict itself.
 */
export function SystemReceiptDeleteDialog({ receiptId, onClose }: { receiptId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const impactQ = useReceiptDeleteImpact(receiptId);
  const del = useSystemDeleteReceipt();
  const [reason, setReason] = useState('');

  const impact = impactQ.data;
  const blockers = impact?.blockers ?? [];
  const canConfirm = !!impact && blockers.length === 0 && reason.trim().length >= 5 && !del.isPending;

  const handleConfirm = () => {
    del.mutate({ receiptId, reason: reason.trim() }, {
      onSuccess: () => {
        toast.success('System voucher deleted and accounting reversed');
        qc.invalidateQueries();
        onClose();
      },
      onError: (e: any) => toast.error(e?.data?.error || e?.message || 'Delete failed'),
    });
  };

  const actions: string[] = impact ? [
    'The receipt voucher is permanently deleted',
    'Its ledger posting is reversed in the books',
    ...(impact.kind !== 'orphan' ? [
      'The payment record is removed from the linked invoice',
      'The invoice payment status is recalculated',
      'The customer outstanding balance is updated',
    ] : []),
    `The ${impact.receivedInName ?? 'cash/bank'} balance is updated`,
    'Dashboards and reports recalculate automatically',
  ] : [];

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="h-5 w-5" /> Delete System Generated Voucher
          </DialogTitle>
          <DialogDescription>
            This voucher was created automatically by the sales flow. Deleting it reverses
            every accounting effect it created. <span className="font-semibold text-destructive">This cannot be undone.</span>
          </DialogDescription>
        </DialogHeader>

        {impactQ.isLoading && (
          <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking what this will change…
          </div>
        )}
        {impactQ.isError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {(impactQ.error as any)?.data?.error || 'Could not load the deletion preview.'}
          </div>
        )}

        {impact && (
          <div className="space-y-4">
            {/* Voucher details */}
            <div className="rounded-md border p-3 text-sm grid grid-cols-2 gap-x-4 gap-y-1.5">
              <span className="text-muted-foreground">Voucher No</span>
              <span className="font-mono font-semibold text-right">{impact.voucherNumber}</span>
              <span className="text-muted-foreground">Date</span>
              <span className="text-right">{impact.receiptDate}</span>
              <span className="text-muted-foreground">Amount</span>
              <span className="font-mono font-semibold text-right">{inr(impact.amount)}</span>
              <span className="text-muted-foreground">Location</span>
              <span className="text-right">{impact.locationLabel}</span>
              <span className="text-muted-foreground">Ledger entry</span>
              <span className="text-right">{impact.receivedFromName ?? '—'} → {impact.receivedInName ?? '—'}</span>
            </div>

            {/* Linked invoices */}
            {impact.sales.length > 0 && (
              <div className="rounded-md border p-3 text-sm space-y-2">
                <div className="font-semibold text-xs uppercase tracking-wide text-muted-foreground">Linked invoice{impact.sales.length > 1 ? 's' : ''}</div>
                {impact.sales.map(s => (
                  <div key={s.saleId} className="space-y-0.5">
                    <div className="flex justify-between gap-2">
                      <span className="font-mono font-semibold">{s.invoiceNumber}</span>
                      <span className="text-muted-foreground truncate">{s.customerName}</span>
                    </div>
                    <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                      <span>{inr(s.reversal)} will be removed from paid amount</span>
                      <span>
                        {statusLabel(s.currentStatus)} → <span className="font-semibold text-foreground">{statusLabel(s.newStatus)}</span>
                      </span>
                    </div>
                    <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                      <span>Paid: {inr(s.currentPaid)} → {inr(s.newPaid)}</span>
                      <span>Total: {inr(s.totalAmount)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {impact.kind === 'orphan' && (
              <div className="rounded-md border p-3 text-xs text-muted-foreground">
                No linked invoice was found for this voucher — only the voucher itself and its posting will be removed.
              </div>
            )}

            {/* Blockers */}
            {blockers.length > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive space-y-1">
                {blockers.map((b, i) => (
                  <div key={i} className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /><span>{b}</span></div>
                ))}
              </div>
            )}

            {/* Actions checklist */}
            {blockers.length === 0 && (
              <div className="rounded-md bg-muted/40 p-3 text-xs space-y-1">
                <div className="font-semibold uppercase tracking-wide text-muted-foreground mb-1">The following will happen</div>
                {actions.map((a, i) => (
                  <div key={i} className="flex gap-2 items-start"><Check className="h-3.5 w-3.5 shrink-0 mt-px text-muted-foreground" /><span>{a}</span></div>
                ))}
              </div>
            )}

            {/* Reason */}
            {blockers.length === 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="sys-del-reason" className="text-sm">
                  Reason for deletion <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="sys-del-reason"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="Why is this voucher being deleted? Recorded permanently in the audit log."
                  rows={2}
                />
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={del.isPending}>Cancel</Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={!canConfirm}>
            {del.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
            Delete Voucher
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
