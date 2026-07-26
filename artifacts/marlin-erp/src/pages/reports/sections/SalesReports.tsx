/**
 * Sales reports — Register, By Item, By Location, Combined Sales & Stock.
 */
import { useState } from 'react';
import {
  useSalesRegister, useSalesByItem, useSalesByLocation, useSalesStockCombined,
  useListOutlets, useListWarehouses,
} from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { downloadCSV } from '@/lib/download';
import {
  fmt, num, pdfMoney, fmtDate, titleCase, periodLabel,
  useDateRange, RangeBar, ReportPicker, SummaryCards, LocationBadge, RTable, ExportButtons, exportReportPdf,
  type RangeState, type Col,
} from '../shared';

type SalesReport = 'register' | 'byItem' | 'byLocation' | 'combined';

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    paid: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    partially_paid: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    unpaid: 'bg-red-500/10 text-red-600 border-red-500/20',
    pending: 'bg-red-500/10 text-red-600 border-red-500/20',
  };
  return (
    <Badge className={`text-[10px] capitalize ${map[status] ?? 'bg-muted/20 text-muted-foreground'}`}>
      {status?.replace('_', ' ')}
    </Badge>
  );
}

// ── Register ──────────────────────────────────────────────────────────────────
function RegisterReport({ range }: { range: RangeState }) {
  const [loc, setLoc] = useState('all');
  const { data: outlets = [] } = useListOutlets();
  const { data: warehouses = [] } = useListWarehouses();

  const [locationType, locationIdStr] = loc === 'all' ? ['', ''] : loc.split(':');
  const { data, isLoading } = useSalesRegister({
    from: range.from || undefined,
    to: range.to || undefined,
    locationType: locationType || undefined,
    locationId: locationIdStr ? Number(locationIdStr) : undefined,
  });
  const rows = data?.rows ?? [];
  const t = data?.totals;
  const locLabel = loc === 'all'
    ? 'All locations'
    : [...(outlets as any[]).map((o) => ({ v: `outlet:${o.id}`, n: o.name })),
       ...(warehouses as any[]).map((w) => ({ v: `warehouse:${w.id}`, n: w.name }))].find((x) => x.v === loc)?.n ?? loc;

  const cols: Col<(typeof rows)[number]>[] = [
    { key: 'invoiceNumber', label: 'Invoice', render: (r) => <span className="font-mono text-xs text-primary font-bold">{r.invoiceNumber}</span> },
    { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
    { key: 'locationName', label: 'Location' },
    { key: 'locationType', label: 'Type', render: (r) => <LocationBadge type={r.locationType} /> },
    { key: 'customerName', label: 'Customer' },
    { key: 'subtotal', label: 'Taxable', align: 'right', render: (r) => fmt(r.subtotal) },
    { key: 'tax', label: 'Tax', align: 'right', render: (r) => fmt(r.tax) },
    { key: 'total', label: 'Total', align: 'right', render: (r) => <b>{fmt(r.total)}</b> },
    { key: 'paid', label: 'Paid', align: 'right', render: (r) => <span className="text-emerald-600">{fmt(r.paid)}</span> },
    { key: 'balance', label: 'Balance', align: 'right', render: (r) => <span className={r.balance > 0 ? 'text-red-500' : ''}>{fmt(r.balance)}</span> },
    { key: 'paymentStatus', label: 'Status', render: (r) => <StatusBadge status={r.paymentStatus} /> },
  ];

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <Select value={loc} onValueChange={setLoc}>
          <SelectTrigger className="h-8 text-xs w-52"><SelectValue placeholder="All locations" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {(outlets as any[]).map((o) => <SelectItem key={`o${o.id}`} value={`outlet:${o.id}`}>{o.name} (Outlet)</SelectItem>)}
            {(warehouses as any[]).map((w) => <SelectItem key={`w${w.id}`} value={`warehouse:${w.id}`}>{w.name} (Warehouse)</SelectItem>)}
          </SelectContent>
        </Select>
        <ExportButtons
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('sales-register.csv', rows.map((r) => ({
            Invoice: r.invoiceNumber, Date: r.date, Location: r.locationName, 'Location Type': r.locationType,
            Customer: r.customerName, 'Taxable (₹)': r.subtotal.toFixed(2), 'Discount (₹)': r.discount.toFixed(2),
            'Tax (₹)': r.tax.toFixed(2), 'Total (₹)': r.total.toFixed(2), 'Paid (₹)': r.paid.toFixed(2),
            'Balance (₹)': r.balance.toFixed(2), Mode: r.paymentMode, Status: r.paymentStatus,
          })))}
          onPDF={() => exportReportPdf({
            title: 'Sales Register',
            subtitle: `Period: ${periodLabel(range.from, range.to)}   |   Location: ${locLabel}`,
            metaRows: [['Period', periodLabel(range.from, range.to)], ['Location', locLabel], ['Invoices', String(t?.invoices ?? 0)]],
            orientation: 'landscape',
            sections: [{
              columns: [
                { label: 'Invoice', width: 1.5 }, { label: 'Date' }, { label: 'Location', width: 1.5 },
                { label: 'Customer', width: 1.5 }, { label: 'Taxable', align: 'right', width: 1.2 },
                { label: 'Tax', align: 'right' }, { label: 'Total', align: 'right', width: 1.2 },
                { label: 'Paid', align: 'right', width: 1.2 }, { label: 'Balance', align: 'right', width: 1.2 },
                { label: 'Status' },
              ],
              rows: rows.map((r) => [r.invoiceNumber, fmtDate(r.date), r.locationName, r.customerName,
                pdfMoney(r.subtotal), pdfMoney(r.tax), pdfMoney(r.total), pdfMoney(r.paid), pdfMoney(r.balance),
                titleCase(r.paymentStatus)]),
              totalsRow: ['TOTAL', '', '', '', pdfMoney(t?.subtotal), pdfMoney(t?.tax), pdfMoney(t?.total),
                pdfMoney(t?.paid), pdfMoney(t?.balance), ''],
            }],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Invoices', value: t?.invoices ?? 0 },
        { label: 'Total Billed', value: fmt(t?.total), tone: 'accent' },
        { label: 'Collected', value: fmt(t?.paid), tone: 'pos' },
        { label: 'Outstanding', value: fmt(t?.balance), tone: 'neg' },
      ]} />

      <RTable
        cols={cols} rows={rows} loading={isLoading} rowKey={(r) => r.id}
        footer={['TOTAL', '', '', '', '', fmt(t?.subtotal), fmt(t?.tax), fmt(t?.total), fmt(t?.paid), fmt(t?.balance), '']}
      />
    </div>
  );
}

// ── By item ───────────────────────────────────────────────────────────────────
function ByItemReport({ range }: { range: RangeState }) {
  const { data, isLoading } = useSalesByItem({ from: range.from || undefined, to: range.to || undefined });
  const rows = data?.rows ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('sales-by-item.csv', rows.map((r) => ({
            Item: r.itemName, Unit: r.unit, Invoices: r.invoices, Qty: r.qty,
            'Taxable (₹)': r.taxable.toFixed(2), 'Tax (₹)': r.tax.toFixed(2), 'Total (₹)': r.total.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Sales by Item',
            subtitle: `Period: ${periodLabel(range.from, range.to)}`,
            metaRows: [['Period', periodLabel(range.from, range.to)], ['Items', String(t?.items ?? 0)]],
            sections: [{
              columns: [
                { label: 'Item', width: 2.4 }, { label: 'Unit' }, { label: 'Invoices', align: 'center' },
                { label: 'Qty', align: 'right' }, { label: 'Taxable', align: 'right', width: 1.4 },
                { label: 'Tax', align: 'right', width: 1.2 }, { label: 'Total', align: 'right', width: 1.4 },
              ],
              rows: rows.map((r) => [r.itemName, r.unit, r.invoices, num(r.qty), pdfMoney(r.taxable), pdfMoney(r.tax), pdfMoney(r.total)]),
              totalsRow: ['TOTAL', '', '', num(t?.qty), pdfMoney(t?.taxable), pdfMoney(t?.tax), pdfMoney(t?.total)],
            }],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Items Sold', value: t?.items ?? 0 },
        { label: 'Quantity', value: num(t?.qty) },
        { label: 'Taxable Value', value: fmt(t?.taxable), tone: 'accent' },
        { label: 'Total (incl. tax)', value: fmt(t?.total), tone: 'pos' },
      ]} />

      <RTable
        cols={[
          { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
          { key: 'unit', label: 'Unit' },
          { key: 'invoices', label: 'Invoices', align: 'center' },
          { key: 'qty', label: 'Qty', align: 'right', render: (r) => num(r.qty) },
          { key: 'taxable', label: 'Taxable', align: 'right', render: (r) => fmt(r.taxable) },
          { key: 'tax', label: 'Tax', align: 'right', render: (r) => fmt(r.tax) },
          { key: 'total', label: 'Total', align: 'right', render: (r) => <b>{fmt(r.total)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.itemId}
        footer={['TOTAL', '', '', num(t?.qty), fmt(t?.taxable), fmt(t?.tax), fmt(t?.total)]}
      />
    </div>
  );
}

// ── By location ───────────────────────────────────────────────────────────────
function ByLocationReport({ range }: { range: RangeState }) {
  const { data, isLoading } = useSalesByLocation({ from: range.from || undefined, to: range.to || undefined });
  const rows = data?.rows ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('sales-by-location.csv', rows.map((r) => ({
            Location: r.locationName, Type: r.locationType, Invoices: r.invoices,
            'Taxable (₹)': r.taxable.toFixed(2), 'Tax (₹)': r.tax.toFixed(2), 'Total (₹)': r.total.toFixed(2),
            'Collected (₹)': r.paid.toFixed(2), 'Outstanding (₹)': r.outstanding.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Sales by Location',
            subtitle: `Period: ${periodLabel(range.from, range.to)}`,
            metaRows: [['Period', periodLabel(range.from, range.to)], ['Locations', String(rows.length)]],
            sections: [{
              columns: [
                { label: 'Location', width: 2.2 }, { label: 'Type' }, { label: 'Invoices', align: 'center' },
                { label: 'Taxable', align: 'right', width: 1.4 }, { label: 'Tax', align: 'right', width: 1.1 },
                { label: 'Total', align: 'right', width: 1.4 }, { label: 'Collected', align: 'right', width: 1.4 },
                { label: 'Outstanding', align: 'right', width: 1.4 },
              ],
              rows: rows.map((r) => [r.locationName, titleCase(r.locationType), r.invoices, pdfMoney(r.taxable),
                pdfMoney(r.tax), pdfMoney(r.total), pdfMoney(r.paid), pdfMoney(r.outstanding)]),
              totalsRow: ['TOTAL', '', t?.invoices ?? 0, pdfMoney(t?.taxable), pdfMoney(t?.tax), pdfMoney(t?.total),
                pdfMoney(t?.paid), pdfMoney(t?.outstanding)],
            }],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Locations', value: rows.length },
        { label: 'Total Billed', value: fmt(t?.total), tone: 'accent' },
        { label: 'Collected', value: fmt(t?.paid), tone: 'pos' },
        { label: 'Outstanding', value: fmt(t?.outstanding), tone: 'neg' },
      ]} />

      <RTable
        cols={[
          { key: 'locationName', label: 'Location', render: (r) => <span className="font-medium">{r.locationName}</span> },
          { key: 'locationType', label: 'Type', render: (r) => <LocationBadge type={r.locationType} /> },
          { key: 'invoices', label: 'Invoices', align: 'center' },
          { key: 'taxable', label: 'Taxable', align: 'right', render: (r) => fmt(r.taxable) },
          { key: 'tax', label: 'Tax', align: 'right', render: (r) => fmt(r.tax) },
          { key: 'total', label: 'Total', align: 'right', render: (r) => <b>{fmt(r.total)}</b> },
          { key: 'paid', label: 'Collected', align: 'right', render: (r) => <span className="text-emerald-600">{fmt(r.paid)}</span> },
          { key: 'outstanding', label: 'Outstanding', align: 'right', render: (r) => <span className={r.outstanding > 0 ? 'text-red-500' : ''}>{fmt(r.outstanding)}</span> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => `${r.locationType}:${r.locationId}`}
        footer={['TOTAL', '', t?.invoices ?? 0, fmt(t?.taxable), fmt(t?.tax), fmt(t?.total), fmt(t?.paid), fmt(t?.outstanding)]}
      />
    </div>
  );
}

// ── Combined sales & stock handout ───────────────────────────────────────────
function CombinedReport({ range }: { range: RangeState }) {
  const { data, isLoading } = useSalesStockCombined({ from: range.from || undefined, to: range.to || undefined });
  const s = data?.sales;

  const onPDF = () => exportReportPdf({
    title: 'Sales & Stock Summary',
    subtitle: `Period: ${periodLabel(range.from, range.to)}`,
    metaRows: [
      ['Period', periodLabel(range.from, range.to)],
      ['Revenue', pdfMoney(s?.revenue)],
      ['Collected', pdfMoney(s?.collected)],
      ['Stock Value', pdfMoney(data?.stockValueTotal)],
    ],
    sections: [
      {
        heading: 'Sales by Location',
        columns: [
          { label: 'Location', width: 2.4 }, { label: 'Type' },
          { label: 'Invoices', align: 'center' }, { label: 'Revenue', align: 'right', width: 1.6 },
        ],
        rows: (data?.salesByLocation ?? []).map((r) => [r.locationName, titleCase(r.locationType), r.invoices, pdfMoney(r.revenue)]),
        totalsRow: ['TOTAL', '', s?.invoices ?? 0, pdfMoney(s?.revenue)],
      },
      {
        heading: 'Top Selling Items',
        columns: [
          { label: 'Item', width: 2.6 }, { label: 'Unit' },
          { label: 'Qty', align: 'right' }, { label: 'Revenue', align: 'right', width: 1.6 },
        ],
        rows: (data?.topItems ?? []).map((r) => [r.itemName, r.unit, num(r.qty), pdfMoney(r.revenue)]),
      },
      {
        heading: 'Current Stock by Location',
        columns: [
          { label: 'Location', width: 2.4 }, { label: 'Type' }, { label: 'SKUs', align: 'center' },
          { label: 'Total Qty', align: 'right' }, { label: 'Stock Value', align: 'right', width: 1.6 },
        ],
        rows: (data?.stockByLocation ?? []).map((r) => [r.locationName, titleCase(r.locationType), r.skus, num(r.totalQty), pdfMoney(r.stockValue)]),
        totalsRow: ['TOTAL', '', '', '', pdfMoney(data?.stockValueTotal)],
      },
    ],
    footerNote: 'Stock positions are as of report generation time; sales figures cover the selected period.',
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons disabled={isLoading || !data} onPDF={onPDF} />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Invoices', value: s?.invoices ?? 0 },
        { label: 'Revenue', value: fmt(s?.revenue), tone: 'accent' },
        { label: 'Collected', value: fmt(s?.collected), tone: 'pos' },
        { label: 'Outstanding', value: fmt(s?.outstanding), tone: 'neg' },
      ]} />

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Sales by Location</h3>
          <RTable
            cols={[
              { key: 'locationName', label: 'Location', render: (r: any) => <span className="font-medium">{r.locationName}</span> },
              { key: 'locationType', label: 'Type', render: (r: any) => <LocationBadge type={r.locationType} /> },
              { key: 'invoices', label: 'Invoices', align: 'center' },
              { key: 'revenue', label: 'Revenue', align: 'right', render: (r: any) => <b>{fmt(r.revenue)}</b> },
            ]}
            rows={data?.salesByLocation ?? []} loading={isLoading} rowKey={(_, i) => i}
          />
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Top Selling Items</h3>
          <RTable
            cols={[
              { key: 'itemName', label: 'Item', render: (r: any) => <span className="font-medium">{r.itemName}</span> },
              { key: 'unit', label: 'Unit' },
              { key: 'qty', label: 'Qty', align: 'right', render: (r: any) => num(r.qty) },
              { key: 'revenue', label: 'Revenue', align: 'right', render: (r: any) => <b>{fmt(r.revenue)}</b> },
            ]}
            rows={data?.topItems ?? []} loading={isLoading} rowKey={(_, i) => i}
          />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Current Stock by Location <span className="font-normal">(snapshot — not date filtered)</span></h3>
        <RTable
          cols={[
            { key: 'locationName', label: 'Location', render: (r: any) => <span className="font-medium">{r.locationName}</span> },
            { key: 'locationType', label: 'Type', render: (r: any) => <LocationBadge type={r.locationType} /> },
            { key: 'skus', label: 'SKUs', align: 'center' },
            { key: 'totalQty', label: 'Total Qty', align: 'right', render: (r: any) => num(r.totalQty) },
            { key: 'stockValue', label: 'Stock Value', align: 'right', render: (r: any) => <b>{fmt(r.stockValue)}</b> },
          ]}
          rows={data?.stockByLocation ?? []} loading={isLoading} rowKey={(_, i) => i}
          footer={['TOTAL', '', '', '', fmt(data?.stockValueTotal)]}
        />
      </div>
    </div>
  );
}

// ── Section root ──────────────────────────────────────────────────────────────
export default function SalesSection() {
  const range = useDateRange('month');
  const [report, setReport] = useState<SalesReport>('register');
  return (
    <div className="space-y-4">
      <ReportPicker
        options={[
          { value: 'register', label: 'Sales Register' },
          { value: 'byItem', label: 'By Item' },
          { value: 'byLocation', label: 'By Location' },
          { value: 'combined', label: 'Sales & Stock Summary' },
        ]}
        value={report} onChange={setReport}
      />
      {report === 'register' && <RegisterReport range={range} />}
      {report === 'byItem' && <ByItemReport range={range} />}
      {report === 'byLocation' && <ByLocationReport range={range} />}
      {report === 'combined' && <CombinedReport range={range} />}
    </div>
  );
}
