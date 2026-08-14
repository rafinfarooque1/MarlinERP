import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { usePaginatedStock, useListWarehouses, useListOutlets, useListStockBatches, type StockBatch } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, BarChart3, Download, AlertTriangle, ChevronRight, ShieldOff } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { useOutletsEnabled, useClearOutletSelection } from '@/lib/useFeatureFlags';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { FilterPanel } from '@/components/app/filter-panel';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { Boxes, Wallet, Snowflake, PackageSearch } from 'lucide-react';
import StorageLocationsTab from './StorageLocationsTab';
import ItemTrackingTab from './ItemTrackingTab';
import StockItemDetailSheet from './StockItemDetailSheet';

/**
 * Path-driven tabs — the URL is the single source of truth for the active tab
 * so deep links and the browser back button work. No local tab state.
 */
export const TAB_PATHS = {
  live:     '/headoffice/stock',
  storage:  '/headoffice/stock/storage',
  tracking: '/headoffice/stock/tracking',
} as const;

export const PATH_TABS: Record<string, keyof typeof TAB_PATHS> = {
  '/headoffice/stock':          'live',
  '/headoffice/stock/storage':  'storage',
  '/headoffice/stock/tracking': 'tracking',
};

const money = (n: number) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MAT_TYPE_LABELS: Record<string, string> = {
  item:        'Item Name (SKU)',
  material:    'Raw Material',
  raw_material:'Packing Material',
};

function ItemTypeBadge({ type }: { type?: string }) {
  if (type === 'material')
    return <Badge variant="outline" className="text-xs text-orange-500 border-orange-500/30">Raw Material</Badge>;
  if (type === 'raw_material')
    return <Badge variant="outline" className="text-xs text-purple-500 border-purple-500/30">Packing Material</Badge>;
  return <Badge variant="outline" className="text-xs text-emerald-500 border-emerald-500/30">Item Name (SKU)</Badge>;
}

export default function Stock() {
  const perm = usePermission('page:/headoffice/stock');
  const [location, navigate] = useLocation();
  const activeTab = PATH_TABS[location] ?? 'live';
  const [branchType,       setBranchType]       = useState<string>('all');
  const [branchId,         setBranchId]         = useState<string>('');
  useClearOutletSelection(branchType === 'outlet', () => { setBranchType('all'); setBranchId(''); });
  const [materialType,     setMaterialType]     = useState<string>('all');
  const [search,           setSearch]           = useState('');
  const [debouncedSearch,  setDebouncedSearch]  = useState('');
  // Identity of the row whose detail sheet is open — `kind:branchType:branchId:itemId`.
  // Stored as a key (not the row object) so a background refetch keeps the
  // sheet fed with fresh data instead of a stale snapshot.
  const [detailKey,        setDetailKey]        = useState<string | null>(null);
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets    = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();

  // Debounce search — runs on server
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params: any = {};
  if (branchType !== 'all') params.branchType = branchType;
  if (branchId && branchId !== '0') params.branchId = Number(branchId);
  if (materialType !== 'all') params.materialType = materialType;

  // limit: 0 asks the server for the whole list in one response — no paging —
  // while keeping the envelope that carries the valuation-visibility flag.
  const { data: stockPage, isLoading, isFetching } = usePaginatedStock({
    ...params, limit: 0, q: debouncedSearch || undefined,
  });
  const stock = stockPage?.rows ?? [];
  // Whether this role may see what the stock is WORTH is the server's call, not
  // the browser's. It strips avgCost/stockValue/costPrice from the payload for
  // roles without the inventory-valuation right and reports the same answer
  // here so the table can drop the columns instead of rendering a row of
  // dashes. Absent means hidden: if the answer has not arrived yet, showing
  // nothing is the safe direction.
  const canSeeValue = (stockPage as any)?.canViewValuation === true;
  // Item, Type, Location, Storage, Qty, Reserved, Available, [Value], Status,
  // trailing detail-chevron.
  const COLS = canSeeValue ? 10 : 9;
  const totalRows  = stockPage?.total ?? 0;

  // Lots exist for all three product kinds. Omitting materialType returns every
  // kind; it is only passed when the page itself is filtered to one.
  const batchParams: any = {};
  if (branchType !== 'all') batchParams.branchType = branchType;
  if (branchId && branchId !== '0') batchParams.branchId = Number(branchId);
  if (materialType !== 'all') batchParams.materialType = materialType;
  const { data: batches = [] } = useListStockBatches(batchParams);

  // Finished goods, raw materials and packing materials share one id space, so
  // the kind has to be part of the key — grouping on item id alone would show a
  // material's row the identically-numbered finished good's lots.
  const batchMap = useMemo(() => {
    const m = new Map<string, StockBatch[]>();
    for (const b of batches as StockBatch[]) {
      const key = `${b.materialType ?? 'item'}:${b.branchType}:${b.branchId}:${b.itemId}`;
      const arr = m.get(key) ?? [];
      arr.push(b);
      m.set(key, arr);
    }
    return m;
  }, [batches]);

  const filtered = stock as any[];
  const { sorted, sort } = useTableSort(filtered, {
    itemName: (s: any) => s.itemName,
    materialType: (s: any) => MAT_TYPE_LABELS[s.materialType ?? 'item'] ?? s.materialType,
    branchName: (s: any) => s.branchName || 'Head Office',
    quantity: (s: any) => Number(s.quantity),
    reserved: (s: any) => Number(s.reserved || 0),
    available: (s: any) => Number(s.available),
    stockValue: (s: any) => Number(s.stockValue),
  });
  const branchOptions = branchType === 'warehouse' ? warehouses : branchType === 'outlet' ? outlets : [];

  // Resolve the open detail row from CURRENT data. If a refetch dropped the
  // row (filters changed, stock moved), the sheet simply closes.
  const detailRow = useMemo(() => {
    if (!detailKey) return null;
    return (stock as any[]).find(s =>
      `${s.materialType ?? 'item'}:${s.branchType}:${s.branchId}:${s.itemId}` === detailKey) ?? null;
  }, [detailKey, stock]);
  const detailBatches = detailKey ? (batchMap.get(detailKey) ?? []) : [];

  const totalValue = filtered.reduce((s, r) => s + Number(r.stockValue || 0), 0);

  const filterCount = (materialType !== 'all' ? 1 : 0) + (branchType !== 'all' ? 1 : 0);
  const clearFilters = () => { setMaterialType('all'); setBranchType('all'); setBranchId(''); };

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
        <Tabs value={activeTab} className="space-y-6">
          <TabsList>
            <TabsTrigger value="live" onClick={() => navigate(TAB_PATHS.live)}>
              <BarChart3 className="w-4 h-4 mr-2" /> Live Stock
            </TabsTrigger>
            <TabsTrigger value="storage" onClick={() => navigate(TAB_PATHS.storage)}>
              <Snowflake className="w-4 h-4 mr-2" /> Storage Locations
            </TabsTrigger>
            <TabsTrigger value="tracking" onClick={() => navigate(TAB_PATHS.tracking)}>
              <PackageSearch className="w-4 h-4 mr-2" /> Item Tracking
            </TabsTrigger>
          </TabsList>

          <TabsContent value="live" className="space-y-6 mt-0">
        <PageHeader
          title="Live Stock"
          description="All inventory — Item Name (SKU), Raw Materials, and Packing Materials across all locations"
          icon={BarChart3}
          actions={perm.canDownload ? (
            <Button variant="outline" size="sm" onClick={() => downloadCSV('stock.csv', filtered.map(s => ({
              Item: s.itemName,
              'Item Type': MAT_TYPE_LABELS[s.materialType ?? 'item'] ?? s.materialType,
              Location: s.branchName,
              'Location Type': s.branchType,
              Qty: s.quantity,
              Reserved: s.reserved || 0,
              Available: s.available,
              Unit: s.unit,
              'Reorder Level': s.reorderLevel,
              // The export follows the screen. A role that cannot see the money
              // on screen must not be able to download it either.
              ...(canSeeValue ? { 'Avg Cost': s.avgCost, Value: s.stockValue } : {}),
            })))}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
          ) : undefined}
        />

        <SummaryCardGrid>
          <SummaryCard
            label="Stock Entries"
            value={totalRows.toLocaleString('en-IN')}
            icon={Boxes}
            loading={isLoading}
          />
          {canSeeValue && (
            <SummaryCard
              label="Total Stock Value"
              value={money(totalValue)}
              icon={Wallet}
              tone="positive"
              loading={isLoading}
            />
          )}
        </SummaryCardGrid>

        {/* Toolbar: search left, filters right */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search item or location..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <FilterPanel activeCount={filterCount} onClear={clearFilters}>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Item type</label>
              <Select value={materialType} onValueChange={v => setMaterialType(v)}>
                <SelectTrigger className="w-full"><SelectValue placeholder="All Types" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Item Types</SelectItem>
                  <SelectItem value="item">Item Name (SKU)</SelectItem>
                  <SelectItem value="material">Raw Material</SelectItem>
                  <SelectItem value="raw_material">Packing Material</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Location</label>
              <Select value={branchType} onValueChange={v => { setBranchType(v); setBranchId(''); }}>
                <SelectTrigger className="w-full"><SelectValue placeholder="All Locations" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Locations</SelectItem>
                  <SelectItem value="headoffice">Head Office</SelectItem>
                  <SelectItem value="warehouse">Warehouse</SelectItem>
                  {outletsEnabled && <SelectItem value="outlet">Outlet</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            {branchOptions.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Specific location</label>
                <Select value={branchId} onValueChange={v => setBranchId(v)}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">All</SelectItem>
                    {branchOptions.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </FilterPanel>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={8} cols={COLS} />
          ) : filtered.length === 0 ? (
            <EmptyState icon={BarChart3} title="No stock data found" hint="Try adjusting your search or filters." />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="itemName" sort={sort}>Item</SortableHead>
                <SortableHead k="materialType" sort={sort}>Item Type</SortableHead>
                <SortableHead k="branchName" sort={sort}>Location</SortableHead>
                <TableHead>Storage</TableHead>
                <SortableHead k="quantity" sort={sort} className="text-right">Quantity</SortableHead>
                <SortableHead k="reserved" sort={sort} className="text-right">Reserved</SortableHead>
                <SortableHead k="available" sort={sort} className="text-right">Available</SortableHead>
                {canSeeValue && <SortableHead k="stockValue" sort={sort} className="text-right">Value</SortableHead>}
                <TableHead className="text-right">Status</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((s, i) => {
                const kind     = (s.materialType ?? 'item') as string;
                const isItem   = kind === 'item';
                const batchKey = `${kind}:${s.branchType}:${s.branchId}:${s.itemId}`;
                const rowKey   = `${batchKey}:${i}`;
                const rowBatches = batchMap.get(batchKey) ?? [];
                const low  = !!s.lowStock;
                const worst = rowBatches.some(b => b.status === 'expired') ? 'expired'
                  : rowBatches.some(b => b.status === 'near_expiry') ? 'near_expiry' : null;

                return (
                    <TableRow
                      key={rowKey}
                      className={`hover:bg-muted/10 cursor-pointer ${low ? 'bg-red-500/5' : ''}`}
                      onClick={() => setDetailKey(batchKey)}
                    >
                      <TableCell className="font-semibold">{s.itemName}</TableCell>
                      <TableCell><ItemTypeBadge type={s.materialType} /></TableCell>
                      <TableCell className="text-muted-foreground">{s.branchName || 'Head Office'}</TableCell>
                      <TableCell>
                        {Array.isArray(s.storageLocations) && s.storageLocations.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {s.storageLocations.map((sl: any, li: number) => (
                              <Badge key={`${sl.storageLocationId ?? sl.name}:${li}`} variant="secondary" className="text-[10px] font-normal gap-1">
                                {sl.name} <span className="font-mono">({Number(sl.quantity).toLocaleString('en-IN')})</span>
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {Number(s.quantity).toLocaleString('en-IN')}{' '}
                        <span className="text-xs font-normal text-muted-foreground">{s.unit}</span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {Number(s.reserved || 0) > 0 ? (
                          <span className="text-amber-600 font-semibold">{Number(s.reserved).toLocaleString('en-IN')}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className={`text-right font-mono font-bold ${low ? 'text-red-500' : 'text-emerald-500'}`}>
                        {Number(s.available).toLocaleString('en-IN')}{' '}
                        <span className="text-xs font-normal text-muted-foreground">{s.unit}</span>
                      </TableCell>
                      {canSeeValue && (
                        <TableCell className="text-right font-mono text-sm">
                          {Number(s.stockValue) > 0 ? money(s.stockValue) : '—'}
                        </TableCell>
                      )}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          {worst === 'expired'    && <Badge variant="destructive" className="text-[10px]">Expired batch</Badge>}
                          {worst === 'near_expiry' && <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">Expiring</Badge>}
                          {isItem
                            ? (low
                                ? <Badge variant="destructive" className="text-xs gap-1"><AlertTriangle className="w-3 h-3" /> Low (&lt;{Number(s.reorderLevel)})</Badge>
                                : <Badge variant="outline" className="text-xs text-emerald-500 border-emerald-500/30">OK</Badge>)
                            : <Badge variant="outline" className="text-xs text-muted-foreground">In stock</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="pl-0 pr-3">
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                );
              })}
            </TableBody>
          </Table>
          )}

          {totalRows > 0 && (
            <div className="p-3 border-t border-border text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
              <span>
                {totalRows} {totalRows === 1 ? 'entry' : 'entries'}
                {isFetching ? ' · refreshing…' : ''}
              </span>
              {canSeeValue && (
                <span className="font-semibold text-foreground">Total stock value: {money(totalValue)}</span>
              )}
            </div>
          )}
        </div>

        {/* Structured item detail — opened by clicking any stock row */}
        <StockItemDetailSheet
          row={detailRow}
          batches={detailBatches}
          canSeeValue={canSeeValue}
          onOpenChange={open => { if (!open) setDetailKey(null); }}
        />
          </TabsContent>

          <TabsContent value="storage" className="space-y-6 mt-0">
            <PageHeader
              title="Storage Locations"
              description="Where each product sits inside a warehouse — freezers, cold rooms, racks and shelves"
              icon={Snowflake}
            />
            <StorageLocationsTab perm={{ canAdd: perm.canAdd, canEdit: perm.canEdit, canDelete: perm.canDelete }} />
          </TabsContent>

          <TabsContent value="tracking" className="space-y-6 mt-0">
            <PageHeader
              title="Item Tracking"
              description="The full lifecycle of one product — purchases, sales, returns, transfers, production and stock counts"
              icon={PackageSearch}
            />
            <ItemTrackingTab />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
