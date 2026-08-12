import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * EmptyState — standard "nothing here" block for tables, lists and tabs.
 *
 * Two flavours:
 *   • no data yet        → explain what will appear + optional action button
 *   • no search results  → say the filters matched nothing (caller passes hint)
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  hint,
  action,
  className,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  /** Optional call-to-action (e.g. <Button>New Sale</Button>) */
  action?: ReactNode;
  className?: string;
  /** Tighter padding for use inside table cells */
  compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'py-8' : 'py-16', className)}>
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-6 w-6" />
      </span>
      <p className="mt-3 text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground max-w-sm">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
