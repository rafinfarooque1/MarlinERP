import type { DashboardLocationSalesRow } from '@workspace/api-client-react';
import { fmt, num } from '@/pages/reports/shared';

export function DashboardLocationSalesTable({
  rows,
  testId = 'table-location-sales-report',
}: {
  rows: DashboardLocationSalesRow[];
  testId?: string;
}) {
  const totals = rows.reduce(
    (sum, row) => ({
      salesAmount: sum.salesAmount + row.salesAmount,
      salesQuantity: sum.salesQuantity + row.salesQuantity,
      outstandingAmount: sum.outstandingAmount + row.outstandingAmount,
    }),
    { salesAmount: 0, salesQuantity: 0, outstandingAmount: 0 },
  );

  return (
    <div className="overflow-x-auto">
      <table
        data-testid={testId}
        className="w-full min-w-[650px] border-separate border-spacing-0 text-sm"
      >
        <caption className="sr-only">Sales and outstanding by location</caption>
        <thead>
          <tr className="bg-muted/40">
            <th scope="col" className="min-w-[190px] border-b border-border px-3 py-2 text-left font-semibold">
              Location
            </th>
            <th scope="col" className="min-w-[165px] border-b border-border px-3 py-2 text-right font-semibold">
              Sales amount
            </th>
            <th scope="col" className="min-w-[145px] border-b border-border px-3 py-2 text-right font-semibold">
              Sales quantity
            </th>
            <th scope="col" className="min-w-[190px] border-b border-border px-3 py-2 text-right font-semibold">
              Outstanding amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.locationType}:${row.locationId}`}
              data-testid={`row-location-sales-${row.locationType}-${row.locationId}`}
              className="hover:bg-muted/20"
            >
              <th scope="row" className="border-b border-border px-3 py-2 text-left font-medium">
                {row.name}
              </th>
              <td className="border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
                {fmt(row.salesAmount)}
              </td>
              <td className="border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
                {num(row.salesQuantity)}
              </td>
              <td className="border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
                {fmt(row.outstandingAmount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr data-testid="row-location-sales-total" className="bg-primary/10 font-bold">
            <th scope="row" className="border-b border-border px-3 py-2 text-left">
              Total
            </th>
            <td className="border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
              {fmt(totals.salesAmount)}
            </td>
            <td className="border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
              {num(totals.salesQuantity)}
            </td>
            <td className="border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
              {fmt(totals.outstandingAmount)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
