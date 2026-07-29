import { useGetMe, useListPermissions, useListHierarchies } from '@workspace/api-client-react';

export interface PermissionSet {
  canView: boolean;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canDownload: boolean;
  canPrint: boolean;
  /** Sign-off authority — distinct from canEdit; see the DB column comment. */
  canApprove: boolean;
  /** Authority to publish a document outside the company (invoice share links). */
  canShare: boolean;
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
  canPrint?: boolean | null;
  canApprove?: boolean | null;
  canShare?: boolean | null;
}

const FULL_ACCESS: PermissionSet = {
  canView: true,
  canAdd: true,
  canEdit: true,
  canDelete: true,
  canDownload: true,
  canPrint: true,
  canApprove: true,
  canShare: true,
  isLoading: false,
};

/** Shown while permissions are loading — treated as denied so nothing flashes. */
const DEFAULT_DENY: PermissionSet = {
  canView: false,
  canAdd: false,
  canEdit: false,
  canDelete: false,
  canDownload: false,
  canPrint: false,
  canApprove: false,
  canShare: false,
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
 *   • no DB row         → deny (matches backend default-deny; seeding migration
 *                         ensures all existing hierarchies have explicit rows)
 *   • row present       → exactly what the row says (nulls default to deny)
 *
 * `module` must be a per-link key from PAGE_PERM_KEYS (src/lib/moduleRegistry.ts) —
 * `page:` + the sidebar link's href. A name that is not in the registry never
 * appears on the Permissions page, so it could never be granted or revoked —
 * don't invent names here. A build-time check enforces this.
 *
 * Pass an array to mean "any of these" — the union of the sets, matching the
 * backend's any-of guards for endpoints shared by several pages.
 */
export function resolvePermissions(
  module: string | string[],
  hierarchyId: number | undefined,
  level: number,
  permissions: PermissionRow[],
): PermissionSet {
  if (level === 1) return FULL_ACCESS;

  const keys = Array.isArray(module) ? module : [module];
  const rows = permissions.filter(
    p => p.hierarchyId === hierarchyId && keys.includes(p.module ?? ''),
  );

  // No row → default-deny, matching the backend permission middleware.
  if (rows.length === 0) return DEFAULT_DENY;

  const any = (pick: (r: PermissionRow) => boolean | null | undefined) =>
    rows.some(r => pick(r) === true);

  return {
    canView: any(r => r.canView),
    canAdd: any(r => r.canAdd),
    canEdit: any(r => r.canEdit),
    canDelete: any(r => r.canDelete),
    canDownload: any(r => r.canDownload),
    canPrint: any(r => r.canPrint),
    canApprove: any(r => r.canApprove),
    canShare: any(r => r.canShare),
    isLoading: false,
  };
}

/**
 * Sidebar/nav helper: can the user view this module?
 * `module === undefined` means the nav item is unrestricted.
 */
export function canViewModule(
  module: string | string[] | undefined,
  hierarchyId: number | undefined,
  level: number,
  permissions: PermissionRow[],
): boolean {
  if (!module || (Array.isArray(module) && module.length === 0)) return true;
  return resolvePermissions(module, hierarchyId, level, permissions).canView;
}

/**
 * Returns the permission set for the current user for a given page key.
 * Page keys are `page:` + a sidebar link's href, listed in PAGE_PERM_KEYS
 * (src/lib/moduleRegistry.ts) — the same list the Permissions page manages and
 * the API middleware checks. Pass an array for "any of these pages".
 */
export function usePermission(module: string | string[]): PermissionSet {
  const { data: user, isLoading: loadingUser } = useGetMe();
  const { data: permissions = [], isLoading: loadingPerms } = useListPermissions();
  const { data: hierarchies = [], isLoading: loadingHier } = useListHierarchies();

  const isLoading = loadingUser || loadingPerms || loadingHier;

  if (isLoading) {
    return { ...FULL_ACCESS, isLoading: true };
  }

  if (!user) return { ...DEFAULT_DENY, isLoading: false };

  const userHierarchy = hierarchies.find(h => h.id === user.hierarchyId);
  const level = userHierarchy?.level ?? 99;

  return resolvePermissions(module, user.hierarchyId, level, permissions);
}
