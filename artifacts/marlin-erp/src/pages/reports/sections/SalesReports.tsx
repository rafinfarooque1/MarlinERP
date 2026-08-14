/**
 * Sales reports — Register, By Item, By Location, Combined Sales & Stock.
 */
import { useState } from 'react';
import {
  useSalesRegister, useSalesByItem, useSalesByLocation, useSalesStockCombined,
  useDiscountReport, useListWarehouses,
} from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { StatusBadge as KitStatusBadge } from '@/components/app/status-badge';
import { Building2, Store } from 'lucide-react';
import { usePermission } from '@/lib/usePermission';
import { downloadCSV } from '@/lib/download';
import { paymentModeLabel } from '@/lib/paymentModes';
import { useEnabledOutlets, useAllOutlets } from '@/lib/locationStructure';
import { useClearOutletSelection } from '@/lib/useFeatureFlags';
import {
  fmt, num, pdfMoney, fmtDate, titleCase, periodLabel,
  useDateRange, RangeBar, ReportPicker, SummaryCards, LocationBadge, RTable, ExportButtons, exportReportPdf, reportViewFromUrl,
  type RangeState, type Col,
} from '../shared';

type SalesReport = 'register' | 'byItem' | 'byLocation' | 'discounts' | 'combined';

// ── Hierarchical warehouse→outlet location tree ───────────────────────────────
type LocRow = {
  locationType: string; locationId: number; locationName: string;
  invoices: number; taxable?: number; tax?: number; total?: number;
  paid?: number; outstanding?: number; revenue?: number;
};

/**
 * Renders a two-level warehouse→outlet sales tree.
 * Each warehouse is a collapsible group header; outlets are indented below;
 * a subtotal row follows each group.
 *
 * compact=true: shows Location / Type / Invoices / Revenue (4 cols — Combined panel)
 * compact=false: shows all 8 cols — By Location full report
 */
function HierarchicalLocationTable({
  rows, loading, warehouses, outlets, compact = false,
}: {
  rows: LocRow[];
  loading: boolean;
  warehouses: any[];
  outlets: any[];
  compact?: boolean;
}) {
  const money = (v?: number) =>
    v != null && v > 0
      ? `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : <span className="text-muted-foreground">—</span>;

  // outlet id → warehouseId
  const outletWhId = new Map<number, number>(
    (outlets as any[]).map((o) => [Number(o.id), Number(o.warehouseId)])
  );
  // warehouseId → name (fallback for warehouses with no direct sales row)
  const whNameMap = new Map<number, string>(
    (warehouses as any[]).map((w) => [Number(w.id), w.name as string])
  );

  type Group = {
    warehouseId: number; warehouseName: string;
    whRow: LocRow | null; outletRows: LocRow[];
  };
  const groupMap = new Map<number, Group>();
  const standalone: LocRow[] = [];

  // Pre-seed every known warehouse so groups appear even with zero direct sales
  (warehouses as any[]).forEach((w) => {
    groupMap.set(Number(w.id), {
      warehouseId: Number(w.id), warehouseName: w.name,
      whRow: null, outletRows: [],
    });
  });

  for (const r of rows) {
    if (r.locationType === 'warehouse') {
      const g = groupMap.get(r.locationId) ?? {
        warehouseId: r.locationId, warehouseName: r.locationName,
        whRow: null, outletRows: [],
      };
      g.whRow = r;
      groupMap.set(r.locationId, g);
    } else if (r.locationType === 'outlet') {
      const whId = outletWhId.get(r.locationId);
      if (whId != null) {
        const g = groupMap.get(whId) ?? {
          warehouseId: whId, warehouseName: whNameMap.get(whId) ?? `Warehouse #${whId}`,
          whRow: null, outletRows: [],
        };
        g.outletRows.push(r);
        groupMap.set(whId, g);
      } else {
        standalone.push(r);
      }
    } else {
      standalone.push(r); // headoffice / production
    }
  }

  // Only keep groups that have any data; sort by combined revenue desc
  const rev = (r: LocRow) => r.revenue ?? r.total ?? 0;
  const groups = [...groupMap.values()]
    .filter((g) => g.whRow || g.outletRows.length > 0)
    .sort((a, b) => {
      const aT = rev(a.whRow ?? {} as any) + a.outletRows.reduce((s, r) => s + rev(r), 0);
      const bT = rev(b.whRow ?? {} as any) + b.outletRows.reduce((s, r) => s + rev(r), 0);
      return bT - aT;
    });

  if (loading) return <div className="text-center py-8 text-muted-foreground text-sm">Loading…</div>;
  if (!groups.length && !standalone.length)
    return <div className="text-center py-8 text-muted-foreground text-sm">No sales in this period</div>;

  const hdrCls = 'text-xs font-medium text-muted-foreground uppercase tracking-wide';

  return (
    <div className="border border-border rounded-lg overflow-x-auto text-sm">
      <div className="min-w-[720px]">
      {/* ── Column headers ── */}
      <div className={`grid ${compact ? 'grid-cols-12' : 'grid-cols-12'} bg-muted/50 px-3 py-2 border-b border-border ${hdrCls}`}>
        <span className="col-span-4">Location</span>
        <span className="col-span-2">Type</span>
        <span className="col-span-2 text-center">Invoices</span>
        {compact ? (
          <span className="col-span-4 text-right">Revenue</span>
        ) : (
          <>
            <span className="col-span-2 text-right">Taxable</span>
            <span className="col-span-1 text-right">Tax</span>
            <span className="col-span-1 text-right">Total</span>
          </>
        )}
      </div>

      {groups.map((g) => {
        const subInv = (g.whRow?.invoices ?? 0) + g.outletRows.reduce((s, r) => s + r.invoices, 0);
        const subRev = rev(g.whRow ?? {} as any) + g.outletRows.reduce((s, r) => s + rev(r), 0);
        const subTaxable = (g.whRow?.taxable ?? 0) + g.outletRows.reduce((s, r) => s + (r.taxable ?? 0), 0);
        const subTax     = (g.whRow?.tax ?? 0)     + g.outletRows.reduce((s, r) => s + (r.tax ?? 0), 0);

        return (
          <div key={g.warehouseId} className="border-b border-border last:border-0">
            {/* ── Warehouse header row ── */}
            <div className="grid grid-cols-12 px-3 py-2.5 bg-blue-500/5 hover:bg-blue-500/8 items-center">
              <span className="col-span-4 font-semibold flex items-center gap-2">
                <Building2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                {g.warehouseName}
              </span>
              <span className="col-span-2"><LocationBadge type="warehouse" /></span>
              <span className="col-span-2 text-center text-muted-foreground">{g.whRow?.invoices ?? 0}</span>
              {compact ? (
                <span className="col-span-4 text-right font-semibold">{money(rev(g.whRow ?? {} as any) || undefined)}</span>
              ) : (
                <>
                  <span className="col-span-2 text-right text-muted-foreground">{money(g.whRow?.taxable)}</span>
                  <span className="col-span-1 text-right text-muted-foreground">{money(g.whRow?.tax)}</span>
                  <span className="col-span-1 text-right font-semibold">{money(g.whRow?.total)}</span>
                </>
              )}
            </div>

            {/* ── Outlet rows (indented) ── */}
            {g.outletRows.map((r) => (
              <div key={r.locationId} className="grid grid-cols-12 px-3 py-2 bg-background hover:bg-muted/20 border-t border-border/40 items-center">
                <span className="col-span-4 flex items-center gap-2 pl-5">
                  <span className="w-px h-4 bg-border/70 shrink-0" />
                  <Store className="w-3 h-3 text-emerald-600 shrink-0" />
                  <span className="text-muted-foreground">{r.locationName}</span>
                </span>
                <span className="col-span-2"><LocationBadge type="outlet" /></span>
                <span className="col-span-2 text-center text-muted-foreground">{r.invoices}</span>
                {compact ? (
                  <span className="col-span-4 text-right">{money(rev(r) || undefined)}</span>
                ) : (
                  <>
                    <span className="col-span-2 text-right text-muted-foreground">{money(r.taxable)}</span>
                    <span className="col-span-1 text-right text-muted-foreground">{money(r.tax)}</span>
                    <span className="col-span-1 text-right">{money(r.total)}</span>
                  </>
                )}
              </div>
            ))}

            {/* ── Warehouse subtotal ── */}
            <div className="grid grid-cols-12 px-3 py-2 bg-muted/40 border-t border-border/60 items-center">
              <span className="col-span-4 pl-5 text-xs font-bold text-muted-foreground uppercase tracking-wide">
                Total — {g.warehouseName}
              </span>
              <span className="col-span-2" />
              <span className="col-span-2 text-center text-xs font-semibold">{subInv}</span>
              {compact ? (
                <span className="col-span-4 text-right font-bold text-primary">
                  ₹{subRev.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              ) : (
                <>
                  <span className="col-span-2 text-right text-xs font-semibold">
                    {subTaxable > 0 ? `₹${subTaxable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                  </span>
                  <span className="col-span-1 text-right text-xs font-semibold">
                    {subTax > 0 ? `₹${subTax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                  </span>
                  <span className="col-span-1 text-right font-bold text-primary">
                    {subRev > 0 ? `₹${subRev.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                  </span>
                </>
              )}
            </div>
          </div>
        );
      })}

      {/* ── Standalone rows (headoffice / ungrouped outlets) ── */}
      {standalone.map((r) => (
        <div key={`${r.locationType}:${r.locationId}`}
          className="grid grid-cols-12 px-3 py-2.5 border-t border-border hover:bg-muted/20 items-center">
          <span className="col-span-4 font-medium">{r.locationName}</span>
          <span className="col-span-2"><LocationBadge type={r.locationType} /></span>
          <span className="col-span-2 text-center">{r.invoices}</span>
          {compact ? (
            <span className="col-span-4 text-right font-semibold">{money(rev(r) || undefined)}</span>
          ) : (
            <>
              <span className="col-span-2 text-right">{money(r.taxable)}</span>
              <span className="col-span-1 text-right">{money(r.tax)}</span>
              <span className="col-span-1 text-right font-semibold">{money(r.total)}</span>
            </>
          )}
        </div>
      ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Delegate colour/tone to the shared kit; keep the exact display text this
  // report has always shown (raw status with a single underscore spaced out).
  return <KitStatusBadge status={status} label={status?.replace('_', ' ')} className="capitalize" />;
}

// ── Register ──────────────────────────────────────────────────────────────────
function RegisterReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const [loc, setLoc] = useState('all');
  // A selector, so it offers only location types that are switched on — and
  // drops a selection left pointing at an outlet once they are switched off.
  const { data: outlets } = useEnabledOutlets();
  useClearOutletSelection(loc.startsWith('outlet:'), () => setLoc('all'));
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
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('sales-register.csv', rows.map((r) => ({
            Invoice: r.invoiceNumber, Date: r.date, Location: r.locationName, 'Location Type': r.locationType,
            Customer: r.customerName, 'Taxable (₹)': r.subtotal.toFixed(2), 'Discount (₹)': r.discount.toFixed(2),
            'Tax (₹)': r.tax.toFixed(2), 'Total (₹)': r.total.toFixed(2), 'Paid (₹)': r.paid.toFixed(2),
            'Balance (₹)': r.balance.toFixed(2), Mode: paymentModeLabel(r.paymentMode), Status: r.paymentStatus,
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

// ── Discounts ─────────────────────────────────────────────────────────────────
function DiscountsReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const [loc, setLoc] = useState('all');
  // A selector, so it offers only location types that are switched on — and
  // drops a selection left pointing at an outlet once they are switched off.
  const { data: outlets } = useEnabledOutlets();
  useClearOutletSelection(loc.startsWith('outlet:'), () => setLoc('all'));
  const { data: warehouses = [] } = useListWarehouses();

  const [locationType, locationIdStr] = loc === 'all' ? ['', ''] : loc.split(':');
  const { data, isLoading } = useDiscountReport({
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
    { key: 'customerName', label: 'Customer' },
    { key: 'couponCode', label: 'Coupon', render: (r) => r.couponCode
      ? <Badge className="text-[10px] font-mono bg-violet-500/10 text-violet-600 border-violet-500/20">{r.couponCode}</Badge>
      : <span className="text-muted-foreground">—</span> },
    { key: 'gross', label: 'Gross', align: 'right', render: (r) => fmt(r.gross) },
    { key: 'itemDiscount', label: 'Item Disc.', align: 'right', render: (r) => r.itemDiscount > 0 ? <span className="text-amber-600">{fmt(r.itemDiscount)}</span> : <span className="text-muted-foreground">—</span> },
    { key: 'billDiscount', label: 'Bill Disc.', align: 'right', render: (r) => r.billDiscount > 0 ? <span className="text-amber-600">{fmt(r.billDiscount)}</span> : <span className="text-muted-foreground">—</span> },
    { key: 'totalDiscount', label: 'Total Disc.', align: 'right', render: (r) => <b className="text-red-500">{fmt(r.totalDiscount)}</b> },
    { key: 'discountPct', label: 'Disc. %', align: 'right', render: (r) => <span className="text-xs text-muted-foreground">{r.discountPct.toFixed(1)}%</span> },
    { key: 'net', label: 'Net Billed', align: 'right', render: (r) => <b>{fmt(r.net)}</b> },
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
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('discount-report.csv', rows.map((r) => ({
            Invoice: r.invoiceNumber, Date: r.date, Location: r.locationName, Customer: r.customerName,
            Coupon: r.couponCode || '', 'Gross (₹)': r.gross.toFixed(2),
            'Item Discount (₹)': r.itemDiscount.toFixed(2), 'Bill Discount (₹)': r.billDiscount.toFixed(2),
            'Total Discount (₹)': r.totalDiscount.toFixed(2), 'Discount %': r.discountPct.toFixed(1),
            'Net Billed (₹)': r.net.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Discount Report',
            subtitle: `Period: ${periodLabel(range.from, range.to)}   |   Location: ${locLabel}`,
            metaRows: [
              ['Period', periodLabel(range.from, range.to)], ['Location', locLabel],
              ['Discounted Invoices', `${t?.invoices ?? 0} of ${t?.allInvoices ?? 0}`],
              ['Total Discount', pdfMoney(t?.totalDiscount)],
            ],
            orientation: 'landscape',
            sections: [{
              columns: [
                { label: 'Invoice', width: 1.5 }, { label: 'Date' }, { label: 'Location', width: 1.4 },
                { label: 'Customer', width: 1.4 }, { label: 'Coupon' },
                { label: 'Gross', align: 'right', width: 1.2 }, { label: 'Item Disc.', align: 'right', width: 1.1 },
                { label: 'Bill Disc.', align: 'right', width: 1.1 }, { label: 'Total Disc.', align: 'right', width: 1.2 },
                { label: 'Disc. %', align: 'right' }, { label: 'Net', align: 'right', width: 1.2 },
              ],
              rows: rows.map((r) => [r.invoiceNumber, fmtDate(r.date), r.locationName, r.customerName,
                r.couponCode || '—', pdfMoney(r.gross), pdfMoney(r.itemDiscount), pdfMoney(r.billDiscount),
                pdfMoney(r.totalDiscount), `${r.discountPct.toFixed(1)}%`, pdfMoney(r.net)]),
              totalsRow: ['TOTAL', '', '', '', '', pdfMoney(t?.gross), pdfMoney(t?.itemDiscount),
                pdfMoney(t?.billDiscount), pdfMoney(t?.totalDiscount), `${(t?.discountPct ?? 0).toFixed(1)}%`, pdfMoney(t?.net)],
            }],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Discounted Invoices', value: `${t?.invoices ?? 0} of ${t?.allInvoices ?? 0}` },
        { label: 'Item Discounts', value: fmt(t?.itemDiscount) },
        { label: 'Bill / Coupon Discounts', value: fmt(t?.billDiscount) },
        { label: `Total Discount${t?.discountPct ? ` (${t.discountPct.toFixed(1)}%)` : ''}`, value: fmt(t?.totalDiscount), tone: 'neg' },
      ]} />

      <RTable
        cols={cols} rows={rows} loading={isLoading} rowKey={(r) => r.id}
        footer={['TOTAL', '', '', '', '', fmt(t?.gross), fmt(t?.itemDiscount), fmt(t?.billDiscount), fmt(t?.totalDiscount), '', fmt(t?.net)]}
      />
    </div>
  );
}

// ── By item ───────────────────────────────────────────────────────────────────
function ByItemReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const { data, isLoading } = useSalesByItem({ from: range.from || undefined, to: range.to || undefined });
  const rows = data?.rows ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          canDownload={canDownload}
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
function ByLocationReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const { data, isLoading } = useSalesByLocation({ from: range.from || undefined, to: range.to || undefined });
  const { data: warehouses = [] } = useListWarehouses();
  // Labels historical rows, so it reads every outlet: a past sale must keep its
  // location's name in the grouping and exports even while outlets are hidden.
  const { data: outlets = [] } = useAllOutlets();
  const rows = data?.rows ?? [];
  const t = data?.totals;

  // Build flat rows for CSV/PDF exports (warehouse first, then its outlets, then subtotal)
  const exportRows: typeof rows = [];
  const outletWhId = new Map<number, number>((outlets as any[]).map((o) => [Number(o.id), Number(o.warehouseId)]));
  const whNameMap  = new Map<number, string>((warehouses as any[]).map((w) => [Number(w.id), w.name as string]));
  const grouped = new Map<number, { wh?: (typeof rows)[number]; outlets: (typeof rows)[number][] }>();
  for (const r of rows) {
    if (r.locationType === 'warehouse') {
      const g = grouped.get(r.locationId) ?? { outlets: [] };
      g.wh = r; grouped.set(r.locationId, g);
    } else if (r.locationType === 'outlet') {
      const whId = outletWhId.get(r.locationId);
      if (whId != null) {
        const g = grouped.get(whId) ?? { outlets: [] }; g.outlets.push(r); grouped.set(whId, g);
      } else { exportRows.push(r); }
    } else { exportRows.push(r); }
  }
  (warehouses as any[]).forEach((w) => {
    const g = grouped.get(Number(w.id));
    if (!g) return;
    if (g.wh) exportRows.push(g.wh);
    exportRows.push(...g.outlets);
    const subTotal = (g.wh?.total ?? 0) + g.outlets.reduce((s, r) => s + r.total, 0);
    const subTaxable = (g.wh?.taxable ?? 0) + g.outlets.reduce((s, r) => s + r.taxable, 0);
    const subTax = (g.wh?.tax ?? 0) + g.outlets.reduce((s, r) => s + r.tax, 0);
    const subPaid = (g.wh?.paid ?? 0) + g.outlets.reduce((s, r) => s + r.paid, 0);
    exportRows.push({ locationType: 'subtotal', locationId: Number(w.id),
      locationName: `TOTAL — ${whNameMap.get(Number(w.id)) ?? w.name}`,
      invoices: (g.wh?.invoices ?? 0) + g.outlets.reduce((s, r) => s + r.invoices, 0),
      taxable: subTaxable, tax: subTax, total: subTotal,
      paid: subPaid, outstanding: subTotal - subPaid });
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('sales-by-location.csv', exportRows.map((r) => ({
            Location: r.locationName, Type: r.locationType === 'subtotal' ? 'SUBTOTAL' : r.locationType,
            Invoices: r.invoices,
            'Taxable (₹)': r.taxable.toFixed(2), 'Tax (₹)': r.tax.toFixed(2),
            'Total (₹)': r.total.toFixed(2), 'Collected (₹)': r.paid.toFixed(2),
            'Outstanding (₹)': r.outstanding.toFixed(2),
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
              rows: exportRows.map((r) => [r.locationName, titleCase(r.locationType), r.invoices,
                pdfMoney(r.taxable), pdfMoney(r.tax), pdfMoney(r.total), pdfMoney(r.paid), pdfMoney(r.outstanding)]),
              totalsRow: ['TOTAL', '', t?.invoices ?? 0, pdfMoney(t?.taxable), pdfMoney(t?.tax),
                pdfMoney(t?.total), pdfMoney(t?.paid), pdfMoney(t?.outstanding)],
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

      <HierarchicalLocationTable
        rows={rows} loading={isLoading}
        warehouses={warehouses as any[]} outlets={outlets as any[]}
      />

      {/* Grand total footer */}
      {!isLoading && rows.length > 0 && (
        <div className="overflow-x-auto">
          <div className="grid grid-cols-12 min-w-[720px] px-3 py-2.5 bg-muted/60 border border-border rounded-lg text-sm font-bold">
            <span className="col-span-4">GRAND TOTAL</span>
            <span className="col-span-2" />
            <span className="col-span-2 text-center">{t?.invoices ?? 0}</span>
            <span className="col-span-2 text-right">{fmt(t?.taxable)}</span>
            <span className="col-span-1 text-right">{fmt(t?.tax)}</span>
            <span className="col-span-1 text-right text-primary">{fmt(t?.total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Combined sales & stock handout ───────────────────────────────────────────
function CombinedReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const { data, isLoading } = useSalesStockCombined({ from: range.from || undefined, to: range.to || undefined });
  const { data: warehouses = [] } = useListWarehouses();
  // Labels historical rows, so it reads every outlet: a past sale must keep its
  // location's name in the grouping and exports even while outlets are hidden.
  const { data: outlets = [] } = useAllOutlets();
  const s = data?.sales;
  // The stock half of this handout is a valuation. The server withholds those
  // fields from roles without the valuation right, so the columns come out too —
  // the sales half, SKU counts and quantities are unaffected.
  const canSeeValue = data?.canViewValuation === true;

  const onPDF = () => exportReportPdf({
    title: 'Sales & Stock Summary',
    subtitle: `Period: ${periodLabel(range.from, range.to)}`,
    metaRows: [
      ['Period', periodLabel(range.from, range.to)],
      ['Revenue', pdfMoney(s?.revenue)],
      ['Collected', pdfMoney(s?.collected)],
      ...(canSeeValue ? [['Stock Value', pdfMoney(data?.stockValueTotal)] as [string, string]] : []),
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
          { label: 'Total Qty', align: 'right' as const },
          ...(canSeeValue ? [{ label: 'Stock Value', align: 'right' as const, width: 1.6 }] : []),
        ],
        rows: (data?.stockByLocation ?? []).map((r) => [
          r.locationName, titleCase(r.locationType), r.skus, num(r.totalQty),
          ...(canSeeValue ? [pdfMoney(r.stockValue)] : []),
        ]),
        totalsRow: canSeeValue
          ? ['TOTAL', '', '', '', pdfMoney(data?.stockValueTotal)]
          : ['TOTAL', '', '', ''],
      },
    ],
    footerNote: 'Stock positions are as of report generation time; sales figures cover the selected period.',
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons canDownload={canDownload} disabled={isLoading || !data} onPDF={onPDF} />
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
          <HierarchicalLocationTable
            rows={(data?.salesByLocation ?? []).map((r: any) => ({ ...r, total: r.revenue }))}
            loading={isLoading}
            warehouses={warehouses as any[]}
            outlets={outlets as any[]}
            compact
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
            { key: 'totalQty', label: 'Total Qty', align: 'right' as const, render: (r: any) => num(r.totalQty) },
            ...(canSeeValue
              ? [{ key: 'stockValue', label: 'Stock Value', align: 'right' as const, render: (r: any) => <b>{fmt(r.stockValue)}</b> }]
              : []),
          ]}
          rows={data?.stockByLocation ?? []} loading={isLoading} rowKey={(_, i) => i}
          footer={canSeeValue ? ['TOTAL', '', '', '', fmt(data?.stockValueTotal)] : ['TOTAL', '', '', '']}
        />
      </div>
    </div>
  );
}

// ── Section root ──────────────────────────────────────────────────────────────
export default function SalesSection() {
  const { canDownload } = usePermission('page:/reports/sales');
  const range = useDateRange('month');
  const [report, setReport] = useState<SalesReport>(() =>
    reportViewFromUrl<SalesReport>(['register', 'byItem', 'byLocation', 'discounts', 'combined']) ?? 'register');
  return (
    <div className="space-y-4">
      <ReportPicker
        options={[
          { value: 'register', label: 'Sales Register' },
          { value: 'byItem', label: 'By Item' },
          { value: 'byLocation', label: 'By Location' },
          { value: 'discounts', label: 'Discounts' },
          { value: 'combined', label: 'Sales & Stock Summary' },
        ]}
        value={report} onChange={setReport}
      />
      {report === 'register' && <RegisterReport range={range} canDownload={canDownload} />}
      {report === 'byItem' && <ByItemReport range={range} canDownload={canDownload} />}
      {report === 'byLocation' && <ByLocationReport range={range} canDownload={canDownload} />}
      {report === 'discounts' && <DiscountsReport range={range} canDownload={canDownload} />}
      {report === 'combined' && <CombinedReport range={range} canDownload={canDownload} />}
    </div>
  );
}
