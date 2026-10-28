import type { DashboardBi } from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/app/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet } from 'lucide-react';
import { fmtZeroAsBlank, periodLabel } from '@/pages/reports/shared';

type LocationAmount = { locationType: string; locationId: number; name: string; amount: number };
const keyOf = (type: string, id: number) => `${type}:${id}`;

export function DashboardAdminDailyReport({
  data,
  isLoading,
  isError,
  fromDate,
  toDate,
}: {
  data?: DashboardBi;
  isLoading: boolean;
  isError: boolean;
  fromDate?: string;
  toDate?: string;
}) {
  const period = data?.period ?? { fromDate: fromDate ?? null, toDate: toDate ?? null };
  const details = data?.adminDailyReport;
  const matrix = data?.financialMatrix;
  const locations = matrix?.locations ?? [];
  const openingDue = new Map((details?.openingDueByLocation ?? []).map((row) => [
    keyOf(row.locationType, row.locationId), row.amount,
  ]));
  const closingDue = new Map((data?.locationSalesReport ?? []).map((row) => [
    keyOf(row.locationType, row.locationId), row.outstandingAmount,
  ]));
  const creditReceived = new Map((details?.creditReceivedByLocation ?? []).map((row) => [
    keyOf(row.locationType, row.locationId), row.amount,
  ]));
  const creditSale = new Map((details?.creditSaleByLocation ?? []).map((row) => [
    keyOf(row.locationType, row.locationId), row.amount,
  ]));
  const salesQty = new Map((data?.locationSalesReport ?? []).map((row) => [
    keyOf(row.locationType, row.locationId), row.salesQuantity,
  ]));
  const sumValues = (values: number[] | undefined) => (values ?? []).reduce((sum, value) => sum + Number(value || 0), 0);
  const sumMap = (values: Map<string, number>) => Array.from(values.values()).reduce((sum, value) => sum + Number(value || 0), 0);

  return (
    <Card className="rounded-xl border border-border bg-card shadow-sm" data-testid="dashboard-admin-daily-report">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sheet className="h-5 w-5 text-primary" />
          Daily Financial Sheet
        </CardTitle>
        <CardDescription>{periodLabel(period.fromDate ?? undefined, period.toDate ?? undefined)} · Administrator report</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="space-y-2" aria-label="Loading administrator report">
            {[...Array(5)].map((_, index) => <Skeleton key={index} className="h-10" />)}
          </div>
        ) : isError || !data || !details || !matrix ? (
          <EmptyState icon={Sheet} title="Administrator report unavailable" hint="Refresh the dashboard to try again." compact />
        ) : (
          <>
            <div className="w-full overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[980px] border-collapse text-sm" data-testid="table-dashboard-admin-financial-sheet">
                <caption className="sr-only">Daily financial sheet for {periodLabel(period.fromDate ?? undefined, period.toDate ?? undefined)}</caption>
                <thead>
                  <tr className="bg-muted/40">
                    {['Location', 'Cash Sale', 'Bank Sale', 'Credit Received', 'Credit Sale', 'Sale Kg', 'Due Opening', 'Due Closing'].map((label) => (
                      <th key={label} scope="col" className={`border border-border px-2 py-2 font-semibold ${label === 'Location' ? 'text-left' : 'text-right'}`}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {locations.map((location, index) => {
                    const key = keyOf(location.locationType, location.locationId);
                    const amount = (values: number[] | undefined) => values?.[index] ?? 0;
                    return (
                      <tr key={key} className="hover:bg-muted/20">
                        <th scope="row" className="border border-border bg-card px-2 py-2 text-left font-medium">{location.name}</th>
                        <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(amount(matrix.cashReceiptBySale))}</td>
                        <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(amount(matrix.bankReceiptBySale))}</td>
                        <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(creditReceived.get(key))}</td>
                        <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(creditSale.get(key))}</td>
                        <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(salesQty.get(key))}</td>
                        <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(openingDue.get(key))}</td>
                        <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(closingDue.get(key))}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-primary/10 font-bold">
                    <th scope="row" className="border border-border px-2 py-2 text-left">Total</th>
                    <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(sumValues(matrix.cashReceiptBySale))}</td>
                    <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(sumValues(matrix.bankReceiptBySale))}</td>
                    <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(sumMap(creditReceived))}</td>
                    <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(sumMap(creditSale))}</td>
                    <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(sumMap(salesQty))}</td>
                    <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(sumMap(openingDue))}</td>
                    <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(sumMap(closingDue))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <section className="space-y-2">
              <h3 className="text-base font-semibold">Expense Narration</h3>
              {details.expenses.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">No expense entries in this date range.</p>
              ) : (
                <div className="w-full overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[680px] border-collapse text-sm" data-testid="table-dashboard-admin-expenses">
                    <thead><tr className="bg-muted/40">
                      {['Date', 'Location', 'Narration', 'Amount'].map((label) => (
                        <th key={label} scope="col" className={`border border-border px-2 py-2 font-semibold ${label === 'Amount' ? 'text-right' : 'text-left'}`}>{label}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {details.expenses.map((expense) => (
                        <tr key={`${expense.source}:${expense.id}`} className="hover:bg-muted/20">
                          <td className="border border-border px-2 py-2">{expense.date}</td>
                          <td className="border border-border px-2 py-2">{expense.locationName}</td>
                          <td className="border border-border px-2 py-2">{expense.narration}</td>
                          <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">{fmtZeroAsBlank(expense.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-primary/10 font-bold">
                        <th scope="row" colSpan={3} className="border border-border px-2 py-2 text-left">Total Expenses</th>
                        <td className="border border-border px-2 py-2 text-right font-mono tabular-nums">
                          {fmtZeroAsBlank(details.expenses.reduce((sum, expense) => sum + expense.amount, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
