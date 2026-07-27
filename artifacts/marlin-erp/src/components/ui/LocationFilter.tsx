/**
 * LocationFilter — reusable warehouse / outlet picker
 *
 * value format:  'all' | 'warehouse:<id>' | 'outlet:<id>'
 */
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LocationFilterProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  /** When true, shows only outlets that belong to the given warehouseId */
  warehouseId?: number;
}

export function LocationFilter({
  value, onChange,
  placeholder = 'All Locations',
  className,
  warehouseId,
}: LocationFilterProps) {
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets    = [] } = useListOutlets();

  const visibleWarehouses = warehouses as any[];
  const visibleOutlets    = warehouseId
    ? (outlets as any[]).filter(o => Number(o.warehouseId) === warehouseId)
    : (outlets as any[]);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn('h-8 text-sm gap-1.5 min-w-[170px]', className)}>
        <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All Locations</SelectItem>

        {visibleWarehouses.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 py-1">
              Warehouses
            </SelectLabel>
            {visibleWarehouses.map((w: any) => (
              <SelectItem key={`warehouse:${w.id}`} value={`warehouse:${w.id}`}>
                {w.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}

        {visibleOutlets.length > 0 && (
          <SelectGroup>
            <SelectLabel className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 py-1">
              Outlets
            </SelectLabel>
            {visibleOutlets.map((o: any) => (
              <SelectItem key={`outlet:${o.id}`} value={`outlet:${o.id}`}>
                {o.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

/** Parse a LocationFilter value string into { type, id } */
export function parseLocationFilter(v: string): { type: 'all' | 'warehouse' | 'outlet'; id: number | null } {
  if (!v || v === 'all') return { type: 'all', id: null };
  const [type, idStr] = v.split(':');
  return { type: type as 'warehouse' | 'outlet', id: Number(idStr) };
}
