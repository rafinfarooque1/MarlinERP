import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettlementContext, type SettlementBill } from '@workspace/api-client-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Wand2 } from 'lucide-react';

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface SettlementSelection {
  /** billId → amount; billId is saleId (customer) or purchaseId (vendor). */
  allocations: { billId: number; amount: number }[];
  advanceAmount: number;
  kind: 'customer' | 'vendor';
}

/** Oldest-first distribution of `amount` across the bills' dues. */
function distribute(bills: SettlementBill[], amount: number): Map<number, number> {
  const out = new Map<number, number>();
  let left = r2(amount);
  for (const b of bills) {
    const id = (b.saleId ?? b.purchaseId)!;
    const take = r2(Math.min(left, b.due));
    if (take > 0.004) out.set(id, take);
    left = r2(left - take);
    if (left <= 0.004) break;
  }
  return out;
}

/**
 * Bill-wise settlement table for the receipt / payment voucher dialogs.
 * Appears only when the selected party ledger has open bills or an advance;
 * auto-allocates the voucher amount oldest-first, lets the user retarget it,
 * and reports the result (allocations + the excess that parks as advance).
 */
export function BillSettlementPanel({ ledgerId, amount, onSelection }: {
  ledgerId: number;
  amount: number;
  onSelection: (sel: SettlementSelection | null) => void;
}) {
  const { data: ctx } = useSettlementContext(ledgerId > 0 ? ledgerId : null);
  const [manual, setManual] = useState<Map<number, number> | null>(null);
  const lastLedger = useRef(ledgerId);

  // Switching party resets any hand-edited split.
  useEffect(() => {
    if (lastLedger.current !== ledgerId) {
      lastLedger.current = ledgerId;
      setManual(null);
    }
  }, [ledgerId]);

  const bills = ctx?.kind ? ctx.bills : [];
  const active = !!ctx?.kind && (bills.length > 0 || (ctx?.advance.available ?? 0) > 0.004);

  const allocs = useMemo(() => {
    if (!active) return new Map<number, number>();
    if (manual) {
      // Clamp hand edits so the split can never exceed the voucher amount.
      const clamped = new Map<number, number>();
      let left = r2(Math.max(0, amount));
      for (const b of bills) {
        const id = (b.saleId ?? b.purchaseId)!;
        const want = manual.get(id) ?? 0;
        const take = r2(Math.min(Math.max(0, want), b.due, left));
        if (take > 0.004) clamped.set(id, take);
        left = r2(left - take);
      }
      return clamped;
    }
    return distribute(bills, Math.max(0, amount));
  }, [active, manual, bills, amount]);

  const allocated = useMemo(
    () => r2([...allocs.values()].reduce((s, v) => s + v, 0)),
    [allocs],
  );
  const advance = r2(Math.max(0, r2(amount) - allocated));
  // Identity-bearing signature: retargeting ₹100 from bill A to bill B keeps
  // `allocated` and `advance` unchanged, so depending on the totals alone
  // would leave the parent holding the OLD split and post it against A.
  const allocSig = useMemo(
    () => [...allocs.entries()].map(([id, amt]) => `${id}:${amt}`).join('|'),
    [allocs],
  );

  // Report the current split upward whenever it changes.
  useEffect(() => {
    if (!active || !ctx?.kind) { onSelection(null); return; }
    onSelection({
      kind: ctx.kind,
      allocations: [...allocs.entries()].map(([billId, amt]) => ({ billId, amount: amt })),
      advanceAmount: advance,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ctx?.kind, allocSig, advance, ledgerId]);

  if (!active) return null;

  const fmt = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          Settle bills — {ctx?.partyName}
        </p>
        {manual && (
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setManual(null)}>
            <Wand2 className="w-3 h-3 mr-1" /> Auto-allocate
          </Button>
        )}
      </div>
      {(ctx?.advance.available ?? 0) > 0.004 && (
        <p className="text-xs text-muted-foreground">
          Available advance with this {ctx?.kind === 'customer' ? 'customer' : 'vendor'}: <span className="font-mono">{fmt(ctx!.advance.available)}</span>
        </p>
      )}
      {bills.length > 0 ? (
        <div className="max-h-48 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-medium py-1">Bill</th>
                <th className="text-left font-medium py-1">Date</th>
                <th className="text-right font-medium py-1">Due</th>
                <th className="text-right font-medium py-1 w-28">This voucher</th>
              </tr>
            </thead>
            <tbody>
              {bills.map(b => {
                const id = (b.saleId ?? b.purchaseId)!;
                const val = allocs.get(id) ?? 0;
                return (
                  <tr key={id} className="border-t border-border/50">
                    <td className="py-1 pr-2 font-mono">{b.invoiceNumber || `#${id}`}</td>
                    <td className="py-1 pr-2 text-muted-foreground">{new Date(b.billDate).toLocaleDateString('en-IN')}</td>
                    <td className="py-1 pr-2 text-right font-mono">{fmt(b.due)}</td>
                    <td className="py-1 text-right">
                      <Input
                        type="number"
                        min={0}
                        max={b.due}
                        step="0.01"
                        value={val || ''}
                        placeholder="0"
                        className="h-7 text-right font-mono text-xs"
                        onChange={e => {
                          const next = new Map(manual ?? allocs);
                          next.set(id, Number(e.target.value) || 0);
                          setManual(next);
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No open bills — the full amount will be parked as an advance.</p>
      )}
      <div className="flex justify-between text-xs pt-1 border-t border-border/50">
        <span className="text-muted-foreground">Against bills: <span className="font-mono text-foreground">{fmt(allocated)}</span></span>
        {advance > 0.004 && (
          <span className="text-muted-foreground">→ Advance: <span className="font-mono text-amber-600 dark:text-amber-500">{fmt(advance)}</span></span>
        )}
      </div>
    </div>
  );
}
