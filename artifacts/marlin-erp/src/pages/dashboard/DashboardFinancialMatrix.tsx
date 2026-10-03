import { useRef, useState } from 'react';
import type { DashboardFinancialMatrix } from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/app/empty-state';
import { Share2, Loader2, TableProperties } from 'lucide-react';
import { toast } from 'sonner';
import { fmt, periodLabel } from '@/pages/reports/shared';

export function DashboardFinancialMatrixSection({
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

  const shareMatrix = async () => {
    if (sharing) return;
    if (!data) {
      toast.info('The financial matrix is still loading — try again in a moment');
      return;
    }
    const captureTarget = captureRef.current;
    if (!captureTarget) {
      console.error('[dashboard] financial matrix share: capture node not mounted');
      toast.error('Could not capture the financial matrix');
      return;
    }

    setSharing(true);
    setPreparingCapture(true);
    try {
      // Give React time to remove sticky positioning before serializing the
      // whole horizontally-scrollable table. Sticky cells are useful onscreen
      // but overlap when an image renderer captures the full-width table.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await document.fonts.ready;
      const { toBlob } = await import('html-to-image');
      const table = captureTarget.querySelector<HTMLTableElement>('table');
      if (!table) throw new Error('financial matrix table not found');
      const captureRect = captureTarget.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      const lastRow = table.tBodies[0]?.rows[table.tBodies[0].rows.length - 1];
      const lastRowBottom = lastRow?.getBoundingClientRect().bottom ?? captureRect.bottom;
      const width = Math.ceil(Math.max(
        captureTarget.scrollWidth,
        captureRect.width,
        table.scrollWidth,
        tableRect.width,
      ));
      // Measure through the last rendered row, not only the wrapper's scroll
      // size: table layout can report a height that clips the final row in the
      // serialized image even though it remains visible in the page.
      const height = Math.ceil(Math.max(
        captureTarget.scrollHeight,
        captureRect.height,
        table.scrollHeight,
        tableRect.height,
        lastRowBottom - captureRect.top,
      )) + 2;
      console.debug('[dashboard] financial matrix share: capture bounds', {
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
      });
      if (!blob) throw new Error('empty matrix image');
      const dateSlug = data.period.fromDate && data.period.toDate
        ? (data.period.fromDate === data.period.toDate
          ? data.period.fromDate
          : `${data.period.fromDate}_to_${data.period.toDate}`)
        : data.period.toDate
          ? `all-time-through-${data.period.toDate}`
          : 'all-time';
      const file = new File([blob], `financial-summary-matrix-${dateSlug}.png`, { type: 'image/png' });
      const canShareFile = typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
        && navigator.canShare({ files: [file] });
      if (canShareFile) {
        try {
          await navigator.share({ files: [file], title: 'Cross-Warehouse Financial Summary' });
          return;
        } catch (shareError: any) {
          if (shareError?.name === 'AbortError') return;
          console.warn(
            '[dashboard] financial matrix native share failed; downloading image instead',
            shareError?.message ?? String(shareError),
          );
        }
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success('Financial matrix image downloaded');
    } catch (error: any) {
      console.error('[dashboard] financial matrix capture failed', error?.message ?? String(error));
      toast.error('Could not capture the financial matrix');
    } finally {
      setPreparingCapture(false);
      setSharing(false);
    }
  };

  const period = data?.period ?? { fromDate: fromDate ?? null, toDate: toDate ?? null };
  const periodText = periodLabel(period.fromDate ?? undefined, period.toDate ?? undefined);
  const openingDescription = period.fromDate
    ? 'Opening cash and bank are the positions as of the day before this period.'
    : 'All time begins at inception with zero opening cash and bank balances.';

  const amountRow = (
    key: string,
    label: string,
    values: number[],
    total: number,
    options: { emphasized?: boolean; nested?: boolean; balance?: boolean } = {},
  ) => (
    <tr
      key={key}
      className={
        options.balance
          ? 'bg-primary/10 font-bold'
          : options.emphasized
            ? 'bg-muted/30 font-semibold'
            : 'hover:bg-muted/20'
      }
    >
      <th
        scope="row"
        className={`${preparingCapture ? '' : 'sticky left-0 z-10'} min-w-[220px] border-b border-border bg-inherit px-3 py-2 text-left ${
          options.nested ? 'pl-7 font-normal text-muted-foreground' : ''
        }`}
      >
        {label}
      </th>
      {data?.locations.map((location, index) => (
        <td
          key={`${location.locationType}:${location.locationId}`}
          className="min-w-[145px] border-b border-border px-3 py-2 text-right font-mono text-sm tabular-nums"
        >
          {fmt(values[index] ?? 0)}
        </td>
      ))}
      <td className={`${preparingCapture ? '' : 'sticky right-0 z-10'} min-w-[160px] border-b border-border bg-muted/30 px-3 py-2 text-right font-mono text-sm font-semibold tabular-nums`}>
        {fmt(total)}
      </td>
    </tr>
  );

  return (
    <Card className="rounded-xl border border-border bg-card shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <TableProperties className="h-5 w-5 text-primary" />
          Cross-Warehouse Financial Summary Matrix
        </CardTitle>
        <CardDescription>
          {periodText} · {openingDescription} Cash and bank balances add opening balances to receipts.
          Reconciliation pending shows bank sales and receipts awaiting a bank destination; it does not change closing bank.
          Columns include active locations available to your account and, for company-wide access, an Unallocated column for company-level balances.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2" aria-label="Loading financial matrix">
            {[...Array(5)].map((_, index) => <Skeleton key={index} className="h-10" />)}
          </div>
        ) : isError || !data ? (
          <EmptyState
            icon={TableProperties}
            title="Financial matrix unavailable"
            hint="Refresh the dashboard to try again."
            compact
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <div
                ref={captureRef}
                data-testid="financial-matrix-capture"
                className="inline-block w-max min-w-full bg-card text-foreground"
              >
              <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
                <caption className="caption-top border-b border-border bg-card px-3 py-2 text-left font-semibold">
                  Financial summary · {periodText}
                </caption>
                <thead>
                  <tr className="bg-muted/40">
                    <th className={`${preparingCapture ? '' : 'sticky left-0 top-0 z-30'} min-w-[220px] border-b border-border bg-muted/40 px-3 py-2 text-left font-semibold`}>
                      Particulars
                    </th>
                    {data.locations.map((location) => (
                      <th
                        key={`${location.locationType}:${location.locationId}`}
                        className={`${preparingCapture ? '' : 'sticky top-0 z-20'} min-w-[145px] max-w-[220px] border-b border-border bg-muted/40 px-3 py-2 text-right font-semibold`}
                      >
                        <span className="block whitespace-normal">{location.name}</span>
                      </th>
                    ))}
                    <th className={`${preparingCapture ? '' : 'sticky right-0 top-0 z-30'} min-w-[160px] border-b border-border bg-muted/50 px-3 py-2 text-right font-semibold`}>
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="bg-muted/60">
                    <th colSpan={data.locations.length + 2} className="border-b border-border px-3 py-2 text-left font-semibold">
                      Cash Summary
                    </th>
                  </tr>
                  {amountRow('opening-cash', 'Opening balance cash', data.openingCash, data.totals.openingCash, { emphasized: true })}
                  {amountRow('cash-receipts-total', 'Cash Receipt', data.cashReceiptTotal, data.totals.cashReceiptTotal, { emphasized: true })}
                  {amountRow('cash-receipts-by-sale', 'By Sale', data.cashReceiptBySale, data.totals.cashReceiptBySale, { nested: true })}
                  {amountRow('cash-receipt-vouchers', 'Cash Receipt', data.cashReceiptVouchers, data.totals.cashReceiptVouchers, { nested: true })}
                  {amountRow('balance', 'Balance', data.balance, data.totals.balance, { balance: true })}
                  {amountRow('cash-expenses', 'Cash Expense', data.cashExpenses, data.totals.cashExpenses, { emphasized: true })}
                  {data.cashExpenseLedgers.map((ledger) =>
                    amountRow(`expense-${ledger.ledgerId}`, ledger.name, ledger.values, ledger.total, { nested: true }),
                  )}
                  {amountRow('closing-cash', 'Closing balance cash', data.closingCash, data.totals.closingCash, { emphasized: true })}
                  <tr className="bg-muted/60">
                    <th colSpan={data.locations.length + 2} className="border-b border-border px-3 py-2 text-left font-semibold">
                      Bank Summary
                    </th>
                  </tr>
                  {amountRow('opening-bank', 'Opening balance bank', data.openingBank, data.totals.openingBank, { emphasized: true })}
                  {amountRow('bank-receipts-total', 'Bank Receipt', data.bankReceiptTotal, data.totals.bankReceiptTotal, { emphasized: true })}
                  {amountRow('bank-receipts-by-sale', 'By Sale', data.bankReceiptBySale, data.totals.bankReceiptBySale, { nested: true })}
                  {amountRow('bank-receipt-vouchers', 'Bank Receipt Vouchers', data.bankReceiptVouchers, data.totals.bankReceiptVouchers, { nested: true })}
                  {amountRow('bank-balance', 'Balance', data.bankBalance, data.totals.bankBalance, { balance: true })}
                  {amountRow('bank-expenses', 'Bank Expense', data.bankExpenses, data.totals.bankExpenses, { emphasized: true })}
                  {data.bankExpenseLedgers.map((ledger) =>
                    amountRow(`bank-expense-${ledger.ledgerId}`, ledger.name, ledger.values, ledger.total, { nested: true }),
                  )}
                  {amountRow('reconciliation-pending', 'Reconciliation pending', data.reconciliationPending, data.totals.reconciliationPending, { emphasized: true })}
                  {amountRow('closing-bank', 'Closing balance bank', data.closingBank, data.totals.closingBank, { emphasized: true })}
                </tbody>
              </table>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="outline" onClick={shareMatrix} disabled={sharing} className="gap-2" data-testid="button-share-financial-matrix">
                {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                {sharing ? 'Preparing image…' : 'Share matrix'}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}