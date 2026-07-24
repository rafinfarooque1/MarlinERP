/**
 * SalesCashBalance — shows the cash balance for the current outlet / warehouse
 * selected in the Sales segment. Read-only view; deposits are recorded by HQ
 * from the Accounts → Cash Balance module.
 */
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { useLocationContext } from '@/lib/locationContext';
import { useGetCashInOutlet } from '@workspace/api-client-react';
import { Separator } from '@/components/ui/separator';
import { Banknote, Warehouse, Store, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

function fmt(n: number) {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function SalesCashBalance() {
  const perm = usePermission('Cash Balance');
  const { locationState } = useLocationContext();
  const { locationType, locationId, locationName } = locationState;

  const { data: allBalances = [], isLoading, refetch } = useGetCashInOutlet();

  // Find the balance entry for the current sales location
  const balance = allBalances.find(
    b => b.locationType === locationType && b.locationId === locationId
  );

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <Banknote className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Cash Balance.</p>
        </div>
      </AppLayout>
    );
  }

  const LocationIcon = locationType === 'warehouse' ? Warehouse : Store;

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-5 max-w-lg">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Banknote className="w-6 h-6 text-primary" /> Cash Balance
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5">
              <LocationIcon className="w-3.5 h-3.5" />
              {locationName}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        {isLoading ? (
          <div className="py-16 text-center text-muted-foreground">Loading…</div>
        ) : !balance ? (
          <div className="rounded-xl border border-border p-8 text-center space-y-2 text-muted-foreground bg-muted/20">
            <Banknote className="w-10 h-10 mx-auto opacity-30" />
            <p className="font-medium">No cash ledger found</p>
            <p className="text-sm opacity-70">The cash account for this location hasn't been set up yet.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            {/* Location badge */}
            <div className="flex items-center gap-2">
              <LocationIcon className="w-4 h-4 text-muted-foreground" />
              <span className="font-semibold text-sm">{balance.locationName}</span>
              <span className="text-xs text-muted-foreground capitalize bg-muted px-2 py-0.5 rounded-full">
                {balance.locationType}
              </span>
            </div>

            <Separator />

            {/* Balance rows */}
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Cash balance</span>
                <span className="font-mono font-semibold text-base">{fmt(balance.cashBalance)}</span>
              </div>

              {balance.pendingDeposits > 0 && (
                <div className="flex justify-between items-center text-amber-600">
                  <span className="text-sm">In transit (deposited, pending bank confirmation)</span>
                  <span className="font-mono text-sm">({fmt(balance.pendingDeposits)})</span>
                </div>
              )}

              <Separator />

              <div className="flex justify-between items-center font-semibold text-emerald-600">
                <span className="text-sm">Available</span>
                <span className="font-mono text-lg">{fmt(balance.availableBalance)}</span>
              </div>
            </div>

            {locationType === 'outlet' && (
              <p className="text-[11px] text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
                To deposit this cash to the bank, use <strong>Accounts → Cash Balance → Record Deposit</strong> from the head office.
              </p>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
