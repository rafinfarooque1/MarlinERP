/**
 * Two-step LocationFilter
 *
 * Step 1 — branch type:  All | Head Office | Warehouse | Outlet
 * Step 2 — specific loc: All [type] | <name> …  (only shown for Warehouse/Outlet)
 *
 * value format:
 *   'all'            — every location
 *   'headoffice'     — head-office only
 *   'warehouse:all'  — all warehouses
 *   'warehouse:<id>' — specific warehouse
 *   'outlet:all'     — all outlets
 *   'outlet:<id>'    — specific outlet
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { Building2, Warehouse, Store } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LocationFilterProps {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  /** When provided, only outlets belonging to this warehouseId appear in the outlet list */
  warehouseId?: number;
}

export function LocationFilter({ value, onChange, className, warehouseId }: LocationFilterProps) {
  const { data: wh = [] } = useListWarehouses();
  const { data: ol = [] } = useListOutlets();

  const warehouses = wh as any[];
  const outlets    = warehouseId
    ? (ol as any[]).filter(o => Number(o.warehouseId) === warehouseId)
    : (ol as any[]);

  // ── Parse current value ──────────────────────────────────────────────────
  const parsedType: 'all' | 'headoffice' | 'warehouse' | 'outlet' =
    value === 'headoffice'           ? 'headoffice'
    : value?.startsWith('warehouse:') ? 'warehouse'
    : value?.startsWith('outlet:')    ? 'outlet'
    : 'all';

  const parsedId = value?.includes(':') ? value.split(':')[1] : 'all';

  // ── Type icon ────────────────────────────────────────────────────────────
  const TypeIcon =
    parsedType === 'warehouse' ? Warehouse
    : parsedType === 'outlet'  ? Store
    : Building2;

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleTypeChange = (t: string) => {
    if (t === 'all')        { onChange('all');           return; }
    if (t === 'headoffice') { onChange('headoffice');    return; }
    if (t === 'warehouse')  { onChange('warehouse:all'); return; }
    if (t === 'outlet')     { onChange('outlet:all');    return; }
  };

  const handleIdChange = (id: string) => {
    onChange(`${parsedType}:${id}`);
  };

  return (
    <div className={cn('flex gap-1.5 items-center', className)}>
      {/* ── Step 1: branch type ─────────────────────────────────────────── */}
      <Select value={parsedType} onValueChange={handleTypeChange}>
        <SelectTrigger className="h-8 text-sm gap-1.5 min-w-[140px]">
          <TypeIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="headoffice">Head Office</SelectItem>
          <SelectItem value="warehouse">Warehouse</SelectItem>
          <SelectItem value="outlet">Outlet</SelectItem>
        </SelectContent>
      </Select>

      {/* ── Step 2: specific location (only for warehouse / outlet) ──────── */}
      {(parsedType === 'warehouse' || parsedType === 'outlet') && (
        <Select value={parsedId} onValueChange={handleIdChange}>
          <SelectTrigger className="h-8 text-sm min-w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              All {parsedType === 'warehouse' ? 'Warehouses' : 'Outlets'}
            </SelectItem>
            {(parsedType === 'warehouse' ? warehouses : outlets).map((loc: any) => (
              <SelectItem key={loc.id} value={String(loc.id)}>
                {loc.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

// ── parseLocationFilter ────────────────────────────────────────────────────
export type ParsedLocationType = 'all' | 'headoffice' | 'warehouse' | 'outlet';

export interface ParsedLocation {
  type: ParsedLocationType;
  /** null means "all of this type" (e.g. warehouse:all → type='warehouse', id=null) */
  id: number | null;
}

export function parseLocationFilter(v: string): ParsedLocation {
  if (!v || v === 'all')      return { type: 'all',        id: null };
  if (v === 'headoffice')     return { type: 'headoffice', id: null };
  const [type, idStr] = v.split(':');
  const id = idStr && idStr !== 'all' ? Number(idStr) : null;
  return { type: type as 'warehouse' | 'outlet', id };
}
