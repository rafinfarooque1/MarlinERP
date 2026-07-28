import { useGetMe } from '@workspace/api-client-react';

/**
 * Product lifecycle status, shared by the three master lists (items, raw
 * materials, packing materials).
 *
 * `status` arrives from a raw-migration column, so older cached responses and
 * hand-built objects may not carry it at all. Everything here treats a missing
 * status as active: a product is only inactive when it explicitly says so.
 */

export type ProductStatus = 'active' | 'inactive';

export interface HasProductStatus {
  id?: number;
  status?: string | null;
}

export const isActiveProduct = (p: HasProductStatus | null | undefined): boolean =>
  ((p?.status ?? 'active') as string) === 'active';

/**
 * Products allowed on a NEW document. Mirrors the server-side create guard, so
 * a discontinued product never reaches a picker in the first place.
 */
export function activeProducts<T extends HasProductStatus>(list: readonly T[] | undefined): T[] {
  return (list ?? []).filter(isActiveProduct);
}

/**
 * Like `activeProducts`, but keeps an already-chosen product in the list even
 * once it goes inactive. Editing an old document must not silently blank the
 * line it is showing — the value stays visible and only new picks are limited.
 */
export function activeProductsWithSelection<T extends HasProductStatus>(
  list: readonly T[] | undefined,
  selectedId: number | null | undefined,
): T[] {
  const id = Number(selectedId);
  return (list ?? []).filter(p => isActiveProduct(p) || (Number.isFinite(id) && id > 0 && Number(p.id) === id));
}

/** True once the signed-in employee is confirmed to sit at Head Office. */
export function useIsHeadOffice(): { isHeadOffice: boolean; isLoading: boolean } {
  const { data: me, isLoading } = useGetMe();
  return {
    // Optimistic-free default: until we know, treat the user as NOT Head Office
    // so write controls appear rather than flicker away.
    isHeadOffice: ((me as any)?.branchType ?? '') === 'headoffice',
    isLoading,
  };
}

/** Copy shown where Head-Office-only controls used to be. */
export const HEAD_OFFICE_ONLY_HINT =
  'Only Head Office can add, edit or delete items. You have full view access here.';
