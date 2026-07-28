import { useGetMe, useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { useOutletsEnabled } from './useFeatureFlags';

/**
 * "Which location am I acting for?" — shared by the documents that now belong to
 * a location instead of always to Head Office (purchase bills, production runs).
 *
 * The rule mirrors the server (`resolveActingLocation`): Head Office may record
 * for any location, and everyone else is pinned to their own. The picker only
 * ever offers what the server would accept, so a warehouse user sees their own
 * name as a read-only fact rather than a choice that would be rejected.
 *
 * Head Office always resolves to id 1 server-side, so the encoded default uses
 * `headoffice:1` regardless of the signed-in employee's branch id.
 */

export type ActingLocationType = 'headoffice' | 'warehouse' | 'outlet';

export interface ActingLocationOption {
  /** `${type}:${id}` — a single string so one <Select> can carry both fields */
  value: string;
  type: ActingLocationType;
  id: number;
  label: string;
}

export const encodeLocation = (type: ActingLocationType, id: number) => `${type}:${id}`;

/** Splits the encoded picker value back into the two fields the API expects. */
export function decodeLocation(v: string | null | undefined): {
  locationType: ActingLocationType;
  locationId: number;
} {
  const [t, rawId] = String(v ?? '').split(':');
  const type: ActingLocationType =
    t === 'warehouse' || t === 'outlet' ? t : 'headoffice';
  const id = Number(rawId);
  return { locationType: type, locationId: Number.isFinite(id) && id > 0 ? id : 1 };
}

export interface ActingLocations {
  options: ActingLocationOption[];
  /** Encoded value to seed a new document with */
  defaultValue: string;
  isHeadOffice: boolean;
  /** False when the user has no choice — render the single option as text */
  canChoose: boolean;
  /** Label for whichever option an encoded value points at */
  labelFor: (value: string | null | undefined) => string;
}

export function useActingLocations(): ActingLocations {
  const { data: me } = useGetMe();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();

  const myType = ((me as any)?.branchType ?? 'headoffice') as ActingLocationType;
  const myId = Number((me as any)?.branchId ?? 1) || 1;
  const isHeadOffice = myType === 'headoffice';

  const options: ActingLocationOption[] = [];
  if (isHeadOffice) {
    options.push({ value: encodeLocation('headoffice', 1), type: 'headoffice', id: 1, label: 'Head Office' });
    for (const w of warehouses as any[]) {
      options.push({ value: encodeLocation('warehouse', w.id), type: 'warehouse', id: w.id, label: w.name });
    }
    // Outlet Management ships retired; only offer outlets while it is switched on.
    if (outletsEnabled) {
      for (const o of outlets as any[]) {
        options.push({ value: encodeLocation('outlet', o.id), type: 'outlet', id: o.id, label: `${o.name} (outlet)` });
      }
    }
  } else {
    const fallback = myType === 'warehouse' ? `Warehouse #${myId}` : `Outlet #${myId}`;
    options.push({
      value: encodeLocation(myType, myId),
      type: myType,
      id: myId,
      label: (me as any)?.branchName || fallback,
    });
  }

  const defaultValue = isHeadOffice ? encodeLocation('headoffice', 1) : encodeLocation(myType, myId);

  return {
    options,
    defaultValue,
    isHeadOffice,
    canChoose: isHeadOffice && options.length > 1,
    labelFor: (value) => options.find(o => o.value === value)?.label ?? 'Head Office',
  };
}
