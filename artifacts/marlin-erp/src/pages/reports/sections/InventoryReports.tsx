/**
 * Inventory reports — stock valuation, expiry, reorder alerts, transfer register.
 * Valuation/expiry/reorder are live snapshots; the transfer register is date-filtered.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  customFetch, useGetStockValuation, useGetExpiryReport, useGetReorderReport,
  useGetMovementAnalysis, useListWarehouses, useGstTransfersReport,
  type StockProductKind,
} from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { usePermission } from '@/lib/usePermission';
import { downloadCSV } from '@/lib/download';
import {
  fmt, num, pdfMoney, fmtDate, titleCase,
  useDateRange, RangeBar, ReportPicker, SummaryCards, LocationBadge, RTable, ExportButtons, exportReportPdf,
  periodLabel, type Col,
} from '../shared';

type InvReport = 'valuation' | 'near_expiry' | 'expired' | 'movement' | 'reorder' | 'transfers' | 'gst_transfers';

const today = () => new Date().toLocaleDateString('en-IN');

// ── Stock valuation ───────────────────────────────────────────────────────────
function ValuationReport({ canDownload }: { canDownload: boolean }) {
  const { data: warehouses = [] } = useListWarehouses();
  const [materialType, setMaterialType] = useState<string>('all');
  const [branchType, setBranchType] = useState<string>('all');
  const [branchId, setBranchId] = useState<string>('');

  const params: any = {};
  if (materialType !== 'all') params.materialType = materialType as StockProductKind;
  if (branchType !== 'all') params.branchType = branchType;
  if (branchId && branchId !== '0') params.branchId = Number(branchId);

  const { data, isLoading } = useGetStockValuation(params);
  const rows = data?.rows ?? [];
  const grandTotal = data?.grandTotal ?? 0;
  const onHandValue = data?.onHandValue ?? 0;
  const inTransitValue = data?.inTransitValue ?? 0;
  const reservedQty = data?.reservedQuantity ?? 0;

  const byLocation = useMemo(() => {
    const m = new Map<string, { branchType: string; branchName: string; skus: number; totalQty: number; value: number; onHand: number; transit: number }>();
    for (const r of rows) {
      const k = `${r.branchType}:${r.branchId}`;
      const e = m.get(k) ?? { branchType: r.branchType, branchName: r.branchName, skus: 0, totalQty: 0, value: 0, onHand: 0, transit: 0 };
      e.skus += 1; e.totalQty += r.quantity; e.value += r.value;
      if (r.inTransit) e.transit += r.value;
      else e.onHand += r.value;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  }, [rows]);

  const branchOptions = branchType === 'warehouse' ? warehouses : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">Live snapshot as of {today()}</p>
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
        {branchOptions.length > 0 && (
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">All</SelectItem>
              {branchOptions.map((b: any) => (
                <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('stock-valuation.csv', rows.map((r) => ({
            'Product Type': r.typeLabel, Item: r.itemName, Unit: r.unit, Location: r.branchName, 'Location Type': titleCase(r.branchType),
            'In Transit': r.inTransit ? 'Yes' : 'No',
            Qty: r.quantity, Reserved: r.reserved, Available: r.available,
            'Avg Cost (₹)': r.avgCost.toFixed(2), 'Value (₹)': r.value.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Stock Valuation',
            subtitle: `Snapshot as of ${today()}`,
            metaRows: [
              ['As of', today()],
              ['Locations', String(byLocation.length)],
              ['On-hand value', pdfMoney(onHandValue)],
              ['In-transit value', pdfMoney(inTransitValue)],
              ['Grand total', pdfMoney(grandTotal)],
            ],
            sections: [
              {
                heading: 'Value by Location',
                columns: [
                  { label: 'Location', width: 2 }, { label: 'Type' }, { label: 'Lines', align: 'center' },
                  { label: 'Total Qty', align: 'right' }, { label: 'On-hand', align: 'right', width: 1.3 },
                  { label: 'In-transit', align: 'right', width: 1.3 }, { label: 'Total', align: 'right', width: 1.3 },
                ],
                rows: byLocation.map((l) => [l.branchName, titleCase(l.branchType), l.skus, num(l.totalQty), pdfMoney(l.onHand), pdfMoney(l.transit), pdfMoney(l.value)]),
                totalsRow: ['TOTAL', '', '', '', pdfMoney(onHandValue), pdfMoney(inTransitValue), pdfMoney(grandTotal)],
              },
              {
                heading: 'Detail by Item & Location',
                columns: [
                  { label: 'Type' }, { label: 'Item', width: 2 }, { label: 'Location', width: 1.4 },
                  { label: 'Qty', align: 'right' }, { label: 'Rsvd', align: 'right' }, { label: 'Avail', align: 'right' },
                  { label: 'Avg Cost', align: 'right', width: 1.1 }, { label: 'Value', align: 'right', width: 1.2 },
                ],
                rows: rows.map((r) => [
                  r.typeLabel, r.itemName, r.branchName + (r.inTransit ? ' (transit)' : ''),
                  num(r.quantity), num(r.reserved), num(r.available), pdfMoney(r.avgCost), pdfMoney(r.value),
                ]),
              },
            ],
          })}
        />
      </div>

      <SummaryCards cards={[
        { label: 'Grand Total', value: fmt(grandTotal), tone: 'accent' },
        { label: 'On-hand Value', value: fmt(onHandValue) },
        { label: 'In-transit Value', value: fmt(inTransitValue) },
        { label: 'Reserved Qty', value: num(reservedQty), tone: reservedQty > 0 ? 'warn' : 'default' },
      ]} />

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Value by Location</h3>
        <RTable
          cols={[
            { key: 'branchName', label: 'Location', render: (r) => <span className="font-medium">{r.branchName}</span> },
            { key: 'branchType', label: 'Type', render: (r) => <LocationBadge type={r.branchType} /> },
            { key: 'skus', label: 'Lines', align: 'center' },
            { key: 'totalQty', label: 'Total Qty', align: 'right', render: (r) => num(r.totalQty) },
            { key: 'onHand', label: 'On-hand', align: 'right', render: (r) => fmt(r.onHand) },
            { key: 'transit', label: 'In-transit', align: 'right', render: (r) => r.transit > 0 ? fmt(r.transit) : <span className="text-muted-foreground">—</span> },
            { key: 'value', label: 'Total Value', align: 'right', render: (r) => <b>{fmt(r.value)}</b> },
          ] satisfies Col<(typeof byLocation)[number]>[]}
          rows={byLocation} loading={isLoading} rowKey={(_, i) => i}
          footer={['TOTAL', '', '', '', fmt(onHandValue), fmt(inTransitValue), fmt(grandTotal)]}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Detail by Item &amp; Location</h3>
        <RTable
          cols={[
            { key: 'typeLabel', label: 'Type', render: (r) => <Badge variant="outline" className="text-[10px]">{r.typeLabel}</Badge> },
            { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
            { key: 'branchName', label: 'Location', render: (r) => (
              <span className={r.inTransit ? 'text-amber-600 text-xs' : ''}>{r.branchName}</span>
            ) },
            { key: 'branchType', label: 'Loc Type', render: (r) => <LocationBadge type={r.branchType} /> },
            { key: 'quantity', label: 'Qty', align: 'right', render: (r) => num(r.quantity) },
            { key: 'reserved', label: 'Rsvd', align: 'right', render: (r) => r.reserved > 0 ? <span className="text-amber-600 font-semibold">{num(r.reserved)}</span> : <span className="text-muted-foreground">—</span> },
            { key: 'available', label: 'Avail', align: 'right', render: (r) => <span className="font-semibold">{num(r.available)}</span> },
            { key: 'avgCost', label: 'Avg Cost', align: 'right', render: (r) => fmt(r.avgCost) },
            { key: 'value', label: 'Value', align: 'right', render: (r) => <b>{fmt(r.value)}</b> },
          ] satisfies Col<(typeof rows)[number]>[]}
          rows={rows} loading={isLoading}
          // A product can appear at one location twice — once on hand, once in
          // transit — and the three product kinds share one id space, so both
          // the kind and the in-transit flag belong in the key.
          rowKey={(r) => `${r.materialType}:${r.refId}:${r.branchType}:${r.branchId}:${r.inTransit ? 'transit' : 'onhand'}`}
        />
      </div>
    </div>
  );
}

// ── Near Expiry report ────────────────────────────────────────────────────────
function NearExpiryReport({ canDownload }: { canDownload: boolean }) {
  const { data: warehouses = [] } = useListWarehouses();
  const [branchType, setBranchType] = useState<string>('');
  const [branchId, setBranchId] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const params: any = { status: 'near_expiry' };
  if (branchType) params.branchType = branchType;
  if (branchId && branchId !== '0') params.branchId = Number(branchId);
  if (from) params.from = from;
  if (to) params.to = to;

  const { data, isLoading } = useGetExpiryReport(params);
  const rows = data?.rows ?? [];
  const buckets = data?.buckets ?? [];
  const summary = data?.summary;
  const valueAtRisk = summary?.nearExpiryValue ?? 0;

  const branchOptions = branchType === 'warehouse' ? warehouses : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">Near-expiry batches</p>
        <Select value={branchType} onValueChange={(v) => { setBranchType(v); setBranchId(''); }}>
          <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All Locations" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Locations</SelectItem>
            <SelectItem value="warehouse">Warehouse</SelectItem>
          </SelectContent>
        </Select>
        {branchOptions.length > 0 && (
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">All</SelectItem>
              {branchOptions.map((b: any) => (
                <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">From</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-xs w-36" />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-xs w-36" />
        </div>
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('near-expiry.csv', rows.map((r) => ({
            Type: r.typeLabel, Item: r.itemName, Batch: r.batchNumber, Location: r.branchName,
            'Mfg Date': r.mfgDate ?? '', 'Expiry Date': r.expiryDate, 'Days to Expiry': r.daysToExpiry,
            Qty: r.quantity, Reserved: r.reserved, Available: r.available,
            'Unit Cost (₹)': r.unitCost.toFixed(2), 'Value (₹)': r.value.toFixed(2), Bucket: r.bucketLabel,
          })))}
          onPDF={() => exportReportPdf({
            title: 'Near Expiry Report',
            subtitle: `Batches nearing expiry (as of ${today()})`,
            metaRows: [['As of', today()], ['Near-expiry batches', String(summary?.nearExpiryBatches ?? 0)], ['Value at risk', pdfMoney(valueAtRisk)]],
            sections: [{
              columns: [
                { label: 'Type' }, { label: 'Item', width: 1.8 }, { label: 'Batch', width: 1.1 }, { label: 'Location', width: 1.3 },
                { label: 'Expiry' }, { label: 'Days', align: 'center' },
                { label: 'Qty', align: 'right' }, { label: 'Avail', align: 'right' }, { label: 'Value', align: 'right', width: 1.1 },
              ],
              rows: rows.map((r) => [r.typeLabel, r.itemName, r.batchNumber, r.branchName, fmtDate(r.expiryDate),
                r.daysToExpiry, num(r.quantity), num(r.available), pdfMoney(r.value)]),
              totalsRow: ['', '', '', '', '', '', '', '', pdfMoney(valueAtRisk)],
            }],
          })}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {buckets.filter(b => b.bucket !== 'expired' && b.bucket !== 'ok' && b.bucket !== 'no_expiry').map(b => (
          <div key={b.bucket} className="bg-card border border-border rounded-lg p-3">
            <p className="text-xs text-muted-foreground mb-1">{b.label}</p>
            <p className="font-bold font-mono text-sm">{b.batches} batches</p>
            <p className="text-xs text-muted-foreground">{num(b.quantity)} qty · {fmt(b.value)}</p>
          </div>
        ))}
      </div>

      {summary && (
        <SummaryCards cards={[
          { label: 'Near-expiry Batches', value: summary.nearExpiryBatches, tone: summary.nearExpiryBatches > 0 ? 'warn' : 'pos' },
          { label: 'Qty at Risk', value: num(summary.nearExpiryQuantity) },
          { label: 'Value at Risk', value: fmt(summary.nearExpiryValue), tone: 'warn' },
          { label: 'Locations', value: new Set(rows.map(r => `${r.branchType}:${r.branchId}`)).size },
        ]} />
      )}

      <RTable
        cols={[
          { key: 'typeLabel', label: 'Type', render: (r) => <Badge variant="outline" className="text-[10px]">{r.typeLabel}</Badge> },
          { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
          { key: 'batchNumber', label: 'Batch', render: (r) => <span className="font-mono text-xs">{r.batchNumber}</span> },
          { key: 'branchName', label: 'Location' },
          { key: 'expiryDate', label: 'Expiry', render: (r) => fmtDate(r.expiryDate) },
          { key: 'bucketLabel', label: 'Shelf Life', render: (r) => {
            const toneMap: Record<string, string> = {
              critical: 'bg-red-500/10 text-red-600 border-red-500/20',
              warn: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
              caution: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
            };
            return <Badge className={`text-[10px] ${toneMap[r.tone] ?? ''}`}>{r.bucketLabel}</Badge>;
          } },
          { key: 'quantity', label: 'Qty', align: 'right', render: (r) => num(r.quantity) },
          { key: 'available', label: 'Avail', align: 'right', render: (r) => <span className="font-semibold">{num(r.available)}</span> },
          { key: 'value', label: 'Value', align: 'right', render: (r) => <b>{fmt(r.value)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.id}
        empty="No batches nearing expiry"
        footer={['', '', '', '', '', '', num(rows.reduce((s, r) => s + r.quantity, 0)), num(rows.reduce((s, r) => s + r.available, 0)), fmt(valueAtRisk)]}
      />
    </div>
  );
}

// ── Expired Stock report ──────────────────────────────────────────────────────
function ExpiredReport({ canDownload }: { canDownload: boolean }) {
  const { data: warehouses = [] } = useListWarehouses();
  const [branchType, setBranchType] = useState<string>('');
  const [branchId, setBranchId] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const params: any = { status: 'expired' };
  if (branchType) params.branchType = branchType;
  if (branchId && branchId !== '0') params.branchId = Number(branchId);
  if (from) params.from = from;
  if (to) params.to = to;

  const { data, isLoading } = useGetExpiryReport(params);
  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const expiredValue = summary?.expiredValue ?? 0;

  const branchOptions = branchType === 'warehouse' ? warehouses : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">Expired stock</p>
        <Select value={branchType} onValueChange={(v) => { setBranchType(v); setBranchId(''); }}>
          <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All Locations" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Locations</SelectItem>
            <SelectItem value="warehouse">Warehouse</SelectItem>
          </SelectContent>
        </Select>
        {branchOptions.length > 0 && (
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">All</SelectItem>
              {branchOptions.map((b: any) => (
                <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">From</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 text-xs w-36" />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 text-xs w-36" />
        </div>
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('expired-stock.csv', rows.map((r) => ({
            Type: r.typeLabel, Item: r.itemName, Batch: r.batchNumber, Location: r.branchName,
            'Mfg Date': r.mfgDate ?? '', 'Expired On': r.expiryDate, 'Days Ago': Math.abs(r.daysToExpiry),
            Qty: r.quantity, Reserved: r.reserved, Available: r.available,
            'Unit Cost (₹)': r.unitCost.toFixed(2), 'Value (₹)': r.value.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Expired Stock Report',
            subtitle: `Expired batches (as of ${today()})`,
            metaRows: [['As of', today()], ['Expired batches', String(summary?.expiredBatches ?? 0)], ['Expired value', pdfMoney(expiredValue)]],
            sections: [{
              columns: [
                { label: 'Type' }, { label: 'Item', width: 1.8 }, { label: 'Batch', width: 1.1 }, { label: 'Location', width: 1.3 },
                { label: 'Expired', width: 1.1 }, { label: 'Days Ago', align: 'center' },
                { label: 'Qty', align: 'right' }, { label: 'Avail', align: 'right' }, { label: 'Value', align: 'right', width: 1.1 },
              ],
              rows: rows.map((r) => [r.typeLabel, r.itemName, r.batchNumber, r.branchName, fmtDate(r.expiryDate),
                Math.abs(r.daysToExpiry), num(r.quantity), num(r.available), pdfMoney(r.value)]),
              totalsRow: ['', '', '', '', '', '', '', '', pdfMoney(expiredValue)],
            }],
          })}
        />
      </div>

      {summary && (
        <SummaryCards cards={[
          { label: 'Expired Batches', value: summary.expiredBatches, tone: summary.expiredBatches > 0 ? 'neg' : 'pos' },
          { label: 'Expired Qty', value: num(summary.expiredQuantity), tone: 'neg' },
          { label: 'Expired Value', value: fmt(summary.expiredValue), tone: 'neg' },
          { label: 'Locations', value: new Set(rows.map(r => `${r.branchType}:${r.branchId}`)).size },
        ]} />
      )}

      <RTable
        cols={[
          { key: 'typeLabel', label: 'Type', render: (r) => <Badge variant="outline" className="text-[10px]">{r.typeLabel}</Badge> },
          { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
          { key: 'batchNumber', label: 'Batch', render: (r) => <span className="font-mono text-xs">{r.batchNumber}</span> },
          { key: 'branchName', label: 'Location' },
          { key: 'expiryDate', label: 'Expired On', render: (r) => fmtDate(r.expiryDate) },
          { key: 'daysToExpiry', label: 'Days Ago', align: 'center', render: (r) => (
            <Badge variant="destructive" className="text-[10px]">{Math.abs(r.daysToExpiry)}d ago</Badge>
          ) },
          { key: 'quantity', label: 'Qty', align: 'right', render: (r) => num(r.quantity) },
          { key: 'available', label: 'Avail', align: 'right', render: (r) => <span className="font-semibold">{num(r.available)}</span> },
          { key: 'value', label: 'Value', align: 'right', render: (r) => <b>{fmt(r.value)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.id}
        empty="No expired stock 🎉"
        footer={['', '', '', '', '', '', num(rows.reduce((s, r) => s + r.quantity, 0)), num(rows.reduce((s, r) => s + r.available, 0)), fmt(expiredValue)]}
      />
    </div>
  );
}

// ── Slow / Dead Stock ─────────────────────────────────────────────────────────
function MovementReport({ canDownload }: { canDownload: boolean }) {
  const { data: warehouses = [] } = useListWarehouses();
  const [branchType, setBranchType] = useState<string>('');
  const [branchId, setBranchId] = useState<string>('');
  const [classFilter, setClassFilter] = useState<string>('all');

  const params: any = {};
  if (branchType) params.branchType = branchType;
  if (branchId && branchId !== '0') params.branchId = Number(branchId);
  if (classFilter !== 'all') params.class = classFilter;

  const { data, isLoading } = useGetMovementAnalysis(params);
  const rows = data?.rows ?? [];
  const summary = data?.summary ?? [];
  const ledgerStart = data?.ledgerStart;

  const branchOptions = branchType === 'warehouse' ? warehouses : [];

  const classMap: Record<string, string> = {
    fast: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    slow: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    dormant: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
    dead: 'bg-red-500/10 text-red-600 border-red-500/20',
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">Slow &amp; dead stock analysis</p>
        <Select value={branchType} onValueChange={(v) => { setBranchType(v); setBranchId(''); }}>
          <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All Locations" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Locations</SelectItem>
            <SelectItem value="warehouse">Warehouse</SelectItem>
          </SelectContent>
        </Select>
        {branchOptions.length > 0 && (
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="0">All</SelectItem>
              {branchOptions.map((b: any) => (
                <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={classFilter} onValueChange={setClassFilter}>
          <SelectTrigger className="h-8 text-xs w-32"><SelectValue placeholder="All Classes" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Classes</SelectItem>
            <SelectItem value="fast">Fast</SelectItem>
            <SelectItem value="slow">Slow</SelectItem>
            <SelectItem value="dormant">Dormant</SelectItem>
            <SelectItem value="dead">Dead</SelectItem>
          </SelectContent>
        </Select>
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('movement-analysis.csv', rows.map((r) => ({
            Type: r.typeLabel, Item: r.itemName, Location: r.branchName,
            Class: r.classLabel, 'Days Since Outbound': r.daysSinceOutbound ?? 'Never',
            'Last Outbound': r.lastOutboundAt ? fmtDate(r.lastOutboundAt) : 'Never',
            Qty: r.quantity, Available: r.available, 'Unit Cost (₹)': r.unitCost.toFixed(2), 'Value (₹)': r.value.toFixed(2),
            'No History': r.noHistory ? 'Yes' : 'No',
          })))}
          onPDF={() => exportReportPdf({
            title: 'Movement Analysis (Slow / Dead Stock)',
            subtitle: `Based on last outbound movement (as of ${today()})`,
            metaRows: [
              ['As of', today()],
              ['Ledger start', ledgerStart ? fmtDate(ledgerStart) : 'Unknown'],
              ['Stock lines', String(rows.length)],
              ['Total value', pdfMoney(data?.totalValue ?? 0)],
            ],
            sections: [{
              columns: [
                { label: 'Class' }, { label: 'Type' }, { label: 'Item', width: 2 }, { label: 'Location', width: 1.3 },
                { label: 'Days Since Out', align: 'right' }, { label: 'Qty', align: 'right' },
                { label: 'Avail', align: 'right' }, { label: 'Value', align: 'right', width: 1.1 },
              ],
              rows: rows.map((r) => [
                r.classLabel, r.typeLabel, r.itemName, r.branchName,
                r.noHistory ? 'Never' : (r.daysSinceOutbound ?? 'N/A'), num(r.quantity), num(r.available), pdfMoney(r.value),
              ]),
              totalsRow: ['', '', '', '', '', '', '', pdfMoney(data?.totalValue ?? 0)],
            }],
          })}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {summary.map(s => (
          <div key={s.class} className="bg-card border border-border rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <Badge className={`text-[10px] ${classMap[s.class] ?? ''}`}>{s.class}</Badge>
            </div>
            <p className="font-bold font-mono text-sm">{s.lines} lines</p>
            <p className="text-xs text-muted-foreground">{num(s.quantity)} qty · {fmt(s.value)}</p>
          </div>
        ))}
      </div>

      {ledgerStart && (
        <div className="text-xs text-muted-foreground bg-muted/20 border border-border rounded-lg p-3">
          Movement recorded since <b>{fmtDate(ledgerStart)}</b>. Stock acquired before this date may show as "no history" even if it moved.
        </div>
      )}

      <RTable
        cols={[
          { key: 'classLabel', label: 'Class', render: (r) => (
            <Badge className={`text-[10px] ${classMap[r.class] ?? ''}`}>{r.classLabel}</Badge>
          ) },
          { key: 'typeLabel', label: 'Type', render: (r) => <Badge variant="outline" className="text-[10px]">{r.typeLabel}</Badge> },
          { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
          { key: 'branchName', label: 'Location' },
          { key: 'daysSinceOutbound', label: 'Days Since Outbound', align: 'right', render: (r) =>
            r.noHistory ? <span className="text-xs text-muted-foreground italic">No history</span> :
            r.daysSinceOutbound != null ? num(r.daysSinceOutbound) : <span className="text-muted-foreground">—</span>
          },
          { key: 'lastOutboundAt', label: 'Last Outbound', render: (r) => r.lastOutboundAt ? fmtDate(r.lastOutboundAt) : <span className="text-muted-foreground text-xs">Never</span> },
          { key: 'quantity', label: 'Qty', align: 'right', render: (r) => num(r.quantity) },
          { key: 'available', label: 'Avail', align: 'right', render: (r) => <span className="font-semibold">{num(r.available)}</span> },
          { key: 'value', label: 'Value', align: 'right', render: (r) => <b>{fmt(r.value)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => `${r.materialType}:${r.refId}:${r.branchType}:${r.branchId}`}
        empty="No stock in selected class"
        footer={['', '', '', '', '', '', num(rows.reduce((s, r) => s + r.quantity, 0)), num(rows.reduce((s, r) => s + r.available, 0)), fmt(rows.reduce((s, r) => s + r.value, 0))]}
      />
    </div>
  );
}

// ── Reorder alerts ────────────────────────────────────────────────────────────
function ReorderReport({ canDownload }: { canDownload: boolean }) {
  const { data: rows = [], isLoading } = useGetReorderReport();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">Items at or below their reorder level (live snapshot)</p>
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('reorder-report.csv', rows.map((r) => ({
            Item: r.itemName, Unit: r.unit, Location: r.branchName, 'Current Qty': r.quantity,
            'Reorder Level': r.reorderLevel, Shortfall: r.shortfall,
          })))}
          onPDF={() => exportReportPdf({
            title: 'Reorder Report',
            subtitle: `Items at or below reorder level (as of ${today()})`,
            metaRows: [['As of', today()], ['Items below level', String(rows.length)]],
            sections: [{
              columns: [
                { label: 'Item', width: 2.4 }, { label: 'Unit' }, { label: 'Location', width: 1.8 },
                { label: 'Current Qty', align: 'right', width: 1.2 }, { label: 'Reorder Level', align: 'right', width: 1.2 },
                { label: 'Shortfall', align: 'right', width: 1.2 },
              ],
              rows: rows.map((r) => [r.itemName, r.unit, r.branchName, num(r.quantity), num(r.reorderLevel), num(r.shortfall)]),
            }],
          })}
        />
      </div>

      <SummaryCards cards={[
        { label: 'Items Below Level', value: rows.length, tone: rows.length > 0 ? 'warn' : 'pos' },
        { label: 'Locations Affected', value: new Set(rows.map((r) => `${r.branchType}:${r.branchId}`)).size },
        { label: 'Total Shortfall', value: num(rows.reduce((s, r) => s + r.shortfall, 0)), tone: 'neg' },
        { label: 'Status', value: rows.length === 0 ? 'All stocked ✓' : 'Action needed', tone: rows.length === 0 ? 'pos' : 'warn' },
      ]} />

      <RTable
        cols={[
          { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
          { key: 'unit', label: 'Unit' },
          { key: 'branchName', label: 'Location' },
          { key: 'branchType', label: 'Type', render: (r) => <LocationBadge type={r.branchType} /> },
          { key: 'quantity', label: 'Current Qty', align: 'right', render: (r) => <span className="text-red-500 font-bold">{num(r.quantity)}</span> },
          { key: 'reorderLevel', label: 'Reorder Level', align: 'right', render: (r) => num(r.reorderLevel) },
          { key: 'shortfall', label: 'Shortfall', align: 'right', render: (r) => <b className="text-amber-600">{num(r.shortfall)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => `${r.itemId}:${r.branchType}:${r.branchId}`}
        empty="All items are above their reorder levels 🎉"
      />
    </div>
  );
}

// ── Transfer register ─────────────────────────────────────────────────────────
interface TransferRow {
  id: number;
  challanNumber?: string | null;
  transferDate: string;
  fromName: string;
  toName: string;
  lineItems: { itemId: number; quantity: number; costPrice?: number }[];
  isInterstate?: boolean;
  status: string;
}

const TRANSFER_STATUSES = ['pending', 'in_transit', 'completed', 'rejected'];

function TransfersReport({ canDownload }: { canDownload: boolean }) {
  const range = useDateRange('month');
  const [status, setStatus] = useState('all');
  // Filtering happens server-side (?from&to&status) so large histories stay fast.
  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  if (status !== 'all') qs.set('status', status);
  qs.set('limit', '2000'); // report view is capped; dedicated transfer pages stay unlimited
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['/api/stock/transfers', range.from, range.to, status],
    queryFn: () => customFetch<TransferRow[]>(`/api/stock/transfers${qs.size ? `?${qs}` : ''}`),
  });

  const dkey = (d: string) => String(d).slice(0, 10);
  const statuses = TRANSFER_STATUSES;

  const qtyOf = (t: TransferRow) => (t.lineItems ?? []).reduce((s, l) => s + (l.quantity ?? 0), 0);
  const totalQty = rows.reduce((s, t) => s + qtyOf(t), 0);

  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      completed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
      pending: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
      rejected: 'bg-red-500/10 text-red-600 border-red-500/20',
    };
    return <Badge className={`text-[10px] capitalize ${map[s] ?? 'bg-muted/20 text-muted-foreground'}`}>{titleCase(s)}</Badge>;
  };

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {statuses.map((s) => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}
          </SelectContent>
        </Select>
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('stock-transfers.csv', rows.map((t) => ({
            Challan: t.challanNumber ?? `#${t.id}`, Date: dkey(t.transferDate), From: t.fromName, To: t.toName,
            Lines: (t.lineItems ?? []).length, 'Total Qty': qtyOf(t), Interstate: t.isInterstate ? 'Yes' : 'No', Status: t.status,
          })))}
          onPDF={() => exportReportPdf({
            title: 'Stock Transfer Register',
            subtitle: `Period: ${periodLabel(range.from, range.to)}`,
            metaRows: [['Period', periodLabel(range.from, range.to)], ['Transfers', String(rows.length)], ['Total Qty', num(totalQty)]],
            sections: [{
              columns: [
                { label: 'Challan', width: 1.4 }, { label: 'Date' }, { label: 'From', width: 1.8 },
                { label: 'To', width: 1.8 }, { label: 'Lines', align: 'center' },
                { label: 'Qty', align: 'right' }, { label: 'Status' },
              ],
              rows: rows.map((t) => [t.challanNumber ?? `#${t.id}`, fmtDate(t.transferDate), t.fromName, t.toName,
                (t.lineItems ?? []).length, num(qtyOf(t)), titleCase(t.status)]),
              totalsRow: ['TOTAL', '', '', '', '', num(totalQty), ''],
            }],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Transfers', value: rows.length },
        { label: 'Qty Moved', value: num(totalQty), tone: 'accent' },
        { label: 'Completed', value: rows.filter((t) => t.status === 'completed').length, tone: 'pos' },
        { label: 'Pending', value: rows.filter((t) => t.status === 'pending').length, tone: rows.some((t) => t.status === 'pending') ? 'warn' : 'default' },
      ]} />

      <RTable
        cols={[
          { key: 'challanNumber', label: 'Challan', render: (t) => <span className="font-mono text-xs text-primary font-bold">{t.challanNumber ?? `#${t.id}`}</span> },
          { key: 'transferDate', label: 'Date', render: (t) => fmtDate(t.transferDate) },
          { key: 'fromName', label: 'From', render: (t) => <span className="font-medium">{t.fromName}</span> },
          { key: 'toName', label: 'To', render: (t) => <span className="font-medium">{t.toName}</span> },
          { key: 'lines', label: 'Lines', align: 'center', render: (t) => (t.lineItems ?? []).length },
          { key: 'qty', label: 'Total Qty', align: 'right', render: (t) => num(qtyOf(t)) },
          { key: 'status', label: 'Status', render: (t) => statusBadge(t.status) },
        ] satisfies Col<TransferRow>[]}
        rows={rows} loading={isLoading} rowKey={(t) => t.id}
        footer={['TOTAL', '', '', '', '', num(totalQty), '']}
      />
    </div>
  );
}

// ── GST Transfers ─────────────────────────────────────────────────────────────
// Transfers between two of the company's own GSTINs are taxable supplies: they
// carry a real tax invoice and appear in GSTR-1. They are NOT sales, so every
// other report excludes them — this is the one view that shows both figures, so
// the outward supplies in the return can be reconciled.
function GstTransfersReport({ canDownload }: { canDownload: boolean }) {
  const range = useDateRange('month');
  const { data, isLoading } = useGstTransfersReport({ from: range.from, to: range.to });
  const rows = data?.rows ?? [];
  const cs = data?.customerSales;
  const bt = data?.branchTransfer;
  const cb = data?.combined;
  const cn = data?.creditNoted;
  const ni = data?.notInvoiced;

  const statusBadge = (r: (typeof rows)[number]) => {
    if (!r.invoiced) return <Badge className="text-[10px] bg-slate-500/10 text-slate-500 border-slate-500/20">Not Invoiced</Badge>;
    if (r.creditNoted) return <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Credit Noted</Badge>;
    if (r.status === 'completed') return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Received</Badge>;
    if (r.status === 'in_transit') return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">In Transit</Badge>;
    return <Badge className="text-[10px] bg-muted/20 text-muted-foreground capitalize">{titleCase(r.status)}</Badge>;
  };
  const rowStatus = (r: (typeof rows)[number]) =>
    !r.invoiced ? 'Not Invoiced' : r.creditNoted ? 'Credit Noted' : titleCase(r.status);

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('gst-transfers.csv', rows.map((r) => ({
            Invoice: r.invoiceNumber ?? '—', Challan: r.challanNumber, Date: fmtDate(r.date),
            From: r.fromName, 'From GSTIN': r.fromGstin, To: r.toName, 'To GSTIN': r.toGstin,
            Supply: r.supplyType, Taxable: r.taxable, CGST: r.cgst, SGST: r.sgst, IGST: r.igst,
            'Total GST': r.tax, 'Invoice Value': r.total,
            Status: rowStatus(r), 'In GST Return': r.invoiced && !r.creditNoted ? 'Yes' : 'No',
          })))}
          onPDF={() => exportReportPdf({
            title: 'GST Transfer Register',
            subtitle: `Period: ${periodLabel(range.from, range.to)}`,
            metaRows: [
              ['Period', periodLabel(range.from, range.to)],
              ['Customer Sales', pdfMoney(cs?.total ?? 0)],
              ['Branch Transfer Sales', pdfMoney(bt?.total ?? 0)],
              ['Total GST Transfer Value', pdfMoney(bt?.total ?? 0)],
            ],
            sections: [{
              columns: [
                { label: 'Invoice', width: 1.5 }, { label: 'Date' }, { label: 'From', width: 1.6 },
                { label: 'To', width: 1.6 }, { label: 'Supply' },
                { label: 'Taxable', align: 'right' }, { label: 'GST', align: 'right' },
                { label: 'Value', align: 'right' }, { label: 'Status' },
              ],
              rows: rows.map((r) => [
                r.invoiceNumber ?? r.challanNumber, fmtDate(r.date), r.fromName, r.toName, r.supplyType,
                pdfMoney(r.taxable), pdfMoney(r.tax), pdfMoney(r.total), rowStatus(r),
              ]),
              totalsRow: ['TOTAL', '', '', '', '', pdfMoney(bt?.taxable ?? 0), pdfMoney(bt?.tax ?? 0), pdfMoney(bt?.total ?? 0), ''],
            }],
          })}
        />
      </RangeBar>

      {/* The three figures the user needs kept apart: what was earned, what was
          merely moved, and the tax-invoice value of the movement. */}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="bg-card border border-border rounded-lg p-3">
          <p className="text-xs text-muted-foreground mb-1">Customer Sales</p>
          <p className="font-bold font-mono text-lg">{fmt(cs?.total)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {cs?.invoices ?? 0} invoices · taxable {fmt(cs?.taxable)} · GST {fmt(cs?.tax)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1.5">Real revenue — the only figure that reaches the P&amp;L and dashboards.</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-3">
          <p className="text-xs text-muted-foreground mb-1">Branch Transfer Sales</p>
          <p className="font-bold font-mono text-lg text-primary">{fmt(bt?.total)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {bt?.invoices ?? 0} invoices · taxable {fmt(bt?.taxable)} · GST {fmt(bt?.tax)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1.5">Own stock moved between your GSTINs. Reported to GST, never counted as revenue.</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-3">
          <p className="text-xs text-muted-foreground mb-1">Total GST Transfer Value</p>
          <p className="font-bold font-mono text-lg">{fmt(cb?.total)}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            taxable {fmt(cb?.taxable)} · GST {fmt(cb?.tax)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1.5">Customer sales + branch transfers — reconciles to outward supplies in GSTR-1.</p>
        </div>
      </div>

      <SummaryCards cards={[
        { label: 'CGST', value: fmt(bt?.cgst), tone: 'accent' },
        { label: 'SGST', value: fmt(bt?.sgst), tone: 'accent' },
        { label: 'IGST', value: fmt(bt?.igst), tone: 'accent' },
        {
          label: 'Credit Noted',
          value: `${cn?.invoices ?? 0} · ${fmt(cn?.total)}`,
          tone: (cn?.invoices ?? 0) > 0 ? 'warn' : 'default',
        },
      ]} />

      {/* Taxable movements with no invoice behind them. Not added to any figure
          above — shown because a silent gap is worse than a visible one. */}
      {(ni?.transfers ?? 0) > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-500">
            {ni!.transfers} cross-GSTIN {ni!.transfers === 1 ? 'transfer carries' : 'transfers carry'} no tax invoice
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Taxable value {fmt(ni!.taxable)} · GST {fmt(ni!.tax)} that is not in your returns. These moved before
            transfer invoicing was switched on, or while it was off. They are listed below as “Not Invoiced” and are
            excluded from every total above. Existing transfers are left as they were — only new ones are invoiced.
          </p>
        </div>
      )}

      <RTable
        cols={[
          { key: 'invoiceNumber', label: 'Tax Invoice', render: (r) => <span className="font-mono text-xs text-primary font-bold">{r.invoiceNumber ?? '—'}</span> },
          { key: 'challanNumber', label: 'Challan', render: (r) => <span className="font-mono text-[11px] text-muted-foreground">{r.challanNumber}</span> },
          { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
          { key: 'fromName', label: 'From', render: (r) => (
            <div><span className="font-medium">{r.fromName}</span><br /><span className="font-mono text-[10px] text-muted-foreground">{r.fromGstin}</span></div>
          ) },
          { key: 'toName', label: 'To', render: (r) => (
            <div><span className="font-medium">{r.toName}</span><br /><span className="font-mono text-[10px] text-muted-foreground">{r.toGstin}</span></div>
          ) },
          { key: 'supplyType', label: 'Supply', render: (r) => (
            <Badge variant="outline" className="text-[10px]">{r.supplyType}</Badge>
          ) },
          { key: 'taxable', label: 'Taxable', align: 'right', render: (r) => fmt(r.taxable) },
          { key: 'cgst', label: 'CGST', align: 'right', render: (r) => fmt(r.cgst) },
          { key: 'sgst', label: 'SGST', align: 'right', render: (r) => fmt(r.sgst) },
          { key: 'igst', label: 'IGST', align: 'right', render: (r) => fmt(r.igst) },
          { key: 'total', label: 'Invoice Value', align: 'right', render: (r) => <b>{fmt(r.total)}</b> },
          { key: 'status', label: 'Status', render: statusBadge },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.id}
        empty="No cross-GSTIN transfers in this period. Transfers within the same GSTIN are stock movements only and carry no tax."
        footer={['TOTAL', '', '', '', '', '', fmt(bt?.taxable), fmt(bt?.cgst), fmt(bt?.sgst), fmt(bt?.igst), fmt(bt?.total), '']}
      />
    </div>
  );
}

// ── Section root ──────────────────────────────────────────────────────────────
/** The reports whose numbers are cost — offered only with the valuation right. */
const COST_REPORTS: { value: InvReport; label: string }[] = [
  { value: 'valuation', label: 'Stock Valuation' },
  { value: 'near_expiry', label: 'Near Expiry' },
  { value: 'expired', label: 'Expired Stock' },
  { value: 'movement', label: 'Slow / Dead Stock' },
  { value: 'reorder', label: 'Reorder Alerts' },
];

export default function InventorySection() {
  const { canDownload } = usePermission('page:/reports/sales');
  // These five reports are built on cost. Their endpoints refuse anyone without
  // the Inventory Valuation right, so offering them here would only render a
  // table of ₹0.00 — a figure that reads as "stock is worthless" rather than
  // "you may not see this". Hide them instead; the transfer registers stay.
  const canSeeValuation = usePermission('page:/headoffice/inventory-reports').canView;
  const [report, setReport] = useState<InvReport>(canSeeValuation ? 'valuation' : 'transfers');
  const options: { value: InvReport; label: string }[] = [
    ...(canSeeValuation ? COST_REPORTS : []),
    { value: 'transfers', label: 'Transfer Register' },
    { value: 'gst_transfers', label: 'GST Transfers' },
  ];
  // Permissions arrive after the first render, so a revoked user can briefly
  // hold a cost report in state — never render one we are not allowed to show.
  const active: InvReport = !canSeeValuation && report !== 'gst_transfers' ? 'transfers' : report;
  return (
    <div className="space-y-4">
      <ReportPicker
        options={options}
        value={active} onChange={setReport}
      />
      {active === 'valuation' && <ValuationReport canDownload={canDownload} />}
      {active === 'near_expiry' && <NearExpiryReport canDownload={canDownload} />}
      {active === 'expired' && <ExpiredReport canDownload={canDownload} />}
      {active === 'movement' && <MovementReport canDownload={canDownload} />}
      {active === 'reorder' && <ReorderReport canDownload={canDownload} />}
      {active === 'transfers' && <TransfersReport canDownload={canDownload} />}
      {active === 'gst_transfers' && <GstTransfersReport canDownload={canDownload} />}
    </div>
  );
}
