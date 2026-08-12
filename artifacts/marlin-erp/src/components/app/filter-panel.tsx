import { useState, type ReactNode } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * FilterPanel — standard collapsible filter area for list pages.
 *
 * Usage:
 *   <FilterPanel activeCount={n} onClear={reset}>
 *     ...selects / date pickers laid out by the caller...
 *   </FilterPanel>
 *
 * The always-visible search input stays OUTSIDE this panel (search is not a
 * filter). `activeCount` should count non-default filter values so the badge
 * tells the user the list is narrowed even when the panel is closed.
 */
export function FilterPanel({
  activeCount = 0,
  onClear,
  children,
  className,
  defaultOpen = false,
}: {
  activeCount?: number;
  onClear?: () => void;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || activeCount > 0);
  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={open || activeCount > 0 ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setOpen(o => !o)}
          className="gap-1.5"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {activeCount > 0 && (
            <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {activeCount}
            </span>
          )}
        </Button>
        {activeCount > 0 && onClear && (
          <Button type="button" variant="ghost" size="sm" onClick={onClear} className="gap-1 text-muted-foreground">
            <X className="h-3.5 w-3.5" /> Clear
          </Button>
        )}
      </div>
      <div
        className={cn(
          'grid gap-3 rounded-lg border border-border bg-muted/30 p-3 mt-2 sm:grid-cols-2 lg:grid-cols-4',
          !open && 'hidden',
        )}
      >
        {children}
      </div>
    </div>
  );
}
