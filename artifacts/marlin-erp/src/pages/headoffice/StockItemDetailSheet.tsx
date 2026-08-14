import { useMemo } from 'react';
import type { StockBatch } from '@workspace/api-client-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Boxes, Layers, Snowflake, Wallet } from 'lucide-react';

/**
 * Read-only structured detail view for one Live Stock row — opened by clicking
 * the row. Deliberately a plain Sheet (no TransactionDialog): nothing here is
 * entered or saved, it only presents what the stock/batch/placement endpoints
 * already returned to the page. Valuation figures render ONLY when the server
 * said the caller holds the inventory-valuation right (`canSeeValue`); absent
 * fields are absent, never zero.
 */

const money = (n: number) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyIN = (n: number) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const dateIN = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

const MAT_TYPE_LABELS: Record<string, string> = {
  item: 'Item Name (SKU)',
  material: 'Raw Material',
  raw_material: 'Packing Material',
};

const BUCKET_TONES: Record<string, string> = {
  critical: 'bg-red-500/10 text-red-600 border-red-500/20',
  warn: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  caution: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
  ok: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  none: 'bg-muted/20 text-muted-foreground border-muted',
};

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'positive' | 'negative' | 'warning' }) {
  const valueClass =
    tone === 'negative' ? 'text-red-500' : tone === 'positive' ? 'text-emerald-600' : tone === 'warning' ? 'text-amber-600' : '';
  return (
    <div className="rounded-lg border border-border bg-muted/10 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`font-mono font-semibold text-sm mt-0.5 ${valueClass}`}>{value}</p>
      {sub ? <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p> : null}
    </div>
  );
}

export interface StockItemDetailSheetProps {
  /** The Live Stock row being inspected, or null when the sheet is closed. */
  row: any | null;
  /** Lots for exactly this (kind, branch, item) — same list the page fetched. */
  batches: StockBatch[];
  /** Server's verdict on the inventory-valuation right — never inferred client-side. */
  canSeeValue: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function StockItemDetailSheet({ row, batches, canSeeValue, onOpenChange }: StockItemDetailSheetProps) {
  const tracked = useMemo(() => batches.reduce((sum, b) => sum + Number(b.quantity), 0), [batches]);
  const untracked = row ? Math.round((Number(row.quantity) - tracked) * 1000) / 1000 : 0;

  if (!row) return <Sheet open={false} onOpenChange={onOpenChange} />;

  const isItem = (row.materialType ?? 'item') === 'item';
  const low = !!row.lowStock;
  const worst = batches.some(b => b.status === 'expired') ? 'expired'
    : batches.some(b => b.status === 'near_expiry') ? 'near_expiry' : null;
  const placements: Array<{ storageLocationId?: number; name: string; quantity: number }> =
    Array.isArray(row.storageLocations) ? row.storageLocations : [];

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="pr-8 flex flex-wrap items-center gap-2">
            {row.itemName}
            <Badge variant="outline" className="text-xs font-normal">{MAT_TYPE_LABELS[row.materialType ?? 'item'] ?? row.materialType}</Badge>
          </SheetTitle>
          <SheetDescription>
            At {row.branchName || 'Head Office'} · unit: {row.unit || '—'}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {/* Status flags */}
          {(low || worst) && (
            <div className="flex flex-wrap gap-1.5">
              {low && (
                <Badge variant="destructive" className="text-xs gap-1">
                  <AlertTriangle className="w-3 h-3" /> Low stock (below {qtyIN(Number(row.reorderLevel))})
                </Badge>
              )}
              {worst === 'expired' && <Badge variant="destructive" className="text-xs">Has expired batches</Badge>}
              {worst === 'near_expiry' && <Badge className="text-xs bg-amber-500/10 text-amber-600 border-amber-500/20">Batches expiring soon</Badge>}
            </div>
          )}

          {/* Quantity figures */}
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
              <Boxes className="w-4 h-4 text-muted-foreground" /> Quantities
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="Quantity" value={`${qtyIN(Number(row.quantity))} ${row.unit ?? ''}`} />
              <Stat
                label="Reserved"
                value={Number(row.reserved || 0) > 0 ? `${qtyIN(Number(row.reserved))} ${row.unit ?? ''}` : '—'}
                tone={Number(row.reserved || 0) > 0 ? 'warning' : undefined}
              />
              <Stat
                label="Available"
                value={`${qtyIN(Number(row.available))} ${row.unit ?? ''}`}
                tone={low ? 'negative' : 'positive'}
              />
              {isItem && <Stat label="Reorder Level" value={qtyIN(Number(row.reorderLevel || 0))} />}
            </div>
          </section>

          {/* Valuation — rendered only when the server granted the right */}
          {canSeeValue && (
            <section>
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
                <Wallet className="w-4 h-4 text-muted-foreground" /> Valuation
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <Stat label="Avg Cost" value={Number(row.avgCost || 0) > 0 ? money(Number(row.avgCost)) : '—'} sub={`per ${row.unit || 'unit'}`} />
                <Stat label="Stock Value" value={Number(row.stockValue || 0) > 0 ? money(Number(row.stockValue)) : '—'} sub="at avg cost" tone="positive" />
              </div>
            </section>
          )}

          {/* Storage placement (warehouse rows only carry this) */}
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
              <Snowflake className="w-4 h-4 text-muted-foreground" /> Storage Placement
            </h3>
            {placements.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {placements.map((sl, i) => (
                  <Badge key={`${sl.storageLocationId ?? sl.name}:${i}`} variant="secondary" className="text-xs font-normal gap-1">
                    <Snowflake className="w-3 h-3 text-sky-500" />
                    {sl.name} <span className="font-mono font-semibold">({qtyIN(Number(sl.quantity))})</span>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {String(row.branchType) === 'warehouse'
                  ? 'Not assigned to any storage location — manage placements on the Storage Locations tab.'
                  : 'Storage locations apply to warehouse stock only.'}
              </p>
            )}
          </section>

          {/* Batches */}
          <section>
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
              <Layers className="w-4 h-4 text-muted-foreground" /> Batches
              <span className="text-xs font-normal text-muted-foreground">({batches.length})</span>
            </h3>
            {batches.length === 0 && untracked <= 0 ? (
              <p className="text-xs text-muted-foreground">No batch records for this stock.</p>
            ) : (
              <div className="rounded-lg border border-border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/20 text-muted-foreground">
                      <th className="text-left px-3 py-1.5 font-medium">Batch</th>
                      <th className="text-left px-3 py-1.5 font-medium">Mfg</th>
                      <th className="text-left px-3 py-1.5 font-medium">Expiry</th>
                      <th className="text-left px-3 py-1.5 font-medium">Shelf Life</th>
                      <th className="text-right px-3 py-1.5 font-medium">Qty</th>
                      <th className="text-right px-3 py-1.5 font-medium">Rsvd</th>
                      <th className="text-right px-3 py-1.5 font-medium">Avail</th>
                      <th className="text-right px-3 py-1.5 font-medium">MRP</th>
                      {canSeeValue && <th className="text-right px-3 py-1.5 font-medium">Unit Cost</th>}
                      {canSeeValue && <th className="text-right px-3 py-1.5 font-medium">Value</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map(b => {
                      const hasReserved = Number(b.reserved || 0) > 0;
                      return (
                        <tr key={b.id} className="border-t border-border/60">
                          <td className="px-3 py-1.5 font-mono">{b.batchNumber}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">{dateIN(b.mfgDate)}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">{dateIN(b.expiryDate)}</td>
                          <td className="px-3 py-1.5">
                            <Badge className={`text-[10px] ${BUCKET_TONES[b.tone] ?? BUCKET_TONES.none}`}>{b.bucketLabel}</Badge>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">{qtyIN(Number(b.quantity))}</td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {hasReserved
                              ? <span className="text-amber-600 font-semibold">{qtyIN(Number(b.reserved))}</span>
                              : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono font-semibold">{qtyIN(Number(b.available))}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{b.mrp != null ? money(b.mrp) : '—'}</td>
                          {canSeeValue && (
                            <td className="px-3 py-1.5 text-right font-mono">{Number(b.unitCost ?? 0) > 0 ? money(Number(b.unitCost)) : '—'}</td>
                          )}
                          {canSeeValue && (
                            <td className="px-3 py-1.5 text-right font-mono">{money(Number(b.value ?? 0))}</td>
                          )}
                        </tr>
                      );
                    })}
                    {untracked > 0 && (
                      <tr className="border-t border-border/60 text-muted-foreground">
                        <td className="px-3 py-1.5 italic" colSpan={4}>Untracked (no batch record)</td>
                        <td className="px-3 py-1.5 text-right font-mono">{qtyIN(untracked)}</td>
                        <td colSpan={canSeeValue ? 5 : 3} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
