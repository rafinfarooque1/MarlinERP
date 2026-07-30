/**
 * RoutePermissionGuard — route-level permission guard for App.tsx
 *
 * Wraps a page component at the router level so that navigating directly to a
 * URL (typed, bookmarked, or shared) is subject to the same permission check
 * as clicking a sidebar link.
 *
 * Key behaviours:
 *   • Blocks direct-URL access to any permission-controlled page.
 *   • Shows a neutral skeleton while permissions load (avoids permissive flash).
 *   • Shows a uniform "Access Denied" panel when access is denied.
 *   • Resolves satellite pages (e.g. /hr/leave → /hr/attendance's permission)
 *     through moduleRegistry's permKeyForRoute() so the check matches the
 *     sidebar's effective permission exactly.
 *   • Pages whose hrefs don't resolve to a known registry key are left
 *     unrestricted — pass `unrestricted` to explicitly opt out of the guard.
 *
 * Usage in App.tsx (inside existing AuthGuard):
 *   <Route path="/production/units">
 *     <AuthGuard>
 *       <RoutePermissionGuard href="/production/units" pageName="Units">
 *         <Units />
 *       </RoutePermissionGuard>
 *     </AuthGuard>
 *   </Route>
 */

import React from 'react';
import { permKeyForRoute, PAGE_PERM_KEY_SET } from '@/lib/moduleRegistry';
import { PermissionGuard } from './PermissionGuard';

export interface RoutePermissionGuardProps {
  /**
   * The canonical href for this route (must match the sidebar link's href or
   * a SATELLITE_PAGE_OWNER key in moduleRegistry).
   */
  href: string;
  /** Human-readable page name shown in the "Access Denied" message */
  pageName: string;
  children: React.ReactNode;
  /**
   * Set to true for pages that intentionally have no permission row
   * (e.g. /profile/me, /change-password). Guard is bypassed entirely.
   */
  unrestricted?: boolean;
}

export function RoutePermissionGuard({
  href,
  pageName,
  children,
  unrestricted = false,
}: RoutePermissionGuardProps) {
  // Pages explicitly flagged unrestricted skip the guard.
  if (unrestricted) return <>{children}</>;

  const permKey = permKeyForRoute(href);

  // If the resolved key is not in the registry (e.g. the page has no
  // sidebar link and is not a satellite), fall through unrestricted.
  // This keeps legacy/unlisted pages working while the registry is maintained.
  if (!PAGE_PERM_KEY_SET.has(permKey)) return <>{children}</>;

  return (
    <PermissionGuard permKey={permKey} pageName={pageName}>
      {children}
    </PermissionGuard>
  );
}
