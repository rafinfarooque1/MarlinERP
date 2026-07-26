/**
 * Purchase reports — Register, By Vendor, By Material.
 */
import { useState } from 'react';
import {
  usePurchaseRegister, usePurchasesByVendor, usePurchasesByMaterial, useListVendors,
} from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { downloadCSV } from '@/lib/download';
import {
  fmt, num, pdfMoney, fmtDate, periodLabel,
  useDateRange, RangeBar, ReportPicker, SummaryCards, RTable, ExportButtons, exportReportPdf,
  type RangeState, type Col,
} from '../shared';

type PurchaseReport = 'register' | 'byVendor' | 'byMaterial';

// ── Register ──────────────────────────────────────────────────────────────────
function RegisterReport({ range }: { range: RangeState }) {
  const [vendor, setVendor] = useState('all');
  const { data: vendors = [] } = useListVendors();
  const { data, isLoading } = usePurchaseRegister({
    from: range.from || undefined,
    to: range.to || undefined,
    vendorId: vendor === 'all' ? undefined : Number(vendor),
  });
  const rows = data?.rows ?? [];
  const t = data?.totals;
  const vendorLabel = vendor === 'all' ? 'All vendors' : (vendors as any[]).find((v) => String(v.id) === vendor)?.name ?? vendor;

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <Select value={vendor} onValueChange={setVendor}>
          <SelectTrigger className="h-8 text-xs w-48"><SelectValue placeholder="All vendors" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All vendors</SelectItem>
            {(vendors as any[]).map((v) => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <ExportButtons
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('purchase-register.csv', rows.map((r) => ({
            'Bill No': r.billNumber, Date: r.date, Vendor: r.vendorName,
            'Taxable (₹)': r.subtotal.toFixed(2), 'Discount (₹)': r.discount.toFixed(2),
            'Tax (₹)': r.tax.toFixed(2), 'Total (₹)': r.total.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Purchase Register',
            subtitle: `Period: ${periodLabel(range.from, range.to)}   |   Vendor: ${vendorLabel}`,
            metaRows: [['Period', periodLabel(range.from, range.to)], ['Vendor', vendorLabel], ['Bills', String(t?.bills ?? 0)]],
            sections: [{
              columns: [
                { label: 'Bill No', width: 1.4 }, { label: 'Date' }, { label: 'Vendor', width: 2 },
                { label: 'Taxable', align: 'right', width: 1.3 }, { label: 'Discount', align: 'right' },
                { label: 'Tax', align: 'right', width: 1.1 }, { label: 'Total', align: 'right', width: 1.3 },
              ],
              rows: rows.map((r) => [r.billNumber, fmtDate(r.date), r.vendorName, pdfMoney(r.subtotal),
                pdfMoney(r.discount), pdfMoney(r.tax), pdfMoney(r.total)]),
              totalsRow: ['TOTAL', '', '', pdfMoney(t?.subtotal), pdfMoney(t?.discount), pdfMoney(t?.tax), pdfMoney(t?.total)],
            }],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Bills', value: t?.bills ?? 0 },
        { label: 'Taxable Value', value: fmt(t?.subtotal) },
        { label: 'Tax (ITC)', value: fmt(t?.tax), tone: 'accent' },
        { label: 'Total Purchases', value: fmt(t?.total), tone: 'warn' },
      ]} />

      <RTable
        cols={[
          { key: 'billNumber', label: 'Bill No', render: (r) => <span className="font-mono text-xs text-primary font-bold">{r.billNumber}</span> },
          { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
          { key: 'vendorName', label: 'Vendor', render: (r) => <span className="font-medium">{r.vendorName}</span> },
          { key: 'subtotal', label: 'Taxable', align: 'right', render: (r) => fmt(r.subtotal) },
          { key: 'discount', label: 'Discount', align: 'right', render: (r) => fmt(r.discount) },
          { key: 'tax', label: 'Tax', align: 'right', render: (r) => fmt(r.tax) },
          { key: 'total', label: 'Total', align: 'right', render: (r) => <b>{fmt(r.total)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.id}
        footer={['TOTAL', '', '', fmt(t?.subtotal), fmt(t?.discount), fmt(t?.tax), fmt(t?.total)]}
      />
    </div>
  );
}

// ── By vendor ─────────────────────────────────────────────────────────────────
function ByVendorReport({ range }: { range: RangeState }) {
  const { data, isLoading } = usePurchasesByVendor({ from: range.from || undefined, to: range.to || undefined });
  const rows = data?.rows ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('purchases-by-vendor.csv', rows.map((r) => ({
            Vendor: r.vendorName, Bills: r.bills, 'Taxable (₹)': r.taxable.toFixed(2),
            'Tax (₹)': r.tax.toFixed(2), 'Total (₹)': r.total.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Purchases by Vendor',
            subtitle: `Period: ${periodLabel(range.from, range.to)}`,
            metaRows: [['Period', periodLabel(range.from, range.to)], ['Vendors', String(t?.vendors ?? 0)]],
            sections: [{
              columns: [
                { label: 'Vendor', width: 2.6 }, { label: 'Bills', align: 'center' },
                { label: 'Taxable', align: 'right', width: 1.4 }, { label: 'Tax', align: 'right', width: 1.2 },
                { label: 'Total', align: 'right', width: 1.4 },
              ],
              rows: rows.map((r) => [r.vendorName, r.bills, pdfMoney(r.taxable), pdfMoney(r.tax), pdfMoney(r.total)]),
              totalsRow: ['TOTAL', t?.bills ?? 0, pdfMoney(t?.taxable), pdfMoney(t?.tax), pdfMoney(t?.total)],
            }],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Vendors', value: t?.vendors ?? 0 },
        { label: 'Bills', value: t?.bills ?? 0 },
        { label: 'Tax (ITC)', value: fmt(t?.tax), tone: 'accent' },
        { label: 'Total Purchases', value: fmt(t?.total), tone: 'warn' },
      ]} />

      <RTable
        cols={[
          { key: 'vendorName', label: 'Vendor', render: (r) => <span className="font-medium">{r.vendorName}</span> },
          { key: 'bills', label: 'Bills', align: 'center' },
          { key: 'taxable', label: 'Taxable', align: 'right', render: (r) => fmt(r.taxable) },
          { key: 'tax', label: 'Tax', align: 'right', render: (r) => fmt(r.tax) },
          { key: 'total', label: 'Total', align: 'right', render: (r) => <b>{fmt(r.total)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.vendorId ?? -1}
        footer={['TOTAL', t?.bills ?? 0, fmt(t?.taxable), fmt(t?.tax), fmt(t?.total)]}
      />
    </div>
  );
}

// ── By material ───────────────────────────────────────────────────────────────
function ByMaterialReport({ range }: { range: RangeState }) {
  const { data, isLoading } = usePurchasesByMaterial({ from: range.from || undefined, to: range.to || undefined });
  const rows = data?.rows ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('purchases-by-material.csv', rows.map((r) => ({
            Material: r.materialName, Category: r.materialTypeLabel, Unit: r.unit, Bills: r.bills, Qty: r.qty,
            'Taxable (₹)': r.taxable.toFixed(2), 'Tax (₹)': r.tax.toFixed(2), 'Total (₹)': r.total.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Purchases by Material',
            subtitle: `Period: ${periodLabel(range.from, range.to)}`,
            metaRows: [['Period', periodLabel(range.from, range.to)], ['Materials', String(t?.materials ?? 0)]],
            sections: [{
              columns: [
                { label: 'Material', width: 2.2 }, { label: 'Category', width: 1.2 }, { label: 'Unit' },
                { label: 'Bills', align: 'center' }, { label: 'Qty', align: 'right' },
                { label: 'Taxable', align: 'right', width: 1.3 }, { label: 'Tax', align: 'right', width: 1.1 },
                { label: 'Total', align: 'right', width: 1.3 },
              ],
              rows: rows.map((r) => [r.materialName, r.materialTypeLabel, r.unit, r.bills, num(r.qty),
                pdfMoney(r.taxable), pdfMoney(r.tax), pdfMoney(r.total)]),
              totalsRow: ['TOTAL', '', '', '', '', pdfMoney(t?.taxable), pdfMoney(t?.tax), pdfMoney(t?.total)],
            }],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Materials', value: t?.materials ?? 0 },
        { label: 'Taxable Value', value: fmt(t?.taxable) },
        { label: 'Tax (ITC)', value: fmt(t?.tax), tone: 'accent' },
        { label: 'Total', value: fmt(t?.total), tone: 'warn' },
      ]} />

      <RTable
        cols={[
          { key: 'materialName', label: 'Material', render: (r) => <span className="font-medium">{r.materialName}</span> },
          { key: 'materialTypeLabel', label: 'Category', render: (r) => <Badge variant="outline" className="text-[10px]">{r.materialTypeLabel}</Badge> },
          { key: 'unit', label: 'Unit' },
          { key: 'bills', label: 'Bills', align: 'center' },
          { key: 'qty', label: 'Qty', align: 'right', render: (r) => num(r.qty) },
          { key: 'taxable', label: 'Taxable', align: 'right', render: (r) => fmt(r.taxable) },
          { key: 'tax', label: 'Tax', align: 'right', render: (r) => fmt(r.tax) },
          { key: 'total', label: 'Total', align: 'right', render: (r) => <b>{fmt(r.total)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => `${r.materialType}:${r.materialId}`}
        footer={['TOTAL', '', '', '', '', fmt(t?.taxable), fmt(t?.tax), fmt(t?.total)]}
      />
    </div>
  );
}

// ── Section root ──────────────────────────────────────────────────────────────
export default function PurchasesSection() {
  const range = useDateRange('month');
  const [report, setReport] = useState<PurchaseReport>('register');
  return (
    <div className="space-y-4">
      <ReportPicker
        options={[
          { value: 'register', label: 'Purchase Register' },
          { value: 'byVendor', label: 'By Vendor' },
          { value: 'byMaterial', label: 'By Material' },
        ]}
        value={report} onChange={setReport}
      />
      {report === 'register' && <RegisterReport range={range} />}
      {report === 'byVendor' && <ByVendorReport range={range} />}
      {report === 'byMaterial' && <ByMaterialReport range={range} />}
    </div>
  );
}
