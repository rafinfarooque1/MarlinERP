import { useGetGstFilters } from '@workspace/api-client-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

export interface GstScope {
  gstin?: string;
  warehouseId?: number;
}

/**
 * GST-number filter with a dependent warehouse dropdown.
 *
 * The warehouse list only ever shows warehouses registered under the selected
 * GSTIN — several warehouses can share one registration. Changing the GSTIN
 * resets the warehouse pick so the pair can never disagree.
 */
export function GstScopeFilter({ value, onChange }: {
  value: GstScope;
  onChange: (next: GstScope) => void;
}) {
  const { data } = useGetGstFilters();
  const groups = data?.gstins ?? [];
  const selected = groups.find(g => g.gstin === value.gstin);

  if (groups.length === 0) return null;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-sm text-muted-foreground">GST No:</span>
      <Select
        value={value.gstin ?? 'all'}
        onValueChange={v => onChange(v === 'all' ? {} : { gstin: v })}
      >
        <SelectTrigger className="w-56"><SelectValue placeholder="All GST numbers" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All GST numbers</SelectItem>
          {groups.map(g => (
            <SelectItem key={g.gstin} value={g.gstin}>
              <span className="font-mono text-xs">{g.gstin}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-sm text-muted-foreground">Warehouse:</span>
      <Select
        value={value.warehouseId ? String(value.warehouseId) : 'all'}
        onValueChange={v => onChange({ gstin: value.gstin, warehouseId: v === 'all' ? undefined : Number(v) })}
        disabled={!selected}
      >
        <SelectTrigger className="w-56">
          <SelectValue placeholder={selected ? 'All warehouses' : 'Pick a GST number first'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All warehouses under this GSTIN</SelectItem>
          {(selected?.warehouses ?? []).map(w => (
            <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Short human label for export subtitles: which scope is active. */
export function gstScopeLabel(scope: GstScope, groups: { gstin: string; warehouses: Array<{ id: number; name: string }> }[]): string {
  if (!scope.gstin) return 'All GST numbers';
  const g = groups.find(x => x.gstin === scope.gstin);
  const wh = scope.warehouseId ? g?.warehouses.find(w => w.id === scope.warehouseId)?.name : undefined;
  return wh ? `${scope.gstin} — ${wh}` : scope.gstin;
}
