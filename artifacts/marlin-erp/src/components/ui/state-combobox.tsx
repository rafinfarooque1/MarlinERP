import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { INDIAN_STATES } from '@/lib/indianStates';
import { cn } from '@/lib/utils';

/**
 * One searchable State picker for every State field in the ERP.
 *
 * The old pattern was a plain <Select> listing all 36 states/UTs — endless
 * scrolling and no typing — and two forms (Warehouse, Outlet) were free-text
 * inputs that accepted typos GST logic later trips over. This is the shared
 * replacement: type a few letters ("kar" → Karnataka), arrow keys + Enter to
 * pick, Escape to close, wheel scrolling in the list.
 *
 * PRESENTATION component only — it never rewrites stored data. A legacy value
 * that is not in INDIAN_STATES (old free-text rows) still displays on the
 * trigger and is listed as a selectable "(as saved)" row, so opening and
 * closing the form never silently drops what the record already holds.
 */

interface Props {
  value: string | null | undefined;
  onChange: (state: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
  /** Injected by shadcn's <FormControl>; forwarded so the FormLabel and any
   *  validation message stay wired to a real element. */
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

export function StateCombobox({
  value,
  onChange,
  placeholder = 'Select state',
  disabled,
  className,
  'data-testid': testId,
  id,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const current = (value ?? '').trim();
  // Legacy free-text values (or old casings) stay visible and re-selectable.
  const isLegacy = current !== '' && !INDIAN_STATES.some(s => s === current);
  const options: string[] = useMemo(
    () => (isLegacy ? [current, ...INDIAN_STATES] : [...INDIAN_STATES]),
    [isLegacy, current],
  );

  // Plain case-insensitive substring — "kar" → Karnataka, "tam" → Tamil Nadu.
  // No fuzzy scoring: the list is short and alphabetical order is predictable.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(s => s.toLowerCase().includes(q));
  }, [options, query]);

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
          id={id}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          className={cn(
            'w-full justify-between font-normal',
            !current && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate" title={current || undefined}>{current || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-0"
        style={{ width: 'max(var(--radix-popover-trigger-width), 260px)' }}
      >
        {/* Escape closed explicitly — cmdk owns the keydown on the search input
            and whether it lets Escape bubble has varied between versions. */}
        <Command
          shouldFilter={false}
          onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
        >
          <CommandInput
            placeholder="Type to search state..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[clamp(180px,40vh,300px)]">
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">No state matches</div>
            ) : (
              <CommandGroup className="p-1">
                {filtered.map(s => (
                  <CommandItem
                    key={s}
                    value={s}
                    onSelect={() => { onChange(s); setOpen(false); setQuery(''); }}
                    className="cursor-pointer"
                  >
                    <Check className={cn('mr-1.5 h-3.5 w-3.5 shrink-0', s === current ? 'opacity-100' : 'opacity-0')} />
                    <span className="truncate">{s}</span>
                    {isLegacy && s === current && (
                      <span className="ml-auto text-[10px] text-muted-foreground">(as saved)</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
