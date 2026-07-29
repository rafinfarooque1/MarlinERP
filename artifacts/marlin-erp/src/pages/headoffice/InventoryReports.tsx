import { useState } from 'react';
import {
  useGetStockValuation, useGetExpiryReport, useGetReorderReport, useGetMovementAnalysis,
  useListWarehouses,
  type ValuationRow, type ExpiryReportRow, type ReorderRow, type StockProductKind,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Boxes, Download, ShieldOff, CheckCircle2, AlertTriangle, PackageX } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';

const fmt = (n: number) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n: number) => (Number(n) || 0).toLocaleString('en-IN');
const dateFmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold font-mono mt-1 ${accent ?? ''}`}>{value}</p>
    </div>
  );
}

export default function InventoryReports() {
  const perms = usePermission('page:/headoffice/inventory-reports');
  const [tab, setTab] = useState('valuation');
  const [search, setSearch] = useState('');
  
  // Valuation filters
  const [materialType, setMaterialType] = useState<string>('all');
  const [branchType, setBranchType] = useState<string>('all');
  const [branchId, setBranchId] = useState<string>('');

  // Expiry filters
  const [expiryBranchType, setExpiryBranchType] = useState<string>('');
  const [expiryBranchId, setExpiryBranchId] = useState<string>('');
  const [expiryFrom, setExpiryFrom] = useState('');
  const [expiryTo, setExpiryTo] = useState('');

  // Movement filters
  const [movementBranchType, setMovementBranchType] = useState<string>('');
  const [movementBranchId, setMovementBranchId] = useState<string>('');
  const [movementClass, setMovementClass] = useState<string>('all');

  const { data: warehouses = [] } = useListWarehouses();

  const valuationParams: any = {};
  if (materialType !== 'all') valuationParams.materialType = materialType as StockProductKind;
  if (branchType !== 'all') valuationParams.branchType = branchType;
  if (branchId && branchId !== '0') valuationParams.branchId = Number(branchId);

  const nearExpiryParams: any = { status: 'near_expiry' };
  if (expiryBranchType) nearExpiryParams.branchType = expiryBranchType;
  if (expiryBranchId && expiryBranchId !== '0') nearExpiryParams.branchId = Number(expiryBranchId);
  if (expiryFrom) nearExpiryParams.from = expiryFrom;
  if (expiryTo) nearExpiryParams.to = expiryTo;

  const expiredParams: any = { status: 'expired' };
  if (expiryBranchType) expiredParams.branchType = expiryBranchType;
  if (expiryBranchId && expiryBranchId !== '0') expiredParams.branchId = Number(expiryBranchId);
  if (expiryFrom) expiredParams.from = expiryFrom;
  if (expiryTo) expiredParams.to = expiryTo;

  const movementParams: any = {};
  if (movementBranchType) movementParams.branchType = movementBranchType;
  if (movementBranchId && movementBranchId !== '0') movementParams.branchId = Number(movementBranchId);
  if (movementClass !== 'all') movementParams.class = movementClass;

  const valuation = useGetStockValuation(valuationParams);
  const nearExpiry = useGetExpiryReport(nearExpiryParams);
  const expired = useGetExpiryReport(expiredParams);
  const movement = useGetMovementAnalysis(movementParams);
  const reorder = useGetReorderReport();

  const valuationBranchOptions = branchType === 'warehouse' ? warehouses : [];
  const expiryBranchOptions = expiryBranchType === 'warehouse' ? warehouses : [];
  const movementBranchOptions = movementBranchType === 'warehouse' ? warehouses : [];

  if (!perms.isLoading && !perms.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <ShieldOff className="w-10 h-10 text-muted-foreground mb-3" />
          <h2 className="text-lg font-semibold">No access</h2>
          <p className="text-sm text-muted-foreground mt-1">You don't have permission to view Inventory Reports.</p>
        </div>
      </AppLayout>
    );
  }

  const val = valuation.data;
  const valRows = val?.rows ?? [];
  const q = search.trim().toLowerCase();
  const filteredValRows = q
    ? valRows.filter(r => r.itemName.toLowerCase().includes(q) || r.branchName.toLowerCase().includes(q))
    : valRows;

  const nearExp = nearExpiry.data;
  const nearExpRows = nearExp?.rows ?? [];
  const expRows = expired.data?.rows ?? [];
  const movementRows = movement.data?.rows ?? [];
  const reorderRows = reorder.data ?? [];

  const exportValuation = () => {
    downloadCSV('stock-valuation.csv', valRows.map((r: ValuationRow) => ({
      'Product Type': r.typeLabel, Item: r.itemName, Unit: r.unit, Location: r.branchName, Type: cap(r.branchType),
      'In Transit': r.inTransit ? 'Yes' : 'No',
      Quantity: r.quantity, Reserved: r.reserved, Available: r.available,
      'Avg Cost': r.avgCost, Value: r.value,
    })));
  };
  const exportNearExpiry = () => {
    downloadCSV('near-expiry.csv', nearExpRows.map((r: ExpiryReportRow) => ({
      Type: r.typeLabel, Item: r.itemName, Batch: r.batchNumber, Location: r.branchName,
      Mfg: r.mfgDate ?? '', Expiry: r.expiryDate, 'Days to Expiry': r.daysToExpiry,
      Quantity: r.quantity, Reserved: r.reserved, Available: r.available,
      'Unit Cost': r.unitCost, Value: r.value, Bucket: r.bucketLabel,
    })));
  };
  const exportExpired = () => {
    downloadCSV('expired-stock.csv', expRows.map((r: ExpiryReportRow) => ({
      Type: r.typeLabel, Item: r.itemName, Batch: r.batchNumber, Location: r.branchName,
      Mfg: r.mfgDate ?? '', 'Expired On': r.expiryDate, 'Days Ago': Math.abs(r.daysToExpiry),
      Quantity: r.quantity, Reserved: r.reserved, Available: r.available,
      'Unit Cost': r.unitCost, Value: r.value,
    })));
  };
  const exportMovement = () => {
    downloadCSV('movement-analysis.csv', movementRows.map((r: any) => ({
      Type: r.typeLabel, Item: r.itemName, Location: r.branchName,
      Class: r.classLabel, 'Days Since Outbound': r.daysSinceOutbound ?? 'Never',
      'Last Outbound': r.lastOutboundAt ? dateFmt(r.lastOutboundAt) : 'Never',
      Qty: r.quantity, Available: r.available, 'Unit Cost': r.unitCost, Value: r.value,
      'No History': r.noHistory ? 'Yes' : 'No',
    })));
  };
  const exportReorder = () => {
    downloadCSV('reorder-report.csv', reorderRows.map((r: ReorderRow) => ({
      Item: r.itemName, Unit: r.unit, Location: r.branchName, Type: cap(r.branchType),
      'Current Qty': r.quantity, 'Reorder Level': r.reorderLevel, Shortfall: r.shortfall,
    })));
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Boxes className="w-6 h-6 text-primary" /> Inventory Reports
            </h1>
            <p className="text-muted-foreground mt-1">Valuation, expiry risk and reorder planning</p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="valuation">Valuation</TabsTrigger>
            <TabsTrigger value="near_expiry">Near Expiry</TabsTrigger>
            <TabsTrigger value="expired">Expired</TabsTrigger>
            <TabsTrigger value="movement">Slow / Dead</TabsTrigger>
            <TabsTrigger value="reorder">Reorder</TabsTrigger>
          </TabsList>

          {/* ── Valuation ───────────────────────────────────────────────── */}
          <TabsContent value="valuation" className="space-y-4 mt-4">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Select value={materialType} onValueChange={setMaterialType}>
                <SelectTrigger className="h-8 text-xs w-44"><SelectValue placeholder="All Types" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Product Kinds</SelectItem>
                  <SelectItem value="item">Finished Good</SelectItem>
                  <SelectItem value="material">Raw Material</SelectItem>
                  <SelectItem value="raw_material">Packing Material</SelectItem>
                </SelectContent>
              </Select>
              <Select value={branchType} onValueChange={(v) => { setBranchType(v); setBranchId(''); }}>
                <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All Locations" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Locations</SelectItem>
                  <SelectItem value="headoffice">Head Office</SelectItem>
                  <SelectItem value="warehouse">Warehouse</SelectItem>
                </SelectContent>
              </Select>
              {valuationBranchOptions.length > 0 && (
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">All</SelectItem>
                    {valuationBranchOptions.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <StatCard label="Grand Total" value={fmt(val?.grandTotal ?? 0)} accent="text-emerald-500" />
              <StatCard label="On-hand" value={fmt(val?.onHandValue ?? 0)} />
              <StatCard label="In-transit" value={fmt(val?.inTransitValue ?? 0)} accent="text-amber-600" />
              <StatCard label="Reserved Qty" value={qty(val?.reservedQuantity ?? 0)} accent={val?.reservedQuantity ? 'text-amber-600' : ''} />
            </div>

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border bg-muted/20">
                <h3 className="font-semibold text-sm">Locations Summary</h3>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Location</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Lines</TableHead>
                      <TableHead className="text-right">Total Qty</TableHead>
                      <TableHead className="text-right">On-hand</TableHead>
                      <TableHead className="text-right">In-transit</TableHead>
                      <TableHead className="text-right">Total Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {valuation.isLoading ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <TableRow key={i}><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                      ))
                    ) : (val?.locations.length ?? 0) === 0 ? (
                      <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-sm">No stock locations</TableCell></TableRow>
                    ) : val!.locations.map((l, i) => (
                      <TableRow key={i} className="hover:bg-muted/10">
                        <TableCell className="text-sm font-medium">{l.branchName}</TableCell>
                        <TableCell><Badge variant="secondary" className="text-xs">{cap(l.branchType)}</Badge></TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(l.itemCount)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(l.totalQuantity)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(l.onHandValue)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{l.inTransitValue > 0 ? fmt(l.inTransitValue) : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmt(l.totalValue)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="flex items-center justify-between flex-wrap gap-3">
              <Input
                placeholder="Search item or location…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-64"
              />
              {perms.canDownload && valRows.length > 0 && (
                <Button variant="outline" size="sm" onClick={exportValuation}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              )}
            </div>

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border bg-muted/20">
                <h3 className="font-semibold text-sm">Valuation Detail</h3>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Type</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead>Unit</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Rsvd</TableHead>
                      <TableHead className="text-right">Avail</TableHead>
                      <TableHead className="text-right">Avg Cost</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {valuation.isLoading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                      ))
                    ) : filteredValRows.length === 0 ? (
                      <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground text-sm">No matching stock</TableCell></TableRow>
                    ) : filteredValRows.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/10">
                        <TableCell><Badge variant="outline" className="text-[10px]">{r.typeLabel}</Badge></TableCell>
                        <TableCell className="text-sm font-medium">{r.itemName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.unit || '—'}</TableCell>
                        <TableCell className={`text-xs ${r.inTransit ? 'text-amber-600' : ''}`}>{r.branchName}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(r.quantity)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{r.reserved > 0 ? <span className="text-amber-600 font-semibold">{qty(r.reserved)}</span> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold">{qty(r.available)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.avgCost)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.value)}</TableCell>
                      </TableRow>
                    ))}
                    {!valuation.isLoading && filteredValRows.length > 0 && (
                      <TableRow className="bg-muted/10 font-bold border-t-2">
                        <TableCell colSpan={8} className="text-xs uppercase tracking-wider">Grand Total</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(val?.grandTotal ?? 0)}</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* ── Near Expiry ─────────────────────────────────────────────── */}
          <TabsContent value="near_expiry" className="space-y-4 mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={expiryBranchType} onValueChange={(v) => { setExpiryBranchType(v); setExpiryBranchId(''); }}>
                <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All Locations" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All Locations</SelectItem>
                  <SelectItem value="warehouse">Warehouse</SelectItem>
                </SelectContent>
              </Select>
              {expiryBranchOptions.length > 0 && (
                <Select value={expiryBranchId} onValueChange={setExpiryBranchId}>
                  <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">All</SelectItem>
                    {expiryBranchOptions.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">From</span>
                <Input type="date" value={expiryFrom} onChange={(e) => setExpiryFrom(e.target.value)} className="h-8 text-xs w-36" />
                <span className="text-xs text-muted-foreground">to</span>
                <Input type="date" value={expiryTo} onChange={(e) => setExpiryTo(e.target.value)} className="h-8 text-xs w-36" />
              </div>
              {perms.canDownload && nearExpRows.length > 0 && (
                <Button variant="outline" size="sm" onClick={exportNearExpiry}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              )}
            </div>

            {nearExp?.summary && (
              nearExpRows.length === 0 ? (
                <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 text-sm text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" /> No batches nearing expiry
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                  <StatCard label="Near-expiry Batches" value={qty(nearExp.summary.nearExpiryBatches)} accent="text-amber-600" />
                  <StatCard label="Qty at Risk" value={qty(nearExp.summary.nearExpiryQuantity)} />
                  <StatCard label="Value at Risk" value={fmt(nearExp.summary.nearExpiryValue)} accent="text-amber-600" />
                  <StatCard label="Locations" value={qty(new Set(nearExpRows.map(r => `${r.branchType}:${r.branchId}`)).size)} />
                </div>
              )
            )}

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Type</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead>Batch</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Expiry</TableHead>
                      <TableHead className="text-right">Shelf Life</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avail</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {nearExpiry.isLoading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                      ))
                    ) : nearExpRows.length === 0 ? (
                      <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground text-sm">No batches nearing expiry</TableCell></TableRow>
                    ) : nearExpRows.map((r) => (
                      <TableRow key={r.id} className="hover:bg-muted/10">
                        <TableCell><Badge variant="outline" className="text-[10px]">{r.typeLabel}</Badge></TableCell>
                        <TableCell className="text-sm font-medium">{r.itemName}</TableCell>
                        <TableCell className="font-mono text-xs">{r.batchNumber}</TableCell>
                        <TableCell className="text-xs">{r.branchName}</TableCell>
                        <TableCell className="text-xs">{dateFmt(r.expiryDate)}</TableCell>
                        <TableCell className="text-right">
                          <Badge className={`text-[10px] ${r.tone === 'warn' ? 'bg-amber-500/10 text-amber-600 border-amber-500/20' : r.tone === 'caution' ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20' : 'bg-muted/20 text-muted-foreground'}`}>
                            {r.bucketLabel}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(r.quantity)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold">{qty(r.available)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* ── Expired Stock ────────────────────────────────────────────── */}
          <TabsContent value="expired" className="space-y-4 mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={expiryBranchType} onValueChange={(v) => { setExpiryBranchType(v); setExpiryBranchId(''); }}>
                <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All Locations" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All Locations</SelectItem>
                  <SelectItem value="warehouse">Warehouse</SelectItem>
                </SelectContent>
              </Select>
              {expiryBranchOptions.length > 0 && (
                <Select value={expiryBranchId} onValueChange={setExpiryBranchId}>
                  <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">All</SelectItem>
                    {expiryBranchOptions.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">From</span>
                <Input type="date" value={expiryFrom} onChange={(e) => setExpiryFrom(e.target.value)} className="h-8 text-xs w-36" />
                <span className="text-xs text-muted-foreground">to</span>
                <Input type="date" value={expiryTo} onChange={(e) => setExpiryTo(e.target.value)} className="h-8 text-xs w-36" />
              </div>
              {perms.canDownload && expRows.length > 0 && (
                <Button variant="outline" size="sm" onClick={exportExpired}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              )}
            </div>

            {expired?.data?.summary && (
              expRows.length === 0 ? (
                <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 text-sm text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" /> No expired stock
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                  <StatCard label="Expired Batches" value={qty(expired.data.summary.expiredBatches)} accent="text-red-500" />
                  <StatCard label="Expired Qty" value={qty(expired.data.summary.expiredQuantity)} accent="text-red-500" />
                  <StatCard label="Expired Value" value={fmt(expired.data.summary.expiredValue)} accent="text-red-500" />
                  <StatCard label="Locations" value={qty(new Set(expRows.map(r => `${r.branchType}:${r.branchId}`)).size)} />
                </div>
              )
            )}

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Type</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead>Batch</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Expired On</TableHead>
                      <TableHead className="text-right">Days Ago</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avail</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expired.isLoading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                      ))
                    ) : expRows.length === 0 ? (
                      <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground text-sm">No expired stock</TableCell></TableRow>
                    ) : expRows.map((r) => (
                      <TableRow key={r.id} className="hover:bg-muted/10">
                        <TableCell><Badge variant="outline" className="text-[10px]">{r.typeLabel}</Badge></TableCell>
                        <TableCell className="text-sm font-medium">{r.itemName}</TableCell>
                        <TableCell className="font-mono text-xs">{r.batchNumber}</TableCell>
                        <TableCell className="text-xs">{r.branchName}</TableCell>
                        <TableCell className="text-xs">{dateFmt(r.expiryDate)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant="destructive" className="text-[10px]">{Math.abs(r.daysToExpiry)}d ago</Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(r.quantity)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold">{qty(r.available)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* ── Slow / Dead Stock ────────────────────────────────────────── */}
          <TabsContent value="movement" className="space-y-4 mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={movementBranchType} onValueChange={(v) => { setMovementBranchType(v); setMovementBranchId(''); }}>
                <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All Locations" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All Locations</SelectItem>
                  <SelectItem value="warehouse">Warehouse</SelectItem>
                </SelectContent>
              </Select>
              {movementBranchOptions.length > 0 && (
                <Select value={movementBranchId} onValueChange={setMovementBranchId}>
                  <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">All</SelectItem>
                    {movementBranchOptions.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Select value={movementClass} onValueChange={setMovementClass}>
                <SelectTrigger className="h-8 text-xs w-32"><SelectValue placeholder="All Classes" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Classes</SelectItem>
                  <SelectItem value="fast">Fast</SelectItem>
                  <SelectItem value="slow">Slow</SelectItem>
                  <SelectItem value="dormant">Dormant</SelectItem>
                  <SelectItem value="dead">Dead</SelectItem>
                </SelectContent>
              </Select>
              {perms.canDownload && movementRows.length > 0 && (
                <Button variant="outline" size="sm" onClick={exportMovement}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              )}
            </div>

            {movement.data?.summary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {movement.data.summary.map((s: any) => {
                  const classMap: Record<string, string> = {
                    fast: 'text-emerald-600',
                    slow: 'text-amber-600',
                    dormant: 'text-orange-600',
                    dead: 'text-red-500',
                  };
                  return (
                    <div key={s.class} className="bg-card border border-border rounded-lg p-3">
                      <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                      <p className={`font-bold font-mono text-sm ${classMap[s.class] ?? ''}`}>{s.lines} lines</p>
                      <p className="text-xs text-muted-foreground">{qty(s.quantity)} qty · {fmt(s.value)}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {movement.data?.ledgerStart && (
              <div className="text-xs text-muted-foreground bg-muted/20 border border-border rounded-lg p-3">
                Movement recorded since <b>{dateFmt(movement.data.ledgerStart)}</b>. Stock acquired before this date may show as "no history" even if it moved.
              </div>
            )}

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Class</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-right">Days Since Outbound</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avail</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movement.isLoading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}><TableCell colSpan={8}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                      ))
                    ) : movementRows.length === 0 ? (
                      <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground text-sm">No stock in selected class</TableCell></TableRow>
                    ) : movementRows.map((r: any, i: number) => {
                      const classMap: Record<string, string> = {
                        fast: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
                        slow: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
                        dormant: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
                        dead: 'bg-red-500/10 text-red-600 border-red-500/20',
                      };
                      return (
                        <TableRow key={i} className="hover:bg-muted/10">
                          <TableCell>
                            <Badge className={`text-[10px] ${classMap[r.class] ?? ''}`}>{r.classLabel}</Badge>
                          </TableCell>
                          <TableCell><Badge variant="outline" className="text-[10px]">{r.typeLabel}</Badge></TableCell>
                          <TableCell className="text-sm font-medium">{r.itemName}</TableCell>
                          <TableCell className="text-xs">{r.branchName}</TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {r.noHistory ? <span className="italic text-muted-foreground text-xs">No history</span> : (r.daysSinceOutbound != null ? qty(r.daysSinceOutbound) : <span className="text-muted-foreground">—</span>)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{qty(r.quantity)}</TableCell>
                          <TableCell className="text-right font-mono text-xs font-semibold">{qty(r.available)}</TableCell>
                          <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.value)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* ── Reorder ─────────────────────────────────────────────────── */}
          <TabsContent value="reorder" className="space-y-4 mt-4">
            <div className="flex items-center justify-end flex-wrap gap-3">
              {perms.canDownload && reorderRows.length > 0 && (
                <Button variant="outline" size="sm" onClick={exportReorder}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              )}
            </div>

            {!reorder.isLoading && reorderRows.length === 0 && (
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-4 h-4" /> All stock is above reorder levels
              </div>
            )}

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Item</TableHead>
                      <TableHead>Unit</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-right">Current Qty</TableHead>
                      <TableHead className="text-right">Reorder Level</TableHead>
                      <TableHead className="text-right">Shortfall</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reorder.isLoading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                      ))
                    ) : reorderRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                          <PackageX className="w-5 h-5 mx-auto mb-2 opacity-60" />
                          All stock is above reorder levels
                        </TableCell>
                      </TableRow>
                    ) : reorderRows.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/10">
                        <TableCell className="text-sm font-medium">{r.itemName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.unit || '—'}</TableCell>
                        <TableCell className="text-xs">{r.branchName}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(r.quantity)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(r.reorderLevel)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold text-red-500">{qty(r.shortfall)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
