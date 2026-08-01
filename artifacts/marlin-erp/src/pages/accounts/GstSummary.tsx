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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermission } from '@/lib/usePermission';
import { GstScopeFilter, gstScopeLabel, type GstScope } from '@/components/accounts/GstScopeFilter';
import { ExportButtons, type ReportDoc, type PdfSection } from '@/pages/reports/shared';

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
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20">
        <h3 className="font-semibold flex items-center gap-2">{icon} {title}</h3>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead>Date</TableHead>
              <TableHead>{title.startsWith('Outward') ? 'Invoice No' : 'Purchase No'}</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">Taxable</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Payment Status</TableHead>
              <TableHead>Payment Mode</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground text-sm">No documents in this period</TableCell></TableRow>
            ) : rows.map((r, i) => (
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
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Receipt className="w-6 h-6 text-primary" /> GST Summary</h1>
            <p className="text-muted-foreground mt-1">Output tax liability vs input tax credit, broken down by rate slab</p>
          </div>
          <ExportButtons onCSV={exportCsv} doc={buildDoc} canDownload={perm.canDownload} disabled={isLoading || docs.isLoading} />
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-muted-foreground">Period:</span>
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
        </div>
        <GstScopeFilter value={scope} onChange={setScope} />

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-4 h-4 text-emerald-500" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Output Tax (Sales)</p>
            </div>
            <p className="text-2xl font-bold text-emerald-500 font-mono">{fmt(totalOutputTax)}</p>
            <p className="text-xs text-muted-foreground mt-1">Tax collected from customers</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="w-4 h-4 text-primary" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Input Tax Credit (Purchases)</p>
            </div>
            <p className="text-2xl font-bold text-primary font-mono">{fmt(totalInputTax)}</p>
            <p className="text-xs text-muted-foreground mt-1">Tax paid to suppliers</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <Receipt className="w-4 h-4 text-amber-500" />
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Net GST Payable</p>
            </div>
            <p className={`text-2xl font-bold font-mono ${netGst > 0 ? 'text-red-500' : 'text-emerald-500'}`}>
              {fmt(netGst)}{netGst < 0 ? ' (credit)' : ''}
            </p>
            <p className="text-xs text-muted-foreground mt-1">Output − Input credit</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Output Tax Table */}
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20">
              <h3 className="font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-500" /> Output Tax (Sales)</h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Rate</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">CGST</TableHead>
                  <TableHead className="text-right">SGST</TableHead>
                  <TableHead className="text-right">IGST</TableHead>
                  <TableHead className="text-right">Total Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                ) : salesData.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                    No taxable sales in this period
                  </TableCell></TableRow>
                ) : salesData.map(r => (
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
          </div>

          {/* Input Tax Table */}
          <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20">
              <h3 className="font-semibold flex items-center gap-2">
                <TrendingDown className="w-4 h-4 text-primary" /> Input Tax Credit (Purchases)
              </h3>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10">
                  <TableHead>Rate</TableHead>
                  <TableHead className="text-right">Purchase Value</TableHead>
                  <TableHead className="text-right">CGST</TableHead>
                  <TableHead className="text-right">SGST</TableHead>
                  <TableHead className="text-right">IGST</TableHead>
                  <TableHead className="text-right">Total Tax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                ) : purchasesData.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                    No purchase data in this period
                  </TableCell></TableRow>
                ) : purchasesData.map((r, i) => (
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
          </div>
        </div>

        {/* Month-wise Breakdown */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-muted/20">
            <h3 className="font-semibold flex items-center gap-2"><Receipt className="w-4 h-4 text-primary" /> Month-wise Breakdown</h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Output Taxable</TableHead>
                <TableHead className="text-right">Output Tax</TableHead>
                <TableHead className="text-right">Input Taxable</TableHead>
                <TableHead className="text-right">Input Tax</TableHead>
                <TableHead className="text-right">Net GST</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              ) : monthWise.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                  No activity in this period
                </TableCell></TableRow>
              ) : monthWise.map(m => (
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
