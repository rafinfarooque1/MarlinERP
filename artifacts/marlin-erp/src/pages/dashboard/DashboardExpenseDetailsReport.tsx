import { Fragment } from 'react';
import type { DashboardFinancialMatrix } from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/app/empty-state';
import { Receipt } from 'lucide-react';
import { fmt, periodLabel } from '@/pages/reports/shared';

type ExpenseRow = {
  ledgerId: number;
  name: string;
  bank: number[];
  cash: number[];
};

export function DashboardExpenseDetailsReport({
  data,
  isLoading,
  isError,
  fromDate,
  toDate,
}: {
  data?: DashboardFinancialMatrix;
  isLoading: boolean;
  isError: boolean;
  fromDate?: string;
  toDate?: string;
}) {
  const period = data?.period ?? { fromDate: fromDate ?? null, toDate: toDate ?? null };
  const periodText = periodLabel(period.fromDate ?? undefined, period.toDate ?? undefined);
  const expenseRowsByLedger = new Map<number, ExpenseRow>();
  const emptyExpenseValues = () => Array(data?.locations.length ?? 0).fill(0) as number[];

  for (const ledger of data?.bankExpenseLedgers ?? []) {
    expenseRowsByLedger.set(ledger.ledgerId, {
      ledgerId: ledger.ledgerId,
      name: ledger.name,
      bank: ledger.values,
      cash: emptyExpenseValues(),
    });
  }
  for (const ledger of data?.cashExpenseLedgers ?? []) {
    const row = expenseRowsByLedger.get(ledger.ledgerId);
    if (row) {
      row.name = ledger.name;
      row.cash = ledger.values;
    } else {
      expenseRowsByLedger.set(ledger.ledgerId, {
        ledgerId: ledger.ledgerId,
        name: ledger.name,
        bank: emptyExpenseValues(),
        cash: ledger.values,
      });
    }
  }

  const expenseRows = Array.from(expenseRowsByLedger.values())
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Card className="rounded-xl border border-border bg-card shadow-sm" data-testid="dashboard-expense-details-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Receipt className="h-5 w-5 text-primary" />
          Expense Details
        </CardTitle>
        <CardDescription>{periodText} · Cash and bank expenses by location.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2" aria-label="Loading expense details">
            {[...Array(5)].map((_, index) => <Skeleton key={index} className="h-10" />)}
          </div>
        ) : isError || !data ? (
          <EmptyState
            icon={Receipt}
            title="Expense details unavailable"
            hint="Refresh the dashboard to try again."
            compact
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table
              className="w-full min-w-max border-separate border-spacing-0 text-sm"
              data-testid="table-dashboard-expense-details"
            >
              <caption className="sr-only">Expense details · {periodText}</caption>
              <thead>
                <tr className="bg-muted/40">
                  <th scope="col" className="min-w-[220px] border-b border-border px-3 py-2 text-left font-semibold">
                    Location
                  </th>
                  {data.locations.map((location) => (
                    <th
                      key={`${location.locationType}:${location.locationId}`}
                      scope="colgroup"
                      colSpan={2}
                      className="min-w-[260px] border-b border-border px-3 py-2 text-center font-semibold"
                    >
                      {location.name}
                    </th>
                  ))}
                </tr>
                <tr className="bg-muted/30">
                  <th scope="col" className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
                    Bank/Cash
                  </th>
                  {data.locations.map((location) => (
                    <Fragment key={`${location.locationType}:${location.locationId}`}>
                      <th scope="col" className="min-w-[130px] border-b border-border px-3 py-2 text-right font-medium">
                        Bank
                      </th>
                      <th scope="col" className="min-w-[130px] border-b border-border px-3 py-2 text-right font-medium">
                        Cash
                      </th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {expenseRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={data.locations.length * 2 + 1}
                      className="border-b border-border px-3 py-4 text-center text-muted-foreground"
                    >
                      No expense details in this period.
                    </td>
                  </tr>
                ) : expenseRows.map((row) => (
                  <tr key={row.ledgerId} className="hover:bg-muted/20">
                    <th scope="row" className="min-w-[220px] border-b border-border bg-card px-3 py-2 text-left font-medium">
                      {row.name}
                    </th>
                    {data.locations.map((location, index) => (
                      <Fragment key={`${location.locationType}:${location.locationId}`}>
                        <td className="min-w-[130px] border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
                          {fmt(row.bank[index] ?? 0)}
                        </td>
                        <td className="min-w-[130px] border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
                          {fmt(row.cash[index] ?? 0)}
                        </td>
                      </Fragment>
                    ))}
                  </tr>
                ))}
                <tr className="bg-primary/10 font-bold" data-testid="row-dashboard-expense-details-total">
                  <th scope="row" className="min-w-[220px] border-b border-border px-3 py-2 text-left">
                    Total
                  </th>
                  {data.locations.map((location, index) => (
                    <Fragment key={`${location.locationType}:${location.locationId}`}>
                      <td className="min-w-[130px] border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
                        {fmt(data.bankExpenses[index] ?? 0)}
                      </td>
                      <td className="min-w-[130px] border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums">
                        {fmt(data.cashExpenses[index] ?? 0)}
                      </td>
                    </Fragment>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
