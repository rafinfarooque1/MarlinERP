/**
 * PermissionGuard — centralized page-level access control
 *
 * Wraps any page that is permission-controlled and handles three states:
 *   1. Loading   → shows a neutral skeleton so no content flashes before
 *                  permissions have been resolved (avoids permissive flash).
 *   2. Denied    → renders a uniform "Access Denied" panel inside AppLayout.
 *   3. Permitted → renders children unchanged.
 *
 * The guard derives the permission key from the `permKey` prop, which must be
 * a `page:` key from PAGE_PERM_KEYS (src/lib/moduleRegistry.ts).  For routes
 * that are not sidebar links themselves (satellite pages), pass the owning
 * link's key — or use RoutePermissionGuard which resolves it automatically via
 * permKeyForRoute().
 *
 * Usage:
 *   <PermissionGuard permKey="page:/production/units" pageName="Units">
 *     <Units />
 *   </PermissionGuard>
 */

import React from 'react';
import { Link } from 'wouter';
import { ShieldOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';

interface PermissionGuardProps {
  /** A `page:` key from PAGE_PERM_KEYS, e.g. `"page:/production/units"` */
  permKey: string;
  /** Human-readable page name shown in the "Access Denied" message */
  pageName: string;
  children: React.ReactNode;
}

/**
 * Loading skeleton shown while permissions are being fetched.
 * Neutral enough to work for any page — just a few grey bars.
 */
function LoadingSkeleton() {
  return (
    <AppLayout>
      <div className="space-y-4 p-2">
        <Skeleton className="h-8 w-48 rounded-md" />
        <Skeleton className="h-4 w-72 rounded-md" />
        <div className="grid grid-cols-1 gap-3 pt-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      </div>
    </AppLayout>
  );
}

/**
 * "Access Denied" panel shown when the resolved permission set has canView=false.
 */
function AccessDenied({ pageName }: { pageName: string }) {
  return (
    <AppLayout>
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
        <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <ShieldOff className="w-8 h-8 text-destructive" />
        </div>
        <div className="max-w-md">
          <h2 className="text-xl font-bold">Access Denied</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            You don&apos;t have permission to view {pageName}.<br />
            Contact your administrator to request access.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/">
            <Button variant="outline">Back to Dashboard</Button>
          </Link>
        </div>
      </div>
    </AppLayout>
  );
}

export function PermissionGuard({ permKey, pageName, children }: PermissionGuardProps) {
  const perm = usePermission(permKey);

  // While permissions are loading, show a neutral skeleton.
  // This prevents the page content from flashing before we know whether the
  // user is allowed to see it (avoids both "permissive flash" and a premature
  // "Access Denied" flicker).
  if (perm.isLoading) {
    return <LoadingSkeleton />;
  }

  if (!perm.canView) {
    return <AccessDenied pageName={pageName} />;
  }

  return <>{children}</>;
}
