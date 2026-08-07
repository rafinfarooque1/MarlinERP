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
import { useEffect, useRef } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useListWarehouses, useListOutlets, useGetMe } from '@workspace/api-client-react';
import { Building2, Warehouse, Store } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';

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
  const { outletsEnabled } = useOutletsEnabled();
  const { data: me } = useGetMe();

  // Branch staff only ever see their own data (LBAC), so the filter must not
  // offer — or even name — locations outside their scope: their own branch
  // (plus, for a warehouse, its child outlets) is the whole world here.
  const myBranchType = (me as any)?.branchType as 'headoffice' | 'warehouse' | 'outlet' | undefined;
  const myBranchId = Number((me as any)?.branchId) || 0;
  const locked = (myBranchType === 'warehouse' || myBranchType === 'outlet') && myBranchId > 0;

  // Outlet Management off ⇒ Outlet is not offered as a filter at all. Hiding
  // the option never hides data: the default 'all' still aggregates historical
  // outlet rows, so totals stay complete — only the ability to single out an
  // outlet goes away.
  const scopedWh = locked
    ? (wh as any[]).filter(w => myBranchType === 'warehouse' && Number(w.id) === myBranchId)
    : (wh as any[]);
  const scopedOl = locked
    ? (ol as any[]).filter(o =>
        myBranchType === 'outlet'
          ? Number(o.id) === myBranchId
          : Number(o.warehouseId) === myBranchId)
    : (ol as any[]);

  const showOutlets = outletsEnabled && (!locked || scopedOl.length > 0);
  const showHeadOffice = !locked;
  const showWarehouses = !locked || scopedWh.length > 0;

  const warehouses = scopedWh;
  const outlets    = warehouseId
    ? scopedOl.filter(o => Number(o.warehouseId) === warehouseId)
    : scopedOl;

  // If outlets get hidden while an outlet filter is active, fall back to "All"
  // rather than leaving the report pinned to an invisible selection.
  const outletSelected = value === 'outlet' || !!value?.startsWith('outlet:');
  // Callers often pass an inline arrow, so onChange identity changes every
  // render. Hold it in a ref and depend on the flags only — depending on
  // onChange itself would re-fire this effect on every parent render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!showOutlets && outletSelected) onChangeRef.current('all');
  }, [showOutlets, outletSelected]);

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
          {showHeadOffice && <SelectItem value="headoffice">Head Office</SelectItem>}
          {showWarehouses && <SelectItem value="warehouse">Warehouse</SelectItem>}
          {showOutlets && <SelectItem value="outlet">Outlet</SelectItem>}
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
