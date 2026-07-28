/**
 * Production reports — output by item, material consumption, batch costs, wastage.
 * Reuses the /api/productions/reports aggregation endpoint.
 */
import { useState } from 'react';
import { useProductionReports } from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import { downloadCSV } from '@/lib/download';
import {
  fmt, num, pdfMoney, fmtDate, periodLabel,
  useDateRange, RangeBar, ReportPicker, SummaryCards, RTable, ExportButtons, exportReportPdf,
  type Col,
} from '../shared';

type ProdReport = 'output' | 'consumption' | 'batches' | 'wastage';

const money = (n: number | null) => (n === null || n === undefined ? '—' : fmt(n));
const pdfM = (n: number | null) => (n === null || n === undefined ? '-' : pdfMoney(n));

export default function ProductionSection() {
  const { canDownload } = usePermission('page:/reports/sales');
  const range = useDateRange('month');
  const [report, setReport] = useState<ProdReport>('output');
  const { data, isLoading } = useProductionReports(range.from || undefined, range.to || undefined);
  const t = data?.totals;

  const output = data?.output ?? [];
  const consumption = data?.consumption ?? [];
  const batches = data?.batches ?? [];
  const wastage = data?.wastage ?? [];

  const sub = `Period: ${periodLabel(range.from, range.to)}`;
  const meta: [string, string][] = [
    ['Period', periodLabel(range.from, range.to)],
    ['Batches', String(t?.batchCount ?? 0)],
    ['Total Cost', pdfMoney(t?.totalCost)],
  ];

  return (
    <div className="space-y-4">
      <ReportPicker
        options={[
          { value: 'output', label: 'Output by Item' },
          { value: 'consumption', label: 'Material Consumption' },
          { value: 'batches', label: 'Batch Costs' },
          { value: 'wastage', label: 'Wastage' },
        ]}
        value={report} onChange={setReport}
      />

      <RangeBar range={range}>
        {report === 'output' && (
          <ExportButtons
            canDownload={canDownload}
            disabled={isLoading || output.length === 0}
            onCSV={() => downloadCSV('production-output.csv', output.map((r) => ({
              Item: r.itemName, Unit: r.unit, Batches: r.batchCount, 'Produced Qty': r.producedQty,
              'Wastage Qty': r.wastageQty, 'Total Cost (₹)': r.totalCost?.toFixed(2) ?? '',
              'Avg Cost/Unit (₹)': r.avgCostPerUnit?.toFixed(2) ?? '',
            })))}
            onPDF={() => exportReportPdf({
              title: 'Production Output by Item', subtitle: sub, metaRows: meta,
              sections: [{
                columns: [
                  { label: 'Item', width: 2.4 }, { label: 'Unit' }, { label: 'Batches', align: 'center' },
                  { label: 'Produced', align: 'right', width: 1.2 }, { label: 'Wastage', align: 'right' },
                  { label: 'Total Cost', align: 'right', width: 1.4 }, { label: 'Cost/Unit', align: 'right', width: 1.2 },
                ],
                rows: output.map((r) => [r.itemName, r.unit, r.batchCount, num(r.producedQty), num(r.wastageQty),
                  pdfM(r.totalCost), pdfM(r.avgCostPerUnit)]),
                totalsRow: ['TOTAL', '', t?.batchCount ?? 0, num(t?.producedQty), num(t?.wastageQty), pdfM(t?.totalCost ?? null), ''],
              }],
            })}
          />
        )}
        {report === 'consumption' && (
          <ExportButtons
            canDownload={canDownload}
            disabled={isLoading || consumption.length === 0}
            onCSV={() => downloadCSV('material-consumption.csv', consumption.map((r) => ({
              Material: r.materialName, Type: r.materialType === 'raw_material' ? 'Packing Material' : 'Material',
              Unit: r.unit, 'Consumed Qty': r.consumedQty, 'Cost (₹)': r.consumedCost?.toFixed(2) ?? '',
              'Expected Qty (BOM)': r.expectedQty ?? '', 'Variance Qty': r.varianceQty ?? '',
            })))}
            onPDF={() => exportReportPdf({
              title: 'Material Consumption', subtitle: sub, metaRows: meta,
              sections: [{
                columns: [
                  { label: 'Material', width: 2.4 }, { label: 'Type', width: 1.2 }, { label: 'Unit' },
                  { label: 'Consumed', align: 'right', width: 1.2 }, { label: 'Cost', align: 'right', width: 1.4 },
                  { label: 'Expected (BOM)', align: 'right', width: 1.3 }, { label: 'Variance', align: 'right', width: 1.1 },
                ],
                rows: consumption.map((r) => [r.materialName, r.materialType === 'raw_material' ? 'Packing Material' : 'Raw Material',
                  r.unit, num(r.consumedQty), pdfM(r.consumedCost), r.expectedQty === null ? '-' : num(r.expectedQty),
                  r.varianceQty === null ? '-' : num(r.varianceQty)]),
              }],
            })}
          />
        )}
        {report === 'batches' && (
          <ExportButtons
            canDownload={canDownload}
            disabled={isLoading || batches.length === 0}
            onCSV={() => downloadCSV('batch-costs.csv', batches.map((r) => ({
              'Batch No': r.batchNumber, Date: r.productionDate, Item: r.itemName, Unit: r.unit,
              'Produced Qty': r.producedQty, 'Wastage Qty': r.wastageQty,
              'Material Cost (₹)': r.materialCost?.toFixed(2) ?? '', 'Overhead (₹)': r.overheadAmount?.toFixed(2) ?? '',
              'Total Cost (₹)': r.totalCost?.toFixed(2) ?? '', 'Cost/Unit (₹)': r.costPerUnit?.toFixed(2) ?? '',
            })))}
            onPDF={() => exportReportPdf({
              title: 'Production Batch Costs', subtitle: sub, metaRows: meta, orientation: 'landscape',
              sections: [{
                columns: [
                  { label: 'Batch No', width: 1.4 }, { label: 'Date' }, { label: 'Item', width: 1.8 },
                  { label: 'Produced', align: 'right' }, { label: 'Wastage', align: 'right' },
                  { label: 'Material Cost', align: 'right', width: 1.3 }, { label: 'Overhead', align: 'right', width: 1.1 },
                  { label: 'Total Cost', align: 'right', width: 1.3 }, { label: 'Cost/Unit', align: 'right', width: 1.1 },
                ],
                rows: batches.map((r) => [r.batchNumber, fmtDate(r.productionDate), r.itemName, num(r.producedQty),
                  num(r.wastageQty), pdfM(r.materialCost), pdfM(r.overheadAmount), pdfM(r.totalCost), pdfM(r.costPerUnit)]),
              }],
            })}
          />
        )}
        {report === 'wastage' && (
          <ExportButtons
            canDownload={canDownload}
            disabled={isLoading || wastage.length === 0}
            onCSV={() => downloadCSV('production-wastage.csv', wastage.map((r) => ({
              'Batch No': r.batchNumber, Date: r.productionDate, Item: r.itemName, Unit: r.unit,
              'Produced Qty': r.producedQty, 'Wastage Qty': r.wastageQty, 'Wastage Value (₹)': r.wastageValue.toFixed(2),
              Reasons: r.lines.map((l) => `${l.reason} (${l.quantity})`).join('; '),
            })))}
            onPDF={() => exportReportPdf({
              title: 'Production Wastage', subtitle: sub,
              metaRows: [...meta, ['Wastage Value', pdfMoney(t?.wastageValue)]],
              sections: [{
                columns: [
                  { label: 'Batch No', width: 1.3 }, { label: 'Date' }, { label: 'Item', width: 1.8 },
                  { label: 'Produced', align: 'right' }, { label: 'Wastage', align: 'right' },
                  { label: 'Value', align: 'right', width: 1.2 }, { label: 'Reasons', width: 2.2 },
                ],
                rows: wastage.map((r) => [r.batchNumber, fmtDate(r.productionDate), r.itemName, num(r.producedQty),
                  num(r.wastageQty), pdfMoney(r.wastageValue), r.lines.map((l) => `${l.reason} (${num(l.quantity)})`).join('; ') || '-']),
                totalsRow: ['TOTAL', '', '', '', num(t?.wastageQty), pdfMoney(t?.wastageValue), ''],
              }],
            })}
          />
        )}
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Batches', value: t?.batchCount ?? 0 },
        { label: 'Produced Qty', value: num(t?.producedQty), tone: 'pos' },
        { label: 'Wastage', value: `${num(t?.wastageQty)} (${fmt(t?.wastageValue)})`, tone: 'neg' },
        { label: 'Total Production Cost', value: fmt(t?.totalCost), tone: 'accent' },
      ]} />

      {report === 'output' && (
        <RTable
          cols={[
            { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
            { key: 'unit', label: 'Unit' },
            { key: 'batchCount', label: 'Batches', align: 'center' },
            { key: 'producedQty', label: 'Produced', align: 'right', render: (r) => num(r.producedQty) },
            { key: 'wastageQty', label: 'Wastage', align: 'right', render: (r) => <span className={r.wastageQty > 0 ? 'text-red-500' : ''}>{num(r.wastageQty)}</span> },
            { key: 'totalCost', label: 'Total Cost', align: 'right', render: (r) => money(r.totalCost) },
            { key: 'avgCostPerUnit', label: 'Avg Cost/Unit', align: 'right', render: (r) => <b>{money(r.avgCostPerUnit)}</b> },
          ] satisfies Col<(typeof output)[number]>[]}
          rows={output} loading={isLoading} rowKey={(r) => r.itemId}
        />
      )}

      {report === 'consumption' && (
        <RTable
          cols={[
            { key: 'materialName', label: 'Material', render: (r) => <span className="font-medium">{r.materialName}</span> },
            { key: 'materialType', label: 'Type', render: (r) => (r.materialType === 'raw_material' ? 'Packing Material' : 'Material') },
            { key: 'unit', label: 'Unit' },
            { key: 'consumedQty', label: 'Consumed', align: 'right', render: (r) => num(r.consumedQty) },
            { key: 'consumedCost', label: 'Cost', align: 'right', render: (r) => money(r.consumedCost) },
            { key: 'expectedQty', label: 'Expected (BOM)', align: 'right', render: (r) => (r.expectedQty === null ? '—' : num(r.expectedQty)) },
            { key: 'varianceQty', label: 'Variance', align: 'right', render: (r) => r.varianceQty === null ? '—' : (
              <span className={r.varianceQty > 0 ? 'text-red-500 font-bold' : 'text-emerald-600'}>
                {r.varianceQty > 0 ? '+' : ''}{num(r.varianceQty)}
              </span>
            ) },
          ] satisfies Col<(typeof consumption)[number]>[]}
          rows={consumption} loading={isLoading} rowKey={(r) => `${r.materialType}:${r.materialId}`}
        />
      )}

      {report === 'batches' && (
        <RTable
          cols={[
            { key: 'batchNumber', label: 'Batch No', render: (r) => <span className="font-mono text-xs text-primary font-bold">{r.batchNumber}</span> },
            { key: 'productionDate', label: 'Date', render: (r) => fmtDate(r.productionDate) },
            { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
            { key: 'producedQty', label: 'Produced', align: 'right', render: (r) => num(r.producedQty) },
            { key: 'wastageQty', label: 'Wastage', align: 'right', render: (r) => <span className={r.wastageQty > 0 ? 'text-red-500' : ''}>{num(r.wastageQty)}</span> },
            { key: 'materialCost', label: 'Material Cost', align: 'right', render: (r) => money(r.materialCost) },
            { key: 'overheadAmount', label: 'Overhead', align: 'right', render: (r) => money(r.overheadAmount) },
            { key: 'totalCost', label: 'Total Cost', align: 'right', render: (r) => <b>{money(r.totalCost)}</b> },
            { key: 'costPerUnit', label: 'Cost/Unit', align: 'right', render: (r) => money(r.costPerUnit) },
          ] satisfies Col<(typeof batches)[number]>[]}
          rows={batches} loading={isLoading} rowKey={(r) => r.id}
        />
      )}

      {report === 'wastage' && (
        <RTable
          cols={[
            { key: 'batchNumber', label: 'Batch No', render: (r) => <span className="font-mono text-xs text-primary font-bold">{r.batchNumber}</span> },
            { key: 'productionDate', label: 'Date', render: (r) => fmtDate(r.productionDate) },
            { key: 'itemName', label: 'Item', render: (r) => <span className="font-medium">{r.itemName}</span> },
            { key: 'producedQty', label: 'Produced', align: 'right', render: (r) => num(r.producedQty) },
            { key: 'wastageQty', label: 'Wastage', align: 'right', render: (r) => <span className="text-red-500 font-bold">{num(r.wastageQty)}</span> },
            { key: 'wastageValue', label: 'Value', align: 'right', render: (r) => <span className="text-red-500">{fmt(r.wastageValue)}</span> },
            { key: 'lines', label: 'Reasons', render: (r) => (
              <span className="text-xs text-muted-foreground">{r.lines.map((l) => `${l.reason} (${num(l.quantity)})`).join('; ') || '—'}</span>
            ) },
          ] satisfies Col<(typeof wastage)[number]>[]}
          rows={wastage} loading={isLoading} rowKey={(r) => r.productionId}
          empty="No wastage recorded in this period 🎉"
          footer={['TOTAL', '', '', '', num(t?.wastageQty), fmt(t?.wastageValue), '']}
        />
      )}
    </div>
  );
}
