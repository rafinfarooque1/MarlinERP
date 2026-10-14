import type { DashboardEmployeeSalesRow } from '@workspace/api-client-react';
import { fmt, fmtZeroAsBlank, num } from '@/pages/reports/shared';

export function DashboardEmployeeSalesTable({
  rows,
  ledgerAdjustment,
  totalOutstanding,
  captureMode = false,
}: {
  rows: DashboardEmployeeSalesRow[];
  ledgerAdjustment: number;
  totalOutstanding?: number;
  captureMode?: boolean;
}) {
  const totals = rows.reduce(
    (sum, row) => ({
      salesAmount: sum.salesAmount + row.salesAmount,
      salesQuantity: sum.salesQuantity + row.salesQuantity,
      outstandingAmount: sum.outstandingAmount + row.outstandingAmount,
    }),
    { salesAmount: 0, salesQuantity: 0, outstandingAmount: 0 },
  );
  const reconciledOutstanding = totalOutstanding
    ?? Math.round((totals.outstandingAmount + ledgerAdjustment) * 100) / 100;

  return (
    <div className={`${captureMode ? 'overflow-visible' : 'overflow-x-auto'} w-full max-w-full rounded-lg border border-border`}>
      <table data-testid="table-salesperson-sales-report" className="w-full border-collapse text-sm">
        <caption className="sr-only">Sales, quantity, and outstanding by salesperson</caption>
        <thead>
          <tr className="bg-muted/40">
            <th scope="col" className="border border-border px-2 py-1 text-left font-semibold">Salesperson</th>
            <th scope="col" className="border border-border px-2 py-1 text-right font-semibold">Sales amount</th>
            <th scope="col" className="border border-border px-2 py-1 text-right font-semibold">Sales quantity</th>
            <th scope="col" className="border border-border px-2 py-1 text-right font-semibold">Outstanding amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.employeeId == null ? 'unassigned' : `employee-${row.employeeId}-${index}`}
              data-testid={`row-salesperson-sales-${row.employeeId ?? 'unassigned'}-${index}`}
              className="hover:bg-muted/20"
            >
              <th scope="row" className="border border-border px-2 py-1 text-left font-medium">{row.name}</th>
              <td className="border border-border px-2 py-1 text-right font-mono tabular-nums">{fmtZeroAsBlank(row.salesAmount)}</td>
              <td className="border border-border px-2 py-1 text-right font-mono tabular-nums">{num(row.salesQuantity)}</td>
              <td className="border border-border px-2 py-1 text-right font-mono tabular-nums">{fmtZeroAsBlank(row.outstandingAmount)}</td>
            </tr>
          ))}
          <tr data-testid="row-salesperson-ledger-adjustment" className="text-muted-foreground">
            <th scope="row" className="border border-border px-2 py-1 text-left font-medium">
              Receivables ledger adjustment
            </th>
            <td className="border border-border px-2 py-1 text-right">—</td>
            <td className="border border-border px-2 py-1 text-right">—</td>
            <td className="border border-border px-2 py-1 text-right font-mono tabular-nums">{fmt(ledgerAdjustment)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr data-testid="row-salesperson-sales-total" className="bg-primary/10 font-bold">
            <th scope="row" className="border border-border px-2 py-1 text-left">Total</th>
            <td className="border border-border px-2 py-1 text-right font-mono tabular-nums">{fmtZeroAsBlank(totals.salesAmount)}</td>
            <td className="border border-border px-2 py-1 text-right font-mono tabular-nums">{num(totals.salesQuantity)}</td>
            <td className="border border-border px-2 py-1 text-right font-mono tabular-nums">{fmt(reconciledOutstanding)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
