import { useRef, useState } from 'react';
import type { DashboardCashBankReport as CashBankReportData } from '@workspace/api-client-react';
import { Landmark, Loader2, Share2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/app/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt, periodLabel } from '@/pages/reports/shared';

function AccountTable({
  title,
  icon: Icon,
  rows,
  totals,
  emptyText,
  testId,
  captureMode,
}: {
  title: string;
  icon: typeof Landmark;
  rows: CashBankReportData['bank']['rows'];
  totals: CashBankReportData['bank']['totals'];
  emptyText: string;
  testId: string;
  captureMode: boolean;
}) {
  return (
    <section className="space-y-2.5">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </h3>
      <div className={`${captureMode ? 'overflow-visible' : 'overflow-x-auto'} rounded-lg border border-border`}>
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm" data-testid={testId}>
          <caption className="sr-only">{title} account balances and period movements</caption>
          <thead>
            <tr className="bg-muted/40">
              <th scope="col" className="min-w-[220px] border-b border-border px-3 py-2 text-left font-semibold">Account</th>
              <th scope="col" className="min-w-[130px] border-b border-border px-3 py-2 text-right font-semibold">Opening</th>
              <th scope="col" className="min-w-[130px] border-b border-border px-3 py-2 text-right font-semibold">Receipt</th>
              <th scope="col" className="min-w-[130px] border-b border-border px-3 py-2 text-right font-semibold">Payment</th>
              <th scope="col" className="min-w-[150px] border-b border-border px-3 py-2 text-right font-semibold">Closing Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="border-b border-border px-3 py-5 text-center text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            ) : rows.map((row) => (
              <tr key={row.ledgerId} className="hover:bg-muted/20">
                <th scope="row" className="border-b border-border bg-card px-3 py-2 text-left font-medium">{row.name}</th>
                <td className="border-b border-border px-3 py-2 text-right font-mono tabular-nums">{fmt(row.opening)}</td>
                <td className="border-b border-border px-3 py-2 text-right font-mono tabular-nums">{fmt(row.receipt)}</td>
                <td className="border-b border-border px-3 py-2 text-right font-mono tabular-nums">{fmt(row.payment)}</td>
                <td className="border-b border-border px-3 py-2 text-right font-mono tabular-nums">{fmt(row.closing)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-primary/10 font-bold" data-testid={`${testId}-total`}>
              <th scope="row" className="px-3 py-2 text-left">Total</th>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(totals.opening)}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(totals.receipt)}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(totals.payment)}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(totals.closing)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

export function DashboardCashBankReport({
  data,
  isLoading,
  isError,
  fromDate,
  toDate,
}: {
  data?: CashBankReportData;
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

  const shareReport = async () => {
    if (sharing) return;
    if (isLoading) {
      toast.info('Cash and bank report is still loading — try again in a moment');
      return;
    }
    if (isError || !data) {
      toast.error('Cash and bank report is unavailable');
      return;
    }
    const element = captureRef.current;
    if (!element) {
      console.error('[dashboard] cash and bank report share: capture node not mounted');
      toast.error('Could not capture the cash and bank report');
      return;
    }

    console.debug('[dashboard] cash and bank report share: capturing…');
    setSharing(true);
    setPreparingCapture(true);
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await document.fonts.ready;
      const { toBlob } = await import('html-to-image');
      const tables = Array.from(element.querySelectorAll<HTMLTableElement>('table'));
      if (tables.length === 0) throw new Error('cash and bank tables not found');
      const captureRect = element.getBoundingClientRect();
      const tableRects = tables.map((table) => table.getBoundingClientRect());
      const lastTable = tables[tables.length - 1];
      const lastRow = lastTable.rows.item(lastTable.rows.length - 1);
      const lastRowBottom = lastRow?.getBoundingClientRect().bottom ?? captureRect.bottom;
      const width = Math.ceil(Math.max(
        element.scrollWidth,
        captureRect.width,
        ...tables.flatMap((table, index) => [table.scrollWidth, tableRects[index]?.width ?? 0]),
      ));
      const height = Math.ceil(Math.max(
        element.scrollHeight,
        captureRect.height,
        ...tables.flatMap((table, index) => [
          table.scrollHeight,
          tableRects[index] ? tableRects[index].bottom - captureRect.top : 0,
        ]),
        lastRowBottom - captureRect.top,
      )) + 2;
      console.debug('[dashboard] cash and bank report share: capture bounds', {
        tables: tables.length,
        width,
        height,
      });
      const blob = await toBlob(element, {
        backgroundColor: '#ffffff',
        width,
        height,
        pixelRatio: 2,
        cacheBust: true,
        style: { overflow: 'visible' },
        filter: (node) => !(node instanceof HTMLElement && node.dataset.captureExclude === 'true'),
      });
      if (!blob) throw new Error('empty image');
      const dateSlug = period.fromDate && period.toDate
        ? (period.fromDate === period.toDate ? period.fromDate : `${period.fromDate}_to_${period.toDate}`)
        : period.toDate
          ? `all-time-through-${period.toDate}`
          : 'all-time';
      const file = new File([blob], `cash-bank-report-${dateSlug}.png`, { type: 'image/png' });
      const canShareFile = typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
        && navigator.canShare({ files: [file] });
      if (canShareFile) {
        try {
          await navigator.share({ files: [file], title: 'Cash & Bank Report' });
          return;
        } catch (shareError: any) {
          if (shareError?.name === 'AbortError') return;
          console.warn(
            '[dashboard] cash and bank report native share failed; downloading image instead',
            shareError?.message ?? String(shareError),
          );
        }
      }

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Cash and bank report image downloaded');
    } catch (error) {
      console.error('[dashboard] cash and bank report share failed', error);
      toast.error('Could not create the cash and bank report image');
    } finally {
      setPreparingCapture(false);
      setSharing(false);
    }
  };

  return (
    <div className="relative">
      <div ref={captureRef} data-testid="dashboard-cash-bank-capture">
        <Card className="rounded-xl border border-border bg-card shadow-sm" data-testid="dashboard-cash-bank-card">
          <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Landmark className="h-5 w-5 text-primary" />
                Cash &amp; Bank
              </CardTitle>
              <CardDescription>{periodText} · Account balances across locations available to you.</CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={shareReport}
              disabled={sharing}
              aria-label={sharing ? 'Preparing cash and bank report image' : 'Share cash and bank report'}
              data-testid="button-share-cash-bank"
              data-capture-exclude="true"
            >
              {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              {sharing ? 'Preparing…' : 'Share'}
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-6" aria-label="Loading cash and bank report">
                {[...Array(2)].map((_, section) => (
                  <div key={section} className="space-y-2">
                    <Skeleton className="h-5 w-24" />
                    {[...Array(3)].map((__, row) => <Skeleton key={row} className="h-10" />)}
                  </div>
                ))}
              </div>
            ) : isError || !data ? (
              <EmptyState
                icon={Landmark}
                title="Cash and bank report unavailable"
                hint="Refresh the dashboard to try again."
                compact
              />
            ) : (
              <div className="space-y-6 bg-card p-1">
                <AccountTable
                  title="Bank"
                  icon={Landmark}
                  rows={data.bank.rows}
                  totals={data.bank.totals}
                  emptyText="No bank account activity in this period."
                  testId="table-dashboard-bank"
                  captureMode={preparingCapture}
                />
                <AccountTable
                  title="Cash"
                  icon={Wallet}
                  rows={data.cash.rows}
                  totals={data.cash.totals}
                  emptyText="No cash account activity in this period."
                  testId="table-dashboard-cash"
                  captureMode={preparingCapture}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
