/**
 * Shared bits for the Asset Management pages.
 *
 * Assets are capital expenditure — they post Dr Fixed Assets / Cr Cash-Bank-
 * Vendor and never touch inventory stock. Every page here follows the same
 * ERP conventions: page permission gate, ₹ formatting, encoded `${type}:${id}`
 * location keys.
 */
import { useListWarehouses, useListOutlets, type AssetStatus, type AssetPaymentMode, type AssetPaymentStatus } from '@workspace/api-client-react';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';
import { AppLayout } from '@/components/layout/AppLayout';
import { Badge } from '@/components/ui/badge';
import { ShieldOff } from 'lucide-react';

// ── Labels ────────────────────────────────────────────────────────────────────

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  active: 'Active',
  sold: 'Sold',
  scrapped: 'Scrapped',
  written_off: 'Written Off',
  transferred_outside: 'Transferred Outside',
};

export const PAYMENT_MODE_LABELS: Record<AssetPaymentMode, string> = {
  cash: 'Cash',
  bank: 'Bank',
  upi: 'UPI',
  credit: 'Credit (vendor)',
};

export const PAYMENT_STATUS_LABELS: Record<AssetPaymentStatus, string> = {
  paid: 'Paid',
  unpaid: 'Unpaid',
  partial: 'Partial',
};

const STATUS_CLS: Record<AssetStatus, string> = {
  active: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  sold: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  scrapped: 'bg-red-500/10 text-red-600 border-red-500/20',
  written_off: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  transferred_outside: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
};

export function AssetStatusBadge({ status }: { status: AssetStatus | string }) {
  const s = status as AssetStatus;
  return (
    <Badge variant="outline" className={`text-xs whitespace-nowrap ${STATUS_CLS[s] ?? 'bg-muted text-muted-foreground border-border'}`}>
      {ASSET_STATUS_LABELS[s] ?? status}
    </Badge>
  );
}

// ── Location options (asset locations = HO + warehouses [+ outlets]) ─────────

export interface AssetLocationOption { type: 'headoffice' | 'warehouse' | 'outlet'; id: number; name: string }

/** Every place an asset can sit — used for transfer destinations and report
 *  filters. Unlike useActingLocations this is NOT limited to where the caller
 *  may record documents: the server enforces scope on the asset itself. */
export function useAssetLocationOptions(): AssetLocationOption[] {
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  const opts: AssetLocationOption[] = [{ type: 'headoffice', id: 1, name: 'Head Office' }];
  for (const w of warehouses as any[]) opts.push({ type: 'warehouse', id: w.id, name: w.name });
  if (outletsEnabled) for (const o of outlets as any[]) opts.push({ type: 'outlet', id: o.id, name: `${o.name} (outlet)` });
  return opts;
}

export const locKey = (type: string, id: number) => `${type}:${id}`;

// ── Access denied (same block every other page renders) ──────────────────────

export function AssetsAccessDenied() {
  return (
    <AppLayout>
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
        <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <ShieldOff className="w-8 h-8 text-destructive" />
        </div>
        <div>
          <h2 className="text-xl font-bold">Access Denied</h2>
          <p className="text-muted-foreground mt-1 text-sm">You don't have permission to view this page.<br />Contact your administrator to request access.</p>
        </div>
      </div>
    </AppLayout>
  );
}
