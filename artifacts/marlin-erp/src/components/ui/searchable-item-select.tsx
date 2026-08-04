import { useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { advanceFrom } from '@/lib/keyboard-entry';

/**
 * One searchable, scrollable item picker for every Item Master selector.
 *
 * The old pattern was a plain <Select> listing the whole Item Master, with all
 * the useful facts concatenated into one line ("Marlin Tender 1.5 kg — 17 avail
 * · MRP ₹380 · 5% GST"). That is unreadable at billing speed and gets worse as
 * the master grows. This renders a compact aligned table instead, with the
 * columns each screen actually needs.
 *
 * This is a PRESENTATION component. It shows the options it is handed and
 * nothing more — it performs no scoping, no stock maths and no authorisation.
 * Callers remain responsible for deciding which items may be listed (location
 * scope, active-only, stock-on-hand), and the server remains the authority on
 * all of it.
 */

export interface ItemOption {
  id: number;
  name: string;
  /** SKU / item code — searchable, and shown when the `code` column is on. */
  code?: string | null;
  /** HSN — searchable, and shown when the `hsn` column is on. */
  hsn?: string | null;
  /** Unit of measure, rendered next to `available`. */
  uom?: string | null;
  mrp?: number | null;
  gstRate?: number | null;
  available?: number | null;
}

/** Optional columns. `item` is always present and always takes the slack. */
export type ItemColumn = 'available' | 'mrp' | 'gst' | 'hsn' | 'code';

const COLUMN_META: Record<ItemColumn, { label: string; width: string; align: 'left' | 'right' }> = {
  code:      { label: 'SKU',       width: '104px', align: 'left'  },
  hsn:       { label: 'HSN',       width: '96px',  align: 'left'  },
  available: { label: 'Available', width: '104px', align: 'right' },
  mrp:       { label: 'MRP',       width: '88px',  align: 'right' },
  gst:       { label: 'GST',       width: '56px',  align: 'right' },
};

/** Render at most this many rows. Beyond it, searching is the way to narrow down. */
const MAX_ROWS = 200;

const money = (n: number) =>
  `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** 17 → "17", 17.50 → "17.5" — trailing zeros are noise in a dense table. */
const qty = (n: number) =>
  Number(n.toFixed(3)).toLocaleString('en-IN', { maximumFractionDigits: 3 });

interface Props {
  items: ItemOption[];
  /** Currently selected item id. 0 / null means nothing is selected. */
  value: number | null | undefined;
  onChange: (id: number) => void;
  /** Which optional columns to show, in order. Defaults to name only. */
  columns?: ItemColumn[];
  placeholder?: string;
  /** Shown when the search matches nothing. */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Keyboard Entry Mode: after picking an item, move focus to the next field of
   * the enclosing [data-kbd-scope] instead of returning it to this trigger.
   */
  advanceOnSelect?: boolean;
  /** Set on the trigger so tests and callers can target a specific row. */
  'data-testid'?: string;
  /**
   * Injected by shadcn's <FormControl> and forwarded verbatim to the trigger, so
   * the sibling <FormLabel htmlFor> still resolves to a real element and a
   * validation message is announced. Without these the label and the error are
   * silently orphaned — the control looks fine and is unusable to a screen reader.
   */
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

export function SearchableItemSelect({
  items,
  value,
  onChange,
  columns = [],
  placeholder = 'Select item',
  emptyLabel = 'No items found',
  disabled,
  className,
  advanceOnSelect,
  'data-testid': testId,
  id,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickedRef = useRef(false);

  const selected = useMemo(
    () => items.find(i => i.id === Number(value)),
    [items, value],
  );

  // Case-insensitive partial match over the three identifiers a user actually
  // knows the product by. Deliberately a plain substring test rather than fuzzy
  // scoring: typing "straw" must return every Strawberry, in master order, with
  // no surprise ranking.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.code ?? '').toLowerCase().includes(q) ||
      (i.hsn ?? '').toLowerCase().includes(q),
    );
  }, [items, query]);

  const visible = filtered.length > MAX_ROWS ? filtered.slice(0, MAX_ROWS) : filtered;

  // Header and rows share one grid template, which is what keeps the columns
  // aligned as the popover resizes.
  const gridTemplate = ['minmax(0,1fr)', ...columns.map(c => COLUMN_META[c].width)].join(' ');

  const cellValue = (item: ItemOption, col: ItemColumn) => {
    switch (col) {
      case 'code': return item.code || '—';
      case 'hsn':  return item.hsn || '—';
      case 'available':
        return item.available == null
          ? '—'
          : `${qty(Number(item.available))}${item.uom ? ` ${item.uom}` : ''}`;
      case 'mrp':
        return item.mrp == null || Number(item.mrp) <= 0 ? '—' : money(Number(item.mrp));
      case 'gst':
        return item.gstRate == null ? '—' : `${Number(item.gstRate)}%`;
    }
  };

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
          id={id}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          className={cn(
            'w-full justify-between font-normal',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate" title={selected?.name}>{selected?.name ?? placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-0"
        // Never narrower than the trigger, wide enough for the columns, and
        // never wider than the viewport — the last clause is what stops the
        // table overflowing on a phone.
        style={{
          width: `min(calc(100vw - 2rem), max(var(--radix-popover-trigger-width), ${columns.length ? 560 : 280}px))`,
        }}
        onCloseAutoFocus={e => {
          // After a selection, hop to the next field instead of back to the
          // trigger — Esc/outside-click still return focus to the trigger.
          if (advanceOnSelect && pickedRef.current) {
            pickedRef.current = false;
            e.preventDefault();
            advanceFrom(triggerRef.current);
          }
        }}
      >
        {/* Escape is closed explicitly rather than left to the dismiss layer: cmdk
            owns the keydown on the search input, and whether it lets Escape bubble
            has varied between versions. Closing here is idempotent with Radix's own
            handler, and on close Radix returns focus to the trigger so Tab can leave. */}
        <Command
          shouldFilter={false}
          onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
        >
          <CommandInput
            placeholder="Search item..."
            value={query}
            onValueChange={setQuery}
          />

          {/* Column header. Sits outside the scroll area, so it stays put while
              the results scroll under it. Hidden on narrow screens, where rows
              switch to a stacked layout that needs no header. */}
          {columns.length > 0 && (
            <div
              className="hidden sm:grid gap-2 px-3 py-1.5 border-b border-border bg-muted/40 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              <span>Item</span>
              {columns.map(c => (
                <span key={c} className={COLUMN_META[c].align === 'right' ? 'text-right' : ''}>
                  {COLUMN_META[c].label}
                </span>
              ))}
            </div>
          )}

          <CommandList className="max-h-[clamp(180px,42vh,320px)]">
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</div>
            ) : (
              <CommandGroup className="p-1">
                {visible.map(item => {
                  const isSelected = Number(value) === item.id;
                  return (
                    <CommandItem
                      key={item.id}
                      value={String(item.id)}
                      onSelect={() => { onChange(item.id); pickedRef.current = true; setOpen(false); setQuery(''); }}
                      className="cursor-pointer"
                    >
                      {/* Desktop: aligned columns. */}
                      <div
                        className="hidden sm:grid w-full items-center gap-2"
                        style={{ gridTemplateColumns: gridTemplate }}
                      >
                        <span className="flex min-w-0 items-center">
                          <Check className={cn('mr-1.5 h-3.5 w-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
                          <span className="truncate" title={item.name}>{item.name}</span>
                        </span>
                        {columns.map(c => (
                          <span
                            key={c}
                            className={cn(
                              'truncate tabular-nums',
                              COLUMN_META[c].align === 'right' ? 'text-right' : '',
                              c === 'code' || c === 'hsn' ? 'font-mono text-xs' : '',
                            )}
                          >
                            {cellValue(item, c)}
                          </span>
                        ))}
                      </div>

                      {/* Narrow screens: two lines rather than four cramped
                          columns — still labelled and separated, never re-run
                          together into one sentence. */}
                      <div className="sm:hidden w-full min-w-0">
                        <div className="flex items-center">
                          <Check className={cn('mr-1.5 h-3.5 w-3.5 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
                          <span className="truncate" title={item.name}>{item.name}</span>
                        </div>
                        {columns.length > 0 && (
                          // Inherit the row's own colour and dim it, rather than a fixed
                          // muted grey: on the highlighted row the grey sits on the accent
                          // fill and all but disappears.
                          <div className="mt-0.5 pl-5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs opacity-75">
                            {columns.map(c => (
                              <span key={c}>
                                {COLUMN_META[c].label}: <span className="tabular-nums font-medium">{cellValue(item, c)}</span>
                              </span>
                            ))}
                          </div>
                        )}
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
