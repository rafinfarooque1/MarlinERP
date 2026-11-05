import { Fragment, useRef, useState } from 'react';
import type { DashboardFinancialMatrix } from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/app/empty-state';
import { Loader2, Receipt, Share2 } from 'lucide-react';
import { fmt, periodLabel } from '@/pages/reports/shared';
import { toast } from 'sonner';

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
  const captureRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);
  const [preparingCapture, setPreparingCapture] = useState(false);
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

  const shareReport = async () => {
    if (sharing) return;
    if (isLoading) {
      toast.info('Expense details are still loading — try again in a moment');
      return;
    }
    if (isError || !data) {
      toast.error('Expense details are unavailable');
      return;
    }

    const captureTarget = captureRef.current;
    if (!captureTarget) {
      console.error('[dashboard] expense details share: capture node not mounted');
      toast.error('Could not capture Expense Details');
      return;
    }

    console.debug('[dashboard] expense details share: capturing…');
    setSharing(true);
    setPreparingCapture(true);
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await document.fonts.ready;
      const { toBlob } = await import('html-to-image');
      const table = captureTarget.querySelector<HTMLTableElement>('table');
      if (!table) throw new Error('Expense Details table not found');

      const captureRect = captureTarget.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      const lastRow = table.rows.item(table.rows.length - 1);
      const lastRowBottom = lastRow?.getBoundingClientRect().bottom ?? captureRect.bottom;
      const width = Math.ceil(Math.max(
        captureTarget.scrollWidth,
        captureRect.width,
        table.scrollWidth,
        tableRect.width,
      ));
      const height = Math.ceil(Math.max(
        captureTarget.scrollHeight,
        captureRect.height,
        table.scrollHeight,
        tableRect.bottom - captureRect.top,
        lastRowBottom - captureRect.top,
      )) + 2;

      console.debug('[dashboard] expense details share: capture bounds', {
        rows: table.rows.length,
        width,
        height,
      });
      const blob = await toBlob(captureTarget, {
        backgroundColor: '#ffffff',
        width,
        height,
        pixelRatio: 2,
        cacheBust: true,
        style: { overflow: 'visible' },
        filter: (node) => !(node instanceof HTMLElement && node.dataset.captureExclude === 'true'),
      });
      if (!blob) throw new Error('empty Expense Details image');

      const dateSlug = period.fromDate && period.toDate
        ? (period.fromDate === period.toDate ? period.fromDate : `${period.fromDate}_to_${period.toDate}`)
        : period.toDate
          ? `all-time-through-${period.toDate}`
          : 'all-time';
      const file = new File([blob], `expense-details-${dateSlug}.png`, { type: 'image/png' });
      const canShareFile = typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
        && navigator.canShare({ files: [file] });
      if (canShareFile) {
        try {
          await navigator.share({ files: [file], title: 'Expense Details' });
          return;
        } catch (shareError: any) {
          if (shareError?.name === 'AbortError') return;
          console.warn(
            '[dashboard] expense details native share failed; downloading image instead',
            shareError?.message ?? String(shareError),
          );
        }
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Expense Details image downloaded');
    } catch (error) {
      console.error('[dashboard] expense details share failed', error);
      toast.error('Could not create the Expense Details image');
    } finally {
      setPreparingCapture(false);
      setSharing(false);
    }
  };

  return (
    <div className="relative">
      <div ref={captureRef} data-testid="dashboard-expense-details-capture">
        <Card className="rounded-xl border border-border bg-card shadow-sm" data-testid="dashboard-expense-details-card">
          <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Receipt className="h-5 w-5 text-primary" />
                Expense Details
              </CardTitle>
              <CardDescription>{periodText} · Cash and bank expenses by location.</CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={shareReport}
              disabled={sharing}
              aria-label={sharing ? 'Preparing Expense Details image' : 'Share Expense Details'}
              data-testid="button-share-expense-details"
              data-capture-exclude="true"
            >
              {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              {sharing ? 'Preparing…' : 'Share'}
            </Button>
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
              <div className={`${preparingCapture ? 'overflow-visible' : 'overflow-x-auto'} rounded-lg border border-border`}>
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
      </div>
    </div>
  );
}
