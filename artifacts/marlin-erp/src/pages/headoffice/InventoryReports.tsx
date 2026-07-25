import { useState } from 'react';
import {
  useGetStockValuation, useGetExpiryReport, useGetReorderReport,
  type ValuationRow, type ExpiryReportRow, type ReorderRow,
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
  const perms = usePermission('Inventory Reports');
  const [tab, setTab] = useState('valuation');
  const [search, setSearch] = useState('');
  const [days, setDays] = useState('30');

  const valuation = useGetStockValuation();
  const expiry = useGetExpiryReport(Number(days));
  const reorder = useGetReorderReport();

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

  const exp = expiry.data;
  const expRows = exp?.rows ?? [];
  const reorderRows = reorder.data ?? [];

  const exportValuation = () => {
    downloadCSV('stock-valuation.csv', valRows.map((r: ValuationRow) => ({
      Item: r.itemName, Unit: r.unit, Location: r.branchName, Type: cap(r.branchType),
      Quantity: r.quantity, 'Avg Cost': r.avgCost, Value: r.value,
    })));
  };
  const exportExpiry = () => {
    downloadCSV(`expiry-report-${days}d.csv`, expRows.map((r: ExpiryReportRow) => ({
      Item: r.itemName, Unit: r.unit, Location: r.branchName, Batch: r.batchNumber,
      Mfg: r.mfgDate ?? '', Expiry: r.expiryDate, 'Days Left': r.daysToExpiry,
      Quantity: r.quantity, 'Unit Cost': r.unitCost, Value: r.value, Status: r.status,
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
            <TabsTrigger value="expiry">Expiry</TabsTrigger>
            <TabsTrigger value="reorder">Reorder</TabsTrigger>
          </TabsList>

          {/* ── Valuation ───────────────────────────────────────────────── */}
          <TabsContent value="valuation" className="space-y-4 mt-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard label="Grand Total" value={fmt(val?.grandTotal ?? 0)} accent="text-emerald-500" />
              <StatCard label="Locations" value={qty(val?.locations.length ?? 0)} />
              <StatCard label="Item-Location Rows" value={qty(valRows.length)} />
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
                      <TableHead className="text-right">Items</TableHead>
                      <TableHead className="text-right">Total Qty</TableHead>
                      <TableHead className="text-right">Total Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {valuation.isLoading ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <TableRow key={i}><TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                      ))
                    ) : (val?.locations.length ?? 0) === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">No stock locations</TableCell></TableRow>
                    ) : val!.locations.map((l, i) => (
                      <TableRow key={i} className="hover:bg-muted/10">
                        <TableCell className="text-sm font-medium">{l.branchName}</TableCell>
                        <TableCell><Badge variant="secondary">{cap(l.branchType)}</Badge></TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(l.itemCount)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(l.totalQuantity)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(l.totalValue)}</TableCell>
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
                      <TableHead>Item</TableHead>
                      <TableHead>Unit</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avg Cost</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {valuation.isLoading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                      ))
                    ) : filteredValRows.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">No matching stock</TableCell></TableRow>
                    ) : filteredValRows.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/10">
                        <TableCell className="text-sm font-medium">{r.itemName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.unit || '—'}</TableCell>
                        <TableCell className="text-xs">{r.branchName}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(r.quantity)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.avgCost)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.value)}</TableCell>
                      </TableRow>
                    ))}
                    {!valuation.isLoading && filteredValRows.length > 0 && (
                      <TableRow className="bg-muted/10 font-bold border-t-2">
                        <TableCell colSpan={5} className="text-xs uppercase tracking-wider">Grand Total</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(val?.grandTotal ?? 0)}</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>

          {/* ── Expiry ──────────────────────────────────────────────────── */}
          <TabsContent value="expiry" className="space-y-4 mt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">Window:</span>
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="15">15 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="60">60 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {perms.canDownload && expRows.length > 0 && (
                <Button variant="outline" size="sm" onClick={exportExpiry}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              )}
            </div>

            {!expiry.isLoading && exp && (
              expRows.length === 0 ? (
                <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 text-sm text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" /> No batches expiring in window
                </div>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-2.5 text-sm text-red-600 dark:text-red-400">
                    <AlertTriangle className="w-4 h-4" />
                    {exp.summary.expiredBatches} expired batches · {qty(exp.summary.expiredQuantity)} qty · {fmt(exp.summary.expiredValue)}
                  </div>
                  <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-2.5 text-sm text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="w-4 h-4" />
                    {exp.summary.nearExpiryBatches} near-expiry batches · {qty(exp.summary.nearExpiryQuantity)} qty · {fmt(exp.summary.nearExpiryValue)}
                  </div>
                </div>
              )
            )}

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Item</TableHead>
                      <TableHead>Batch</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Mfg</TableHead>
                      <TableHead>Expiry</TableHead>
                      <TableHead className="text-right">Days Left</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expiry.isLoading ? (
                      Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                      ))
                    ) : expRows.length === 0 ? (
                      <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground text-sm">No batches expiring in window</TableCell></TableRow>
                    ) : expRows.map((r) => (
                      <TableRow key={r.id} className="hover:bg-muted/10">
                        <TableCell className="text-sm font-medium">{r.itemName}</TableCell>
                        <TableCell className="font-mono text-xs">{r.batchNumber}</TableCell>
                        <TableCell className="text-xs">{r.branchName}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{dateFmt(r.mfgDate)}</TableCell>
                        <TableCell className="text-xs">{dateFmt(r.expiryDate)}</TableCell>
                        <TableCell className="text-right">
                          {r.daysToExpiry < 0 ? (
                            <Badge variant="destructive">{r.daysToExpiry}</Badge>
                          ) : (
                            <Badge className="bg-amber-500/15 text-amber-600 hover:bg-amber-500/15 border-0">{r.daysToExpiry}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{qty(r.quantity)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.value)}</TableCell>
                        <TableCell>
                          {r.status === 'expired' ? (
                            <Badge variant="destructive">Expired</Badge>
                          ) : (
                            <Badge className="bg-amber-500/15 text-amber-600 hover:bg-amber-500/15 border-0">Near Expiry</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
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
