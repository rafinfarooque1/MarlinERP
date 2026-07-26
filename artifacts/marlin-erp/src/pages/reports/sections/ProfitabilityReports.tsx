/**
 * Profitability — gross profit by item or by location.
 * Revenue is ex-tax; COGS from batch consumption, remainder at item average cost.
 */
import { useState } from 'react';
import { useProfitability } from '@workspace/api-client-react';
import { downloadCSV } from '@/lib/download';
import {
  fmt, num, pdfMoney, periodLabel,
  useDateRange, RangeBar, ReportPicker, SummaryCards, RTable, ExportButtons, exportReportPdf,
  type Col,
} from '../shared';

export default function ProfitabilitySection() {
  const range = useDateRange('month');
  const [groupBy, setGroupBy] = useState<'item' | 'location'>('item');
  const { data, isLoading } = useProfitability({ from: range.from || undefined, to: range.to || undefined, groupBy });
  const rows = data?.rows ?? [];
  const t = data?.totals;
  const hasEstimates = rows.some((r) => r.estimatedCostQty > 0);
  const entity = groupBy === 'item' ? 'Item' : 'Location';

  const marginCls = (m: number) => (m >= 25 ? 'text-emerald-600' : m >= 10 ? 'text-amber-600' : 'text-red-500');

  return (
    <div className="space-y-4">
      <ReportPicker
        options={[{ value: 'item' as const, label: 'By Item' }, { value: 'location' as const, label: 'By Location' }]}
        value={groupBy} onChange={setGroupBy}
      />
      <RangeBar range={range}>
        <ExportButtons
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV(`profitability-by-${groupBy}.csv`, rows.map((r) => ({
            [entity]: r.label, ...(groupBy === 'item' ? { Unit: r.unit } : {}), Qty: r.qty,
            'Revenue (₹)': r.revenue.toFixed(2), 'COGS (₹)': r.cogs.toFixed(2),
            'Gross Profit (₹)': r.grossProfit.toFixed(2), 'Margin %': r.marginPct.toFixed(1),
          })))}
          onPDF={() => exportReportPdf({
            title: `Profitability by ${entity}`,
            subtitle: `Period: ${periodLabel(range.from, range.to)}   |   Revenue ex-tax; COGS from batch costs`,
            metaRows: [
              ['Period', periodLabel(range.from, range.to)],
              ['Revenue', pdfMoney(t?.revenue)],
              ['Gross Profit', pdfMoney(t?.grossProfit)],
              ['Margin', `${(t?.marginPct ?? 0).toFixed(1)}%`],
            ],
            sections: [{
              columns: [
                { label: entity, width: 2.4 },
                ...(groupBy === 'item' ? [{ label: 'Unit' }] : []),
                { label: 'Qty', align: 'right' as const },
                { label: 'Revenue', align: 'right' as const, width: 1.4 },
                { label: 'COGS', align: 'right' as const, width: 1.4 },
                { label: 'Gross Profit', align: 'right' as const, width: 1.4 },
                { label: 'Margin %', align: 'right' as const },
              ],
              rows: rows.map((r) => [
                r.label + (r.estimatedCostQty > 0 ? ' *' : ''),
                ...(groupBy === 'item' ? [r.unit] : []),
                num(r.qty), pdfMoney(r.revenue), pdfMoney(r.cogs), pdfMoney(r.grossProfit), `${r.marginPct.toFixed(1)}%`,
              ]),
              totalsRow: ['TOTAL', ...(groupBy === 'item' ? [''] : []), '', pdfMoney(t?.revenue), pdfMoney(t?.cogs),
                pdfMoney(t?.grossProfit), `${(t?.marginPct ?? 0).toFixed(1)}%`],
            }],
            footerNote: hasEstimates
              ? '* Some quantities had no batch cost data and were costed at the item average cost.'
              : undefined,
          })}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Revenue (ex-tax)', value: fmt(t?.revenue), tone: 'accent' },
        { label: 'COGS', value: fmt(t?.cogs), tone: 'warn' },
        { label: 'Gross Profit', value: fmt(t?.grossProfit), tone: (t?.grossProfit ?? 0) >= 0 ? 'pos' : 'neg' },
        { label: 'Margin', value: `${(t?.marginPct ?? 0).toFixed(1)}%`, tone: (t?.marginPct ?? 0) >= 0 ? 'pos' : 'neg' },
      ]} />

      <RTable
        cols={[
          { key: 'label', label: entity, render: (r) => (
            <span className="font-medium">{r.label}{r.estimatedCostQty > 0 && <span className="text-amber-600" title="Partially estimated cost"> *</span>}</span>
          ) },
          ...(groupBy === 'item' ? [{ key: 'unit', label: 'Unit' } as Col<(typeof rows)[number]>] : []),
          { key: 'qty', label: 'Qty Sold', align: 'right', render: (r) => num(r.qty) },
          { key: 'revenue', label: 'Revenue', align: 'right', render: (r) => fmt(r.revenue) },
          { key: 'cogs', label: 'COGS', align: 'right', render: (r) => fmt(r.cogs) },
          { key: 'grossProfit', label: 'Gross Profit', align: 'right', render: (r) => (
            <b className={r.grossProfit >= 0 ? 'text-emerald-600' : 'text-red-500'}>{fmt(r.grossProfit)}</b>
          ) },
          { key: 'marginPct', label: 'Margin %', align: 'right', render: (r) => (
            <span className={`font-bold ${marginCls(r.marginPct)}`}>{r.marginPct.toFixed(1)}%</span>
          ) },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.label}
        footer={['TOTAL', ...(groupBy === 'item' ? [''] : []), '', fmt(t?.revenue), fmt(t?.cogs), fmt(t?.grossProfit), `${(t?.marginPct ?? 0).toFixed(1)}%`]}
      />

      {hasEstimates && (
        <p className="text-xs text-muted-foreground">
          * Some sold quantities had no batch cost data — those were costed at the item's average cost (estimate).
        </p>
      )}
    </div>
  );
}
