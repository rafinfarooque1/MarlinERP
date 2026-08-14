import { useGetMe, useListHierarchies } from '@workspace/api-client-react';

/**
 * True only for level-1 (Administrator) users — the same derivation the
 * sidebar uses. Voucher deletion is gated on this client-side; the API
 * enforces it again with a 403, so this is display routing, not the guard.
 *
 * Fails closed: while `me` or the hierarchy list is still loading (or either
 * fails), the caller sees `false` and admin-only affordances stay hidden.
 */
export function useIsAdmin(): boolean {
  const { data: me } = useGetMe();
  const { data: hierarchies = [] } = useListHierarchies();
  const h = (hierarchies as any[]).find((x: any) => x.id === (me as any)?.hierarchyId);
  return Number(h?.level ?? 99) === 1;
}
