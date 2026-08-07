import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * Searchable, scrollable picker for choosing a source document (sales invoice,
 * purchase bill) out of a long list — e.g. when recording a return.
 *
 * The old pattern was a plain <Select> that rendered every bill as one flat
 * row: no search box, and with hundreds of bills the only way to reach an old
 * one was to scroll blindly. This searches over the bill number AND the party
 * name, shows the amount and date alongside, and caps the rendered rows so the
 * popover stays fast — typing is the way to narrow down.
 *
 * PRESENTATION component: it shows the options it is handed and nothing more.
 * Callers keep deciding which documents are eligible.
 */

export interface BillOption {
  id: number;
  /** Document number, e.g. "B2B/26-27/92". Falls back handled by caller. */
  number: string;
  /** Counterparty — customer or vendor name. */
  party: string;
  /** Bill total, pre-formatted not required — formatted here. */
  amount?: number | string | null;
  /** ISO date, shown dimmed on the right. */
  date?: string | null;
}

/** Render at most this many rows; beyond it, searching narrows down. */
const MAX_ROWS = 200;

const money = (n: unknown) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const dshort = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';

interface Props {
  options: BillOption[];
  /** Selected document id. 0 / null means nothing selected. */
  value: number | null | undefined;
  onChange: (id: number) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function BillCombobox({
  options,
  value,
  onChange,
  placeholder = 'Select bill…',
  searchPlaceholder = 'Search bill no. or name…',
  emptyLabel = 'No bills found',
  disabled,
  className,
  'data-testid': testId,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = useMemo(
    () => options.find(o => o.id === Number(value)),
    [options, value],
  );

  // Plain case-insensitive substring match over the two things a user knows a
  // bill by — its number and the party — in list order, no fuzzy ranking.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o =>
      o.number.toLowerCase().includes(q) ||
      o.party.toLowerCase().includes(q),
    );
  }, [options, query]);

  const visible = filtered.length > MAX_ROWS ? filtered.slice(0, MAX_ROWS) : filtered;

  return (
    <Popover open={open} onOpenChange={v => { setOpen(v); if (!v) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId}
          className={cn('w-full justify-between font-normal', !selected && 'text-muted-foreground', className)}
        >
          <span className="truncate" title={selected ? `${selected.number} — ${selected.party}` : undefined}>
            {selected ? `${selected.number} — ${selected.party}` : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-0"
        // Never narrower than the trigger, wide enough to read a bill line,
        // never wider than the viewport (phones).
        style={{ width: 'min(calc(100vw - 2rem), max(var(--radix-popover-trigger-width), 420px))' }}
      >
        {/* Escape closed explicitly — cmdk owns the keydown on the search input
            and whether it lets Escape bubble has varied between versions. */}
        <Command shouldFilter={false} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[clamp(180px,42vh,320px)]">
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</div>
            ) : (
              <CommandGroup className="p-1">
                {visible.map(o => {
                  const isSelected = Number(value) === o.id;
                  return (
                    <CommandItem
                      key={o.id}
                      value={String(o.id)}
                      onSelect={() => { onChange(o.id); setOpen(false); setQuery(''); }}
                      className="cursor-pointer"
                    >
                      <Check className={cn('mr-1.5 h-3.5 w-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate font-medium">{o.number}</span>
                          <span className="shrink-0 font-mono text-xs tabular-nums">{money(o.amount)}</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 text-xs opacity-75">
                          <span className="truncate">{o.party}</span>
                          {o.date ? <span className="shrink-0 tabular-nums">{dshort(o.date)}</span> : null}
                        </div>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {filtered.length > MAX_ROWS && (
              <div className="border-t border-border px-3 py-1.5 text-center text-[11px] text-muted-foreground">
                Showing first {MAX_ROWS} of {filtered.length} — keep typing to narrow down
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
