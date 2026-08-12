import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'positive' | 'negative' | 'warning' | 'info';

const TONE_ICON: Record<Tone, string> = {
  default:  'bg-primary/10 text-primary',
  positive: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  negative: 'bg-red-500/10 text-red-600 dark:text-red-400',
  warning:  'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  info:     'bg-blue-500/10 text-blue-600 dark:text-blue-400',
};

const TONE_VALUE: Record<Tone, string> = {
  default:  '',
  positive: 'text-emerald-600 dark:text-emerald-400',
  negative: 'text-red-600 dark:text-red-400',
  warning:  'text-amber-600 dark:text-amber-400',
  info:     '',
};

/**
 * SummaryCard — one KPI tile in the row of summary cards under the page header.
 *
 * Use inside <SummaryCardGrid>. `value` should already be formatted
 * (₹ formatting stays with the caller so paise rules are never re-invented).
 */
export function SummaryCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'default',
  loading = false,
  onClick,
  className,
}: {
  label: string;
  value: ReactNode;
  /** Small secondary line under the value (e.g. "12 bills") */
  sub?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  loading?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <Card
      onClick={onClick}
      className={cn(
        'shadow-sm',
        onClick && 'cursor-pointer transition-colors hover:border-primary/40',
        className,
      )}
    >
      <CardContent className="p-4 flex items-start gap-3">
        {Icon && (
          <span className={cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', TONE_ICON[tone])}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide truncate">{label}</p>
          {loading ? (
            <Skeleton className="mt-1.5 h-6 w-24" />
          ) : (
            <p className={cn('mt-0.5 text-xl font-semibold tabular-nums truncate', TONE_VALUE[tone])}>{value}</p>
          )}
          {sub != null && !loading && (
            <p className="mt-0.5 text-xs text-muted-foreground truncate">{sub}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Responsive grid wrapper for SummaryCards (2-up on tablet, 4-up on desktop). */
export function SummaryCardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4', className)}>
      {children}
    </div>
  );
}
