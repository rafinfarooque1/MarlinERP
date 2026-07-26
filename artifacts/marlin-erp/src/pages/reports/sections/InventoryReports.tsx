/**
 * Inventory reports — stock valuation, expiry, reorder alerts, transfer register.
 * Valuation/expiry/reorder are live snapshots; the transfer register is date-filtered.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  customFetch, useGetStockValuation, useGetExpiryReport, useGetReorderReport,
} from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { downloadCSV } from '@/lib/download';
import {
  fmt, num, pdfMoney, fmtDate, titleCase,
  useDateRange, RangeBar, ReportPicker, SummaryCards, LocationBadge, RTable, ExportButtons, exportReportPdf,
  periodLabel, type Col,
} from '../shared';

type InvReport = 'valuation' | 'expiry' | 'reorder' | 'transfers';

const today = () => new Date().toLocaleDateString('en-IN');

// ── Stock valuation ───────────────────────────────────────────────────────────
function ValuationReport() {
  const { data, isLoading } = useGetStockValuation();
  const rows = data?.rows ?? [];
  const grandTotal = data?.grandTotal ?? 0;

  const byLocation = useMemo(() => {
    const m = new Map<string, { branchType: string; branchName: string; skus: number; totalQty: number; value: number }>();
    for (const r of rows) {
      const k = `${r.branchType}:${r.branchId}`;
      const e = m.get(k) ?? { branchType: r.branchType, branchName: r.branchName, skus: 0, totalQty: 0, value: 0 };
      e.skus += 1; e.totalQty += r.quantity; e.value += r.value;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">Live snapshot as of {today()}</p>
        <ExportButtons
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('stock-valuation.csv', rows.map((r) => ({
            Item: r.itemName, Unit: r.unit, Location: r.branchName, 'Location Type': r.branchType,
            Qty: r.quantity, 'Avg Cost (₹)': r.avgCost.toFixed(2), 'Value (₹)': r.value.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Stock Valuation',
            subtitle: `Snapshot as of ${today()}`,
            metaRows: [['As of', today()], ['Locations', String(byLocation.length)], ['Stock Value', pdfMoney(grandTotal)]],
            sections: [
              {
                heading: 'Value by Location',
                columns: [
                  { label: 'Location', width: 2.2 }, { label: 'Type' }, { label: 'SKUs', align: 'center' },
                  { label: 'Total Qty', align: 'right' }, { label: 'Value', align: 'right', width: 1.5 },
                ],
                rows: byLocation.map((l) => [l.branchName, titleCase(l.branchType), l.skus, num(l.totalQty), pdfMoney(l.value)]),
                totalsRow: ['TOTAL', '', '', '', pdfMoney(grandTotal)],
              },
              {
                heading: 'Detail by Item & Location',
                columns: [
                  { label: 'Item', width: 2.2 }, { label: 'Unit' }, { label: 'Location', width: 1.6 },
                  { label: 'Qty', align: 'right' }, { label: 'Avg Cost', align: 'right', width: 1.2 },
                  { label: 'Value', align: 'right', width: 1.4 },
                ],
                rows: rows.map((r) => [r.itemName, r.unit, r.branchName, num(r.quantity), pdfMoney(r.avgCost), pdfMoney(r.value)]),
              },
            ],
          })}
        />
      </div>

      <SummaryCards cards={[
        { label: 'Total Stock Value', value: fmt(grandTotal), tone: 'accent' },
        { label: 'Locations', value: byLocation.length },
        { label: 'Stock Lines', value: rows.length },
        { label: 'Total Qty', value: num(rows.reduce((s, r) => s + r.quantity, 0)) },
      ]} />

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Value by Location</h3>
        <RTable
          cols={[
            { key: 'branchName', label: 'Location', render: (r) => <span className="font-medium">{r.branchName}</span> },
            { key: 'branchType', label: 'Type', render: (r) => <LocationBadge type={r.branchType} /> },
            { key: 'skus', label: 'SKUs', align: 'center' },
            { key: 'totalQty', label: 'Total Qty', align: 'right', render: (r) => num(r.totalQty) },
            { key: 'value', label: 'Value', align: 'right', render: (r) => <b>{fmt(r.value)}</b> },
          ] satisfies Col<(typeof byLocation)[number]>[]}
          rows={byLocation} loading={isLoading} rowKey={(_, i) => i}
          footer={['TOTAL', '', '', '', fmt(grandTotal)]}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Detail by Item &amp; Location</h3>
        <RTable
          cols={[
            { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
            { key: 'unit', label: 'Unit' },
            { key: 'branchName', label: 'Location' },
            { key: 'branchType', label: 'Type', render: (r) => <LocationBadge type={r.branchType} /> },
            { key: 'quantity', label: 'Qty', align: 'right', render: (r) => num(r.quantity) },
            { key: 'avgCost', label: 'Avg Cost', align: 'right', render: (r) => fmt(r.avgCost) },
            { key: 'value', label: 'Value', align: 'right', render: (r) => <b>{fmt(r.value)}</b> },
          ] satisfies Col<(typeof rows)[number]>[]}
          rows={rows} loading={isLoading} rowKey={(r) => `${r.itemId}:${r.branchType}:${r.branchId}`}
        />
      </div>
    </div>
  );
}

// ── Expiry report ─────────────────────────────────────────────────────────────
function ExpiryReport() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useGetExpiryReport(days);
  const rows = data?.rows ?? [];
  const expired = rows.filter((r) => r.status === 'expired');
  const valueAtRisk = rows.reduce((s, r) => s + r.value, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Batches expiring within</span>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="h-8 text-xs w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[7, 15, 30, 60, 90].map((d) => <SelectItem key={d} value={String(d)}>{d} days</SelectItem>)}
          </SelectContent>
        </Select>
        <ExportButtons
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('expiry-report.csv', rows.map((r) => ({
            Item: r.itemName, Batch: r.batchNumber, Location: r.branchName, 'Mfg Date': r.mfgDate ?? '',
            'Expiry Date': r.expiryDate, 'Days to Expiry': r.daysToExpiry, Qty: r.quantity,
            'Unit Cost (₹)': r.unitCost.toFixed(2), 'Value (₹)': r.value.toFixed(2), Status: r.status,
          })))}
          onPDF={() => exportReportPdf({
            title: 'Stock Expiry Report',
            subtitle: `Batches expiring within ${days} days (as of ${today()})`,
            metaRows: [['Window', `${days} days`], ['At-risk batches', String(rows.length)], ['Value at risk', pdfMoney(valueAtRisk)]],
            sections: [{
              columns: [
                { label: 'Item', width: 2 }, { label: 'Batch', width: 1.2 }, { label: 'Location', width: 1.5 },
                { label: 'Expiry', width: 1.1 }, { label: 'Days Left', align: 'center' },
                { label: 'Qty', align: 'right' }, { label: 'Value', align: 'right', width: 1.2 }, { label: 'Status' },
              ],
              rows: rows.map((r) => [r.itemName, r.batchNumber, r.branchName, fmtDate(r.expiryDate),
                r.daysToExpiry, num(r.quantity), pdfMoney(r.value), r.status === 'expired' ? 'EXPIRED' : 'Near expiry']),
              totalsRow: ['TOTAL', '', '', '', '', '', pdfMoney(valueAtRisk), ''],
            }],
          })}
        />
      </div>

      <SummaryCards cards={[
        { label: 'At-risk Batches', value: rows.length, tone: rows.length > 0 ? 'warn' : 'pos' },
        { label: 'Already Expired', value: expired.length, tone: expired.length > 0 ? 'neg' : 'pos' },
        { label: 'Qty at Risk', value: num(rows.reduce((s, r) => s + r.quantity, 0)) },
        { label: 'Value at Risk', value: fmt(valueAtRisk), tone: 'neg' },
      ]} />

      <RTable
        cols={[
          { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
          { key: 'batchNumber', label: 'Batch', render: (r) => <span className="font-mono text-xs">{r.batchNumber}</span> },
          { key: 'branchName', label: 'Location' },
          { key: 'expiryDate', label: 'Expiry', render: (r) => fmtDate(r.expiryDate) },
          { key: 'daysToExpiry', label: 'Days Left', align: 'center', render: (r) => (
            <Badge className={`text-[10px] ${r.status === 'expired' ? 'bg-red-500/10 text-red-600 border-red-500/20' : r.daysToExpiry <= 7 ? 'bg-orange-500/10 text-orange-600 border-orange-500/20' : 'bg-amber-500/10 text-amber-600 border-amber-500/20'}`}>
              {r.status === 'expired' ? 'Expired' : `${r.daysToExpiry}d`}
            </Badge>
          ) },
          { key: 'quantity', label: 'Qty', align: 'right', render: (r) => num(r.quantity) },
          { key: 'unitCost', label: 'Unit Cost', align: 'right', render: (r) => fmt(r.unitCost) },
          { key: 'value', label: 'Value', align: 'right', render: (r) => <b>{fmt(r.value)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.id}
        empty={`No batches expiring within ${days} days 🎉`}
        footer={['TOTAL', '', '', '', '', num(rows.reduce((s, r) => s + r.quantity, 0)), '', fmt(valueAtRisk)]}
      />
    </div>
  );
}

// ── Reorder alerts ────────────────────────────────────────────────────────────
function ReorderReport() {
  const { data: rows = [], isLoading } = useGetReorderReport();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">Items at or below their reorder level (live snapshot)</p>
        <ExportButtons
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

function TransfersReport() {
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

// ── Section root ──────────────────────────────────────────────────────────────
export default function InventorySection() {
  const [report, setReport] = useState<InvReport>('valuation');
  return (
    <div className="space-y-4">
      <ReportPicker
        options={[
          { value: 'valuation', label: 'Stock Valuation' },
          { value: 'expiry', label: 'Expiry Report' },
          { value: 'reorder', label: 'Reorder Alerts' },
          { value: 'transfers', label: 'Transfer Register' },
        ]}
        value={report} onChange={setReport}
      />
      {report === 'valuation' && <ValuationReport />}
      {report === 'expiry' && <ExpiryReport />}
      {report === 'reorder' && <ReorderReport />}
      {report === 'transfers' && <TransfersReport />}
    </div>
  );
}
