import { useRef, useState } from 'react';
import type { DashboardLocationSalesRow } from '@workspace/api-client-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/app/empty-state';
import { Loader2, MapPin, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { DashboardLocationSalesTable } from './DashboardLocationSalesTable';

export function DashboardLocationSalesReportCard({
  rows,
  isLoading,
  isError,
  description,
  fromDate,
  toDate,
}: {
  rows?: DashboardLocationSalesRow[];
  isLoading: boolean;
  isError: boolean;
  description: string;
  fromDate?: string;
  toDate?: string;
}) {
  const captureRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);
  const [preparingCapture, setPreparingCapture] = useState(false);

  const shareReport = async () => {
    if (sharing) return;
    if (isLoading) {
      toast.info('Location report is still loading — try again in a moment');
      return;
    }
    if (isError || !Array.isArray(rows)) {
      toast.error('Location report is unavailable');
      return;
    }
    if (rows.length === 0) {
      toast.info('There are no locations to share for this report');
      return;
    }

    const captureTarget = captureRef.current;
    if (!captureTarget) {
      console.error('[dashboard] location report share: capture node not mounted');
      toast.error('Could not capture the location report');
      return;
    }

    console.debug('[dashboard] location report share: capturing…');
    setSharing(true);
    setPreparingCapture(true);
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      await document.fonts.ready;
      const { toBlob } = await import('html-to-image');
      const table = captureTarget.querySelector<HTMLTableElement>('table');
      if (!table) throw new Error('location sales table not found');

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

      console.debug('[dashboard] location report share: capture bounds', {
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
      if (!blob) throw new Error('empty location report image');

      const dateSlug = fromDate && toDate
        ? (fromDate === toDate ? fromDate : `${fromDate}_to_${toDate}`)
        : toDate
          ? `all-time-through-${toDate}`
          : 'all-time';
      const file = new File([blob], `sales-outstanding-by-location-${dateSlug}.png`, {
        type: 'image/png',
      });
      const canShareFile = typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
        && navigator.canShare({ files: [file] });
      if (canShareFile) {
        try {
          await navigator.share({ files: [file], title: 'Sales & Outstanding by Location' });
          return;
        } catch (shareError: any) {
          if (shareError?.name === 'AbortError') return;
          console.warn(
            '[dashboard] location report native share failed; downloading image instead',
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
      toast.success('Location report image downloaded');
    } catch (error) {
      console.error('[dashboard] location report share failed', error);
      toast.error('Could not create the location report image');
    } finally {
      setPreparingCapture(false);
      setSharing(false);
    }
  };

  return (
    <div className="relative">
      <div ref={captureRef} data-testid="location-sales-share-capture">
        <Card className="border-card-border bg-card shadow-sm flex flex-col">
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 pb-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-lg flex items-center gap-2">
                <MapPin className="h-5 w-5 text-primary" />
                Sales &amp; Outstanding by Location
              </CardTitle>
              <CardDescription className="mt-1.5">{description}</CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 gap-2"
              onClick={shareReport}
              disabled={sharing}
              aria-label={sharing ? 'Preparing location report image' : 'Share location report'}
              data-testid="button-share-location-sales"
              data-capture-exclude="true"
            >
              {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              {sharing ? 'Preparing…' : 'Share'}
            </Button>
          </CardHeader>
          <CardContent className="flex-1">
            {isLoading ? (
              <div className="space-y-2" aria-label="Loading location sales report">
                {[0, 1, 2].map((row) => <Skeleton key={row} className="h-10" />)}
              </div>
            ) : isError || !Array.isArray(rows) ? (
              <EmptyState icon={MapPin} title="Location report unavailable" compact />
            ) : rows.length === 0 ? (
              <EmptyState icon={MapPin} title="No locations in scope" compact />
            ) : (
              <DashboardLocationSalesTable rows={rows} captureMode={preparingCapture} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
