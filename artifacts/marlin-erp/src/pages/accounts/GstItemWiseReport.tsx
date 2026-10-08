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

export const GST_ITEMWISE_PDF_COLUMNS: PdfCol[] = [
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

export function gstItemWiseCsvRow(row: GstItemWiseRow, outward: boolean) {
  return {
    Date: formatDateOrDash(row.date),
    'Inv no': outward
      ? formatSalesInvoiceDisplayNumber(row.documentNumber || '—')
      : row.documentNumber || '—',
    Party: row.partyName || '—',
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
  };
}

export function gstItemWisePdfRow(row: GstItemWiseRow, outward: boolean): (string | number)[] {
  return [
    formatDateOrDash(row.date),
    outward ? formatSalesInvoiceDisplayNumber(row.documentNumber || '—') : row.documentNumber || '—',
    row.partyName || '—',
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
  });
  const { pageRows, pagerProps } = useClientPage(sorted);

  return (
    <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center justify-between gap-3">
        <h3 className="font-semibold flex items-center gap-2">
          <FileText className="w-4 h-4 text-primary" /> {title}
        </h3>
        {!loading && <span className="text-xs text-muted-foreground">{rows.length.toLocaleString('en-IN')} lines</span>}
      </div>
      <div className="overflow-x-auto">
        {loading ? (
          <TableSkeleton rows={5} cols={15} />
        ) : rows.length === 0 ? (
          <EmptyState icon={FileText} title="No item lines in this period" compact />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="doc" sort={sort}>Inv no</SortableHead>
                <SortableHead k="party" sort={sort}>Party</SortableHead>
                <SortableHead k="gstin" sort={sort}>GST no</SortableHead>
                <SortableHead k="state" sort={sort}>State</SortableHead>
                <SortableHead k="stateCode" sort={sort}>State code</SortableHead>
                <SortableHead k="item" sort={sort}>Item name</SortableHead>
                <SortableHead k="hsn" sort={sort}>HSN</SortableHead>
                <SortableHead k="quantity" sort={sort} className="text-right">Qty</SortableHead>
                <SortableHead k="unit" sort={sort}>Unit</SortableHead>
                <SortableHead k="taxable" sort={sort} className="text-right">Taxable amount</SortableHead>
                <SortableHead k="cgst" sort={sort} className="text-right">CGST</SortableHead>
                <SortableHead k="sgst" sort={sort} className="text-right">SGST</SortableHead>
                <SortableHead k="igst" sort={sort} className="text-right">IGST</SortableHead>
                <SortableHead k="total" sort={sort} className="text-right">Total invoice amount</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row, index) => (
                <TableRow key={`${row.date}-${row.documentNumber}-${index}`} className="hover:bg-muted/10">
                  <TableCell className="text-xs whitespace-nowrap">{formatDateOrDash(row.date)}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    {outward
                      ? formatSalesInvoiceDisplayNumber(row.documentNumber || '—')
                      : row.documentNumber || '—'}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{row.partyName || '—'}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{row.partyGstin || '—'}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{row.state || '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{row.stateCode || '—'}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{row.itemName || '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{row.hsnCode || '—'}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{quantity(row.quantity)}</TableCell>
                  <TableCell className="text-xs">{row.unit || '—'}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{money(row.taxableAmount)}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{money(row.cgst)}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{money(row.sgst)}</TableCell>
                  <TableCell className="text-right font-mono text-xs whitespace-nowrap">{money(row.igst)}</TableCell>
                  <TableCell className="text-right font-mono text-xs font-bold whitespace-nowrap">{money(row.invoiceValue)}</TableCell>
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
