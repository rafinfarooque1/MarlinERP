import type { ReactNode } from 'react';

export interface DashboardLocationLine {
  label: string;
  value: string;
}

/**
 * Canonical location-row layout shared by the live dashboard and its
 * screenshot/print report. The amount is always shrink-0 so mobile never
 * clips the financial figure.
 */
export function DashboardLocationBreakdown({
  lines,
  className = '',
}: {
  lines: DashboardLocationLine[];
  className?: string;
}): ReactNode {
  return (
    <div className={`space-y-0.5 text-left ${className}`.trim()}>
      {lines.map((line) => (
        <div key={line.label} className="flex items-start justify-between gap-2 leading-tight">
          <span className="min-w-0 truncate">{line.label}</span>
          <span className="shrink-0 font-mono tabular-nums">{line.value}</span>
        </div>
      ))}
    </div>
  );
}