import { useState } from 'react';
import {
  useGetGstSummaryScoped, useGetGstDocuments, useGetGstFilters,
  type GstDocumentRow, type GstSummaryItemRow,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Receipt, TrendingUp, TrendingDown, Info, ShieldOff, FileText } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermission } from '@/lib/usePermission';
import { GstScopeFilter, gstScopeLabel, type GstScope } from '@/components/accounts/GstScopeFilter';
import { ExportButtons, type ReportDoc, type PdfSection } from '@/pages/reports/shared';
import { formatDateOrDash } from '@/lib/date';
import { formatSalesInvoiceDisplayNumber } from '@/lib/invoiceNumber';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

const fmt = (n: number) => `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty = (n: number) => Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export function PaymentStatusBadge({ status }: { status: string }) {
  if (status === 'na') return <span className="text-xs text-muted-foreground">—</span>;
  if (status === 'paid') return <Badge className="bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 border-0">Paid</Badge>;
  if (status === 'partially_paid') return <Badge className="bg-amber-500/15 text-amber-600 hover:bg-amber-500/15 border-0">Partial</Badge>;
  return <Badge className="bg-red-500/15 text-red-600 hover:bg-red-500/15 border-0">Unpaid</Badge>;
}

const payStatusLabel = (s: string) =>
  s === 'na' ? '—' : s === 'paid' ? 'Paid' : s === 'partially_paid' ? 'Partial' : 'Unpaid';

export function GstDocumentsTable({ title, icon, rows, loading }: {
  title: string; icon: React.ReactNode; rows: GstDocumentRow[]; loading: boolean;
}) {
  const { sorted, sort } = useTableSort(rows, {
    date: r => r.date,
    doc: r => r.documentNumber,
    party: r => r.partyName,
    partyGstin: r => r.partyGstin,
    warehouse: r => r.warehouseName,
    taxable: r => Number(r.taxableValue),
    tax: r => Number(r.taxAmount),
    total: r => Number(r.invoiceValue),
    payStatus: r => r.paymentStatus,
    payMode: r => r.paymentModes,
  });
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20">
        <h3 className="font-semibold flex items-center gap-2">{icon} {title}</h3>
      </div>
      <div className="overflow-x-auto">
        {loading ? (
          <TableSkeleton rows={4} cols={10} />
        ) : rows.length === 0 ? (
          <EmptyState icon={FileText} title="No documents in this period" compact />
        ) : (
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <SortableHead k="date" sort={sort}>Date</SortableHead>
              <SortableHead k="doc" sort={sort}>{title.startsWith('Outward') ? 'Invoice No' : 'Purchase No'}</SortableHead>
              <SortableHead k="party" sort={sort}>Party</SortableHead>
              <SortableHead k="partyGstin" sort={sort}>
                {title.startsWith('Outward') ? 'Customer GST No.' : 'Vendor GST No.'}
              </SortableHead>
              <SortableHead k="warehouse" sort={sort}>Warehouse</SortableHead>
              <SortableHead k="taxable" sort={sort} className="text-right">Taxable</SortableHead>
              <SortableHead k="tax" sort={sort} className="text-right">Tax</SortableHead>
              <SortableHead k="total" sort={sort} className="text-right">Total</SortableHead>
              <SortableHead k="payStatus" sort={sort}>Payment Status</SortableHead>
              <SortableHead k="payMode" sort={sort}>Payment Mode</SortableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r, i) => (
              <TableRow key={i} className="hover:bg-muted/10">
                <TableCell className="text-xs whitespace-nowrap">{formatDateOrDash(r.date)}</TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap">
                  {title.startsWith('Outward')
                    ? formatSalesInvoiceDisplayNumber(r.documentNumber || '—')
                    : r.documentNumber || '—'}
                  {r.isBranchTransfer && <Badge variant="outline" className="ml-1.5 text-[10px]">Transfer</Badge>}
                </TableCell>
                <TableCell className="text-xs">{r.partyName || '—'}</TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap">{r.partyGstin || '—'}</TableCell>
                <TableCell className="text-xs">{r.warehouseName}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.taxableValue)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.taxAmount)}</TableCell>
                <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.invoiceValue)}</TableCell>
                <TableCell><PaymentStatusBadge status={r.paymentStatus} /></TableCell>
                <TableCell className="text-xs whitespace-nowrap">{r.paymentModes}</TableCell>
              </TableRow>
            ))}
            {rows.length > 1 && (
              <TableRow className="bg-muted/10 font-bold border-t-2">
                <TableCell colSpan={5} className="text-xs uppercase tracking-wider">Total ({rows.length})</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + r.taxableValue, 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + r.taxAmount, 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + r.invoiceValue, 0))}</TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            )}
          </TableBody>
        </Table>
        )}
      </div>
    </div>
  );
}

/** Document rows → export cells, shared by CSV and the PDF/Excel doc. */
export const docExportRow = (r: GstDocumentRow, outward = false) => ({
  Date: formatDateOrDash(r.date),
  'Document No': outward
    ? formatSalesInvoiceDisplayNumber(r.documentNumber || '—')
    : r.documentNumber || '—',
  Party: r.partyName || '—',
  'GST No.': r.partyGstin || '—',
  Warehouse: r.warehouseName,
  Taxable: r.taxableValue,
  CGST: r.cgst,
  SGST: r.sgst,
  IGST: r.igst,
  'Total Tax': r.taxAmount,
  Total: r.invoiceValue,
  'Payment Status': payStatusLabel(r.paymentStatus),
  'Payment Mode': r.paymentModes,
});

export const DOC_PDF_COLUMNS = [
  { label: 'Date' }, { label: 'Document No' }, { label: 'Party' }, { label: 'GST No.' }, { label: 'Warehouse' },
  { label: 'Taxable', align: 'right' as const }, { label: 'Total Tax', align: 'right' as const },
  { label: 'Total', align: 'right' as const }, { label: 'Payment Status' }, { label: 'Payment Mode' },
];

export const docPdfRow = (r: GstDocumentRow, outward = false): (string | number)[] => [
  formatDateOrDash(r.date),
  outward ? formatSalesInvoiceDisplayNumber(r.documentNumber || '—') : r.documentNumber || '—',
  r.partyName || '—', r.partyGstin || '—', r.warehouseName,
  r.taxableValue, r.taxAmount, r.invoiceValue, payStatusLabel(r.paymentStatus), r.paymentModes,
];

type GstItemWiseRow = GstSummaryItemRow & { transactionType: 'Sales' | 'Purchases' };

function GstItemsTable({ rows, loading }: { rows: GstItemWiseRow[]; loading: boolean }) {
  const { sorted, sort } = useTableSort(rows, {
    transaction: r => r.transactionType,
    item: r => r.itemName,
    rate: r => Number(r.taxRate),
    quantity: r => Number(r.quantity),
    taxable: r => Number(r.taxableValue),
    cgst: r => Number(r.cgst),
    sgst: r => Number(r.sgst),
    igst: r => Number(r.igst),
    tax: r => Number(r.taxAmount),
  });
  const sideRows = (side: GstItemWiseRow['transactionType']) => rows.filter((row) => row.transactionType === side);
  const total = (
    subset: GstItemWiseRow[],
    key: keyof Pick<GstSummaryItemRow, 'quantity' | 'taxableValue' | 'cgst' | 'sgst' | 'igst' | 'taxAmount'>,
  ) => subset.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20">
        <h3 className="font-semibold flex items-center gap-2">
          <Receipt className="w-4 h-4 text-primary" /> Item-wise GST Breakdown
        </h3>
      </div>
      <div className="overflow-x-auto">
        {loading ? (
          <TableSkeleton rows={4} cols={9} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Receipt} title="No item-wise GST in this period" compact />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="transaction" sort={sort}>Transaction</SortableHead>
                <SortableHead k="item" sort={sort}>Item</SortableHead>
                <SortableHead k="rate" sort={sort}>Rate</SortableHead>
                <SortableHead k="quantity" sort={sort} className="text-right">Qty</SortableHead>
                <SortableHead k="taxable" sort={sort} className="text-right">Taxable</SortableHead>
                <SortableHead k="cgst" sort={sort} className="text-right">CGST</SortableHead>
                <SortableHead k="sgst" sort={sort} className="text-right">SGST</SortableHead>
                <SortableHead k="igst" sort={sort} className="text-right">IGST</SortableHead>
                <SortableHead k="tax" sort={sort} className="text-right">Total Tax</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow key={`${row.transactionType}:${row.itemType}:${row.itemId ?? row.itemName}:${row.taxRate}`} className="hover:bg-muted/10">
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={row.transactionType === 'Sales'
                        ? 'border-emerald-500/30 text-emerald-600'
                        : 'border-primary/30 text-primary'}
                    >
                      {row.transactionType}
                    </Badge>
                  </TableCell>
                  <TableCell className="min-w-44">
                    <div className="font-medium text-xs">{row.itemName}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {row.itemTypeLabel}{row.unit ? ` · ${row.unit}` : ''}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{row.taxRate}%</Badge></TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{fmtQty(Number(row.quantity))}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{fmt(Number(row.taxableValue))}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{fmt(Number(row.cgst))}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{fmt(Number(row.sgst))}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{fmt(Number(row.igst))}</TableCell>
                  <TableCell className={`text-right font-mono font-bold text-xs whitespace-nowrap ${row.transactionType === 'Sales' ? 'text-emerald-500' : 'text-primary'}`}>
                    {fmt(Number(row.taxAmount))}
                  </TableCell>
                </TableRow>
              ))}
              {(['Sales', 'Purchases'] as const).map((side) => {
                const subset = sideRows(side);
                if (subset.length === 0) return null;
                const tone = side === 'Sales' ? 'text-emerald-500' : 'text-primary';
                return (
                  <TableRow key={`${side}-total`} className="bg-muted/10 font-bold border-t-2">
                    <TableCell colSpan={3} className="text-xs uppercase tracking-wider">{side} total</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmtQty(total(subset, 'quantity'))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(total(subset, 'taxableValue'))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(total(subset, 'cgst'))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(total(subset, 'sgst'))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(total(subset, 'igst'))}</TableCell>
                    <TableCell className={`text-right font-mono text-xs ${tone}`}>{fmt(total(subset, 'taxAmount'))}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

export default function GstSummary() {
  const perm = usePermission('page:/accounts/gst');
  const now = new Date();
  const [fromDate, setFromDate] = useState(`${now.getFullYear()}-04-01`);
  const [toDate, setToDate] = useState(now.toISOString().split('T')[0]);
  const [scope, setScope] = useState<GstScope>({});
  const [itemWise, setItemWise] = useState(false);

  const params = { fromDate, toDate, ...scope };
  const { data: gst, isLoading } = useGetGstSummaryScoped(params);
  const docs = useGetGstDocuments(params);
  const filters = useGetGstFilters();

  const salesData = gst?.salesByRate ?? [];
  const purchasesData = gst?.purchasesByRate ?? [];
  const salesItems = gst?.salesByItem ?? [];
  const purchaseItems = gst?.purchasesByItem ?? [];
  const itemWiseRows: GstItemWiseRow[] = [
    ...salesItems.map((row) => ({ ...row, transactionType: 'Sales' as const })),
    ...purchaseItems.map((row) => ({ ...row, transactionType: 'Purchases' as const })),
  ];
  const monthWise = gst?.monthWise ?? [];
  const outward = docs.data?.outward ?? [];
  const inward = docs.data?.inward ?? [];

  const totalOutputTax = salesData.reduce((s, r) => s + Number(r.taxAmount || 0), 0);
  const totalInputTax = purchasesData.reduce((s, r) => s + Number(r.taxAmount || 0), 0);
  const netGst = totalOutputTax - totalInputTax;

  const salesSort = useTableSort(salesData, {
    rate: r => Number(r.taxRate),
    taxable: r => Number(r.taxableValue),
    cgst: r => Number(r.cgst),
    sgst: r => Number(r.sgst),
    igst: r => Number(r.igst),
    tax: r => Number(r.taxAmount),
  });
  const purchasesSort = useTableSort(purchasesData, {
    rate: r => Number(r.taxRate),
    taxable: r => Number(r.taxableValue),
    cgst: r => Number(r.cgst),
    sgst: r => Number(r.sgst),
    igst: r => Number(r.igst ?? 0),
    tax: r => Number(r.taxAmount),
  });
  const monthSort = useTableSort(monthWise, {
    month: r => r.month,
    outputTaxable: r => Number(r.outputTaxable),
    outputTax: r => Number(r.outputTax),
    inputTaxable: r => Number(r.inputTaxable),
    inputTax: r => Number(r.inputTax),
    netGst: r => Number(r.netGst),
  });

  const scopeText = gstScopeLabel(scope, filters.data?.gstins ?? []);

  const exportCsv = () => {
    const csvRow = (values: Record<string, unknown>) => ({
      Section: '', Detail: '', Transaction: '', Item: '', Type: '', Rate: '', Quantity: '', Unit: '',
      Date: '', 'Document No': '', Party: '', 'GST No.': '', Warehouse: '',
      Taxable: '', CGST: '', SGST: '', IGST: '', 'Total Tax': '', Total: '',
      'Payment Status': '', 'Payment Mode': '',
      ...values,
    });
    const selectedDetails = itemWise
      ? itemWiseRows.map((row) => csvRow({
          Section: 'Item-wise', Transaction: row.transactionType, Item: row.itemName,
          Type: row.itemTypeLabel, Rate: `${row.taxRate}%`, Quantity: row.quantity, Unit: row.unit,
          Taxable: row.taxableValue, CGST: row.cgst, SGST: row.sgst, IGST: row.igst, 'Total Tax': row.taxAmount,
        }))
      : [
          ...outward.map((row) => csvRow({ Section: 'Outward documents', ...docExportRow(row, true) })),
          ...inward.map((row) => csvRow({ Section: 'Inward documents', ...docExportRow(row) })),
        ];
    downloadCSV(`gst-summary-${fromDate}-to-${toDate}.csv`, [
      ...salesData.map(r => csvRow({
        Section: 'Output by rate', Detail: `${r.taxRate}%`, Rate: `${r.taxRate}%`,
        Taxable: r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst, 'Total Tax': r.taxAmount,
      })),
      ...purchasesData.map(r => csvRow({
        Section: 'Input by rate', Detail: `${r.taxRate}%`, Rate: `${r.taxRate}%`,
        Taxable: r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst, 'Total Tax': r.taxAmount,
      })),
      ...selectedDetails,
    ]);
  };

  const buildDoc = (): ReportDoc => {
    const rateCols = [
      { label: 'Rate' }, { label: 'Taxable', align: 'right' as const },
      { label: 'CGST', align: 'right' as const }, { label: 'SGST', align: 'right' as const },
      { label: 'IGST', align: 'right' as const }, { label: 'Total Tax', align: 'right' as const },
    ];
    const rateRow = (r: { taxRate: number; taxableValue: number; cgst: number; sgst: number; igst: number; taxAmount: number }) =>
      [`${r.taxRate}%`, r.taxableValue, r.cgst, r.sgst, r.igst, r.taxAmount];
    const itemCols = [
      { label: 'Transaction' }, { label: 'Item', width: 2 }, { label: 'Rate' }, { label: 'Qty', align: 'right' as const },
      { label: 'Taxable', align: 'right' as const }, { label: 'CGST', align: 'right' as const },
      { label: 'SGST', align: 'right' as const }, { label: 'IGST', align: 'right' as const },
      { label: 'Total Tax', align: 'right' as const },
    ];
    const itemRow = (r: GstItemWiseRow) => [
      r.transactionType, `${r.itemName} (${r.itemTypeLabel}${r.unit ? ` · ${r.unit}` : ''})`,
      `${r.taxRate}%`, fmtQty(Number(r.quantity)), r.taxableValue, r.cgst, r.sgst, r.igst, r.taxAmount,
    ];
    const sections: PdfSection[] = [
      { heading: 'Output Tax by Rate (Sales)', columns: rateCols, rows: salesData.map(rateRow) },
      { heading: 'Input Tax Credit by Rate (Purchases)', columns: rateCols, rows: purchasesData.map(rateRow) },
      ...(itemWise
        ? [{ heading: 'Item-wise GST Breakdown', columns: itemCols, rows: itemWiseRows.map(itemRow) }]
        : []),
      {
        heading: 'Month-wise Breakdown',
        columns: [{ label: 'Month' }, { label: 'Output Taxable', align: 'right' as const }, { label: 'Output Tax', align: 'right' as const }, { label: 'Input Taxable', align: 'right' as const }, { label: 'Input Tax', align: 'right' as const }, { label: 'Net GST', align: 'right' as const }],
        rows: monthWise.map(m => [m.month, m.outputTaxable, m.outputTax, m.inputTaxable, m.inputTax, m.netGst]),
      },
      ...(!itemWise
        ? [
            { heading: 'Outward Documents (Sales)', columns: DOC_PDF_COLUMNS, rows: outward.map(r => docPdfRow(r, true)) },
            { heading: 'Inward Documents (Purchases)', columns: DOC_PDF_COLUMNS, rows: inward.map(r => docPdfRow(r)) },
          ]
        : []),
    ];
    return {
      title: 'GST Summary',
      subtitle: `${formatDateOrDash(fromDate)} to ${formatDateOrDash(toDate)}`,
      metaRows: [['Scope', scopeText]],
      orientation: 'landscape',
      sections,
      filename: `gst-summary-${fromDate}-to-${toDate}`,
    };
  };

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
        <PageHeader
          title="GST Summary"
          description="Output tax liability vs input tax credit, broken down by rate slab and item"
          icon={Receipt}
          actions={<ExportButtons onCSV={exportCsv} doc={buildDoc} canDownload={perm.canDownload} disabled={isLoading || (!itemWise && docs.isLoading)} />}
        />

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-muted-foreground">Period:</span>
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
        </div>
        <GstScopeFilter value={scope} onChange={setScope} />
        <div className="flex items-start gap-2">
          <Checkbox
            id="gst-item-wise"
            checked={itemWise}
            onCheckedChange={(checked) => setItemWise(checked === true)}
          />
          <div className="grid gap-0.5">
            <label htmlFor="gst-item-wise" className="text-sm font-medium leading-none cursor-pointer">
              Item-wise
            </label>
            <span className="text-xs text-muted-foreground">Checked: one combined item table. Unchecked: bill-wise registers.</span>
          </div>
        </div>

        {/* Summary Cards */}
        <SummaryCardGrid className="lg:grid-cols-3">
          <SummaryCard
            label="Output Tax (Sales)"
            value={<span className="font-mono">{fmt(totalOutputTax)}</span>}
            sub="Tax collected from customers"
            icon={TrendingUp}
            tone="positive"
            loading={isLoading}
          />
          <SummaryCard
            label="Input Tax Credit (Purchases)"
            value={<span className="font-mono text-primary">{fmt(totalInputTax)}</span>}
            sub="Tax paid to suppliers"
            icon={TrendingDown}
            tone="default"
            loading={isLoading}
          />
          <SummaryCard
            label="Net GST Payable"
            value={<span className={`font-mono ${netGst > 0 ? 'text-red-500' : 'text-emerald-500'}`}>{fmt(netGst)}{netGst < 0 ? ' (credit)' : ''}</span>}
            sub="Output − Input credit"
            icon={Receipt}
            tone="warning"
            loading={isLoading}
          />
        </SummaryCardGrid>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Output Tax Table */}
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20">
              <h3 className="font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-500" /> Output Tax (Sales)</h3>
            </div>
            {isLoading ? (
              <TableSkeleton rows={4} cols={6} />
            ) : salesData.length === 0 ? (
              <EmptyState icon={TrendingUp} title="No taxable sales in this period" compact />
            ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <SortableHead k="rate" sort={salesSort.sort}>Rate</SortableHead>
                  <SortableHead k="taxable" sort={salesSort.sort} className="text-right">Taxable</SortableHead>
                  <SortableHead k="cgst" sort={salesSort.sort} className="text-right">CGST</SortableHead>
                  <SortableHead k="sgst" sort={salesSort.sort} className="text-right">SGST</SortableHead>
                  <SortableHead k="igst" sort={salesSort.sort} className="text-right">IGST</SortableHead>
                  <SortableHead k="tax" sort={salesSort.sort} className="text-right">Total Tax</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {salesSort.sorted.map(r => (
                  <TableRow key={r.taxRate} className="hover:bg-muted/10">
                    <TableCell><Badge variant="secondary">{r.taxRate}%</Badge></TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.taxableValue))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.cgst))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.sgst))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.igst))}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-emerald-500">{fmt(Number(r.taxAmount))}</TableCell>
                  </TableRow>
                ))}
                {salesData.length > 1 && (
                  <TableRow className="bg-muted/10 font-bold border-t-2">
                    <TableCell className="text-xs uppercase tracking-wider">Total</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(salesData.reduce((s, r) => s + Number(r.taxableValue), 0))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(salesData.reduce((s, r) => s + Number(r.cgst), 0))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(salesData.reduce((s, r) => s + Number(r.sgst), 0))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(salesData.reduce((s, r) => s + Number(r.igst), 0))}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-emerald-500">{fmt(totalOutputTax)}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            )}
          </div>

          {/* Input Tax Table */}
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20">
              <h3 className="font-semibold flex items-center gap-2">
                <TrendingDown className="w-4 h-4 text-primary" /> Input Tax Credit (Purchases)
              </h3>
            </div>
            {isLoading ? (
              <TableSkeleton rows={4} cols={6} />
            ) : purchasesData.length === 0 ? (
              <EmptyState icon={TrendingDown} title="No purchase data in this period" compact />
            ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <SortableHead k="rate" sort={purchasesSort.sort}>Rate</SortableHead>
                  <SortableHead k="taxable" sort={purchasesSort.sort} className="text-right">Purchase Value</SortableHead>
                  <SortableHead k="cgst" sort={purchasesSort.sort} className="text-right">CGST</SortableHead>
                  <SortableHead k="sgst" sort={purchasesSort.sort} className="text-right">SGST</SortableHead>
                  <SortableHead k="igst" sort={purchasesSort.sort} className="text-right">IGST</SortableHead>
                  <SortableHead k="tax" sort={purchasesSort.sort} className="text-right">Total Tax</SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchasesSort.sorted.map((r, i) => (
                  <TableRow key={i} className="hover:bg-muted/10">
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary">{r.taxRate}%</Badge>
                        {r.estimated && (
                          <Tooltip>
                            <TooltipTrigger><Info className="w-3 h-3 text-amber-500" /></TooltipTrigger>
                            <TooltipContent>Estimated at {r.taxRate}% of purchase value (per-line GST not tracked on purchases)</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.taxableValue))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.cgst))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.sgst))}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{fmt(Number(r.igst ?? 0))}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-primary">{fmt(Number(r.taxAmount))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            )}
          </div>
        </div>

        {itemWise && <GstItemsTable rows={itemWiseRows} loading={isLoading} />}

        {/* Month-wise Breakdown */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-muted/20">
            <h3 className="font-semibold flex items-center gap-2"><Receipt className="w-4 h-4 text-primary" /> Month-wise Breakdown</h3>
          </div>
          {isLoading ? (
            <TableSkeleton rows={4} cols={6} />
          ) : monthWise.length === 0 ? (
            <EmptyState icon={Receipt} title="No activity in this period" compact />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="month" sort={monthSort.sort}>Month</SortableHead>
                <SortableHead k="outputTaxable" sort={monthSort.sort} className="text-right">Output Taxable</SortableHead>
                <SortableHead k="outputTax" sort={monthSort.sort} className="text-right">Output Tax</SortableHead>
                <SortableHead k="inputTaxable" sort={monthSort.sort} className="text-right">Input Taxable</SortableHead>
                <SortableHead k="inputTax" sort={monthSort.sort} className="text-right">Input Tax</SortableHead>
                <SortableHead k="netGst" sort={monthSort.sort} className="text-right">Net GST</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {monthSort.sorted.map(m => (
                <TableRow key={m.month} className="hover:bg-muted/10">
                  <TableCell className="text-sm font-medium">
                    {new Date(`${m.month}-01T00:00:00`).toLocaleString('en-IN', { month: 'short', year: 'numeric' })}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmt(Number(m.outputTaxable))}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-emerald-500">{fmt(Number(m.outputTax))}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmt(Number(m.inputTaxable))}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-primary">{fmt(Number(m.inputTax))}</TableCell>
                  <TableCell className={`text-right font-mono text-xs font-bold ${Number(m.netGst) > 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                    {fmt(Number(m.netGst))}{Number(m.netGst) < 0 ? ' (credit)' : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </div>

        {!itemWise && (
          <>
            <GstDocumentsTable
              title="Outward Documents (Sales)"
              icon={<FileText className="w-4 h-4 text-emerald-500" />}
              rows={outward}
              loading={docs.isLoading}
            />
            <GstDocumentsTable
              title="Inward Documents (Purchases)"
              icon={<FileText className="w-4 h-4 text-primary" />}
              rows={inward}
              loading={docs.isLoading}
            />
          </>
        )}
      </div>
    </AppLayout>
  );
}
