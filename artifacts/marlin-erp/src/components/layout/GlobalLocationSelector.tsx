/**
 * Global location selector — lives in the app header on every page.
 *
 * Writes the same location context the Sales section uses (one source of
 * truth, persisted in localStorage), so picking a location here and picking
 * one at /sales are the same act.
 *
 * Location-locked employees (warehouse/outlet logins) see a fixed chip: their
 * data scope is decided by the server, and offering a dead dropdown would
 * misstate who controls it. The selector only ever narrows what a Head Office
 * user is looking at — the backend still enforces LBAC on every request.
 */
import { useEffect } from 'react';
import { useGetMe, useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { useLocationContext, ALL_LOCATIONS } from '@/lib/locationContext';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Layers, MapPin, Store, Warehouse } from 'lucide-react';

export function GlobalLocationSelector() {
  const { data: user } = useGetMe();
  const { locationState, setLocation } = useLocationContext();
  const { outletsEnabled } = useOutletsEnabled();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();

  const branchType = (user as any)?.branchType as 'headoffice' | 'warehouse' | 'outlet' | undefined;
  const isLocked = branchType === 'warehouse' || branchType === 'outlet';
  const myBranchId = Number((user as any)?.branchId) || 0;

  // The context persists in localStorage across logins, so a location-locked
  // employee can inherit another user's selection on a shared browser. Their
  // location is decided by their login, so force the context to it — otherwise
  // every filtered page would send a foreign location the server (correctly)
  // answers with zero rows, and the chip would misname their location.
  useEffect(() => {
    if (!isLocked || !branchType || !myBranchId) return;
    const list = branchType === 'warehouse' ? (warehouses as any[]) : (outlets as any[]);
    const resolvedName = list.find((l) => l.id === myBranchId)?.name ?? '';
    const inSync =
      locationState.locationType === branchType &&
      locationState.locationId === myBranchId &&
      (!resolvedName || locationState.locationName === resolvedName);
    if (inSync) return;
    setLocation({
      locationType: branchType,
      locationId: myBranchId,
      locationName: resolvedName || locationState.locationName || '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocked, branchType, myBranchId, warehouses, outlets,
      locationState.locationType, locationState.locationId, locationState.locationName]);

  if (!user) return null;

  if (isLocked) {
    // Fixed chip — the employee's location is pinned by their login.
    return (
      <div
        className="hidden sm:flex items-center gap-1.5 h-9 px-3 rounded-md bg-muted/50 text-sm text-muted-foreground"
        title="Your location is set by your login and cannot be changed."
      >
        {branchType === 'warehouse'
          ? <Warehouse className="w-4 h-4 text-blue-500 shrink-0" />
          : <Store className="w-4 h-4 text-emerald-500 shrink-0" />}
        <span className="max-w-[140px] truncate font-medium text-foreground">
          {locationState.locationName || (branchType === 'warehouse' ? 'Warehouse' : 'Outlet')}
        </span>
      </div>
    );
  }

  const value =
    locationState.locationType === 'warehouse' || locationState.locationType === 'outlet'
      ? `${locationState.locationType}:${locationState.locationId}`
      : 'all';

  const handleChange = (v: string) => {
    if (v === 'all') { setLocation(ALL_LOCATIONS); return; }
    const [type, rawId] = v.split(':');
    const id = Number(rawId);
    const list = type === 'warehouse' ? (warehouses as any[]) : (outlets as any[]);
    const name = list.find((l) => l.id === id)?.name ?? '';
    if (type === 'warehouse' || type === 'outlet') {
      setLocation({ locationType: type, locationId: id, locationName: name });
    }
  };

  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger
        className="h-9 w-auto min-w-[150px] max-w-[220px] gap-1.5 bg-muted/50 border-transparent text-sm"
        aria-label="Location filter"
      >
        {value === 'all'
          ? <Layers className="w-4 h-4 text-primary shrink-0" />
          : locationState.locationType === 'warehouse'
          ? <Warehouse className="w-4 h-4 text-blue-500 shrink-0" />
          : <Store className="w-4 h-4 text-emerald-500 shrink-0" />}
        <span className="truncate">
          <SelectValue placeholder="All Locations" />
        </span>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="all">All Locations</SelectItem>
        {(warehouses as any[]).length > 0 && (
          <SelectGroup>
            <SelectLabel className="flex items-center gap-1.5 text-xs">
              <Warehouse className="w-3 h-3" /> Warehouses
            </SelectLabel>
            {(warehouses as any[]).map((w) => (
              <SelectItem key={`warehouse:${w.id}`} value={`warehouse:${w.id}`}>{w.name}</SelectItem>
            ))}
          </SelectGroup>
        )}
        {outletsEnabled && (outlets as any[]).length > 0 && (
          <SelectGroup>
            <SelectLabel className="flex items-center gap-1.5 text-xs">
              <Store className="w-3 h-3" /> Outlets
            </SelectLabel>
            {(outlets as any[]).map((o) => (
              <SelectItem key={`outlet:${o.id}`} value={`outlet:${o.id}`}>{o.name}</SelectItem>
            ))}
          </SelectGroup>
        )}
        {(warehouses as any[]).length === 0 && (!outletsEnabled || (outlets as any[]).length === 0) && (
          <div className="px-2 py-3 text-xs text-muted-foreground flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5" /> No locations configured
          </div>
        )}
      </SelectContent>
    </Select>
  );
}
