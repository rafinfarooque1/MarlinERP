import { useListHierarchies, useListPermissions } from '@workspace/api-client-react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * ERP permission resolution for the mobile app.
 *
 * Mirrors the web app's usePermission (marlin-erp/src/lib/usePermission.ts)
 * and the API middleware exactly, so display and enforcement cannot drift:
 *   • level 1 hierarchy → full access, always
 *   • no DB row         → deny (backend is default-deny)
 *   • row present       → exactly what the row says (nulls = deny)
 *
 * Keys are the web sidebar's per-link permission keys: `page:` + href.
 * Pass an array to mean "any of these" — the union of the sets, matching the
 * backend's any-of guards for endpoints shared by several pages.
 *
 * GET /company/permissions returns only the caller's own hierarchy rows for
 * non-admins; GET /hr/hierarchies is unguarded. Both are safe to fetch for
 * every signed-in employee.
 *
 * The UI is display-gating ONLY — the backend re-checks every request.
 */

/** Permission keys for the mobile modules (must match moduleRegistry hrefs). */
export const PAGE = {
  dashboard: 'page:/',
  sales: 'page:/sales/pos',
  dispatch: 'page:/operations/dispatch',
  stock: 'page:/headoffice/stock',
  receiptVoucher: ['page:/accounts/vouchers', 'page:/operations/receipt-voucher'],
  paymentVoucher: ['page:/accounts/vouchers', 'page:/operations/payment-voucher'],
} as const;

export interface PermissionSet {
  canView: boolean;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canDownload: boolean;
}

const FULL_ACCESS: PermissionSet = {
  canView: true, canAdd: true, canEdit: true, canDelete: true, canDownload: true,
};

const DENY: PermissionSet = {
  canView: false, canAdd: false, canEdit: false, canDelete: false, canDownload: false,
};

/** Minimal structural shape of a permissions row (matches the API type). */
interface PermissionRow {
  hierarchyId?: number | null;
  module?: string | null;
  canView?: boolean | null;
  canAdd?: boolean | null;
  canEdit?: boolean | null;
  canDelete?: boolean | null;
  canDownload?: boolean | null;
}

export interface ErpPermissions {
  /** True once employee + permission + hierarchy data are all loaded. */
  ready: boolean;
  /** Hierarchy level of the signed-in user (1 = administrator). */
  level: number;
  /** Full permission set for a page key (or any-of array of keys). */
  perm: (module: string | readonly string[]) => PermissionSet;
  /** Shorthand: can the user view this page key (or any of these)? */
  canView: (module: string | readonly string[]) => boolean;
}

export function useErpPermissions(): ErpPermissions {
  const { token, employee } = useAuth();
  const enabled = !!token;

  const { data: permissions } = useListPermissions(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled, staleTime: 60_000 } as any },
  );
  const { data: hierarchies } = useListHierarchies(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled, staleTime: 60_000 } as any },
  );

  const ready =
    enabled && !!employee && permissions !== undefined && hierarchies !== undefined;

  const level = hierarchies?.find(h => h.id === employee?.hierarchyId)?.level ?? 99;

  const perm = (module: string | readonly string[]): PermissionSet => {
    // Not ready → deny, so nothing ERP flashes before permissions arrive.
    if (!ready || !employee) return DENY;
    if (level === 1) return FULL_ACCESS;

    const keys = Array.isArray(module) ? module : [module as string];
    const rows = ((permissions ?? []) as PermissionRow[]).filter(
      p => p.hierarchyId === employee.hierarchyId && keys.includes(p.module ?? ''),
    );
    if (rows.length === 0) return DENY;

    const any = (pick: (r: PermissionRow) => boolean | null | undefined) =>
      rows.some(r => pick(r) === true);

    return {
      canView: any(r => r.canView),
      canAdd: any(r => r.canAdd),
      canEdit: any(r => r.canEdit),
      canDelete: any(r => r.canDelete),
      canDownload: any(r => r.canDownload),
    };
  };

  const canView = (module: string | readonly string[]) => perm(module).canView;

  return { ready, level, perm, canView };
}

/**
 * True when the user may view at least one ERP business module. Decides the
 * navigation shape: ERP users get Home/Sales/Dispatch/Stock/More; pure
 * employee users keep the original Home/Payslips/Attendance/Leaves tabs.
 */
export function useHasErpAccess(): boolean {
  const { ready, canView } = useErpPermissions();
  if (!ready) return false;
  return (
    canView(PAGE.sales) ||
    canView(PAGE.dispatch) ||
    canView(PAGE.stock) ||
    canView(PAGE.receiptVoucher) ||
    canView(PAGE.paymentVoucher) ||
    canView(PAGE.dashboard)
  );
}
