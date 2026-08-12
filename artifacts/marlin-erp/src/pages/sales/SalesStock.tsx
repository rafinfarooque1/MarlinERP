import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import { useListStock, useListItems, useListStockBatches, type StockBatch } from '@workspace/api-client-react';
import { useAllOutlets, useIsLocationKindEnabled } from '@/lib/locationStructure';
import { LocationFilter, parseLocationFilter } from '@/components/ui/LocationFilter';
import { Package, AlertTriangle, Search, ShieldOff, Boxes, PackageX } from 'lucide-react';
import { usePermission } from '@/lib/usePermission';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';

export default function SalesStock() {
  const perm = usePermission('page:/headoffice/stock');
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

  // Child outlets for warehouse mode. Historical aggregation, not a selector:
  // stock physically held by a child outlet stays part of the warehouse's total
  // whether or not outlets are on show, otherwise the quantity simply vanishes.
  const outletsVisible = useIsLocationKindEnabled('outlet');
  const { data: outlets = [] } = useAllOutlets();
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

  // Enrich rows with the derived display values (item name/unit, nearest-expiry,
  // status) so the sort accessors compare exactly what the cells render, and
  // preserve the existing default order (quantity desc).
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const rows = stock.filter(s =>
      !search ||
      (s.itemName ?? '').toLowerCase().includes(q) ||
      (s.branchName ?? '').toLowerCase().includes(q)
    );
    const enriched = rows.map((entry: any) => {
      const item = itemMap.get(entry.itemId);
      const qty = Number(entry.quantity ?? 0);
      const reorder = Number(entry.reorderLevel ?? 10);
      const isLow = qty > 0 && (entry.lowStock ?? qty < reorder);
      const isEmpty = qty <= 0;
      const nb = nearestExpiry.get(Number(entry.itemId));
      return {
        ...entry,
        _name: entry.itemName || item?.name || `Item #${entry.itemId}`,
        _unit: item?.unit ?? '',
        _qty: qty,
        _expiry: nb?.expiryDate ?? '',
        _status: isEmpty ? 'Out of Stock' : isLow ? 'Low' : 'In Stock',
      };
    });
    return enriched.sort((a, b) => b._qty - a._qty);
  }, [stock, search, itemMap, nearestExpiry]);

  const { sorted, sort } = useTableSort(filtered, {
    item: r => r._name,
    location: r => r.branchName,
    type: r => r.branchType,
    unit: r => r._unit,
    quantity: r => r._qty,
    expiry: r => r._expiry,
    status: r => r._status,
  });

  const { pageRows, pagerProps } = useClientPage(sorted);

  // Summary figures derive only from the already-fetched (and filtered) rows.
  const totalUnits = sorted.reduce((s: number, e: any) => s + Number(e.quantity ?? 0), 0);
  const entriesWithQty = sorted.filter((s: any) => Number(s.quantity) > 0).length;
  const lowCount = sorted.filter((s: any) => s._status === 'Low').length;
  const outCount = sorted.filter((s: any) => s._status === 'Out of Stock').length;

  const showLocationCol = isAll || isWarehouse;
  const title    = isAll ? 'Stock — All Locations' : `Stock — ${locationName}`;
  const subtitle = isAll
    ? `Current inventory across all warehouses${outletsVisible ? ' and outlets' : ''}`
    : isWarehouse
    ? `Stock at ${locationName}${outletsVisible ? ' and its outlets' : ''}`
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
  const colCount = showLocationCol ? (showExpiryCol ? 7 : 6) : showExpiryCol ? 5 : 4;
  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader title={title} description={subtitle} icon={Package} />

        <SummaryCardGrid>
          <SummaryCard label="Stock Entries" value={entriesWithQty.toLocaleString('en-IN')} sub="with quantity on hand" icon={Boxes} loading={isLoading} />
          <SummaryCard label="Total Units" value={totalUnits.toLocaleString('en-IN')} icon={Package} tone="info" loading={isLoading} />
          <SummaryCard label="Low Stock" value={lowCount.toLocaleString('en-IN')} sub="below reorder level" icon={AlertTriangle} tone="warning" loading={isLoading} />
          <SummaryCard label="Out of Stock" value={outCount.toLocaleString('en-IN')} icon={PackageX} tone="negative" loading={isLoading} />
        </SummaryCardGrid>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {/* Filter / search bar */}
          <div className="p-3 border-b border-border bg-muted/20 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-[160px]">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="Search item or location…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="border-transparent bg-transparent focus-visible:ring-0 h-8"
              />
            </div>
            <LocationFilter
              value={filterLoc}
              onChange={v => { setFilterLoc(v); setSearch(''); }}
            />
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="item" sort={sort}>Item</SortableHead>
                {showLocationCol && <SortableHead k="location" sort={sort}>Location</SortableHead>}
                {showLocationCol && <SortableHead k="type" sort={sort}>Type</SortableHead>}
                <SortableHead k="unit" sort={sort}>Unit</SortableHead>
                <SortableHead k="quantity" sort={sort} className="text-right">Quantity</SortableHead>
                {showExpiryCol && <SortableHead k="expiry" sort={sort}>Nearest Expiry</SortableHead>}
                <SortableHead k="status" sort={sort}>Status</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={colCount} className="p-0">
                    <TableSkeleton rows={8} cols={colCount} />
                  </TableCell>
                </TableRow>
              ) : sorted.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={colCount} className="p-0">
                    <EmptyState
                      icon={Package}
                      title={isAll ? 'No stock across any location' : `No stock at ${locationName}`}
                      hint="Stock entries appear here once inventory is recorded at this location."
                      compact
                    />
                  </TableCell>
                </TableRow>
              ) : pageRows.map((entry: any, i: number) => {
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
                        <Badge variant="outline" className="text-xs capitalize">{entry.branchType}</Badge>
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
                        <Badge variant="destructive" className="text-xs">Out of Stock</Badge>
                      ) : isLow ? (
                        <Badge className="text-xs bg-amber-500/10 text-amber-600 border-amber-500/20">
                          <AlertTriangle className="w-3 h-3 mr-1" />Low
                        </Badge>
                      ) : (
                        <Badge className="text-xs bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
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
                {entriesWithQty} stock entries with quantity
              </span>
              <span className="font-bold">
                {totalUnits.toLocaleString('en-IN')} total units
              </span>
            </div>
          )}
        </div>

        <TablePager {...pagerProps} />
      </div>
    </AppLayout>
  );
}
