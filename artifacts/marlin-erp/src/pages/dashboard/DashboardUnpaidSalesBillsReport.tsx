import { useMemo, useRef, useState } from 'react';
import type { DashboardUnpaidSalesBills as UnpaidSalesBillsData } from '@workspace/api-client-react';
import { Loader2, Receipt, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/app/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/pages/reports/shared';
import { measureReportCaptureDimensions } from './report-capture-size';

const ALL_SALESPERSONS = '__all_salespeople__';
const UNASSIGNED_SALESPERSON = '__unassigned_salesperson__';

export function DashboardUnpaidSalesBillsReport({
  data,
  isLoading,
  isError,
}: {
  data?: UnpaidSalesBillsData;
  isLoading: boolean;
  isError: boolean;
}) {
  const captureRef = useRef<HTMLDivElement>(null);
  const [selectedSalesperson, setSelectedSalesperson] = useState(ALL_SALESPERSONS);
  const [sharing, setSharing] = useState(false);
  const [preparingCapture, setPreparingCapture] = useState(false);

  const sortedSalespeople = useMemo(
    () => [...(data?.salespeople ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [data?.salespeople],
  );
  const visibleRows = useMemo(() => {
    const rows = data?.rows ?? [];
    if (selectedSalesperson === ALL_SALESPERSONS) return rows;
    if (selectedSalesperson === UNASSIGNED_SALESPERSON) {
      return rows.filter((row) => row.salespersonEmployeeId == null);
    }
    const employeeId = Number(selectedSalesperson);
    return rows.filter((row) => row.salespersonEmployeeId === employeeId);
  }, [data?.rows, selectedSalesperson]);
  const totalUnpaid = Math.round(
    visibleRows.reduce((total, row) => total + Number(row.unpaidAmount ?? 0), 0) * 100,
  ) / 100;
  const selectedName = selectedSalesperson === ALL_SALESPERSONS
    ? 'All salespeople'
    : selectedSalesperson === UNASSIGNED_SALESPERSON
      ? 'Unassigned'
      : sortedSalespeople.find((person) => String(person.employeeId) === selectedSalesperson)?.name ?? 'Selected salesperson';

  const shareReport = async () => {
    if (sharing) return;
    if (isLoading) {
      toast.info('Unpaid sales bills are still loading — try again in a moment');
      return;
    }
    if (isError || !data) {
      toast.error('Unpaid sales bills are unavailable');
      return;
    }
    if (visibleRows.length === 0) {
      toast.info('There are no unpaid bills to share for this selection');
      return;
    }
    const element = captureRef.current;
    if (!element) {
      toast.error('Could not capture the unpaid sales bills report');
      return;
    }

    setSharing(true);
    setPreparingCapture(true);
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await document.fonts.ready;
      const { toBlob } = await import('html-to-image');
      const table = element.querySelector<HTMLTableElement>('table');
      if (!table) throw new Error('unpaid sales bills table not found');
      const dimensions = measureReportCaptureDimensions(element);
      const blob = await toBlob(element, {
        backgroundColor: '#ffffff',
        width: dimensions.width,
        height: dimensions.height,
        pixelRatio: 2,
        cacheBust: true,
        style: { overflow: 'visible' },
        filter: (node) => !(node instanceof HTMLElement && node.dataset.captureExclude === 'true'),
      });
      if (!blob) throw new Error('empty report image');

      const file = new File([blob], 'unpaid-sales-bills.png', { type: 'image/png' });
      const canShareFile = typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
        && navigator.canShare({ files: [file] });
      if (canShareFile) {
        try {
          await navigator.share({ files: [file], title: `Unpaid Sales Bills — ${selectedName}` });
          return;
        } catch (shareError: any) {
          if (shareError?.name === 'AbortError') return;
          console.warn('[dashboard] unpaid sales bills native share failed; downloading image instead', shareError);
        }
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Unpaid sales bills image downloaded');
    } catch (error) {
      console.error('[dashboard] unpaid sales bills share failed', error);
      toast.error('Could not create the unpaid sales bills image');
    } finally {
      setPreparingCapture(false);
      setSharing(false);
    }
  };

  return (
    <div className="relative">
      <div ref={captureRef} data-testid="unpaid-sales-bills-capture">
        <Card className="border-card-border bg-card shadow-sm" data-report-card>
          <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Receipt className="h-5 w-5 text-primary" />
                Unpaid Sales Bills
              </CardTitle>
              <CardDescription className="mt-1.5">
                Per-invoice dues; customer ledger balance may include credits or extra payments from other invoices · {selectedName}
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2" data-capture-exclude="true">
              <label className="sr-only" htmlFor="unpaid-salesperson-filter">Filter by salesperson</label>
              <Select value={selectedSalesperson} onValueChange={setSelectedSalesperson}>
                <SelectTrigger
                  id="unpaid-salesperson-filter"
                  aria-label="Filter unpaid bills by salesperson"
                  className="w-[min(11rem,42vw)]"
                  data-testid="select-unpaid-salesperson"
                >
                  <SelectValue placeholder="All salespeople" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SALESPERSONS}>All</SelectItem>
                  {sortedSalespeople.map((person) => (
                    <SelectItem
                      key={person.employeeId == null ? UNASSIGNED_SALESPERSON : person.employeeId}
                      value={person.employeeId == null ? UNASSIGNED_SALESPERSON : String(person.employeeId)}
                    >
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={shareReport}
                disabled={sharing}
                aria-label={sharing ? 'Preparing unpaid sales bills image' : 'Share unpaid sales bills'}
                data-testid="button-share-unpaid-sales-bills"
              >
                {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                {sharing ? 'Preparing…' : 'Share'}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2" aria-label="Loading unpaid sales bills">
                {[0, 1, 2].map((row) => <Skeleton key={row} className="h-10" />)}
              </div>
            ) : isError || !data ? (
              <EmptyState icon={Receipt} title="Unpaid sales bills unavailable" hint="Refresh the dashboard to try again." compact />
            ) : visibleRows.length === 0 ? (
              <EmptyState icon={Receipt} title="No unpaid bills for this selection" compact />
            ) : (
              <div className={`${preparingCapture ? 'overflow-visible' : 'overflow-x-auto'} w-full max-w-full rounded-lg border border-border`}>
                <table className="w-full border-collapse text-sm" data-testid="table-unpaid-sales-bills">
                  <caption className="sr-only">Unpaid sales bills by salesperson</caption>
                  <thead>
                    <tr className="bg-muted/40">
                      <th scope="col" className="whitespace-nowrap border border-border px-2 py-1 text-left font-semibold">Sales Man</th>
                      <th scope="col" className="border border-border px-2 py-1 text-left font-semibold">Vendor</th>
                      <th scope="col" className="whitespace-nowrap border border-border px-2 py-1 text-left font-semibold">Bill no</th>
                      <th scope="col" className="border border-border px-2 py-1 text-left font-semibold">Location</th>
                      <th scope="col" className="whitespace-nowrap border border-border px-2 py-1 text-right font-semibold">Bill amount</th>
                      <th scope="col" className="whitespace-nowrap border border-border px-2 py-1 text-right font-semibold">Invoice due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <tr key={row.saleId} className="hover:bg-muted/20">
                        <td className="border border-border px-2 py-1">{row.salespersonName}</td>
                        <td className="border border-border px-2 py-1">{row.customerName}</td>
                        <td className="border border-border px-2 py-1">{row.invoiceNumber}</td>
                        <td className="border border-border px-2 py-1">{row.locationName}</td>
                        <td className="whitespace-nowrap border border-border px-2 py-1 text-right font-mono tabular-nums">
                          {fmt(row.billAmount)}
                        </td>
                        <td className="whitespace-nowrap border border-border px-2 py-1 text-right font-mono tabular-nums">
                          {fmt(row.unpaidAmount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-primary/10 font-bold" data-testid="row-unpaid-sales-bills-total">
                      <th scope="row" colSpan={5} className="border border-border px-2 py-1 text-left">Total invoice dues</th>
                      <td className="whitespace-nowrap border border-border px-2 py-1 text-right font-mono tabular-nums">
                        {fmt(totalUnpaid)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
