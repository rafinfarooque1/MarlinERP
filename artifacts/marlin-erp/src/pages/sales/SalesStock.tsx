import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import { useListStock, useListItems, useListOutlets, useListStockBatches, type StockBatch } from '@workspace/api-client-react';
import { LocationFilter, parseLocationFilter } from '@/components/ui/LocationFilter';
import { Package, AlertTriangle, Search, ShieldOff } from 'lucide-react';
import { usePermission } from '@/lib/usePermission';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

export default function SalesStock() {
  const perm = usePermission('Stock');
  const { locationState } = useLocationContext();
  const [search, setSearch] = useState('');
  const [filterLoc, setFilterLoc] = useState('all');
  const [, navigate] = useLocation();

  const { locationType: ctxType, locationId: ctxId, locationName } = locationState;

  // When a manual filter is chosen it overrides the location context
  const { type: filterType, id: filterId } = parseLocationFilter(filterLoc);
  const locationType = filterType !== 'all' ? filterType : ctxType;
  const locationId   = filterId   ?? ctxId;

  const isAll       = locationType === 'all';
  const isWarehouse = locationType === 'warehouse' && !!locationId && !isAll;
  const isSpecific  = !isAll && !!locationType && !!locationId;

  // No location chosen (e.g. direct link / fresh session) → send to the picker
  useEffect(() => {
    if (!locationType) navigate('/sales');
  }, [locationType]);

  // Child outlets for warehouse mode
  const { data: outlets = [] } = useListOutlets();
  const childOutletIds = isWarehouse
    ? new Set((outlets as any[]).filter(o => Number(o.warehouseId) === locationId).map(o => o.id))
    : new Set<number>();

  // Fetch all stock for 'all' / 'warehouse' modes; specific otherwise
  const { data: allStock = [], isLoading } = useListStock(
    isSpecific ? { branchType: locationType as any, branchId: locationId! } : {},
    { query: { enabled: isAll || isWarehouse || isSpecific } as any }
  );

  const { data: items = [] } = useListItems();
  const itemMap = new Map((items as any[]).map(i => [i.id, i]));

  // Nearest-expiry column only for a single-location view (warehouse mode mixes
  // in child-outlet rows, whose batches live at a different branch)
  const showExpiryCol = isSpecific && !isWarehouse;
  const { data: locBatches = [] } = useListStockBatches(
    showExpiryCol ? { branchType: locationType as string, branchId: locationId! } : undefined,
    { enabled: showExpiryCol },
  );
  const nearestExpiry = new Map<number, StockBatch>();
  for (const b of locBatches as StockBatch[]) {
    if (b.expiryDate && !nearestExpiry.has(b.itemId)) nearestExpiry.set(b.itemId, b);
  }

  // In warehouse mode filter to warehouse + child outlets
  const stock = isWarehouse
    ? (allStock as any[]).filter(s =>
        (s.branchType === 'warehouse' && Number(s.branchId) === locationId) ||
        (s.branchType === 'outlet'    && childOutletIds.has(Number(s.branchId)))
      )
    : (allStock as any[]);

  const filtered = stock.filter(s =>
    !search ||
    (s.itemName ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (s.branchName ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => Number(b.quantity) - Number(a.quantity));

  const showLocationCol = isAll || isWarehouse;
  const title    = isAll ? 'Stock — All Locations' : `Stock — ${locationName}`;
  const subtitle = isAll
    ? 'Current inventory across all warehouses and outlets'
    : isWarehouse
    ? `Stock at ${locationName} and its outlets`
    : 'Current inventory at this location';

  if (!locationType) return null;

  if (!perm.isLoading && !perm.canView) {
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
  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Package className="w-6 h-6 text-primary" />
            {title}
          </h1>
          <p className="text-muted-foreground mt-1">{subtitle}</p>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {/* Filter / search bar */}
          <div className="p-3 border-b border-border bg-muted/20 flex flex-wrap items-center gap-2">
            <LocationFilter
              value={filterLoc}
              onChange={v => { setFilterLoc(v); setSearch(''); }}
            />
            <div className="flex items-center gap-2 flex-1 min-w-[160px]">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="Search item or location…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="border-transparent bg-transparent focus-visible:ring-0 h-8"
              />
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Item</TableHead>
                {showLocationCol && <TableHead>Location</TableHead>}
                {showLocationCol && <TableHead>Type</TableHead>}
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                {showExpiryCol && <TableHead>Nearest Expiry</TableHead>}
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={showLocationCol ? 6 : showExpiryCol ? 5 : 4}>
                      <div className="h-8 bg-muted/30 rounded animate-pulse" />
                    </TableCell>
                  </TableRow>
                ))
              ) : sorted.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={showLocationCol ? 6 : showExpiryCol ? 5 : 4} className="text-center py-16 text-muted-foreground">
                    <Package className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>{isAll ? 'No stock across any location' : `No stock at ${locationName}`}</p>
                  </TableCell>
                </TableRow>
              ) : sorted.map((entry: any, i: number) => {
                const item = itemMap.get(entry.itemId);
                const qty    = Number(entry.quantity ?? 0);
                const reorder = Number(entry.reorderLevel ?? 10);
                const isLow  = qty > 0 && (entry.lowStock ?? qty < reorder);
                const isEmpty = qty <= 0;
                return (
                  <TableRow key={`${entry.branchType}-${entry.branchId}-${entry.itemId}-${i}`} className={isEmpty ? 'opacity-50' : ''}>
                    <TableCell className="font-medium">
                      {entry.itemName || item?.name || `Item #${entry.itemId}`}
                    </TableCell>
                    {showLocationCol && (
                      <TableCell className="text-sm text-muted-foreground">
                        {entry.branchName ?? '—'}
                      </TableCell>
                    )}
                    {showLocationCol && (
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] capitalize">{entry.branchType}</Badge>
                      </TableCell>
                    )}
                    <TableCell className="text-sm text-muted-foreground">
                      {item?.unit ?? '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold">
                      {qty.toLocaleString('en-IN')}
                    </TableCell>
                    {showExpiryCol && (
                      <TableCell>
                        {(() => {
                          const nb = nearestExpiry.get(Number(entry.itemId));
                          if (!nb) return <span className="text-xs text-muted-foreground">—</span>;
                          const cls = nb.status === 'expired' ? 'text-red-500 font-medium' : nb.status === 'near_expiry' ? 'text-amber-600 font-medium' : 'text-muted-foreground';
                          return (
                            <span className={`text-xs ${cls}`}>
                              {new Date(nb.expiryDate!).toLocaleDateString('en-IN')}
                              {nb.daysToExpiry != null && <span className="ml-1 font-mono">({nb.daysToExpiry}d)</span>}
                            </span>
                          );
                        })()}
                      </TableCell>
                    )}
                    <TableCell>
                      {isEmpty ? (
                        <Badge variant="destructive" className="text-[10px]">Out of Stock</Badge>
                      ) : isLow ? (
                        <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">
                          <AlertTriangle className="w-3 h-3 mr-1" />Low
                        </Badge>
                      ) : (
                        <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
                          In Stock
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {sorted.length > 0 && (
            <div className="p-3 border-t border-border flex justify-between text-sm">
              <span className="text-muted-foreground">
                {sorted.filter((s: any) => Number(s.quantity) > 0).length} stock entries with quantity
              </span>
              <span className="font-bold">
                {sorted.reduce((s: number, e: any) => s + Number(e.quantity ?? 0), 0).toLocaleString('en-IN')} total units
              </span>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
