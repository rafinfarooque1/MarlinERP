import { useRef, useState } from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { advanceFrom } from '@/lib/keyboard-entry';

/**
 * Smart Dropdown — the ONE searchable single-select for large entity lists
 * (customers, vendors, employees, ledgers, bank accounts, batches, …).
 *
 * Same conventions as AccountCombobox / SearchableItemSelect (cmdk inside
 * CommandList, keyboard-entry advance, trigger-width popover) but generic:
 * options are plain {id, label, sublabel?}. Use the specialised comboboxes
 * where they already exist; reach for this one everywhere else instead of a
 * plain <Select> over a mapped entity list.
 */
export interface EntityOption {
  id: number;
  label: string;
  /** Dimmed right-aligned hint — code, phone, balance, branch, … */
  sublabel?: string | null;
}

interface Props {
  options: EntityOption[];
  /** null/0 = nothing selected. */
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  /** Show an inline ✕ to clear the selection (sends null). */
  clearable?: boolean;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  /** Keyboard Entry Mode: move focus to the next [data-kbd-scope] field after picking. */
  advanceOnSelect?: boolean;
  'data-testid'?: string;
  'data-field'?: string;
}

const MAX_VISIBLE = 200;

export function EntityCombobox({
  options, value, onChange,
  placeholder = 'Select…', searchPlaceholder = 'Search…', emptyLabel = 'No results found.',
  clearable, loading, disabled, className, advanceOnSelect,
  'data-testid': testId,
  'data-field': dataField,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickedRef = useRef(false);

  const selected = value ? options.find(o => o.id === value) : undefined;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(o => o.label.toLowerCase().includes(q) || (o.sublabel ?? '').toLowerCase().includes(q))
    : options;
  const visible = filtered.slice(0, MAX_VISIBLE);

  return (
    <Popover open={open} onOpenChange={v => { setOpen(v); if (!v) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId}
          data-field={dataField}
          className={cn(
            'w-full justify-between font-normal h-10 px-3',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <span className="ml-2 flex items-center gap-1 shrink-0">
            {clearable && selected ? (
              <X
                className="h-3.5 w-3.5 opacity-50 hover:opacity-100"
                aria-label="Clear selection"
                onClick={e => { e.stopPropagation(); e.preventDefault(); onChange(null); }}
              />
            ) : null}
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-0"
        style={{ width: 'var(--radix-popover-trigger-width)', minWidth: '240px' }}
        onCloseAutoFocus={e => {
          if (advanceOnSelect && pickedRef.current) {
            pickedRef.current = false;
            e.preventDefault();
            advanceFrom(triggerRef.current);
          }
        }}
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          {/* cmdk keyboard navigation only sees items inside CommandList. */}
          <CommandList className="max-h-56">
            {loading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
            ) : (
              <>
                <CommandEmpty>{emptyLabel}</CommandEmpty>
                <CommandGroup>
                  {visible.map(opt => (
                    <CommandItem
                      key={opt.id}
                      value={String(opt.id)}
                      onSelect={() => { onChange(opt.id); pickedRef.current = true; setOpen(false); setQuery(''); }}
                    >
                      <Check className={cn('mr-2 h-4 w-4 shrink-0', value === opt.id ? 'opacity-100' : 'opacity-0')} />
                      <span className="truncate">{opt.label}</span>
                      {opt.sublabel ? (
                        <span className="ml-auto pl-3 text-xs text-muted-foreground shrink-0">{opt.sublabel}</span>
                      ) : null}
                    </CommandItem>
                  ))}
                  {filtered.length > MAX_VISIBLE ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      Showing first {MAX_VISIBLE} — type to narrow down.
                    </div>
                  ) : null}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
