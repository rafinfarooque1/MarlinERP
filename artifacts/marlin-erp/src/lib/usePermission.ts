import { useGetMe, useListPermissions, useListHierarchies } from '@workspace/api-client-react';

export interface PermissionSet {
  canView: boolean;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canDownload: boolean;
  isLoading: boolean;
}

/** Minimal structural shape of a permissions DB row (matches the API type). */
export interface PermissionRow {
  hierarchyId?: number | null;
  module?: string | null;
  canView?: boolean | null;
  canAdd?: boolean | null;
  canEdit?: boolean | null;
  canDelete?: boolean | null;
  canDownload?: boolean | null;
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
 * Pure permission resolution — the single source of truth for what a user can
 * do with a module. Used by the usePermission() hook, the AppLayout sidebar,
 * and mirrored by the API middleware (api-server middleware/permissions.ts),
 * so display and enforcement cannot drift apart.
 *
 * Rules:
 *   • level 1 hierarchy → full access, always
 *   • no DB row         → view-only default (view ✓, writes ✗, download ✓)
 *   • row present       → exactly what the row says
 *
 * `module` must be a `key` from MODULE_REGISTRY (src/lib/moduleRegistry.ts).
 * A name that is not in the registry never appears on the Permissions page,
 * so it could never be granted or revoked — don't invent names here.
 */
export function resolvePermissions(
  module: string,
  hierarchyId: number | undefined,
  level: number,
  permissions: PermissionRow[],
): PermissionSet {
  if (level === 1) return FULL_ACCESS;

  const perm = permissions.find(
    p => p.hierarchyId === hierarchyId && p.module === module,
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

/**
 * Sidebar/nav helper: can the user view this module?
 * `module === undefined` means the nav item is unrestricted.
 */
export function canViewModule(
  module: string | undefined,
  hierarchyId: number | undefined,
  level: number,
  permissions: PermissionRow[],
): boolean {
  if (!module) return true;
  return resolvePermissions(module, hierarchyId, level, permissions).canView;
}

/**
 * Returns the permission set for the current user for a given module key.
 * Module keys are defined in src/lib/moduleRegistry.ts (MODULE_REGISTRY) —
 * the same list the Permissions page manages and the API middleware checks.
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

  const userHierarchy = hierarchies.find(h => h.id === user.hierarchyId);
  const level = userHierarchy?.level ?? 99;

  return resolvePermissions(module, user.hierarchyId, level, permissions);
}
