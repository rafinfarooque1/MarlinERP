import { FileText } from 'lucide-react';
import type { GstItemWiseRow } from '@workspace/api-client-react';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { TablePager, useClientPage } from '@/components/ui/table-pager';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { formatDateOrDash } from '@/lib/date';
import { formatSalesInvoiceDisplayNumber } from '@/lib/invoiceNumber';
import type { PdfCol } from '@/pages/reports/shared';

const money = (value: number) =>
  `₹${Math.abs(Number(value) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const quantity = (value: number) =>
  Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const GST_ITEMWISE_BASE_PDF_COLUMNS: PdfCol[] = [
  { label: 'Date' },
  { label: 'Inv no' },
  { label: 'Party' },
  { label: 'GST no' },
  { label: 'State' },
  { label: 'State code' },
  { label: 'Item name' },
  { label: 'HSN' },
  { label: 'Qty', align: 'right' },
  { label: 'Unit' },
  { label: 'Taxable amount', align: 'right' },
  { label: 'CGST', align: 'right' },
  { label: 'SGST', align: 'right' },
  { label: 'IGST', align: 'right' },
  { label: 'Total invoice amount', align: 'right' },
];

export const GST_ITEMWISE_OUTWARD_PDF_COLUMNS: PdfCol[] = [
  ...GST_ITEMWISE_BASE_PDF_COLUMNS.slice(0, 3),
  { label: 'Salesperson' },
  ...GST_ITEMWISE_BASE_PDF_COLUMNS.slice(3),
  { label: 'Amount received', align: 'right' },
  { label: 'Balance due', align: 'right' },
];

export const GST_ITEMWISE_INWARD_PDF_COLUMNS = GST_ITEMWISE_BASE_PDF_COLUMNS;

export function gstItemWiseCsvRow(row: GstItemWiseRow, outward: boolean) {
  return {
    Date: formatDateOrDash(row.date),
    'Inv no': outward
      ? formatSalesInvoiceDisplayNumber(row.documentNumber || '—')
      : row.documentNumber || '—',
    Party: row.partyName || '—',
    ...(outward ? { Salesperson: row.salesperson || 'Unassigned' } : {}),
    'GST no': row.partyGstin || '—',
    State: row.state || '—',
    'State code': row.stateCode || '—',
    'Item name': row.itemName || '—',
    HSN: row.hsnCode || '—',
    Qty: row.quantity,
    Unit: row.unit || '—',
    'Taxable amount': row.taxableAmount,
    CGST: row.cgst,
    SGST: row.sgst,
    IGST: row.igst,
    'Total invoice amount': row.invoiceValue,
    ...(outward ? {
      'Amount received': row.amountReceived ?? 0,
      'Balance due': row.balanceDue ?? 0,
    } : {}),
  };
}

export function gstItemWisePdfRow(row: GstItemWiseRow, outward: boolean): (string | number)[] {
  return [
    formatDateOrDash(row.date),
    outward ? formatSalesInvoiceDisplayNumber(row.documentNumber || '—') : row.documentNumber || '—',
    row.partyName || '—',
    ...(outward ? [row.salesperson || 'Unassigned'] : []),
    row.partyGstin || '—',
    row.state || '—',
    row.stateCode || '—',
    row.itemName || '—',
    row.hsnCode || '—',
    row.quantity,
    row.unit || '—',
    row.taxableAmount,
    row.cgst,
    row.sgst,
    row.igst,
    row.invoiceValue,
    ...(outward ? [row.amountReceived ?? 0, row.balanceDue ?? 0] : []),
  ];
}

export function GstItemWiseTable({ title, rows, loading, outward }: {
  title: string;
  rows: GstItemWiseRow[];
  loading: boolean;
  outward: boolean;
}) {
  const { sorted, sort } = useTableSort(rows, {
    date: row => row.date,
    doc: row => row.documentNumber,
    party: row => row.partyName,
    salesperson: row => row.salesperson || 'Unassigned',
    gstin: row => row.partyGstin,
    state: row => row.state,
    stateCode: row => row.stateCode,
    item: row => row.itemName,
    hsn: row => row.hsnCode,
    quantity: row => Number(row.quantity),
    unit: row => row.unit,
    taxable: row => Number(row.taxableAmount),
    cgst: row => Number(row.cgst),
    sgst: row => Number(row.sgst),
    igst: row => Number(row.igst),
    total: row => Number(row.invoiceValue),
    amountReceived: row => Number(row.amountReceived ?? 0),
    balanceDue: row => Number(row.balanceDue ?? 0),
  });
  const { pageRows, pagerProps } = useClientPage(sorted, 25);
  const compactHead = 'h-8 px-1.5 text-[11px]';
  const compactCell = 'px-1.5 py-1 text-[11px]';

  return (
    <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-muted/20 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary shrink-0" /> {title}
          </h3>
          {outward && rows.length > 0 && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Received and due amounts repeat for each invoice item line.
            </p>
          )}
        </div>
        {!loading && <span className="text-[11px] text-muted-foreground">{rows.length.toLocaleString('en-IN')} lines</span>}
      </div>
      <div className="max-w-full">
        {loading ? (
          <TableSkeleton rows={4} cols={outward ? 18 : 15} />
        ) : rows.length === 0 ? (
          <EmptyState icon={FileText} title="No item lines in this period" compact />
        ) : (
          <Table className="w-max min-w-full text-xs">
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="date" sort={sort} className={compactHead}>Date</SortableHead>
                <SortableHead k="doc" sort={sort} className={compactHead}>Inv no</SortableHead>
                <SortableHead k="party" sort={sort} className={compactHead}>Party</SortableHead>
                {outward && <SortableHead k="salesperson" sort={sort} className={compactHead}>Salesperson</SortableHead>}
                <SortableHead k="gstin" sort={sort} className={compactHead}>GST no</SortableHead>
                <SortableHead k="state" sort={sort} className={compactHead}>State</SortableHead>
                <SortableHead k="stateCode" sort={sort} className={compactHead}>State code</SortableHead>
                <SortableHead k="item" sort={sort} className={compactHead}>Item name</SortableHead>
                <SortableHead k="hsn" sort={sort} className={compactHead}>HSN</SortableHead>
                <SortableHead k="quantity" sort={sort} className={`${compactHead} text-right`}>Qty</SortableHead>
                <SortableHead k="unit" sort={sort} className={compactHead}>Unit</SortableHead>
                <SortableHead k="taxable" sort={sort} className={`${compactHead} text-right`}>Taxable amount</SortableHead>
                <SortableHead k="cgst" sort={sort} className={`${compactHead} text-right`}>CGST</SortableHead>
                <SortableHead k="sgst" sort={sort} className={`${compactHead} text-right`}>SGST</SortableHead>
                <SortableHead k="igst" sort={sort} className={`${compactHead} text-right`}>IGST</SortableHead>
                <SortableHead k="total" sort={sort} className={`${compactHead} text-right`}>Total invoice amount</SortableHead>
                {outward && <SortableHead k="amountReceived" sort={sort} className={`${compactHead} text-right`}>Amount received</SortableHead>}
                {outward && <SortableHead k="balanceDue" sort={sort} className={`${compactHead} text-right`}>Balance due</SortableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row, index) => (
                <TableRow key={`${row.date}-${row.documentNumber}-${index}`} className="h-8 hover:bg-muted/10">
                  <TableCell className={`${compactCell} whitespace-nowrap`}>{formatDateOrDash(row.date)}</TableCell>
                  <TableCell className={`${compactCell} font-mono whitespace-nowrap`}>
                    {outward
                      ? formatSalesInvoiceDisplayNumber(row.documentNumber || '—')
                      : row.documentNumber || '—'}
                  </TableCell>
                  <TableCell className={`${compactCell} whitespace-nowrap`}>{row.partyName || '—'}</TableCell>
                  {outward && <TableCell className={`${compactCell} whitespace-nowrap`}>{row.salesperson || 'Unassigned'}</TableCell>}
                  <TableCell className={`${compactCell} font-mono whitespace-nowrap`}>{row.partyGstin || '—'}</TableCell>
                  <TableCell className={`${compactCell} whitespace-nowrap`}>{row.state || '—'}</TableCell>
                  <TableCell className={`${compactCell} font-mono`}>{row.stateCode || '—'}</TableCell>
                  <TableCell className={`${compactCell} whitespace-nowrap`}>{row.itemName || '—'}</TableCell>
                  <TableCell className={`${compactCell} font-mono`}>{row.hsnCode || '—'}</TableCell>
                  <TableCell className={`${compactCell} text-right font-mono`}>{quantity(row.quantity)}</TableCell>
                  <TableCell className={compactCell}>{row.unit || '—'}</TableCell>
                  <TableCell className={`${compactCell} text-right font-mono whitespace-nowrap`}>{money(row.taxableAmount)}</TableCell>
                  <TableCell className={`${compactCell} text-right font-mono whitespace-nowrap`}>{money(row.cgst)}</TableCell>
                  <TableCell className={`${compactCell} text-right font-mono whitespace-nowrap`}>{money(row.sgst)}</TableCell>
                  <TableCell className={`${compactCell} text-right font-mono whitespace-nowrap`}>{money(row.igst)}</TableCell>
                  <TableCell className={`${compactCell} text-right font-mono font-bold whitespace-nowrap`}>{money(row.invoiceValue)}</TableCell>
                  {outward && <TableCell className={`${compactCell} text-right font-mono whitespace-nowrap`}>{money(row.amountReceived ?? 0)}</TableCell>}
                  {outward && <TableCell className={`${compactCell} text-right font-mono whitespace-nowrap`}>{money(row.balanceDue ?? 0)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {!loading && rows.length > 25 && <div className="px-4 py-2"><TablePager {...pagerProps} /></div>}
    </section>
  );
}
