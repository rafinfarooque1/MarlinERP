/**
 * Purchase reports — Register, By Vendor, By Material.
 */
import { useState } from 'react';
import {
  usePurchaseRegister, usePurchasesByVendor, usePurchasesByMaterial, useListVendors,
} from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { downloadCSV } from '@/lib/download';
import {
  fmt, num, pdfMoney, fmtDate, periodLabel,
  useDateRange, RangeBar, ReportPicker, SummaryCards, RTable, ExportButtons, exportReportPdf,
  type RangeState, type Col,
} from '../shared';

type PurchaseReport = 'register' | 'byVendor' | 'byMaterial';

// ── Register ──────────────────────────────────────────────────────────────────
function RegisterReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const [vendor, setVendor] = useState('all');
  const { data: vendors = [] } = useListVendors();
  const { data, isLoading } = usePurchaseRegister({
    from: range.from || undefined,
    to: range.to || undefined,
    vendorId: vendor === 'all' ? undefined : Number(vendor),
  });
  // Backend adds gross / inputGst / net (recoverable input GST split out, so
  // net purchases ties to the P&L). Access them loosely — the shared client
  // type still lists only the legacy tax/total fields.
  const rows = (data?.rows ?? []) as Array<{
    id: number; billNumber: string; date: string; vendorName: string;
    subtotal: number; discount: number; tax: number; total: number;
    gross?: number; inputGst?: number; net?: number;
  }>;
  const t = data?.totals as (undefined | {
    bills: number; subtotal: number; discount: number; tax: number; total: number;
    gross?: number; inputGst?: number; net?: number;
  });
  const reconciliation = (data as any)?.reconciliation as string | undefined;
  const g = (r: { gross?: number; total: number }) => r.gross ?? r.total;
  const ig = (r: { inputGst?: number; tax: number }) => r.inputGst ?? r.tax;
  const nt = (r: { net?: number; total: number; tax: number }) => r.net ?? (r.total - r.tax);
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
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('purchase-register.csv', rows.map((r) => ({
            'Bill No': r.billNumber, Date: r.date, Vendor: r.vendorName,
            'Taxable (₹)': r.subtotal.toFixed(2), 'Discount (₹)': r.discount.toFixed(2),
            'Gross (₹)': g(r).toFixed(2), 'Input GST (₹)': ig(r).toFixed(2), 'Net (₹)': nt(r).toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Purchase Register',
            subtitle: `Period: ${periodLabel(range.from, range.to)}   |   Vendor: ${vendorLabel}`,
            metaRows: [['Period', periodLabel(range.from, range.to)], ['Vendor', vendorLabel], ['Bills', String(t?.bills ?? 0)]],
            sections: [{
              columns: [
                { label: 'Bill No', width: 1.4 }, { label: 'Date' }, { label: 'Vendor', width: 2 },
                { label: 'Gross', align: 'right', width: 1.3 }, { label: 'Input GST', align: 'right', width: 1.1 },
                { label: 'Net', align: 'right', width: 1.3 },
              ],
              rows: rows.map((r) => [r.billNumber, fmtDate(r.date), r.vendorName,
                pdfMoney(g(r)), pdfMoney(ig(r)), pdfMoney(nt(r))]),
              totalsRow: ['TOTAL', '', '', pdfMoney(t?.gross ?? t?.total), pdfMoney(t?.inputGst ?? t?.tax), pdfMoney(t?.net ?? ((t?.total ?? 0) - (t?.tax ?? 0)))],
            }],
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Bills', value: t?.bills ?? 0 },
        { label: 'Gross Invoice', value: fmt(t?.gross ?? t?.total), tone: 'warn' },
        { label: 'Input GST (ITC)', value: fmt(t?.inputGst ?? t?.tax), tone: 'accent' },
        { label: 'Net Purchases', value: fmt(t?.net ?? ((t?.total ?? 0) - (t?.tax ?? 0))) },
      ]} />

      <RTable
        cols={[
          { key: 'billNumber', label: 'Bill No', render: (r) => <span className="font-mono text-xs text-primary font-bold">{r.billNumber}</span> },
          { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
          { key: 'vendorName', label: 'Vendor', render: (r) => <span className="font-medium">{r.vendorName}</span> },
          { key: 'gross', label: 'Gross', align: 'right', render: (r) => fmt(g(r)) },
          { key: 'inputGst', label: 'Input GST', align: 'right', render: (r) => fmt(ig(r)) },
          { key: 'net', label: 'Net', align: 'right', render: (r) => <b>{fmt(nt(r))}</b> },
        ] as Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.id}
        footer={['TOTAL', '', '', fmt(t?.gross ?? t?.total), fmt(t?.inputGst ?? t?.tax), fmt(t?.net ?? ((t?.total ?? 0) - (t?.tax ?? 0)))]}
      />

      <p className="text-xs text-muted-foreground">
        {reconciliation ?? 'Gross − Input GST = Net purchases (agrees with the P&L Purchases line, before any journal-voucher adjustments).'}
      </p>
    </div>
  );
}

// ── By vendor ─────────────────────────────────────────────────────────────────
function ByVendorReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const { data, isLoading } = usePurchasesByVendor({ from: range.from || undefined, to: range.to || undefined });
  const rows = data?.rows ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          canDownload={canDownload}
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
function ByMaterialReport({ range, canDownload }: { range: RangeState; canDownload: boolean }) {
  const { data, isLoading } = usePurchasesByMaterial({ from: range.from || undefined, to: range.to || undefined });
  const rows = data?.rows ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <ExportButtons
          canDownload={canDownload}
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
  const { canDownload } = usePermission('page:/reports/sales');
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
      {report === 'register' && <RegisterReport range={range} canDownload={canDownload} />}
      {report === 'byVendor' && <ByVendorReport range={range} canDownload={canDownload} />}
      {report === 'byMaterial' && <ByMaterialReport range={range} canDownload={canDownload} />}
    </div>
  );
}
