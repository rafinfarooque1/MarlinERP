/**
 * Location options + name resolution for party (customer/vendor) screens.
 *
 * Parties carry an assigned location (`locationType` + `locationId`). This
 * hook centralises the three things every party page needs:
 *  - `nameOf(type, id)`  — display name for a stored stamp. Head Office
 *    matches on TYPE ALONE (its placeholder id varies per table).
 *  - `assignOptions`     — locations a Head Office user may assign a party to.
 *    Outlets are hidden while the outlets module is disabled — the server
 *    refuses new outlet assignments then, so offering them would only error.
 *  - `filterOptions`     — locations offered by the list-page filter. These
 *    include outlets even when disabled: existing records still live there
 *    and must stay findable.
 *  - `isHeadOffice` / `myLocationLabel` — whether the signed-in user may
 *    choose a location at all; branch users are stamped by their session.
 */
import { useMemo } from 'react';
import { useGetMe, useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';

export interface LocationOption {
  /** `headoffice:0`, `warehouse:<id>` or `outlet:<id>` */
  value: string;
  label: string;
  group: 'headoffice' | 'warehouse' | 'outlet';
}

export const HEAD_OFFICE_VALUE = 'headoffice:0';

/** Stored stamp → select value. Head Office normalises to `headoffice:0`. */
export function locationValueOf(type?: string | null, id?: number | null): string {
  if (!type || type === 'headoffice') return HEAD_OFFICE_VALUE;
  return `${type}:${Number(id) || 0}`;
}

export function usePartyLocations() {
  const { data: user } = useGetMe();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();

  const branchType = (user as any)?.branchType as string | undefined;
  const isHeadOffice = branchType === 'headoffice';
  const myBranchId = Number((user as any)?.branchId) || 0;

  return useMemo(() => {
    const whs = (warehouses as any[]).map((w) => ({
      value: `warehouse:${w.id}`, label: String(w.name), group: 'warehouse' as const,
    }));
    const outs = (outlets as any[]).map((o) => ({
      value: `outlet:${o.id}`, label: String(o.name), group: 'outlet' as const,
    }));
    const ho: LocationOption = { value: HEAD_OFFICE_VALUE, label: 'Head Office', group: 'headoffice' };

    const nameOf = (type?: string | null, id?: number | null): string => {
      if (!type || type === 'headoffice') return 'Head Office';
      const list = type === 'warehouse' ? whs : type === 'outlet' ? outs : [];
      return list.find((l) => l.value === `${type}:${Number(id)}`)?.label
        ?? `${type === 'warehouse' ? 'Warehouse' : type === 'outlet' ? 'Outlet' : type} #${id ?? '?'}`;
    };

    const myLocationLabel = isHeadOffice
      ? 'Head Office'
      : nameOf(branchType ?? null, myBranchId);

    return {
      isHeadOffice,
      branchType: branchType ?? null,
      myBranchId,
      myLocationLabel,
      nameOf,
      /** every location, for the list filter (retired-module outlets included) */
      filterOptions: [ho, ...whs, ...outs] as LocationOption[],
      /** assignable locations, for the form (no outlets while disabled) */
      assignOptions: [ho, ...whs, ...(outletsEnabled ? outs : [])] as LocationOption[],
    };
  }, [warehouses, outlets, outletsEnabled, isHeadOffice, branchType, myBranchId]);
}

/** Does a row's stored stamp match a `type:id` filter value? */
export function rowMatchesLocation(
  filterValue: string,
  rowType?: string | null,
  rowId?: number | null,
): boolean {
  if (filterValue === 'all') return true;
  const [ft, fid] = filterValue.split(':');
  const rt = rowType || 'headoffice';
  if (ft === 'headoffice') return rt === 'headoffice'; // type alone — id varies per table
  return rt === ft && Number(rowId) === Number(fid);
}
