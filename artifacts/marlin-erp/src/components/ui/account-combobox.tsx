import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

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
}

export function AccountCombobox({
  options, value, onChange, placeholder = 'Select account', disabled, className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = options.find(o => o.id === value);
  const filtered = query.trim()
    ? options.filter(o => o.name.toLowerCase().includes(query.toLowerCase()))
    : options;

  return (
    <Popover open={open} onOpenChange={v => { setOpen(v); if (!v) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
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
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandEmpty>No accounts found.</CommandEmpty>
          <CommandGroup className="max-h-56 overflow-auto">
            {filtered.map(opt => (
              <CommandItem
                key={opt.id}
                value={String(opt.id)}
                onSelect={() => { onChange(opt.id); setOpen(false); setQuery(''); }}
              >
                <Check className={cn('mr-2 h-4 w-4 shrink-0', value === opt.id ? 'opacity-100' : 'opacity-0')} />
                {opt.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
