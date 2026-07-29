/**
 * Global location service — the single source of truth for which location types
 * the ERP currently offers.
 *
 * Location Structure lives in Company Settings (`outletsEnabled` today, more
 * location types later). Pages must not re-derive that rule: they ask this
 * module for locations and get back only the ones that are switched on, so a
 * future location type is hidden or revealed everywhere by changing this file
 * alone.
 *
 * Two deliberately separate reads:
 *
 *   useEnabledOutlets() — outlets offered for *selection or as a current
 *                         location*. Empty while the module is off.
 *   useAllOutlets()     — every outlet ever created, for resolving names on
 *                         *historical* records.
 *
 * Hiding the module must never blank out the past. A sale recorded against an
 * outlet last year still has to render its outlet's name, so anything that
 * labels history reads `useAllOutlets()`; anything the user can pick, filter or
 * post against reads `useEnabledOutlets()`. Outlet rows stay in the database
 * untouched, so switching the module back on restores every one of them.
 *
 * This is a UI concern only. The backend refuses outlet writes independently and
 * remains the enforcement point.
 */
import { useMemo } from 'react';
import { useListOutlets, useGetCashInOutlet } from '@workspace/api-client-react';
import { useOutletsEnabled } from './useFeatureFlags';

export type LocationKind = 'headoffice' | 'warehouse' | 'outlet';

const KINDS_WITH_OUTLETS: LocationKind[] = ['headoffice', 'warehouse', 'outlet'];
const KINDS_BASE: LocationKind[] = ['headoffice', 'warehouse'];

/**
 * The location types currently in play. Drive tabs, chips and type filters from
 * this rather than hard-coding a triple of options.
 */
export function useEnabledLocationKinds(): { kinds: LocationKind[]; isLoading: boolean } {
  const { outletsEnabled, isLoading } = useOutletsEnabled();
  return { kinds: outletsEnabled ? KINDS_WITH_OUTLETS : KINDS_BASE, isLoading };
}

/** Is `kind` a location type the user may currently pick? */
export function useIsLocationKindEnabled(kind: LocationKind): boolean {
  const { kinds } = useEnabledLocationKinds();
  return kinds.includes(kind);
}

/**
 * Outlets the user may select, filter by, or post against — empty while Outlet
 * Management is off. Mirrors the shape of the underlying list hook, so it is a
 * drop-in replacement for `useListOutlets()` at every selection site.
 */
export function useEnabledOutlets() {
  const query = useListOutlets();
  const { outletsEnabled } = useOutletsEnabled();
  const data = useMemo(
    () => (outletsEnabled ? (query.data ?? []) : []),
    [outletsEnabled, query.data],
  );
  return { ...query, data };
}

/**
 * Every outlet, regardless of the toggle. Use *only* to resolve a name or label
 * on an existing record; never to populate something selectable.
 */
export function useAllOutlets() {
  return useListOutlets();
}

/**
 * Cash tills, with outlet tills withheld while Outlet Management is off so Cash
 * Balance shows only Head Office and warehouses. The balances themselves are
 * untouched in the ledger — this hides the cards, not the money.
 */
export function useLocationCashBalances() {
  const query = useGetCashInOutlet();
  const { outletsEnabled } = useOutletsEnabled();
  const data = useMemo(() => {
    const rows = query.data ?? [];
    const visible = outletsEnabled ? rows : rows.filter(b => b.locationType !== 'outlet');
    // One card per till, never per name. A place kept as both an outlet and a
    // warehouse row shares a single cash ledger, so listing both identities
    // would show the same money twice and double it in every total. Outlets are
    // preferred while they are switched on, warehouses once they are not — so
    // the till always appears under a location the user can actually see.
    const seen = new Set<number>();
    const ordered = outletsEnabled
      ? [...visible].sort((a, b) => Number(a.locationType !== 'outlet') - Number(b.locationType !== 'outlet'))
      : visible;
    return ordered.filter(b => {
      const ledgerId = (b as any).cashLedgerId;
      if (ledgerId == null) return true;   // no till resolved — nothing to collide with
      if (seen.has(Number(ledgerId))) return false;
      seen.add(Number(ledgerId));
      return true;
    });
  }, [outletsEnabled, query.data]);
  return { ...query, data };
}

/**
 * Drops outlet entries from any list of location-ish rows while the module is
 * off. For collections that arrive inside another payload (report filter blocks,
 * for instance) and so cannot use the hooks above.
 */
export function useVisibleLocations<T extends { locationType?: string; type?: string }>(rows: T[]): T[] {
  const { outletsEnabled } = useOutletsEnabled();
  return useMemo(() => {
    if (outletsEnabled) return rows;
    return rows.filter(r => (r.locationType ?? r.type) !== 'outlet');
  }, [outletsEnabled, rows]);
}
