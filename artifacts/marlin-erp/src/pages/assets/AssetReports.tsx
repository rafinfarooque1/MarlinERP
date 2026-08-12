/**
 * Asset Reports — eight reports over the asset register behind one shared
 * filter bar (date, location, category, vendor, status), exportable through
 * the same CSV / Excel / PDF / Print machinery as every other ERP report.
 *
 * Register / warranty slices read the asset's CURRENT location; the purchase
 * report reads the location it was purchased at. Group-by reports (warehouse /
 * category / vendor) are computed client-side from the filtered rows.
 */
import { useMemo, useState } from 'react';
import {
  useAssetPurchases, useAssetTransfers, useAssetDisposals,
  useAssetCategories, useListVendors,
  type AssetPurchase,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { downloadCSV } from '@/lib/download';
import { PageHeader } from '@/components/app/page-header';
import { BarChart3 } from 'lucide-react';
import {
  fmt, fmtDate, pdfMoney, periodLabel,
  useDateRange, RangeBar, useLocationFilter, LocationFilter,
  ReportPicker, SummaryCards, RTable, ExportButtons,
  type Col, type ReportDoc, type LocationOption,
} from '@/pages/reports/shared';
import {
  AssetsAccessDenied, AssetStatusBadge, useAssetLocationOptions,
  ASSET_STATUS_LABELS, PAYMENT_MODE_LABELS, PAYMENT_STATUS_LABELS,
} from './shared';

type ReportKind =
  | 'register' | 'purchases' | 'by_warehouse' | 'by_category'
  | 'by_vendor' | 'warranty' | 'transfers' | 'disposals';

const REPORTS: { value: ReportKind; label: string }[] = [
  { value: 'register', label: 'Asset Register' },
  { value: 'purchases', label: 'Purchase Report' },
  { value: 'by_warehouse', label: 'Warehouse-wise' },
  { value: 'by_category', label: 'Category-wise' },
  { value: 'by_vendor', label: 'Vendor-wise' },
  { value: 'warranty', label: 'Warranty Expiry' },
  { value: 'transfers', label: 'Transfer History' },
  { value: 'disposals', label: 'Disposal History' },
];

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface GroupRow { name: string; count: number; qty: number; cost: number }

function groupBy(rows: AssetPurchase[], keyOf: (a: AssetPurchase) => string): GroupRow[] {
  const m = new Map<string, GroupRow>();
  for (const a of rows) {
    const k = keyOf(a) || '—';
    const g = m.get(k) ?? { name: k, count: 0, qty: 0, cost: 0 };
    g.count += 1;
    g.qty += Number(a.quantity) || 0;
    g.cost += Number(a.totalCost) || 0;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.cost - a.cost);
}

export default function AssetReports() {
  const perm = usePermission('page:/assets/reports');
  const [report, setReport] = useState<ReportKind>('register');
  const range = useDateRange('all');
  const loc = useLocationFilter();
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [vendorFilter, setVendorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const { data: categories = [] } = useAssetCategories();
  const { data: vendors = [] } = useListVendors();
  const locationOptions = useAssetLocationOptions();
  const locFilterOptions: LocationOption[] = locationOptions.map(o => ({ type: o.type, id: o.id, name: o.name }));

  // Purchase report filters by purchase date + purchase location; every other
  // asset slice is a point-in-time view of the register (current location).
  const isPurchaseView = report === 'purchases';
  const purchaseFilters = useMemo(() => ({
    fromDate: isPurchaseView ? (range.from || undefined) : undefined,
    toDate: isPurchaseView ? (range.to || undefined) : undefined,
    locationType: loc.type || undefined,
    locationId: loc.id || undefined,
    categoryId: categoryFilter !== 'all' ? categoryFilter : undefined,
    vendorId: vendorFilter !== 'all' ? vendorFilter : undefined,
    status: statusFilter !== 'all' ? statusFilter : undefined,
    locationBasis: (isPurchaseView ? 'purchase' : 'current') as 'purchase' | 'current',
  }), [isPurchaseView, range.from, range.to, loc.type, loc.id, categoryFilter, vendorFilter, statusFilter]);

  const assetsQuery = useAssetPurchases(purchaseFilters);
  const transfersQuery = useAssetTransfers(
    { fromDate: range.from || undefined, toDate: range.to || undefined },
  );
  const disposalsQuery = useAssetDisposals(
    { fromDate: range.from || undefined, toDate: range.to || undefined },
  );

  const assets = assetsQuery.data ?? [];
  const transfers = transfersQuery.data ?? [];
  const disposals = disposalsQuery.data ?? [];
  const loading = report === 'transfers' ? transfersQuery.isLoading
    : report === 'disposals' ? disposalsQuery.isLoading
    : assetsQuery.isLoading;

  // Warranty report: only assets that HAVE a warranty end, soonest first.
  const warrantyRows = useMemo(() =>
    assets.filter(a => a.warrantyEnd).sort((a, b) => String(a.warrantyEnd).localeCompare(String(b.warrantyEnd))),
  [assets]);

  const grouped = useMemo(() => {
    if (report === 'by_warehouse') return groupBy(assets, a => a.currentLocationName);
    if (report === 'by_category') return groupBy(assets, a => a.categoryName);
    if (report === 'by_vendor') return groupBy(assets, a => a.vendorName);
    return [];
  }, [report, assets]);

  const totalCost = assets.reduce((s, a) => s + (Number(a.totalCost) || 0), 0);
  const activeCount = assets.filter(a => a.status === 'active').length;

  const cards = report === 'transfers' ? [
    { label: 'Transfers', value: String(transfers.length) },
  ] : report === 'disposals' ? [
    { label: 'Disposals', value: String(disposals.length) },
    { label: 'Cost Disposed', value: fmt(disposals.reduce((s, d) => s + (Number(d.totalCost) || 0), 0)) },
  ] : [
    { label: 'Assets', value: String(assets.length) },
    { label: 'Active', value: String(activeCount), tone: 'pos' as const },
    { label: 'Total Value (at cost)', value: fmt(totalCost), tone: 'accent' as const },
    ...(report === 'warranty' ? [{
      label: 'Expired',
      value: String(warrantyRows.filter(a => String(a.warrantyEnd) < todayIso()).length),
      tone: 'neg' as const,
    }] : []),
  ];

  // ── Columns per report ──────────────────────────────────────────────────────
  const registerCols: Col<AssetPurchase>[] = [
    { key: 'assetCode', label: 'Code', render: a => <span className="font-mono font-semibold">{a.assetCode}</span> },
    { key: 'assetName', label: 'Asset' },
    { key: 'categoryName', label: 'Category', render: a => a.categoryName || '—' },
    { key: 'purchaseDate', label: 'Purchased', render: a => fmtDate(a.purchaseDate) },
    { key: 'currentLocationName', label: 'Location', render: a => a.currentLocationName || '—' },
    { key: 'vendorName', label: 'Vendor', render: a => a.vendorName || '—' },
    { key: 'quantity', label: 'Qty', align: 'right', sortValue: a => Number(a.quantity), render: a => String(Number(a.quantity)) },
    { key: 'totalCost', label: 'Cost', align: 'right', sortValue: a => Number(a.totalCost), render: a => fmt(a.totalCost) },
    { key: 'status', label: 'Status', render: a => <AssetStatusBadge status={a.status} /> },
    { key: 'warrantyEnd', label: 'Warranty End', render: a => a.warrantyEnd ? fmtDate(a.warrantyEnd) : '—' },
  ];

  const purchaseCols: Col<AssetPurchase>[] = [
    { key: 'purchaseDate', label: 'Date', render: a => fmtDate(a.purchaseDate) },
    { key: 'assetCode', label: 'Code', render: a => <span className="font-mono font-semibold">{a.assetCode}</span> },
    { key: 'assetName', label: 'Asset' },
    { key: 'invoiceNumber', label: 'Invoice No.', render: a => a.invoiceNumber || '—' },
    { key: 'vendorName', label: 'Vendor', render: a => a.vendorName || '—' },
    { key: 'locationName', label: 'Location', render: a => a.locationName || '—' },
    { key: 'quantity', label: 'Qty', align: 'right', sortValue: a => Number(a.quantity), render: a => String(Number(a.quantity)) },
    { key: 'acquisitionCost', label: 'Unit Cost', align: 'right', sortValue: a => Number(a.acquisitionCost), render: a => fmt(a.acquisitionCost) },
    { key: 'gstAmount', label: 'GST', align: 'right', sortValue: a => Number(a.gstAmount), render: a => `${fmt(a.gstAmount)} (${Number(a.gstRate)}%)` },
    { key: 'totalCost', label: 'Total', align: 'right', sortValue: a => Number(a.totalCost), render: a => fmt(a.totalCost) },
    { key: 'paymentMode', label: 'Payment', render: a => `${PAYMENT_MODE_LABELS[a.paymentMode] ?? a.paymentMode} · ${PAYMENT_STATUS_LABELS[a.paymentStatus] ?? a.paymentStatus}` },
  ];

  const groupCols: Col<GroupRow>[] = [
    { key: 'name', label: report === 'by_warehouse' ? 'Location' : report === 'by_category' ? 'Category' : 'Vendor' },
    { key: 'count', label: 'Assets', align: 'right', render: g => String(g.count) },
    { key: 'qty', label: 'Qty', align: 'right', render: g => String(g.qty) },
    { key: 'cost', label: 'Total Cost', align: 'right', render: g => fmt(g.cost) },
  ];

  const warrantyCols: Col<AssetPurchase>[] = [
    { key: 'assetCode', label: 'Code', render: a => <span className="font-mono font-semibold">{a.assetCode}</span> },
    { key: 'assetName', label: 'Asset' },
    { key: 'categoryName', label: 'Category', render: a => a.categoryName || '—' },
    { key: 'currentLocationName', label: 'Location', render: a => a.currentLocationName || '—' },
    { key: 'serialNumber', label: 'Serial No.', render: a => a.serialNumber || '—' },
    { key: 'warrantyStart', label: 'Warranty Start', render: a => a.warrantyStart ? fmtDate(a.warrantyStart) : '—' },
    {
      key: 'warrantyEnd', label: 'Warranty End',
      render: a => <span className={String(a.warrantyEnd) < todayIso() ? 'text-red-500 font-medium' : ''}>{fmtDate(a.warrantyEnd)}</span>,
    },
    { key: 'status', label: 'Status', render: a => <AssetStatusBadge status={a.status} /> },
  ];

  type TransferRow = (typeof transfers)[number];
  const transferCols: Col<TransferRow>[] = [
    { key: 'transferDate', label: 'Date', render: t => fmtDate(t.transferDate) },
    { key: 'assetCode', label: 'Code', render: t => <span className="font-mono font-semibold">{t.assetCode}</span> },
    { key: 'assetName', label: 'Asset' },
    { key: 'fromName', label: 'From' },
    { key: 'toName', label: 'To' },
    { key: 'approvedBy', label: 'Approved By', render: t => t.approvedBy || '—' },
    { key: 'reason', label: 'Reason', render: t => t.reason || '—' },
  ];

  type DisposalRow = (typeof disposals)[number];
  const disposalCols: Col<DisposalRow>[] = [
    { key: 'disposalDate', label: 'Date', render: d => fmtDate(d.disposalDate) },
    { key: 'assetCode', label: 'Code', render: d => <span className="font-mono font-semibold">{d.assetCode}</span> },
    { key: 'assetName', label: 'Asset' },
    { key: 'disposalType', label: 'Type', render: d => ASSET_STATUS_LABELS[d.disposalType] ?? d.disposalType },
    { key: 'totalCost', label: 'Asset Cost', align: 'right', sortValue: d => d.totalCost != null ? Number(d.totalCost) : null, render: d => d.totalCost != null ? fmt(d.totalCost) : '—' },
    { key: 'reason', label: 'Reason', render: d => d.reason || '—' },
    { key: 'createdBy', label: 'Recorded By', render: d => d.createdBy || '—' },
  ];

  // ── Exports ─────────────────────────────────────────────────────────────────
  const reportLabel = REPORTS.find(r => r.value === report)?.label ?? 'Asset Report';

  const csvRows = (): Record<string, unknown>[] => {
    switch (report) {
      case 'register':
        return assets.map(a => ({
          Code: a.assetCode, Asset: a.assetName, Category: a.categoryName || '', Purchased: a.purchaseDate,
          Location: a.currentLocationName || '', Vendor: a.vendorName || '', Qty: a.quantity,
          Cost: a.totalCost, Status: ASSET_STATUS_LABELS[a.status] ?? a.status, 'Warranty End': a.warrantyEnd || '',
        }));
      case 'purchases':
        return assets.map(a => ({
          Date: a.purchaseDate, Code: a.assetCode, Asset: a.assetName, 'Invoice No.': a.invoiceNumber || '',
          Vendor: a.vendorName || '', Location: a.locationName || '', Qty: a.quantity,
          'Unit Cost': a.acquisitionCost, 'GST %': a.gstRate, 'GST Amount': a.gstAmount, Total: a.totalCost,
          'Payment Mode': PAYMENT_MODE_LABELS[a.paymentMode] ?? a.paymentMode,
          'Payment Status': PAYMENT_STATUS_LABELS[a.paymentStatus] ?? a.paymentStatus,
        }));
      case 'by_warehouse': case 'by_category': case 'by_vendor':
        return grouped.map(g => ({ Name: g.name, Assets: g.count, Qty: g.qty, 'Total Cost': g.cost }));
      case 'warranty':
        return warrantyRows.map(a => ({
          Code: a.assetCode, Asset: a.assetName, Category: a.categoryName || '', Location: a.currentLocationName || '',
          'Serial No.': a.serialNumber || '', 'Warranty Start': a.warrantyStart || '', 'Warranty End': a.warrantyEnd || '',
          Status: ASSET_STATUS_LABELS[a.status] ?? a.status,
        }));
      case 'transfers':
        return transfers.map(t => ({
          Date: t.transferDate, Code: t.assetCode, Asset: t.assetName, From: t.fromName, To: t.toName,
          'Approved By': t.approvedBy || '', Reason: t.reason || '',
        }));
      case 'disposals':
        return disposals.map(d => ({
          Date: d.disposalDate, Code: d.assetCode, Asset: d.assetName,
          Type: ASSET_STATUS_LABELS[d.disposalType] ?? d.disposalType,
          'Asset Cost': d.totalCost ?? '', Reason: d.reason || '', 'Recorded By': d.createdBy || '',
        }));
    }
  };

  const buildDoc = (): ReportDoc => {
    const meta: [string, string][] = [
      ['Period', (isPurchaseView || report === 'transfers' || report === 'disposals') ? periodLabel(range.from || undefined, range.to || undefined) : 'As of today'],
      ['Location', loc.key ? (locFilterOptions.find(o => `${o.type}:${o.id}` === loc.key)?.name ?? loc.key) : 'All locations'],
    ];
    if (categoryFilter !== 'all') meta.push(['Category', categories.find(c => String(c.id) === categoryFilter)?.name ?? '']);
    if (vendorFilter !== 'all') meta.push(['Vendor', (vendors as any[]).find(v => String(v.id) === vendorFilter)?.name ?? '']);
    if (statusFilter !== 'all') meta.push(['Status', ASSET_STATUS_LABELS[statusFilter as keyof typeof ASSET_STATUS_LABELS] ?? statusFilter]);

    switch (report) {
      case 'register':
        return {
          title: 'Asset Register', metaRows: meta, orientation: 'landscape', filename: 'asset-register',
          sections: [{
            columns: [
              { label: 'Code' }, { label: 'Asset' }, { label: 'Category' }, { label: 'Purchased' },
              { label: 'Location' }, { label: 'Vendor' }, { label: 'Qty', align: 'right' },
              { label: 'Cost', align: 'right' }, { label: 'Status' }, { label: 'Warranty End' },
            ],
            rows: assets.map(a => [
              a.assetCode, a.assetName, a.categoryName || '-', fmtDate(a.purchaseDate),
              a.currentLocationName || '-', a.vendorName || '-', Number(a.quantity),
              pdfMoney(a.totalCost), ASSET_STATUS_LABELS[a.status] ?? a.status, a.warrantyEnd ? fmtDate(a.warrantyEnd) : '-',
            ]),
            totalsRow: ['Total', '', '', '', '', '', assets.reduce((s, a) => s + Number(a.quantity || 0), 0), pdfMoney(totalCost), '', ''],
          }],
        };
      case 'purchases':
        return {
          title: 'Asset Purchase Report', metaRows: meta, orientation: 'landscape', filename: 'asset-purchase-report',
          sections: [{
            columns: [
              { label: 'Date' }, { label: 'Code' }, { label: 'Asset' }, { label: 'Invoice' }, { label: 'Vendor' },
              { label: 'Location' }, { label: 'Qty', align: 'right' }, { label: 'Unit Cost', align: 'right' },
              { label: 'GST', align: 'right' }, { label: 'Total', align: 'right' }, { label: 'Payment' },
            ],
            rows: assets.map(a => [
              fmtDate(a.purchaseDate), a.assetCode, a.assetName, a.invoiceNumber || '-', a.vendorName || '-',
              a.locationName || '-', Number(a.quantity), pdfMoney(a.acquisitionCost),
              pdfMoney(a.gstAmount), pdfMoney(a.totalCost), PAYMENT_MODE_LABELS[a.paymentMode] ?? a.paymentMode,
            ]),
            totalsRow: ['Total', '', '', '', '', '', '', '', pdfMoney(assets.reduce((s, a) => s + Number(a.gstAmount || 0), 0)), pdfMoney(totalCost), ''],
          }],
        };
      case 'by_warehouse': case 'by_category': case 'by_vendor':
        return {
          title: `Assets ${reportLabel}`, metaRows: meta, filename: `assets-${report.replace('_', '-')}`,
          sections: [{
            columns: [
              { label: groupCols[0].label }, { label: 'Assets', align: 'right' },
              { label: 'Qty', align: 'right' }, { label: 'Total Cost', align: 'right' },
            ],
            rows: grouped.map(g => [g.name, g.count, g.qty, pdfMoney(g.cost)]),
            totalsRow: ['Total', grouped.reduce((s, g) => s + g.count, 0), grouped.reduce((s, g) => s + g.qty, 0), pdfMoney(grouped.reduce((s, g) => s + g.cost, 0))],
          }],
        };
      case 'warranty':
        return {
          title: 'Asset Warranty Expiry', metaRows: meta, orientation: 'landscape', filename: 'asset-warranty-expiry',
          sections: [{
            columns: [
              { label: 'Code' }, { label: 'Asset' }, { label: 'Category' }, { label: 'Location' },
              { label: 'Serial No.' }, { label: 'Warranty Start' }, { label: 'Warranty End' }, { label: 'Status' },
            ],
            rows: warrantyRows.map(a => [
              a.assetCode, a.assetName, a.categoryName || '-', a.currentLocationName || '-',
              a.serialNumber || '-', a.warrantyStart ? fmtDate(a.warrantyStart) : '-', fmtDate(a.warrantyEnd), ASSET_STATUS_LABELS[a.status] ?? a.status,
            ]),
          }],
        };
      case 'transfers':
        return {
          title: 'Asset Transfer History', metaRows: meta, orientation: 'landscape', filename: 'asset-transfer-history',
          sections: [{
            columns: [
              { label: 'Date' }, { label: 'Code' }, { label: 'Asset' }, { label: 'From' },
              { label: 'To' }, { label: 'Approved By' }, { label: 'Reason' },
            ],
            rows: transfers.map(t => [
              fmtDate(t.transferDate), t.assetCode, t.assetName, t.fromName, t.toName, t.approvedBy || '-', t.reason || '-',
            ]),
          }],
        };
      case 'disposals':
        return {
          title: 'Asset Disposal History', metaRows: meta, filename: 'asset-disposal-history',
          sections: [{
            columns: [
              { label: 'Date' }, { label: 'Code' }, { label: 'Asset' }, { label: 'Type' },
              { label: 'Asset Cost', align: 'right' }, { label: 'Reason' },
            ],
            rows: disposals.map(d => [
              fmtDate(d.disposalDate), d.assetCode, d.assetName, ASSET_STATUS_LABELS[d.disposalType] ?? d.disposalType,
              d.totalCost != null ? pdfMoney(d.totalCost) : '-', d.reason || '-',
            ]),
          }],
        };
    }
  };

  if (!perm.isLoading && !perm.canView) return <AssetsAccessDenied />;

  const showEntityFilters = report !== 'transfers' && report !== 'disposals';
  const showDateRange = isPurchaseView || report === 'transfers' || report === 'disposals';

  return (
    <AppLayout>
      <div className="space-y-5">
        <PageHeader
          title="Asset Reports"
          description="Register, purchases, warranty and movement history — filter and export."
          icon={BarChart3}
        />

        <ReportPicker options={REPORTS} value={report} onChange={setReport} />

        <div className="flex flex-wrap items-center gap-2">
          {showDateRange ? (
            <RangeBar range={range} />
          ) : (
            <span className="text-xs text-muted-foreground border border-dashed border-border rounded-md px-2.5 py-1.5">Point-in-time view — shows the register as it stands today</span>
          )}
          {showEntityFilters && (
            <>
              <LocationFilter state={loc} options={locFilterOptions} />
              <select
                value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="all">All categories</option>
                {categories.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
              <select
                value={vendorFilter} onChange={e => setVendorFilter(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="all">All vendors</option>
                {(vendors as any[]).map(v => <option key={v.id} value={String(v.id)}>{v.name}</option>)}
              </select>
              <select
                value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="all">All statuses</option>
                {Object.entries(ASSET_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </>
          )}
          <ExportButtons
            onCSV={() => downloadCSV(`${report.replace('_', '-')}.csv`, csvRows())}
            doc={buildDoc}
            disabled={loading}
            canDownload={perm.canDownload}
          />
        </div>

        <SummaryCards cards={cards} />

        {report === 'register' && <RTable cols={registerCols} rows={assets} loading={loading} rowKey={a => a.id} empty="No assets match the filters" />}
        {report === 'purchases' && (
          <RTable cols={purchaseCols} rows={assets} loading={loading} rowKey={a => a.id} empty="No purchases in the selected period"
            footer={['Total', '', '', '', '', '', '', '', fmt(assets.reduce((s, a) => s + Number(a.gstAmount || 0), 0)), fmt(totalCost), '']} />
        )}
        {(report === 'by_warehouse' || report === 'by_category' || report === 'by_vendor') && (
          <RTable cols={groupCols} rows={grouped} loading={loading} rowKey={g => g.name} empty="No assets match the filters"
            footer={['Total', String(grouped.reduce((s, g) => s + g.count, 0)), String(grouped.reduce((s, g) => s + g.qty, 0)), fmt(grouped.reduce((s, g) => s + g.cost, 0))]} />
        )}
        {report === 'warranty' && <RTable cols={warrantyCols} rows={warrantyRows} loading={loading} rowKey={a => a.id} empty="No assets carry a warranty end date" />}
        {report === 'transfers' && <RTable cols={transferCols} rows={transfers} loading={loading} rowKey={t => t.id} empty="No transfers in the selected period" />}
        {report === 'disposals' && <RTable cols={disposalCols} rows={disposals} loading={loading} rowKey={d => d.id} empty="No disposals in the selected period" />}
      </div>
    </AppLayout>
  );
}
