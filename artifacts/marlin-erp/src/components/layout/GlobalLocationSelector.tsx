/**
 * Global location selector — the permanent "Current Location" block pinned to
 * the bottom of the sidebar on every page.
 *
 * Writes the same location context the Sales section uses (one source of
 * truth, persisted in localStorage), so picking a location here and picking
 * one at /sales are the same act. Every API request then carries the context
 * as headers, so the whole ERP — dashboard, reports, statements, lists —
 * follows the selection without per-page plumbing.
 *
 * Location-locked employees (warehouse/outlet logins) see a fixed label:
 * their data scope is decided by the server, and offering a dead dropdown
 * would misstate who controls it. The selector only ever narrows what a Head
 * Office user is looking at — the backend still enforces LBAC on every
 * request. Head Office users' selection is also persisted server-side (a
 * display preference), so it follows them across browsers.
 */
import { useEffect } from 'react';
import { useGetMe, useListWarehouses, useListOutlets, customFetch } from '@workspace/api-client-react';
import { useLocationContext, ALL_LOCATIONS, type LocationState } from '@/lib/locationContext';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Layers, MapPin, Store, Warehouse } from 'lucide-react';

/** Fire-and-forget server persistence of the selection (display pref only). */
function persistPref(state: LocationState): void {
  const body =
    state.locationType === 'warehouse' || state.locationType === 'outlet'
      ? { locationType: state.locationType, locationId: state.locationId, locationName: state.locationName }
      : { locationType: 'all' };
  customFetch('/api/auth/location-pref', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => { /* a lost pref is cosmetic — never block the UI on it */ });
}

export function GlobalLocationSelector({ collapsed = false }: { collapsed?: boolean }) {
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
  // answers with zero rows, and the label would misname their location.
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

  // Hydrate a Head Office user's server-side preference — but only when this
  // browser has no local selection yet (local always wins once it exists).
  useEffect(() => {
    if (!user || isLocked) return;
    if (localStorage.getItem('marlin_sales_location')) return;
    const raw = (user as any).uiLocationPref;
    if (!raw || typeof raw !== 'string') return;
    try {
      const p = JSON.parse(raw);
      if (p.locationType === 'all') {
        setLocation(ALL_LOCATIONS);
      } else if ((p.locationType === 'warehouse' || p.locationType === 'outlet') && p.locationId) {
        setLocation({
          locationType: p.locationType,
          locationId: Number(p.locationId),
          locationName: typeof p.locationName === 'string' ? p.locationName : '',
        });
      }
    } catch { /* a malformed pref is ignored, never fatal */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isLocked]);

  if (!user) return null;

  const activeIcon =
    locationState.locationType === 'warehouse'
      ? <Warehouse className="w-4 h-4 text-blue-500 shrink-0" />
      : locationState.locationType === 'outlet'
      ? <Store className="w-4 h-4 text-emerald-500 shrink-0" />
      : <Layers className="w-4 h-4 text-primary shrink-0" />;

  const activeName = isLocked
    ? (locationState.locationName || (branchType === 'warehouse' ? 'Warehouse' : 'Outlet'))
    : (locationState.locationType === 'warehouse' || locationState.locationType === 'outlet')
    ? (locationState.locationName || 'Location')
    : 'All Locations';

  // ── Collapsed sidebar: icon + tooltip only ────────────────────────────────
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center justify-center w-10 h-10 mx-auto rounded-md bg-muted/40" data-testid="location-context-collapsed">
            {activeIcon}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span className="font-medium">📍 {activeName}</span>
          {!isLocked && <span className="block text-xs text-muted-foreground">Expand the sidebar to change</span>}
        </TooltipContent>
      </Tooltip>
    );
  }

  // ── Locked employees: fixed label, no dropdown ────────────────────────────
  if (isLocked) {
    return (
      <div data-testid="location-context-locked">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1">
          <MapPin className="w-3 h-3" /> Current Location
        </p>
        <div
          className="flex items-center gap-2 h-9 px-3 rounded-md bg-muted/50 text-sm"
          title="Your location is set by your login and cannot be changed."
        >
          {activeIcon}
          <span className="truncate font-medium">{activeName}</span>
        </div>
      </div>
    );
  }

  // ── Head Office: full selector ────────────────────────────────────────────
  const value =
    locationState.locationType === 'warehouse' || locationState.locationType === 'outlet'
      ? `${locationState.locationType}:${locationState.locationId}`
      : 'all';

  const handleChange = (v: string) => {
    let next: LocationState;
    if (v === 'all') {
      next = ALL_LOCATIONS;
    } else {
      const [type, rawId] = v.split(':');
      const id = Number(rawId);
      if (type !== 'warehouse' && type !== 'outlet') return;
      const list = type === 'warehouse' ? (warehouses as any[]) : (outlets as any[]);
      next = { locationType: type, locationId: id, locationName: list.find((l) => l.id === id)?.name ?? '' };
    }
    setLocation(next); // provider refetches the whole ERP view
    persistPref(next);
  };

  return (
    <div data-testid="location-context-selector">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1">
        <MapPin className="w-3 h-3" /> Current Location
      </p>
      <Select value={value} onValueChange={handleChange}>
        <SelectTrigger
          className="h-9 w-full gap-1.5 bg-muted/50 border-transparent text-sm"
          aria-label="Current location"
        >
          {activeIcon}
          <span className="truncate flex-1 text-left">
            <SelectValue placeholder="All Locations" />
          </span>
        </SelectTrigger>
        <SelectContent align="start" side="top">
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
    </div>
  );
}
