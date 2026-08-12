import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Standard table pagination footer — 25 / 50 / 100 rows per page, Prev/Next,
 * and a "Showing x–y of N" readout. One look everywhere (brief §35).
 *
 * Works for BOTH modes:
 *  • server-paged lists — parent owns page/pageSize and refetches;
 *  • client-paged lists — pair with useClientPage() below.
 *
 * Renders nothing while the list fits inside the smallest page size, so small
 * tables stay exactly as they are today.
 */
export const PAGE_SIZES = [25, 50, 100] as const;

interface TablePagerProps {
  page: number;              // 1-based
  pageSize: number;
  total: number;             // total row count across all pages
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  /** Keep the pager visible even for small lists (default: hide under 26 rows). */
  alwaysShow?: boolean;
  isFetching?: boolean;
  className?: string;
}

export function TablePager({
  page, pageSize, total, onPageChange, onPageSizeChange, alwaysShow, isFetching, className,
}: TablePagerProps) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (!alwaysShow && total <= PAGE_SIZES[0]) return null;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 px-1 py-2 ${className ?? ''}`}>
      <p className="text-xs text-muted-foreground">
        Showing {from.toLocaleString('en-IN')}–{to.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}
        {isFetching ? ' · refreshing…' : ''}
      </p>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="hidden sm:inline">Rows per page</span>
          <Select value={String(pageSize)} onValueChange={v => { onPageSizeChange(Number(v)); onPageChange(1); }}>
            <SelectTrigger className="h-8 w-[72px]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map(s => <SelectItem key={s} value={String(s)}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-8 px-2" disabled={page <= 1}
                  onClick={() => onPageChange(page - 1)} aria-label="Previous page">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-xs text-muted-foreground px-1 whitespace-nowrap">
            Page {Math.min(page, pages)} / {pages}
          </span>
          <Button variant="outline" size="sm" className="h-8 px-2" disabled={page >= pages}
                  onClick={() => onPageChange(page + 1)} aria-label="Next page">
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Client-side paging over an already-fetched (and already filtered/sorted)
 * array. Resets to page 1 whenever the row set changes size — a filter or
 * search upstream just changed the list, and staying on page 7 of a 2-page
 * result shows an empty table.
 *
 *   const { pageRows, pagerProps } = useClientPage(sortedRows);
 *   … render pageRows …
 *   <TablePager {...pagerProps} />
 */
export function useClientPage<T>(rows: readonly T[], defaultSize: number = 50) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultSize);

  useEffect(() => { setPage(1); }, [rows.length]);

  const safePage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  const pageRows = useMemo(
    () => rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [rows, safePage, pageSize],
  );

  return {
    pageRows,
    page: safePage,
    pageSize,
    pagerProps: {
      page: safePage,
      pageSize,
      total: rows.length,
      onPageChange: setPage,
      onPageSizeChange: setPageSize,
    },
  };
}
