import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * PageHeader — standard page top block.
 *
 * Every page starts with this: title (+ optional icon), one-line description,
 * and primary actions on the right. Keep actions to at most two buttons; put
 * secondary actions in a dropdown.
 */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** Right-aligned action buttons */
  actions?: ReactNode;
  /** Optional extra row under the header (e.g. tabs) */
  children?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            {Icon && (
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                <Icon className="h-5 w-5" />
              </span>
            )}
            <span className="truncate">{title}</span>
          </h1>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground max-w-2xl">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
