import { Fragment, useEffect, useMemo, useState } from 'react';
import { usePaginatedStock, useListWarehouses, useListOutlets, useListStockBatches, type StockBatch } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, BarChart3, Download, AlertTriangle, ChevronRight, ChevronDown, Layers, ShieldOff } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';

const money = (n: number) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateIN = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

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

function ExpiryBadge({ batch }: { batch: StockBatch }) {
  if (batch.status === 'expired')
    return <Badge variant="destructive" className="text-[10px]">Expired {Math.abs(batch.daysToExpiry ?? 0)}d ago</Badge>;
  if (batch.status === 'near_expiry')
    return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">{batch.daysToExpiry}d left</Badge>;
  if (batch.status === 'no_expiry')
    return <span className="text-xs text-muted-foreground">—</span>;
  return <Badge variant="outline" className="text-[10px] text-emerald-500 border-emerald-500/30">{batch.daysToExpiry}d</Badge>;
}

export default function Stock() {
  const perm = usePermission('Stock');
  const [branchType,       setBranchType]       = useState<string>('all');
  const [branchId,         setBranchId]         = useState<string>('');
  const [materialType,     setMaterialType]     = useState<string>('all');
  const [search,           setSearch]           = useState('');
  const [debouncedSearch,  setDebouncedSearch]  = useState('');
  const [page,             setPage]             = useState(1);
  const PAGE_SIZE = 50;
  const [expanded,         setExpanded]         = useState<Set<string>>(new Set());
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets    = [] } = useListOutlets();

  // Debounce search — runs on server
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset page when any filter changes
  useEffect(() => { setPage(1); }, [branchType, branchId, materialType]);

  const params: any = {};
  if (branchType !== 'all') params.branchType = branchType;
  if (branchId && branchId !== '0') params.branchId = Number(branchId);
  if (materialType !== 'all') params.materialType = materialType;

  const { data: stockPage, isLoading, isFetching } = usePaginatedStock({
    ...params, page, limit: PAGE_SIZE, q: debouncedSearch || undefined,
  });
  const stock = stockPage?.rows ?? [];
  const totalRows  = stockPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // Batches only apply to items (SKU); pass only branchType/branchId, not materialType
  const batchParams: any = {};
  if (branchType !== 'all') batchParams.branchType = branchType;
  if (branchId && branchId !== '0') batchParams.branchId = Number(branchId);
  const { data: batches = [] } = useListStockBatches(batchParams);

  // Group batches per item-location key (items only)
  const batchMap = useMemo(() => {
    const m = new Map<string, StockBatch[]>();
    for (const b of batches as StockBatch[]) {
      const key = `item:${b.branchType}:${b.branchId}:${b.itemId}`;
      const arr = m.get(key) ?? [];
      arr.push(b);
      m.set(key, arr);
    }
    return m;
  }, [batches]);

  const filtered = stock as any[];
  const branchOptions = branchType === 'warehouse' ? warehouses : branchType === 'outlet' ? outlets : [];

  const toggle = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const totalValue = filtered.reduce((s, r) => s + Number(r.stockValue || 0), 0);

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
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <BarChart3 className="w-6 h-6 text-primary" /> Live Stock
            </h1>
            <p className="text-muted-foreground mt-1">
              All inventory — Item Name (SKU), Raw Materials, and Packing Materials across all locations
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => downloadCSV('stock.csv', filtered.map(s => ({
            Item: s.itemName,
            'Item Type': MAT_TYPE_LABELS[s.materialType ?? 'item'] ?? s.materialType,
            Location: s.branchName,
            'Location Type': s.branchType,
            Qty: s.quantity,
            Unit: s.unit,
            'Reorder Level': s.reorderLevel,
            'Avg Cost': s.avgCost,
            Value: s.stockValue,
          })))}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {/* Filter bar */}
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="Search item or location..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="border-transparent bg-transparent focus-visible:ring-0"
              />
            </div>

            {/* Item Type filter */}
            <Select value={materialType} onValueChange={v => { setMaterialType(v); setPage(1); }}>
              <SelectTrigger className="w-44"><SelectValue placeholder="All Types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Item Types</SelectItem>
                <SelectItem value="item">Item Name (SKU)</SelectItem>
                <SelectItem value="material">Raw Material</SelectItem>
                <SelectItem value="raw_material">Packing Material</SelectItem>
              </SelectContent>
            </Select>

            {/* Location filter */}
            <Select value={branchType} onValueChange={v => { setBranchType(v); setBranchId(''); setPage(1); }}>
              <SelectTrigger className="w-44"><SelectValue placeholder="All Locations" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                <SelectItem value="headoffice">Head Office</SelectItem>
                <SelectItem value="warehouse">Warehouse</SelectItem>
                <SelectItem value="outlet">Outlet</SelectItem>
              </SelectContent>
            </Select>

            {branchOptions.length > 0 && (
              <Select value={branchId} onValueChange={v => { setBranchId(v); setPage(1); }}>
                <SelectTrigger className="w-44"><SelectValue placeholder="All" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">All</SelectItem>
                  {branchOptions.map((b: any) => (
                    <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead className="w-8" />
                <TableHead>Item</TableHead>
                <TableHead>Item Type</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Available Stock</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <div className="h-8 bg-muted/30 rounded animate-pulse" />
                    </TableCell>
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                    <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>No stock data found</p>
                  </TableCell>
                </TableRow>
              ) : filtered.map((s, i) => {
                const isItem   = !s.materialType || s.materialType === 'item';
                const rowKey   = `${s.materialType ?? 'item'}:${s.branchType}:${s.branchId}:${s.itemId}:${i}`;
                const batchKey = `item:${s.branchType}:${s.branchId}:${s.itemId}`;
                const rowBatches = isItem ? (batchMap.get(batchKey) ?? []) : [];
                const tracked    = rowBatches.reduce((sum, b) => sum + Number(b.quantity), 0);
                const untracked  = Math.round((Number(s.quantity) - tracked) * 1000) / 1000;
                const low  = !!s.lowStock;
                const worst = rowBatches.some(b => b.status === 'expired') ? 'expired'
                  : rowBatches.some(b => b.status === 'near_expiry') ? 'near_expiry' : null;
                const isOpen = expanded.has(rowKey);

                return (
                  <Fragment key={rowKey}>
                    <TableRow
                      className={`hover:bg-muted/10 ${isItem ? 'cursor-pointer' : ''} ${low ? 'bg-red-500/5' : ''}`}
                      onClick={() => isItem && toggle(rowKey)}
                    >
                      <TableCell className="pr-0">
                        {isItem
                          ? (isOpen
                              ? <ChevronDown  className="w-4 h-4 text-muted-foreground" />
                              : <ChevronRight className="w-4 h-4 text-muted-foreground" />)
                          : <span className="w-4 h-4 block" />}
                      </TableCell>
                      <TableCell className="font-semibold">{s.itemName}</TableCell>
                      <TableCell><ItemTypeBadge type={s.materialType} /></TableCell>
                      <TableCell className="text-muted-foreground">{s.branchName || 'Head Office'}</TableCell>
                      <TableCell className={`text-right font-mono font-bold ${low ? 'text-red-500' : 'text-emerald-500'}`}>
                        {Number(s.quantity).toLocaleString('en-IN')}{' '}
                        <span className="text-xs font-normal text-muted-foreground">{s.unit}</span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {Number(s.stockValue) > 0 ? money(s.stockValue) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          {isItem && worst === 'expired'    && <Badge variant="destructive" className="text-[10px]">Expired batch</Badge>}
                          {isItem && worst === 'near_expiry' && <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">Expiring</Badge>}
                          {isItem
                            ? (low
                                ? <Badge variant="destructive" className="text-xs gap-1"><AlertTriangle className="w-3 h-3" /> Low (&lt;{Number(s.reorderLevel)})</Badge>
                                : <Badge variant="outline" className="text-xs text-emerald-500 border-emerald-500/30">OK</Badge>)
                            : <Badge variant="outline" className="text-xs text-muted-foreground">In stock</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>

                    {/* Expanded batch detail — items only */}
                    {isOpen && isItem && (
                      <TableRow className="bg-muted/5 hover:bg-muted/5">
                        <TableCell />
                        <TableCell colSpan={6} className="py-3">
                          {rowBatches.length === 0 && untracked <= 0 ? (
                            <p className="text-xs text-muted-foreground flex items-center gap-2">
                              <Layers className="w-3.5 h-3.5" /> No batch records for this stock
                            </p>
                          ) : (
                            <div className="rounded-lg border border-border overflow-hidden max-w-3xl">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="bg-muted/20 text-muted-foreground">
                                    <th className="text-left px-3 py-1.5 font-medium">Batch</th>
                                    <th className="text-left px-3 py-1.5 font-medium">Barcode</th>
                                    <th className="text-left px-3 py-1.5 font-medium">Mfg</th>
                                    <th className="text-left px-3 py-1.5 font-medium">Expiry</th>
                                    <th className="text-left px-3 py-1.5 font-medium">Shelf Life</th>
                                    <th className="text-right px-3 py-1.5 font-medium">Qty</th>
                                    <th className="text-right px-3 py-1.5 font-medium">MRP</th>
                                    <th className="text-right px-3 py-1.5 font-medium">Unit Cost</th>
                                    <th className="text-left px-3 py-1.5 font-medium">Source</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {rowBatches.map(b => (
                                    <tr key={b.id} className="border-t border-border/60">
                                      <td className="px-3 py-1.5 font-mono">{b.batchNumber}</td>
                                      <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{(b as any).barcode || '—'}</td>
                                      <td className="px-3 py-1.5">{dateIN(b.mfgDate)}</td>
                                      <td className="px-3 py-1.5">{dateIN(b.expiryDate)}</td>
                                      <td className="px-3 py-1.5"><ExpiryBadge batch={b} /></td>
                                      <td className="px-3 py-1.5 text-right font-mono">{Number(b.quantity).toLocaleString('en-IN')}</td>
                                      {/* Null MRP = never priced. Lots created before MRP was
                                          tracked fall back to the item's current MRP. */}
                                      <td className="px-3 py-1.5 text-right font-mono">{(b as any).mrp != null ? money((b as any).mrp) : '—'}</td>
                                      <td className="px-3 py-1.5 text-right font-mono">{Number(b.unitCost) > 0 ? money(b.unitCost) : '—'}</td>
                                      <td className="px-3 py-1.5 capitalize text-muted-foreground">{b.source}</td>
                                    </tr>
                                  ))}
                                  {untracked > 0 && (
                                    <tr className="border-t border-border/60 text-muted-foreground">
                                      <td className="px-3 py-1.5 italic" colSpan={5}>Untracked (no batch record)</td>
                                      <td className="px-3 py-1.5 text-right font-mono">{untracked.toLocaleString('en-IN')}</td>
                                      <td colSpan={3} />
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>

          {totalRows > 0 && (
            <div className="p-3 border-t border-border text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
              <span>
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalRows)} of {totalRows} entries
                {isFetching ? ' · refreshing…' : ''}
              </span>
              <div className="flex items-center gap-3">
                <span className="font-semibold text-foreground">Page stock value: {money(totalValue)}</span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                  <span className="px-1">Page {page}/{totalPages}</span>
                  <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
