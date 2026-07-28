import { useState } from 'react';
import { useProductionReports } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { BarChart3, Download, AlertTriangle, Factory, Trash2, IndianRupee, Scale } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';

type Tab = 'output' | 'consumption' | 'wastage' | 'batches';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'output', label: 'Output Summary' },
  { key: 'consumption', label: 'Consumption vs BOM' },
  { key: 'wastage', label: 'Wastage' },
  { key: 'batches', label: 'Batch Costs' },
];

const inr = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const qty = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function today(): string {
  return new Date().toISOString().split('T')[0];
}

export default function ProductionReports() {
  const perm = usePermission('Production');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [tab, setTab] = useState<Tab>('output');
  const { data, isLoading } = useProductionReports(from, to);

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-3">
          <AlertTriangle className="w-10 h-10 text-destructive/50" />
          <p className="text-lg font-medium">Access Denied</p>
          <p className="text-sm">You don't have permission to view Production reports.</p>
        </div>
      </AppLayout>
    );
  }

  const totals = data?.totals;

  const exportCurrentTab = () => {
    if (!data) return;
    if (tab === 'output') {
      downloadCSV(`production-output-${from}-to-${to}.csv`, data.output.map(o => ({
        Item: o.itemName, Unit: o.unit, Batches: o.batchCount,
        'Produced Qty': o.producedQty, 'Wastage Qty': o.wastageQty,
        'Total Cost': o.totalCost ?? '', 'Avg Cost/Unit': o.avgCostPerUnit ?? '',
      })));
    } else if (tab === 'consumption') {
      downloadCSV(`production-consumption-${from}-to-${to}.csv`, data.consumption.map(c => ({
        Material: c.materialName, Type: c.materialType === 'raw_material' ? 'Packing Material' : 'Raw Material', Unit: c.unit,
        'Consumed Qty': c.consumedQty, 'BOM Expected Qty': c.expectedQty ?? '',
        'Variance Qty': c.varianceQty ?? '', 'Consumed Cost': c.consumedCost ?? '',
      })));
    } else if (tab === 'wastage') {
      downloadCSV(`production-wastage-${from}-to-${to}.csv`, data.wastage.map(w => ({
        Batch: w.batchNumber, Date: w.productionDate, Item: w.itemName,
        'Produced Qty': w.producedQty, 'Wastage Qty': w.wastageQty, 'Wastage Value': w.wastageValue,
        Reasons: w.lines.map(l => `${l.quantity} — ${l.reason}`).join('; '),
      })));
    } else {
      downloadCSV(`production-batch-costs-${from}-to-${to}.csv`, data.batches.map(b => ({
        Batch: b.batchNumber, Date: b.productionDate, Item: b.itemName,
        Location: (b as any).locationName ?? '',
        'Produced Qty': b.producedQty, 'Wastage Qty': b.wastageQty,
        'Raw Material Cost': (b as any).rmCost ?? '', 'Packing Material Cost': (b as any).pmCost ?? '',
        'Material Cost': b.materialCost ?? '',
        'Labour Cost': (b as any).labourCost ?? '', 'Labour Method': (b as any).labourMethod ?? '',
        'Overhead %': b.overheadPercent ?? '',
        'Overhead Amount': b.overheadAmount ?? '', 'Total Cost': b.totalCost ?? '', 'Cost/Unit': b.costPerUnit ?? '',
      })));
    }
  };

  const t = totals as any;
  const summaryCards = [
    { icon: Factory, label: 'Batches', value: totals ? String(totals.batchCount) : '—', sub: '' },
    { icon: Scale, label: 'Units Produced', value: totals ? qty(totals.producedQty) : '—', sub: '' },
    { icon: Trash2, label: 'Wastage', value: totals ? `${qty(totals.wastageQty)} · ${inr(totals.wastageValue)}` : '—', sub: '' },
    {
      icon: IndianRupee, label: 'Total Production Cost', value: totals ? inr(totals.totalCost) : '—',
      // Where the batch cost came from: raw material, packing, labour, overheads.
      sub: totals
        ? `RM ${inr(t.rmCost ?? 0)} · PM ${inr(t.pmCost ?? 0)} · Labour ${inr(t.labourCost ?? 0)} · OH ${inr(t.overheadAmount ?? 0)}`
        : '',
    },
  ];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <BarChart3 className="w-6 h-6 text-primary" /> Production Reports
            </h1>
            <p className="text-muted-foreground mt-1">Output, material consumption vs BOM, wastage, and batch cost history</p>
          </div>
          {perm.canDownload && (
            <Button variant="outline" size="sm" onClick={exportCurrentTab} disabled={!data}>
              <Download className="w-4 h-4 mr-2" /> Export {TABS.find(t => t.key === tab)?.label}
            </Button>
          )}
        </div>

        {/* Period filter */}
        <div className="flex flex-wrap items-end gap-3 bg-card border border-border rounded-xl p-4">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">From</label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-44" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">To</label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-44" />
          </div>
          <div className="flex gap-2 pb-0.5">
            <Button variant="outline" size="sm" onClick={() => { setFrom(monthStart()); setTo(today()); }}>This month</Button>
            <Button variant="outline" size="sm" onClick={() => {
              const d = new Date(); d.setDate(d.getDate() - 30);
              setFrom(d.toISOString().split('T')[0]); setTo(today());
            }}>Last 30 days</Button>
            <Button variant="outline" size="sm" onClick={() => { setFrom(''); setTo(''); }}>All time</Button>
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {summaryCards.map(c => (
            <div key={c.label} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider">
                <c.icon className="w-3.5 h-3.5" /> {c.label}
              </div>
              <p className="text-xl font-bold font-mono mt-2">{c.value}</p>
              {c.sub && <p className="text-[10px] text-muted-foreground font-mono mt-1">{c.sub}</p>}
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
                tab === t.key
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-muted-foreground hover:border-primary/40'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="p-8 space-y-3">{[...Array(4)].map((_, i) => <div key={i} className="h-8 bg-muted/30 rounded animate-pulse" />)}</div>
          ) : tab === 'output' ? (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Batches</TableHead>
                  <TableHead className="text-right">Produced</TableHead>
                  <TableHead className="text-right">Wastage</TableHead>
                  <TableHead className="text-right">Total Cost</TableHead>
                  <TableHead className="text-right">Avg Cost/Unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!data || data.output.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                    <Factory className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No production in this period</p>
                  </TableCell></TableRow>
                ) : data.output.map(o => (
                  <TableRow key={o.itemId} className="hover:bg-muted/10">
                    <TableCell className="font-medium">{o.itemName}</TableCell>
                    <TableCell className="text-right font-mono">{o.batchCount}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-emerald-500">{qty(o.producedQty)} {o.unit}</TableCell>
                    <TableCell className="text-right font-mono">{o.wastageQty > 0 ? `${qty(o.wastageQty)} ${o.unit}` : '—'}</TableCell>
                    <TableCell className="text-right font-mono">{inr(o.totalCost)}</TableCell>
                    <TableCell className="text-right font-mono font-bold">{inr(o.avgCostPerUnit)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : tab === 'consumption' ? (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Material</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Consumed</TableHead>
                  <TableHead className="text-right">BOM Expected</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!data || data.consumption.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                    <Scale className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No material consumption in this period</p>
                  </TableCell></TableRow>
                ) : data.consumption.map(c => (
                  <TableRow key={`${c.materialType}-${c.materialId}`} className="hover:bg-muted/10">
                    <TableCell className="font-medium">{c.materialName}</TableCell>
                    <TableCell><Badge variant="secondary" className="text-xs">{c.materialType === 'raw_material' ? 'Packing Material' : 'Raw Material'}</Badge></TableCell>
                    <TableCell className="text-right font-mono">{qty(c.consumedQty)} {c.unit}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{c.expectedQty === null ? '—' : `${qty(c.expectedQty)} ${c.unit}`}</TableCell>
                    <TableCell className="text-right">
                      {c.varianceQty === null ? (
                        <span className="text-xs text-muted-foreground">no BOM</span>
                      ) : c.varianceQty > 0.0005 ? (
                        <Badge variant="destructive" className="font-mono text-[11px]">+{qty(c.varianceQty)} over</Badge>
                      ) : (
                        <Badge className="font-mono text-[11px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">within BOM</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">{inr(c.consumedCost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : tab === 'wastage' ? (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Batch</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Produced</TableHead>
                  <TableHead className="text-right">Wasted</TableHead>
                  <TableHead className="text-right">Value Lost</TableHead>
                  <TableHead>Reasons</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!data || data.wastage.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                    <Trash2 className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No wastage recorded in this period</p>
                  </TableCell></TableRow>
                ) : data.wastage.map(w => (
                  <TableRow key={w.productionId} className="hover:bg-muted/10">
                    <TableCell className="font-mono text-primary font-bold">{w.batchNumber}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(w.productionDate).toLocaleDateString('en-IN')}</TableCell>
                    <TableCell className="font-medium">{w.itemName}</TableCell>
                    <TableCell className="text-right font-mono">{qty(w.producedQty)}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-destructive">{qty(w.wastageQty)}</TableCell>
                    <TableCell className="text-right font-mono">{inr(w.wastageValue)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[280px]">
                      {w.lines.map((l, i) => <span key={i} className="block">{qty(l.quantity)} — {l.reason}</span>)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Batch</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Produced</TableHead>
                  <TableHead className="text-right">Raw Mat.</TableHead>
                  <TableHead className="text-right">Packing</TableHead>
                  <TableHead className="text-right">Labour</TableHead>
                  <TableHead className="text-right">Overhead</TableHead>
                  <TableHead className="text-right">Total Cost</TableHead>
                  <TableHead className="text-right">Cost/Unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!data || data.batches.length === 0 ? (
                  <TableRow><TableCell colSpan={11} className="text-center py-16 text-muted-foreground">
                    <Factory className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No batches in this period</p>
                  </TableCell></TableRow>
                ) : data.batches.map(b => (
                  <TableRow key={b.id} className="hover:bg-muted/10">
                    <TableCell className="font-mono text-primary font-bold">{b.batchNumber}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(b.productionDate).toLocaleDateString('en-IN')}</TableCell>
                    <TableCell className="font-medium">{b.itemName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{(b as any).locationName ?? 'Head Office'}</TableCell>
                    <TableCell className="text-right font-mono">{qty(b.producedQty)}{b.wastageQty > 0 && <span className="text-destructive text-xs ml-1">(+{qty(b.wastageQty)} waste)</span>}</TableCell>
                    <TableCell className="text-right font-mono">{(b as any).rmCost == null ? inr(b.materialCost) : inr((b as any).rmCost)}</TableCell>
                    <TableCell className="text-right font-mono">{(b as any).pmCost == null ? '—' : inr((b as any).pmCost)}</TableCell>
                    <TableCell className="text-right font-mono">
                      {(b as any).labourCost == null ? '—' : (
                        <>
                          {inr((b as any).labourCost)}
                          {(b as any).labourMethod === 'manual' && <span className="block text-[9px] text-muted-foreground font-sans">manual</span>}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {b.overheadAmount === null ? '—' : `${inr(b.overheadAmount)}${b.overheadPercent ? ` (${Number(b.overheadPercent)}%)` : ''}`}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold">{inr(b.totalCost)}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-primary">
                      {b.costPerUnit === null ? <Badge variant="outline" className="text-[10px] font-sans">not costed</Badge> : inr(b.costPerUnit)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
