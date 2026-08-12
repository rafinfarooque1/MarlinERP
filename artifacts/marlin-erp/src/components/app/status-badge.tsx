import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * StatusBadge — ONE way to render a document/record status everywhere.
 *
 * Colour semantics:
 *   green  = settled / good      (paid, active, approved, completed, received…)
 *   amber  = needs attention     (partial, pending, draft, near expiry…)
 *   red    = problem / stopped   (unpaid, cancelled, expired, rejected, inactive…)
 *   blue   = informational state (credit, in transit, converted, locked…)
 *   gray   = neutral / terminal  (closed, archived, n/a)
 *
 * Unknown statuses render gray with the raw text so new backend states are
 * never invisible. Pass `label` to override display text (e.g. Hindi/short).
 */
type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray';

const TONE_CLASS: Record<Tone, string> = {
  green: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25',
  red:   'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/25',
  blue:  'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/25',
  gray:  'bg-muted text-muted-foreground border-border',
};

const STATUS_MAP: Record<string, { tone: Tone; label: string }> = {
  // payment / settlement
  paid:        { tone: 'green', label: 'Paid' },
  settled:     { tone: 'green', label: 'Settled' },
  partial:     { tone: 'amber', label: 'Partial' },
  partially_paid: { tone: 'amber', label: 'Partial' },
  unpaid:      { tone: 'red',   label: 'Unpaid' },
  overdue:     { tone: 'red',   label: 'Overdue' },
  credit:      { tone: 'blue',  label: 'Credit' },
  refunded:    { tone: 'blue',  label: 'Refunded' },
  // documents / workflow
  draft:       { tone: 'amber', label: 'Draft' },
  pending:     { tone: 'amber', label: 'Pending' },
  approved:    { tone: 'green', label: 'Approved' },
  rejected:    { tone: 'red',   label: 'Rejected' },
  cancelled:   { tone: 'red',   label: 'Cancelled' },
  completed:   { tone: 'green', label: 'Completed' },
  converted:   { tone: 'blue',  label: 'Converted' },
  open:        { tone: 'amber', label: 'Open' },
  closed:      { tone: 'gray',  label: 'Closed' },
  locked:      { tone: 'blue',  label: 'Locked' },
  // transfers / stock
  dispatched:  { tone: 'blue',  label: 'Dispatched' },
  in_transit:  { tone: 'blue',  label: 'In Transit' },
  received:    { tone: 'green', label: 'Received' },
  expired:     { tone: 'red',   label: 'Expired' },
  near_expiry: { tone: 'amber', label: 'Near Expiry' },
  // people / masters
  active:      { tone: 'green', label: 'Active' },
  inactive:    { tone: 'red',   label: 'Inactive' },
  on_leave:    { tone: 'amber', label: 'On Leave' },
  left:        { tone: 'gray',  label: 'Left' },
};

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: string | null | undefined;
  /** Override display text; tone still derives from `status`. */
  label?: string;
  className?: string;
}) {
  const key = String(status ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const def = STATUS_MAP[key] ?? { tone: 'gray' as Tone, label: String(status ?? '—') };
  return (
    <Badge
      variant="outline"
      className={cn('font-medium text-xs whitespace-nowrap', TONE_CLASS[def.tone], className)}
    >
      {label ?? def.label}
    </Badge>
  );
}
