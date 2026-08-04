import { useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { advanceFrom } from '@/lib/keyboard-entry';

export interface AccountOption {
  id: number;
  name: string;
  code?: string | null;
  parentId?: number | null;
}

interface Props {
  options: AccountOption[];
  value: number;          // 0 = nothing selected
  onChange: (id: number) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Keyboard Entry Mode: after picking an option, move focus to the next field
   * of the enclosing [data-kbd-scope] instead of returning it to this trigger.
   */
  advanceOnSelect?: boolean;
  'data-testid'?: string;
  /** Enables focusField('<name>') to land here on validation errors. */
  'data-field'?: string;
}

export function AccountCombobox({
  options, value, onChange, placeholder = 'Select account', disabled, className,
  advanceOnSelect,
  'data-testid': testId,
  'data-field': dataField,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickedRef = useRef(false);

  const selected = options.find(o => o.id === value);
  const filtered = query.trim()
    ? options.filter(o => o.name.toLowerCase().includes(query.toLowerCase()))
    : options;

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
          <span className="truncate">{selected?.name ?? placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="p-0"
        style={{ width: 'var(--radix-popover-trigger-width)', minWidth: '220px' }}
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
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search…"
            value={query}
            onValueChange={setQuery}
          />
          {/* cmdk v1 keyboard navigation (arrows/Enter) only sees items inside
              CommandList — without it, nothing highlights and Enter is a no-op. */}
          <CommandList className="max-h-56">
            <CommandEmpty>No accounts found.</CommandEmpty>
            <CommandGroup>
              {filtered.map(opt => (
                <CommandItem
                  key={opt.id}
                  value={String(opt.id)}
                  onSelect={() => { onChange(opt.id); pickedRef.current = true; setOpen(false); setQuery(''); }}
                >
                  <Check className={cn('mr-2 h-4 w-4 shrink-0', value === opt.id ? 'opacity-100' : 'opacity-0')} />
                  {opt.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
