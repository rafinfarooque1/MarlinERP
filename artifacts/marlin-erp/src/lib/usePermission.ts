import { useGetMe, useListPermissions, useListHierarchies } from '@workspace/api-client-react';

export interface PermissionSet {
  canView: boolean;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canDownload: boolean;
  isLoading: boolean;
}

const FULL_ACCESS: PermissionSet = {
  canView: true,
  canAdd: true,
  canEdit: true,
  canDelete: true,
  canDownload: true,
  isLoading: false,
};

const DEFAULT_VIEW_ONLY: PermissionSet = {
  canView: true,
  canAdd: false,
  canEdit: false,
  canDelete: false,
  canDownload: true,
  isLoading: false,
};

/**
 * Returns the permission set for the current user for a given module name.
 * Module names match those defined in the Permissions page MODULE_GROUPS:
 * 'Materials', 'Raw Materials', 'Items', 'Purchases', 'Production',
 * 'Stock Transfers', 'Warehouses', 'Outlets', 'Stock', 'HO Transfers',
 * 'Item Prices', 'Sales', 'Customers', 'Vendors', 'Coupons',
 * 'Hierarchy', 'Employees', 'Payroll', 'Attendance', 'Leave',
 * 'Chart of Accounts', 'Ledger', 'Cash & Bank', 'Expenses', 'GST Summary',
 * 'Settings', 'Permissions', 'Profile'
 */
export function usePermission(module: string): PermissionSet {
  const { data: user, isLoading: loadingUser } = useGetMe();
  const { data: permissions = [], isLoading: loadingPerms } = useListPermissions();
  const { data: hierarchies = [], isLoading: loadingHier } = useListHierarchies();

  const isLoading = loadingUser || loadingPerms || loadingHier;

  if (isLoading) {
    return { ...FULL_ACCESS, isLoading: true };
  }

  if (!user) return { ...DEFAULT_VIEW_ONLY, isLoading: false };

  // Find the user's hierarchy and its level
  const userHierarchy = hierarchies.find(h => h.id === user.hierarchyId);
  const level = userHierarchy?.level ?? 99;

  // Level 1 = top authority → always full access
  if (level === 1) return FULL_ACCESS;

  // Look up DB permissions for this hierarchy + module
  const perm = permissions.find(
    p => p.hierarchyId === user.hierarchyId && p.module === module,
  );

  if (!perm) return DEFAULT_VIEW_ONLY;

  return {
    canView: perm.canView ?? true,
    canAdd: perm.canAdd ?? false,
    canEdit: perm.canEdit ?? false,
    canDelete: perm.canDelete ?? false,
    canDownload: perm.canDownload ?? true,
    isLoading: false,
  };
}
