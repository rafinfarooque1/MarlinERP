import { useEffect, useMemo, useState } from 'react';
import { useVoucherLocations } from '@workspace/api-client-react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLocationContext } from '@/lib/locationContext';

/**
 * Shared voucher-location choice for every manual voucher entry form
 * (Receipt, Payment, Journal, Contra, Notes, the unified Vouchers page and
 * the operations keyboard-entry pages).
 *
 * The selected location OWNS the voucher's accounting — an Admin recording on
 * behalf of a branch produces a branch voucher, never a Head Office one. The
 * hook exposes: which locations the caller may record under, the currently
 * selected one, and which ledgers to HIDE for it — accounts owned by a
 * different location, plus Head Office's own cash/bank when a branch is
 * selected. The same rule is enforced by the server on save; this just keeps
 * the pickers honest.
 *
 * Defaulting: an explicit `initial` (the row being edited) wins; otherwise the
 * global location selector, when it points at a specific location the caller
 * may use; otherwise the first offered location (Head Office for HO users,
 * the user's own location for branch staff).
 */
export function useVoucherLocationChoice(initial?: { locationType?: string | null; locationId?: number | null }) {
  const { data: voucherLocs } = useVoucherLocations();
  const { locationState } = useLocationContext();
  const locations = voucherLocs?.locations ?? [];
  const [locKey, setLocKey] = useState<string>(
    initial?.locationType ? `${initial.locationType}:${initial.locationId ?? 0}` : ''
  );
  useEffect(() => {
    if (locKey || !locations.length) return;
    // Global selector first — "working as" a location should carry into the
    // form. "All Locations" is a VIEW, never a posting location, so it (and
    // anything not offered to this caller) falls through to the default.
    const g = locationState;
    if (g.locationType && g.locationType !== 'all') {
      const gid = g.locationType === 'headoffice' ? 0 : Number(g.locationId ?? 0);
      const hit = locations.find(l => l.locationType === g.locationType && Number(l.locationId) === gid);
      if (hit) { setLocKey(`${hit.locationType}:${hit.locationId}`); return; }
    }
    setLocKey(`${locations[0].locationType}:${locations[0].locationId}`);
  }, [locKey, locations, locationState]);
  const selLoc = locations.find(l => `${l.locationType}:${l.locationId}` === locKey);

  const foreignLedgerIds = useMemo(() => {
    const set = new Set<number>();
    if (!voucherLocs || !selLoc) return set;
    for (const o of voucherLocs.ownedLedgers) {
      if (!(o.locationType === selLoc.locationType && o.locationId === selLoc.locationId)) set.add(o.ledgerId);
    }
    // A mirror location's shared till is owned by BOTH identities — if the
    // selected location is one of them, the ledger stays visible.
    for (const o of voucherLocs.ownedLedgers) {
      if (o.locationType === selLoc.locationType && o.locationId === selLoc.locationId) set.delete(o.ledgerId);
    }
    if (selLoc.locationType !== 'headoffice') {
      for (const id of voucherLocs.headOfficeCashBankLedgerIds) set.add(id);
    }
    return set;
  }, [voucherLocs, selLoc]);

  return { locations, locKey, setLocKey, selLoc, foreignLedgerIds };
}

export function parseLocKey(key: string): { locationType: 'headoffice' | 'warehouse' | 'outlet'; locationId: number } | null {
  const [t, i] = key.split(':');
  if (t !== 'headoffice' && t !== 'warehouse' && t !== 'outlet') return null;
  return { locationType: t, locationId: Number(i) || 0 };
}

/** Display name for a voucher row's location stamp (list columns / exports). */
export function voucherLocationName(
  locations: { locationType: string; locationId: number; name: string }[],
  locationType?: string | null,
  locationId?: number | null,
): string {
  const lt = locationType || 'headoffice';
  if (lt === 'headoffice') return 'Head Office';
  const hit = locations.find(l => l.locationType === lt && Number(l.locationId) === Number(locationId ?? 0));
  return hit?.name ?? `${lt === 'warehouse' ? 'Warehouse' : 'Outlet'} #${locationId ?? 0}`;
}

export function LocationSelectField({ locations, locKey, setLocKey }: {
  locations: { locationType: string; locationId: number; name: string }[];
  locKey: string;
  setLocKey: (k: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label>Location</Label>
      <Select value={locKey} onValueChange={setLocKey}>
        <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
        <SelectContent>
          {locations.map(l => (
            <SelectItem key={`${l.locationType}:${l.locationId}`} value={`${l.locationType}:${l.locationId}`}>
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
