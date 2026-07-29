/**
 * Route guard for the Outlet module.
 *
 * Outlet Management is a Location Structure setting. When it is off the module
 * is not merely hidden from the sidebar — reaching /headoffice/outlets by typed
 * URL, bookmark or stale tab lands on an "Access Disabled" page instead of the
 * live page.
 *
 * This is an affordance guard, not a security boundary: the API refuses outlet
 * writes independently (409 OUTLETS_DISABLED). Outlet *records* are never
 * deleted or hidden from history — turning the setting back on restores the
 * page and every existing record with it.
 */
import { Link } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { PackageX } from 'lucide-react';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';

export function OutletsEnabledRoute({ children }: { children: React.ReactNode }) {
  const { outletsEnabled, isLoading } = useOutletsEnabled();

  // The flags hook defaults to "disabled" so a failed fetch can never re-open
  // the module. That default would also flash this page on every hard load, so
  // hold the render until the real value has arrived.
  if (isLoading) return null;

  if (!outletsEnabled) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
            <PackageX className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="max-w-md">
            <h2 className="text-xl font-bold">Outlet Management is turned off</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              This company is set up with warehouses only. No outlet records have been
              deleted — every past outlet sale, stock movement and accounting entry is
              still in the system, and turning Outlet Management back on restores this
              page and all of its data immediately.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/company/settings">
              <Button>Open Location Structure settings</Button>
            </Link>
            <Link href="/">
              <Button variant="outline">Back to dashboard</Button>
            </Link>
          </div>
        </div>
      </AppLayout>
    );
  }

  return <>{children}</>;
}
