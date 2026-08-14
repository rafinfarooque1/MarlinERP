import { useState } from 'react';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import {
  useGetHsnSummary, useGetGstr1, useGetGstr3b, useGetGstReconciliation, useGetGstFilters,
  type HsnSummaryRow, type Gstr3bResponse, type GstReconMismatchDoc,
} from '@workspace/api-client-react';
import { resolveDrill } from '@/lib/drilldown';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { FileSpreadsheet, Download, CheckCircle2, AlertTriangle, ShieldOff } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { GstScopeFilter, gstScopeLabel, type GstScope } from '@/components/accounts/GstScopeFilter';
import { PaymentStatusBadge } from '@/pages/accounts/GstSummary';
import { ExportButtons, type ReportDoc } from '@/pages/reports/shared';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

const payStatusLabel = (s?: string) =>
  s === 'na' ? '—' : s === 'paid' ? 'Paid' : s === 'partially_paid' ? 'Partial' : 'Unpaid';

const fmt = (n: number) => `₹${Math.abs(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthLabel = (m: string) => {
  const d = new Date(`${m}-01T00:00:00`);
  return isNaN(d.getTime()) ? m : d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
};

function HsnTable({ title, rows, loading }: { title: string; rows: HsnSummaryRow[]; loading: boolean }) {
  const { sorted, sort } = useTableSort(rows, {
    hsn: r => r.hsnCode,
    rate: r => Number(r.taxRate),
    qty: r => Number(r.quantity),
    unit: r => r.unit,
    taxable: r => Number(r.taxableValue),
    cgst: r => Number(r.cgst),
    sgst: r => Number(r.sgst),
    igst: r => Number(r.igst),
    totalTax: r => Number(r.taxAmount),
  });
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20">
        <h3 className="font-semibold text-sm">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        {loading ? (
          <TableSkeleton rows={4} cols={9} />
        ) : rows.length === 0 ? (
          <EmptyState title="No records in this period" compact />
        ) : (
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <SortableHead k="hsn" sort={sort}>HSN</SortableHead>
              <SortableHead k="rate" sort={sort}>Rate</SortableHead>
              <SortableHead k="qty" sort={sort} className="text-right">Qty</SortableHead>
              <SortableHead k="unit" sort={sort}>Unit</SortableHead>
              <SortableHead k="taxable" sort={sort} className="text-right">Taxable Value</SortableHead>
              <SortableHead k="cgst" sort={sort} className="text-right">CGST</SortableHead>
              <SortableHead k="sgst" sort={sort} className="text-right">SGST</SortableHead>
              <SortableHead k="igst" sort={sort} className="text-right">IGST</SortableHead>
              <SortableHead k="totalTax" sort={sort} className="text-right">Total Tax</SortableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r, i) => (
              <TableRow key={i} className="hover:bg-muted/10">
                <TableCell className="font-mono text-xs">{r.hsnCode}</TableCell>
                <TableCell><Badge variant="secondary">{r.taxRate}%</Badge></TableCell>
                <TableCell className="text-right font-mono text-xs">{Number(r.quantity).toLocaleString('en-IN')}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.unit || '—'}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.taxableValue)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.cgst)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.sgst)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.igst)}</TableCell>
                <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.taxAmount)}</TableCell>
              </TableRow>
            ))}
            {rows.length > 1 && (
              <TableRow className="bg-muted/10 font-bold border-t-2">
                <TableCell colSpan={4} className="text-xs uppercase tracking-wider">Total</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.taxableValue), 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.cgst), 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.sgst), 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.igst), 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.taxAmount), 0))}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        )}
      </div>
    </div>
  );
}

function Gstr3bCard({ title, heads, total, totalLabel, accent }: {
  title: string;
  heads: { cgst: number; sgst: number; igst: number };
  total: number;
  totalLabel: string;
  accent: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">{title}</p>
      <div className="space-y-1.5 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">CGST</span><span className="font-mono">{fmt(heads.cgst)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">SGST</span><span className="font-mono">{fmt(heads.sgst)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">IGST</span><span className="font-mono">{fmt(heads.igst)}</span></div>
        <div className="flex justify-between border-t border-border pt-1.5 mt-1.5 font-bold">
          <span>{totalLabel}</span><span className={`font-mono ${accent}`}>{fmt(total)}</span>
        </div>
      </div>
    </div>
  );
}

export default function GstReturns() {
  const perms = usePermission('page:/accounts/gst-returns');
  const [, navigate] = useLocation();
  const now = new Date();
  const fyStart = `${now.getMonth() + 1 < 4 ? now.getFullYear() - 1 : now.getFullYear()}-04-01`;
  const [fromDate, setFromDate] = useState(fyStart);
  const [toDate, setToDate] = useState(now.toISOString().split('T')[0]);
  const [month, setMonth] = useState(now.toISOString().slice(0, 7));
  // Deep-linkable tab (?tab=gstr1|gstr3b|recon) — same query-param convention
  // the drill-down targets use.
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t && ['hsn', 'gstr1', 'gstr3b', 'recon'].includes(t) ? t : 'hsn';
  });
  const [scope, setScope] = useState<GstScope>({});

  const hsn = useGetHsnSummary({ fromDate, toDate, ...scope });
  const g1 = useGetGstr1({ fromDate, toDate, ...scope });
  const g3b = useGetGstr3b(month, scope);
  const recon = useGetGstReconciliation({ fromDate, toDate });
  const filters = useGetGstFilters();
  const scopeText = gstScopeLabel(scope, filters.data?.gstins ?? []);

  if (!perms.isLoading && !perms.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <ShieldOff className="w-10 h-10 text-muted-foreground mb-3" />
          <h2 className="text-lg font-semibold">No access</h2>
          <p className="text-sm text-muted-foreground mt-1">You don't have permission to view GST Returns.</p>
        </div>
      </AppLayout>
    );
  }

  const b2b = g1.data?.b2b ?? [];
  const b2c = g1.data?.b2c ?? [];
  const b2cs = g1.data?.b2cs ?? [];
  const d3b: Gstr3bResponse | undefined = g3b.data;
  const reconRows = recon.data?.rows ?? [];
  const mismatchDocs = [
    ...(recon.data?.mismatchDocs?.outward ?? []),
    ...(recon.data?.mismatchDocs?.inward ?? []),
  ];
  const otherEntries = recon.data?.otherEntries ?? [];
  const reconChecked = recon.data?.checked;

  const b2bSort = useTableSort(b2b, {
    invoice: r => r.invoiceNumber,
    date: r => r.saleDate,
    customer: r => r.customerName,
    gstin: r => r.gstin,
    pos: r => r.placeOfSupply,
    warehouse: r => r.warehouseName,
    rate: r => Number(r.taxRate),
    taxable: r => Number(r.taxableValue),
    cgst: r => Number(r.cgst),
    sgst: r => Number(r.sgst),
    igst: r => Number(r.igst),
    invoiceValue: r => Number(r.invoiceValue),
    payStatus: r => r.paymentStatus,
    payMode: r => r.paymentModes,
  });
  const b2cSort = useTableSort(b2c, {
    invoice: r => r.invoiceNumber,
    date: r => r.saleDate,
    customer: r => r.customerName,
    pos: r => r.placeOfSupply,
    warehouse: r => r.warehouseName,
    rate: r => Number(r.taxRate),
    taxable: r => Number(r.taxableValue),
    cgst: r => Number(r.cgst),
    sgst: r => Number(r.sgst),
    igst: r => Number(r.igst),
    invoiceValue: r => Number(r.invoiceValue),
    payStatus: r => r.paymentStatus,
    payMode: r => r.paymentModes,
  });
  const b2csSort = useTableSort(b2cs, {
    pos: r => r.placeOfSupply,
    rate: r => Number(r.taxRate),
    taxable: r => Number(r.taxableValue),
    cgst: r => Number(r.cgst),
    sgst: r => Number(r.sgst),
    igst: r => Number(r.igst),
    taxAmount: r => Number(r.taxAmount),
  });
  const mismatchSort = useTableSort(mismatchDocs, {
    type: r => r.docType,
    doc: r => r.documentNumber,
    date: r => r.date,
    party: r => r.partyName,
    register: r => r.register.cgst + r.register.sgst + r.register.igst,
    ledger: r => r.ledger.cgst + r.ledger.sgst + r.ledger.igst,
    diff: r => Number(r.differenceTotal),
    reason: r => r.reason,
  });
  const otherSort = useTableSort(otherEntries, {
    date: r => r.date,
    source: r => r.source,
    voucher: r => r.voucherNumber ?? '',
    head: r => r.head,
    amount: r => Number(r.amount),
  });
  const reconSort = useTableSort(reconRows, {
    head: r => r.head,
    ledger: r => r.ledgerCode,
    ledgerAmount: r => Number(r.ledgerAmount),
    registerAmount: r => Number(r.registerAmount),
    difference: r => Number(r.difference),
  });

  const exportHsn = () => {
    const mk = (r: HsnSummaryRow, type: string) => ({
      Type: type, HSN: r.hsnCode, 'Rate %': r.taxRate, Qty: r.quantity, Unit: r.unit,
      'Taxable Value': r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst, 'Total Tax': r.taxAmount,
    });
    downloadCSV(`hsn-summary-${fromDate}-to-${toDate}.csv`, [
      ...(hsn.data?.outward ?? []).map(r => mk(r, 'Outward (Sales)')),
      ...(hsn.data?.inward ?? []).map(r => mk(r, 'Inward (Purchases)')),
    ]);
  };
  const exportGstr1 = () => {
    downloadCSV(`gstr1-${fromDate}-to-${toDate}.csv`, [
      ...b2b.map(r => ({
        Section: 'B2B', 'Invoice No': r.invoiceNumber, Date: r.saleDate, Customer: r.customerName,
        GSTIN: r.gstin, 'Place of Supply': r.placeOfSupply, Warehouse: r.warehouseName ?? '',
        'Rate %': r.taxRate,
        'Taxable Value': r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst,
        'Total Tax': r.taxAmount, 'Invoice Value': r.invoiceValue,
        'Payment Status': payStatusLabel(r.paymentStatus), 'Payment Mode': r.paymentModes ?? '',
      })),
      ...b2c.map(r => ({
        Section: 'B2C (Invoices)', 'Invoice No': r.invoiceNumber, Date: r.saleDate, Customer: r.customerName,
        GSTIN: '', 'Place of Supply': r.placeOfSupply, Warehouse: r.warehouseName ?? '',
        'Rate %': r.taxRate,
        'Taxable Value': r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst,
        'Total Tax': r.taxAmount, 'Invoice Value': r.invoiceValue,
        'Payment Status': payStatusLabel(r.paymentStatus), 'Payment Mode': r.paymentModes ?? '',
      })),
      ...b2cs.map(r => ({
        Section: 'B2C (Small, aggregated)', 'Invoice No': '', Date: '', Customer: '', GSTIN: '',
        'Place of Supply': r.placeOfSupply, Warehouse: '', 'Rate %': r.taxRate,
        'Taxable Value': r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst,
        'Total Tax': r.taxAmount, 'Invoice Value': '', 'Payment Status': '', 'Payment Mode': '',
      })),
    ]);
  };
  const exportGstr3b = () => {
    if (!d3b) return;
    downloadCSV(`gstr3b-${month}.csv`, [
      { Section: '3.1(a) Outward taxable supplies', 'Taxable Value': d3b.outwardSupplies.taxableValue, CGST: d3b.outwardSupplies.cgst, SGST: d3b.outwardSupplies.sgst, IGST: d3b.outwardSupplies.igst, Total: d3b.outwardSupplies.totalTax },
      { Section: '3.1(c) Nil-rated / exempt supplies', 'Taxable Value': d3b.nilRatedSupplies.taxableValue, CGST: 0, SGST: 0, IGST: 0, Total: 0 },
      { Section: '4(A) Eligible ITC', 'Taxable Value': '', CGST: d3b.itc.cgst, SGST: d3b.itc.sgst, IGST: d3b.itc.igst, Total: d3b.itc.totalItc },
      { Section: '6.1 Net tax payable (after ITC set-off)', 'Taxable Value': '', CGST: d3b.netPayable.cgst, SGST: d3b.netPayable.sgst, IGST: d3b.netPayable.igst, Total: d3b.netPayable.total },
      { Section: 'ITC carried forward', 'Taxable Value': '', CGST: d3b.itcCarriedForward.cgst, SGST: d3b.itcCarriedForward.sgst, IGST: d3b.itcCarriedForward.igst, Total: d3b.itcCarriedForward.total },
    ]);
  };
  const exportRecon = () => {
    downloadCSV(`gst-reconciliation-${fromDate}-to-${toDate}.csv`, [
      ...reconRows.map(r => ({
        Section: 'Heads', Head: r.head, Ledger: r.ledgerCode, Document: '', Date: '', Party: '',
        'Ledger Amount': r.ledgerAmount, 'Register Amount': r.registerAmount, Difference: r.difference, Reason: '',
      })),
      ...mismatchDocs.map(r => ({
        Section: r.docType === 'sale' ? 'Mismatch (Outward)' : 'Mismatch (Inward)',
        Head: '', Ledger: '', Document: r.documentNumber, Date: r.date, Party: r.partyName,
        'Ledger Amount': r.ledger.cgst + r.ledger.sgst + r.ledger.igst,
        'Register Amount': r.register.cgst + r.register.sgst + r.register.igst,
        Difference: r.differenceTotal, Reason: r.reason,
      })),
      ...otherEntries.map(r => ({
        Section: 'Other GST-Ledger Entries', Head: r.head, Ledger: r.ledgerCode,
        Document: r.voucherNumber ?? r.entryId, Date: r.date, Party: r.description,
        'Ledger Amount': r.amount, 'Register Amount': '', Difference: r.amount, Reason: '',
      })),
    ]);
  };

  // Drill-down: a mismatch row opens its source document, an "other entry"
  // opens the voucher that posted it. Same provenance-key mapping the ledger
  // statement and day book use.
  const openEntry = (entryId: string, source?: string | null) => {
    const t = resolveDrill(entryId, source);
    if (!t) return;
    if (t.kind === 'link') navigate(t.href);
    else toast.info(t.reason);
  };
  const openDoc = (d: GstReconMismatchDoc) => openEntry(`${d.docType}:${d.id}`, d.docType);

  // ── PDF / Excel documents (exactly the on-screen filtered rows) ─────────────
  const metaRows: [string, string][] = [['Scope', scopeText]];
  const hsnCols = [
    { label: 'Type' }, { label: 'HSN' }, { label: 'Rate' },
    { label: 'Qty', align: 'right' as const }, { label: 'Unit' },
    { label: 'Taxable', align: 'right' as const }, { label: 'CGST', align: 'right' as const },
    { label: 'SGST', align: 'right' as const }, { label: 'IGST', align: 'right' as const },
    { label: 'Total Tax', align: 'right' as const },
  ];
  const hsnRow = (r: HsnSummaryRow, type: string): (string | number)[] =>
    [type, r.hsnCode, `${r.taxRate}%`, r.quantity, r.unit, r.taxableValue, r.cgst, r.sgst, r.igst, r.taxAmount];
  const hsnDoc = (): ReportDoc => ({
    title: 'HSN Summary', subtitle: `${fromDate} to ${toDate}`, metaRows, orientation: 'landscape',
    filename: `hsn-summary-${fromDate}-to-${toDate}`,
    sections: [
      { heading: 'Outward Supplies (Sales)', columns: hsnCols, rows: (hsn.data?.outward ?? []).map(r => hsnRow(r, 'Outward')) },
      { heading: 'Inward Supplies (Purchases)', columns: hsnCols, rows: (hsn.data?.inward ?? []).map(r => hsnRow(r, 'Inward')) },
    ],
  });
  const gstr1Doc = (): ReportDoc => ({
    title: 'GSTR-1 Working', subtitle: `${fromDate} to ${toDate}`, metaRows, orientation: 'landscape',
    filename: `gstr1-${fromDate}-to-${toDate}`,
    sections: [
      {
        heading: 'B2B Invoices',
        columns: [
          { label: 'Invoice' }, { label: 'Date' }, { label: 'Customer' }, { label: 'GSTIN' },
          { label: 'Warehouse' }, { label: 'Rate' },
          { label: 'Taxable', align: 'right' as const }, { label: 'Tax', align: 'right' as const },
          { label: 'Invoice Value', align: 'right' as const },
          { label: 'Payment Status' }, { label: 'Payment Mode' },
        ],
        rows: b2b.map(r => [
          r.invoiceNumber, r.saleDate, r.customerName, r.gstin, r.warehouseName ?? '',
          `${r.taxRate}%`, r.taxableValue, r.taxAmount, r.invoiceValue,
          payStatusLabel(r.paymentStatus), r.paymentModes ?? '',
        ]),
      },
      {
        heading: 'B2C Invoices',
        columns: [
          { label: 'Invoice' }, { label: 'Date' }, { label: 'Customer' },
          { label: 'Warehouse' }, { label: 'Rate' },
          { label: 'Taxable', align: 'right' as const }, { label: 'Tax', align: 'right' as const },
          { label: 'Invoice Value', align: 'right' as const },
          { label: 'Payment Status' }, { label: 'Payment Mode' },
        ],
        rows: b2c.map(r => [
          r.invoiceNumber, r.saleDate, r.customerName, r.warehouseName ?? '',
          `${r.taxRate}%`, r.taxableValue, r.taxAmount, r.invoiceValue,
          payStatusLabel(r.paymentStatus), r.paymentModes ?? '',
        ]),
      },
      {
        heading: 'B2C Small (aggregated)',
        columns: [
          { label: 'Place of Supply' }, { label: 'Rate' },
          { label: 'Taxable', align: 'right' as const }, { label: 'CGST', align: 'right' as const },
          { label: 'SGST', align: 'right' as const }, { label: 'IGST', align: 'right' as const },
          { label: 'Total Tax', align: 'right' as const },
        ],
        rows: b2cs.map(r => [r.placeOfSupply || '—', `${r.taxRate}%`, r.taxableValue, r.cgst, r.sgst, r.igst, r.taxAmount]),
      },
    ],
    footerNote: 'Credit/debit notes are reported separately as vouchers and are not netted against GSTR-1 figures under the current rules.',
  });
  const gstr3bDoc = (): ReportDoc => ({
    title: 'GSTR-3B Working', subtitle: month, metaRows, filename: `gstr3b-${month}`,
    sections: [{
      columns: [
        { label: 'Section' }, { label: 'Taxable Value', align: 'right' as const },
        { label: 'CGST', align: 'right' as const }, { label: 'SGST', align: 'right' as const },
        { label: 'IGST', align: 'right' as const }, { label: 'Total', align: 'right' as const },
      ],
      rows: d3b ? [
        ['3.1(a) Outward taxable supplies', d3b.outwardSupplies.taxableValue, d3b.outwardSupplies.cgst, d3b.outwardSupplies.sgst, d3b.outwardSupplies.igst, d3b.outwardSupplies.totalTax],
        ['3.1(c) Nil-rated / exempt supplies', d3b.nilRatedSupplies.taxableValue, 0, 0, 0, 0],
        ['4(A) Eligible ITC', '', d3b.itc.cgst, d3b.itc.sgst, d3b.itc.igst, d3b.itc.totalItc],
        ['6.1 Net tax payable (after ITC set-off)', '', d3b.netPayable.cgst, d3b.netPayable.sgst, d3b.netPayable.igst, d3b.netPayable.total],
        ['ITC carried forward', '', d3b.itcCarriedForward.cgst, d3b.itcCarriedForward.sgst, d3b.itcCarriedForward.igst, d3b.itcCarriedForward.total],
      ] : [],
    }],
  });
  const reconDoc = (): ReportDoc => ({
    title: 'GST Reconciliation', subtitle: `${fromDate} to ${toDate}`,
    metaRows: [
      ['Scope', 'Company-wide (ledgers are not GSTIN-scoped)'],
      ['Documents checked', `${reconChecked?.sales ?? 0} sales, ${reconChecked?.purchases ?? 0} purchase bills`],
      ['Documents with differences', String(mismatchDocs.length)],
    ],
    filename: `gst-reconciliation-${fromDate}-to-${toDate}`,
    sections: [
      {
        heading: 'Tax Heads',
        columns: [
          { label: 'Head' }, { label: 'Ledger' },
          { label: 'Ledger Amount', align: 'right' as const },
          { label: 'Register Amount', align: 'right' as const },
          { label: 'Difference', align: 'right' as const },
        ],
        rows: reconRows.map(r => [r.head, r.ledgerCode, r.ledgerAmount, r.registerAmount, r.difference]),
      },
      ...(mismatchDocs.length ? [{
        heading: 'Documents with Differences',
        columns: [
          { label: 'Type' }, { label: 'Document' }, { label: 'Date' }, { label: 'Party' },
          { label: 'Register Tax', align: 'right' as const },
          { label: 'Ledger Tax', align: 'right' as const },
          { label: 'Difference', align: 'right' as const },
          { label: 'Reason' },
        ],
        rows: mismatchDocs.map(r => [
          r.docType === 'sale' ? 'Sale' : 'Purchase', r.documentNumber, r.date, r.partyName,
          r.register.cgst + r.register.sgst + r.register.igst,
          r.ledger.cgst + r.ledger.sgst + r.ledger.igst,
          r.differenceTotal, r.reason,
        ]),
      }] : []),
      ...(otherEntries.length ? [{
        heading: 'Other Postings on GST Ledgers (journal vouchers etc.)',
        columns: [
          { label: 'Date' }, { label: 'Source' }, { label: 'Voucher' },
          { label: 'Head' }, { label: 'Amount', align: 'right' as const }, { label: 'Description' },
        ],
        rows: otherEntries.map(r => [r.date, r.source, r.voucherNumber ?? r.entryId, r.head, r.amount, r.description]),
      }] : []),
    ],
  });

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="GST Returns"
          description="HSN summary, GSTR-1 and GSTR-3B working data, and ledger reconciliation"
          icon={FileSpreadsheet}
        />

        {tab !== 'gstr3b' && (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-muted-foreground">Period:</span>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
            <span className="text-muted-foreground">to</span>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
          </div>
        )}
        {tab !== 'recon' && <GstScopeFilter value={scope} onChange={setScope} />}
        {tab === 'recon' && (
          <p className="text-xs text-muted-foreground">
            Reconciliation compares the GST ledgers with the registers company-wide — ledger postings are not GSTIN-scoped, so the GST number filter does not apply here.
          </p>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="hsn">HSN Summary</TabsTrigger>
            <TabsTrigger value="gstr1">GSTR-1</TabsTrigger>
            <TabsTrigger value="gstr3b">GSTR-3B</TabsTrigger>
            <TabsTrigger value="recon">Reconciliation</TabsTrigger>
          </TabsList>

          {/* ── HSN Summary ─────────────────────────────────────────────── */}
          <TabsContent value="hsn" className="space-y-4 mt-4">
            <div className="flex justify-end">
              <ExportButtons onCSV={exportHsn} doc={hsnDoc} canDownload={perms.canDownload} disabled={hsn.isLoading} />
            </div>
            <HsnTable title="Outward Supplies (Sales)" rows={hsn.data?.outward ?? []} loading={hsn.isLoading} />
            <HsnTable title="Inward Supplies (Purchases)" rows={hsn.data?.inward ?? []} loading={hsn.isLoading} />
          </TabsContent>

          {/* ── GSTR-1 ──────────────────────────────────────────────────── */}
          <TabsContent value="gstr1" className="space-y-4 mt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex gap-2 flex-wrap">
                <Badge variant="secondary">{g1.data?.totals.invoiceCount ?? 0} invoices</Badge>
                <Badge variant="secondary">{g1.data?.totals.b2bInvoices ?? 0} B2B</Badge>
                <Badge variant="secondary">{g1.data?.totals.b2cInvoices ?? 0} B2C</Badge>
                <Badge variant="outline" className="font-mono">Tax: {fmt(g1.data?.totals.taxAmount ?? 0)}</Badge>
              </div>
              <ExportButtons onCSV={exportGstr1} doc={gstr1Doc} canDownload={perms.canDownload} disabled={g1.isLoading} />
            </div>

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border bg-muted/20">
                <h3 className="font-semibold text-sm">B2B Invoices (registered customers, rate-wise)</h3>
              </div>
              <div className="overflow-x-auto">
                {g1.isLoading ? (
                  <TableSkeleton rows={4} cols={14} />
                ) : b2b.length === 0 ? (
                  <EmptyState title="No B2B invoices in this period" compact />
                ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <SortableHead k="invoice" sort={b2bSort.sort}>Invoice</SortableHead>
                      <SortableHead k="date" sort={b2bSort.sort}>Date</SortableHead>
                      <SortableHead k="customer" sort={b2bSort.sort}>Customer</SortableHead>
                      <SortableHead k="gstin" sort={b2bSort.sort}>GSTIN</SortableHead>
                      <SortableHead k="pos" sort={b2bSort.sort}>POS</SortableHead>
                      <SortableHead k="warehouse" sort={b2bSort.sort}>Warehouse</SortableHead>
                      <SortableHead k="rate" sort={b2bSort.sort}>Rate</SortableHead>
                      <SortableHead k="taxable" sort={b2bSort.sort} className="text-right">Taxable</SortableHead>
                      <SortableHead k="cgst" sort={b2bSort.sort} className="text-right">CGST</SortableHead>
                      <SortableHead k="sgst" sort={b2bSort.sort} className="text-right">SGST</SortableHead>
                      <SortableHead k="igst" sort={b2bSort.sort} className="text-right">IGST</SortableHead>
                      <SortableHead k="invoiceValue" sort={b2bSort.sort} className="text-right">Invoice Value</SortableHead>
                      <SortableHead k="payStatus" sort={b2bSort.sort}>Payment Status</SortableHead>
                      <SortableHead k="payMode" sort={b2bSort.sort}>Payment Mode</SortableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {b2bSort.sorted.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/10">
                        <TableCell className="font-mono text-xs">{r.invoiceNumber}</TableCell>
                        <TableCell className="text-xs">{r.saleDate}</TableCell>
                        <TableCell className="text-xs">{r.customerName}</TableCell>
                        <TableCell className="font-mono text-xs">{r.gstin}</TableCell>
                        <TableCell className="text-xs">{r.placeOfSupply || '—'}</TableCell>
                        <TableCell className="text-xs">{r.warehouseName ?? '—'}</TableCell>
                        <TableCell><Badge variant="secondary">{r.taxRate}%</Badge></TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.taxableValue)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.cgst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.sgst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.igst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.invoiceValue)}</TableCell>
                        <TableCell><PaymentStatusBadge status={r.paymentStatus ?? 'unpaid'} /></TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{r.paymentModes ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                )}
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border bg-muted/20">
                <h3 className="font-semibold text-sm">B2C Invoices (unregistered customers, invoice-wise)</h3>
              </div>
              <div className="overflow-x-auto">
                {g1.isLoading ? (
                  <TableSkeleton rows={4} cols={13} />
                ) : b2c.length === 0 ? (
                  <EmptyState title="No B2C invoices in this period" compact />
                ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <SortableHead k="invoice" sort={b2cSort.sort}>Invoice</SortableHead>
                      <SortableHead k="date" sort={b2cSort.sort}>Date</SortableHead>
                      <SortableHead k="customer" sort={b2cSort.sort}>Customer</SortableHead>
                      <SortableHead k="pos" sort={b2cSort.sort}>POS</SortableHead>
                      <SortableHead k="warehouse" sort={b2cSort.sort}>Warehouse</SortableHead>
                      <SortableHead k="rate" sort={b2cSort.sort}>Rate</SortableHead>
                      <SortableHead k="taxable" sort={b2cSort.sort} className="text-right">Taxable</SortableHead>
                      <SortableHead k="cgst" sort={b2cSort.sort} className="text-right">CGST</SortableHead>
                      <SortableHead k="sgst" sort={b2cSort.sort} className="text-right">SGST</SortableHead>
                      <SortableHead k="igst" sort={b2cSort.sort} className="text-right">IGST</SortableHead>
                      <SortableHead k="invoiceValue" sort={b2cSort.sort} className="text-right">Invoice Value</SortableHead>
                      <SortableHead k="payStatus" sort={b2cSort.sort}>Payment Status</SortableHead>
                      <SortableHead k="payMode" sort={b2cSort.sort}>Payment Mode</SortableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {b2cSort.sorted.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/10">
                        <TableCell className="font-mono text-xs">{r.invoiceNumber}</TableCell>
                        <TableCell className="text-xs">{r.saleDate}</TableCell>
                        <TableCell className="text-xs">{r.customerName}</TableCell>
                        <TableCell className="text-xs">{r.placeOfSupply || '—'}</TableCell>
                        <TableCell className="text-xs">{r.warehouseName ?? '—'}</TableCell>
                        <TableCell><Badge variant="secondary">{r.taxRate}%</Badge></TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.taxableValue)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.cgst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.sgst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.igst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.invoiceValue)}</TableCell>
                        <TableCell><PaymentStatusBadge status={r.paymentStatus ?? 'unpaid'} /></TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{r.paymentModes ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                )}
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border bg-muted/20">
                <h3 className="font-semibold text-sm">B2C Small (unregistered, aggregated by place of supply & rate)</h3>
              </div>
              {g1.isLoading ? (
                <TableSkeleton rows={4} cols={7} />
              ) : b2cs.length === 0 ? (
                <EmptyState title="No B2C sales in this period" compact />
              ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/10">
                    <SortableHead k="pos" sort={b2csSort.sort}>Place of Supply</SortableHead>
                    <SortableHead k="rate" sort={b2csSort.sort}>Rate</SortableHead>
                    <SortableHead k="taxable" sort={b2csSort.sort} className="text-right">Taxable</SortableHead>
                    <SortableHead k="cgst" sort={b2csSort.sort} className="text-right">CGST</SortableHead>
                    <SortableHead k="sgst" sort={b2csSort.sort} className="text-right">SGST</SortableHead>
                    <SortableHead k="igst" sort={b2csSort.sort} className="text-right">IGST</SortableHead>
                    <SortableHead k="taxAmount" sort={b2csSort.sort} className="text-right">Total Tax</SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {b2csSort.sorted.map((r, i) => (
                    <TableRow key={i} className="hover:bg-muted/10">
                      <TableCell className="text-xs">{r.placeOfSupply || '—'}</TableCell>
                      <TableCell><Badge variant="secondary">{r.taxRate}%</Badge></TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.taxableValue)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.cgst)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.sgst)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.igst)}</TableCell>
                      <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.taxAmount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Credit/debit notes are reported separately as vouchers and are not netted against these GSTR-1 figures under the current rules.
            </p>
          </TabsContent>

          {/* ── GSTR-3B ─────────────────────────────────────────────────── */}
          <TabsContent value="gstr3b" className="space-y-4 mt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">Return month:</span>
                <Input type="month" value={month} onChange={e => setMonth(e.target.value)} className="w-44" />
              </div>
              {d3b && <ExportButtons onCSV={exportGstr3b} doc={gstr3bDoc} canDownload={perms.canDownload} disabled={g3b.isLoading} />}
            </div>

            {g3b.isLoading ? (
              <div className="h-40 bg-muted/30 rounded-xl animate-pulse" />
            ) : d3b ? (
              <>
                <div className="bg-card border border-border rounded-xl p-5">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">3.1(a) Outward Taxable Supplies — {monthLabel(d3b.month)}</p>
                      <p className="text-2xl font-bold font-mono mt-1">{fmt(d3b.outwardSupplies.taxableValue)}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Taxable value · {d3b.counts.sales} sales, {d3b.counts.purchases} purchases · Nil-rated: {fmt(d3b.nilRatedSupplies.taxableValue)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Output Tax</p>
                      <p className="text-2xl font-bold font-mono text-emerald-500 mt-1">{fmt(d3b.outwardSupplies.totalTax)}</p>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <Gstr3bCard title="3.1(a) Output Tax" heads={d3b.outwardSupplies} total={d3b.outwardSupplies.totalTax} totalLabel="Total" accent="text-emerald-500" />
                  <Gstr3bCard title="4(A) Eligible ITC" heads={d3b.itc} total={d3b.itc.totalItc} totalLabel="Total ITC" accent="text-primary" />
                  <Gstr3bCard title="6.1 Net Payable (cash)" heads={d3b.netPayable} total={d3b.netPayable.total} totalLabel="Payable" accent={d3b.netPayable.total > 0 ? 'text-red-500' : 'text-emerald-500'} />
                  <Gstr3bCard title="ITC Carried Forward" heads={d3b.itcCarriedForward} total={d3b.itcCarriedForward.total} totalLabel="Carry Fwd" accent="text-primary" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Net payable applies the standard ITC set-off order: IGST credit against IGST → CGST → SGST; CGST credit against CGST → IGST; SGST credit against SGST → IGST.
                </p>
              </>
            ) : (
              <div className="text-center py-12 text-muted-foreground text-sm">Pick a month to compute GSTR-3B</div>
            )}
          </TabsContent>

          {/* ── Reconciliation ──────────────────────────────────────────── */}
          <TabsContent value="recon" className="space-y-4 mt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              {recon.data && (
                recon.data.matched ? (
                  <Badge className="bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 border-0">
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Ledgers match registers
                  </Badge>
                ) : (
                  <Badge className="bg-amber-500/15 text-amber-600 hover:bg-amber-500/15 border-0">
                    <AlertTriangle className="w-3.5 h-3.5 mr-1" /> Differences found
                  </Badge>
                )
              )}
              <ExportButtons onCSV={exportRecon} doc={reconDoc} canDownload={perms.canDownload} disabled={recon.isLoading} />
            </div>

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              {recon.isLoading ? (
                <TableSkeleton rows={4} cols={5} />
              ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/10">
                    <SortableHead k="head" sort={reconSort.sort}>Tax Head</SortableHead>
                    <SortableHead k="ledger" sort={reconSort.sort}>Ledger</SortableHead>
                    <SortableHead k="ledgerAmount" sort={reconSort.sort} className="text-right">Ledger Balance</SortableHead>
                    <SortableHead k="registerAmount" sort={reconSort.sort} className="text-right">Register Total</SortableHead>
                    <SortableHead k="difference" sort={reconSort.sort} className="text-right">Difference</SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reconSort.sorted.map((r) => (
                    <TableRow key={r.ledgerCode} className="hover:bg-muted/10">
                      <TableCell className="text-sm font-medium">{r.head}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{r.ledgerCode}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.ledgerAmount)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.registerAmount)}</TableCell>
                      <TableCell className="text-right">
                        {Math.abs(r.difference) < 0.05 ? (
                          <Badge variant="secondary" className="font-mono text-emerald-600">0.00</Badge>
                        ) : (
                          <Badge className="bg-red-500/15 text-red-600 hover:bg-red-500/15 border-0 font-mono">{r.difference > 0 ? '+' : '−'}{fmt(r.difference)}</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              )}
            </div>

            {/* Explicit matched evidence — a clean state names what was checked. */}
            {recon.data?.matched && reconChecked && mismatchDocs.length === 0 && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 text-sm text-emerald-700 dark:text-emerald-400">
                <p className="font-medium flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  All {reconChecked.sales.toLocaleString('en-IN')} sales invoices and {reconChecked.purchases.toLocaleString('en-IN')} purchase bills reconcile with the GST ledgers
                </p>
                <p className="text-xs opacity-80 mt-1">
                  Every document's ledger postings were compared head-by-head against its register tax.
                  {otherEntries.length > 0 && ` ${otherEntries.length} journal posting${otherEntries.length === 1 ? '' : 's'} on the GST ledgers (listed below) ${otherEntries.length === 1 ? 'is' : 'are'} included in the ledger balances.`}
                </p>
              </div>
            )}

            {/* Bill-level mismatch drill-down */}
            {mismatchDocs.length > 0 && (
              <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
                <div className="p-4 border-b border-border bg-muted/20">
                  <h3 className="font-semibold text-sm">Documents with differences ({mismatchDocs.length} of {(reconChecked?.sales ?? 0) + (reconChecked?.purchases ?? 0)} checked)</h3>
                  <p className="text-xs text-muted-foreground mt-1">Each row is a bill whose ledger postings differ from its register tax. Click a row to open the document.</p>
                </div>
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <SortableHead k="type" sort={mismatchSort.sort}>Type</SortableHead>
                      <SortableHead k="doc" sort={mismatchSort.sort}>Document</SortableHead>
                      <SortableHead k="date" sort={mismatchSort.sort}>Date</SortableHead>
                      <SortableHead k="party" sort={mismatchSort.sort}>Party</SortableHead>
                      <SortableHead k="register" sort={mismatchSort.sort} className="text-right">Register Tax</SortableHead>
                      <SortableHead k="ledger" sort={mismatchSort.sort} className="text-right">Ledger Tax</SortableHead>
                      <SortableHead k="diff" sort={mismatchSort.sort} className="text-right">Difference</SortableHead>
                      <SortableHead k="reason" sort={mismatchSort.sort}>Why</SortableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mismatchSort.sorted.map((r) => (
                      <TableRow
                        key={`${r.docType}:${r.id}`}
                        className="hover:bg-muted/10 cursor-pointer"
                        title={r.docType === 'sale' ? 'Open sale invoice' : 'Open purchase bill'}
                        onClick={() => openDoc(r)}
                      >
                        <TableCell>
                          <Badge variant="secondary">{r.docType === 'sale' ? 'Sale' : 'Purchase'}</Badge>
                          {r.cancelled && <Badge className="ml-1 bg-red-500/15 text-red-600 hover:bg-red-500/15 border-0">Cancelled</Badge>}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-primary font-semibold">{r.documentNumber}</TableCell>
                        <TableCell className="text-xs">{r.date}</TableCell>
                        <TableCell className="text-xs">{r.partyName || '—'}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.register.cgst + r.register.sgst + r.register.igst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.ledger.cgst + r.ledger.sgst + r.ledger.igst)}</TableCell>
                        <TableCell className="text-right">
                          <Badge className="bg-red-500/15 text-red-600 hover:bg-red-500/15 border-0 font-mono">{r.differenceTotal > 0 ? '+' : '−'}{fmt(r.differenceTotal)}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-72">{r.reason}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              </div>
            )}

            {/* Non-document postings on the GST ledgers */}
            {otherEntries.length > 0 && (
              <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
                <div className="p-4 border-b border-border bg-muted/20">
                  <h3 className="font-semibold text-sm">Other postings on GST ledgers ({otherEntries.length})</h3>
                  <p className="text-xs text-muted-foreground mt-1">Journal vouchers and other entries with no register document — they move the ledger side of the comparison. Click a row to open the voucher.</p>
                </div>
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <SortableHead k="date" sort={otherSort.sort}>Date</SortableHead>
                      <SortableHead k="source" sort={otherSort.sort}>Source</SortableHead>
                      <SortableHead k="voucher" sort={otherSort.sort}>Voucher</SortableHead>
                      <SortableHead k="head" sort={otherSort.sort}>Tax Head</SortableHead>
                      <SortableHead k="amount" sort={otherSort.sort} className="text-right">Amount</SortableHead>
                      <TableHead>Description</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {otherSort.sorted.map((r, i) => {
                      const drill = resolveDrill(r.entryId, r.source);
                      return (
                        <TableRow
                          key={`${r.entryId}|${r.ledgerCode}|${i}`}
                          className={`hover:bg-muted/10 ${drill ? 'cursor-pointer' : ''}`}
                          title={drill ? (drill.kind === 'link' ? drill.label : 'No document — click for details') : undefined}
                          onClick={() => openEntry(r.entryId, r.source)}
                        >
                          <TableCell className="text-xs">{r.date}</TableCell>
                          <TableCell><Badge variant="secondary">{r.source}</Badge></TableCell>
                          <TableCell className="font-mono text-xs text-primary font-semibold">{r.voucherNumber ?? '—'}</TableCell>
                          <TableCell className="text-xs">{r.head}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{r.amount < 0 ? `−${fmt(r.amount)}` : fmt(r.amount)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-96 truncate">{r.description}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                </div>
              </div>
            )}

            {recon.data && (Math.abs(recon.data.dtxDirect) > 0.004 || Math.abs(recon.data.salesLumpResidual) > 0.004) && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm text-amber-700 dark:text-amber-400">
                <p className="font-medium mb-1">Legacy Duty & Tax lump: {fmt(recon.data.dtxDirect)}</p>
                <p className="text-xs opacity-80">{recon.data.note}</p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
