import { useState } from 'react';
import {
  useGetGstSummaryScoped, useGetGstDocuments, useGetGstFilters,
  type GstDocumentRow,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Receipt, TrendingUp, TrendingDown, Info, ShieldOff, FileText } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermission } from '@/lib/usePermission';
import { GstScopeFilter, gstScopeLabel, type GstScope } from '@/components/accounts/GstScopeFilter';
import { ExportButtons, type ReportDoc, type PdfSection } from '@/pages/reports/shared';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

const fmt = (n: number) => `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
          <TableSkeleton rows={4} cols={9} />
        ) : rows.length === 0 ? (
          <EmptyState icon={FileText} title="No documents in this period" compact />
        ) : (
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <SortableHead k="date" sort={sort}>Date</SortableHead>
              <SortableHead k="doc" sort={sort}>{title.startsWith('Outward') ? 'Invoice No' : 'Purchase No'}</SortableHead>
              <SortableHead k="party" sort={sort}>Party</SortableHead>
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
                <TableCell className="text-xs whitespace-nowrap">{r.date}</TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap">
                  {r.documentNumber || '—'}
                  {r.isBranchTransfer && <Badge variant="outline" className="ml-1.5 text-[10px]">Transfer</Badge>}
                </TableCell>
                <TableCell className="text-xs">{r.partyName || '—'}</TableCell>
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
                <TableCell colSpan={4} className="text-xs uppercase tracking-wider">Total ({rows.length})</TableCell>
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
export const docExportRow = (r: GstDocumentRow) => ({
  Date: r.date,
  'Document No': r.documentNumber || '—',
  Party: r.partyName || '—',
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
  { label: 'Date' }, { label: 'Document No' }, { label: 'Party' }, { label: 'Warehouse' },
  { label: 'Taxable', align: 'right' as const }, { label: 'Total Tax', align: 'right' as const },
  { label: 'Total', align: 'right' as const }, { label: 'Payment Status' }, { label: 'Payment Mode' },
];

export const docPdfRow = (r: GstDocumentRow): (string | number)[] => [
  r.date, r.documentNumber || '—', r.partyName || '—', r.warehouseName,
  r.taxableValue, r.taxAmount, r.invoiceValue, payStatusLabel(r.paymentStatus), r.paymentModes,
];

export default function GstSummary() {
  const perm = usePermission('page:/accounts/gst');
  const now = new Date();
  const [fromDate, setFromDate] = useState(`${now.getFullYear()}-04-01`);
  const [toDate, setToDate] = useState(now.toISOString().split('T')[0]);
  const [scope, setScope] = useState<GstScope>({});

  const params = { fromDate, toDate, ...scope };
  const { data: gst, isLoading } = useGetGstSummaryScoped(params);
  const docs = useGetGstDocuments(params);
  const filters = useGetGstFilters();

  const salesData = gst?.salesByRate ?? [];
  const purchasesData = gst?.purchasesByRate ?? [];
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
    downloadCSV(`gst-summary-${fromDate}-to-${toDate}.csv`, [
      ...salesData.map(r => ({ Section: 'Output by rate', Detail: `${r.taxRate}%`, Taxable: r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst, 'Total Tax': r.taxAmount })),
      ...purchasesData.map(r => ({ Section: 'Input by rate', Detail: `${r.taxRate}%`, Taxable: r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst, 'Total Tax': r.taxAmount })),
      ...outward.map(r => ({ Section: 'Outward documents', Detail: '', ...docExportRow(r) })),
      ...inward.map(r => ({ Section: 'Inward documents', Detail: '', ...docExportRow(r) })),
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
    const sections: PdfSection[] = [
      { heading: 'Output Tax by Rate (Sales)', columns: rateCols, rows: salesData.map(rateRow) },
      { heading: 'Input Tax Credit by Rate (Purchases)', columns: rateCols, rows: purchasesData.map(rateRow) },
      {
        heading: 'Month-wise Breakdown',
        columns: [{ label: 'Month' }, { label: 'Output Taxable', align: 'right' as const }, { label: 'Output Tax', align: 'right' as const }, { label: 'Input Taxable', align: 'right' as const }, { label: 'Input Tax', align: 'right' as const }, { label: 'Net GST', align: 'right' as const }],
        rows: monthWise.map(m => [m.month, m.outputTaxable, m.outputTax, m.inputTaxable, m.inputTax, m.netGst]),
      },
      { heading: 'Outward Documents (Sales)', columns: DOC_PDF_COLUMNS, rows: outward.map(docPdfRow) },
      { heading: 'Inward Documents (Purchases)', columns: DOC_PDF_COLUMNS, rows: inward.map(docPdfRow) },
    ];
    return {
      title: 'GST Summary',
      subtitle: `${fromDate} to ${toDate}`,
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
          description="Output tax liability vs input tax credit, broken down by rate slab"
          icon={Receipt}
          actions={<ExportButtons onCSV={exportCsv} doc={buildDoc} canDownload={perm.canDownload} disabled={isLoading || docs.isLoading} />}
        />

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-muted-foreground">Period:</span>
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
        </div>
        <GstScopeFilter value={scope} onChange={setScope} />

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

        {/* Document registers */}
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
      </div>
    </AppLayout>
  );
}
