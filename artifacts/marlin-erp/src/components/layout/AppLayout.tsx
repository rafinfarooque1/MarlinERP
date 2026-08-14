import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { 
  LayoutDashboard, 
  Factory, 
  Building2, 
  Users, 
  UsersRound, 
  Calculator, 
  Settings, 
  LogOut,
  ChevronDown,
  ChevronRight,
  Menu,
  Bell,
  Search,
  User,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  KeyRound,
  Eye,
  EyeOff,
  ShoppingCart,
  Warehouse,
  Store,
  Package,
  ArrowLeftRight,
  MapPin,
  Receipt,
  Banknote,
  Layers,
  FileBarChart2,
  FileText,
} from 'lucide-react';
import { useLocationContext } from '@/lib/locationContext';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { useLogout, useGetMe, useChangePassword, useListPermissions, useListHierarchies, useQuickSearch, useExpiredQuotationNotifications } from '@workspace/api-client-react';
import { Input } from '@/components/ui/input';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import {
  MODULE_REGISTRY,
  getNavGroups,
  pagePermKey,
  RETIRED_PAGE_HREFS,
  type SidebarNavItem,
} from '@/lib/moduleRegistry';
import { canViewModule as checkCanView } from '@/lib/usePermission';
import { useOutletsEnabled } from '@/lib/useFeatureFlags';
import { GlobalLocationSelector } from '@/components/layout/GlobalLocationSelector';

const LOGO_KEY = 'marlin_company_logo';
/** The retired Outlet module's sidebar link, matched by href so
 *  moduleRegistry's navEntries stay untouched. */
const OUTLETS_HREF = '/headoffice/outlets';

/**
 * Retired sidebar links to hide, matched by href so moduleRegistry's
 * navEntries stay untouched (same total-hide pattern as OUTLETS_HREF).
 *
 * The set lives in moduleRegistry (RETIRED_PAGE_HREFS) so the sidebar, the
 * route table and the Permissions matrix retire the same pages. Only the
 * navigation/UI exposure is removed: permission keys and every expense and
 * stock-ledger read API stay in place, so history keeps its names.
 */
const RETIRED_NAV_HREFS = RETIRED_PAGE_HREFS;

// ─── Navigation — derived from module registry ────────────────────────────────
// To add, rename, or reorder modules edit src/lib/moduleRegistry.ts only.
// AppLayout and the Permissions page update automatically from that file.

const _standaloneNavItems = MODULE_REGISTRY
  .filter(m => m.navGroup === '__standalone__')
  .map(m => ({
    name:    m.navEntries[0].name,
    icon:    m.icon!,
    href:    m.navEntries[0].href,
    module:  m.key,
    permKey: pagePermKey(m.navEntries[0].href),
  }));

const navigation: SidebarNavItem[] = [
  ..._standaloneNavItems,
  // My Profile is always visible and has no permission key
  { name: 'My Profile', icon: User, href: '/profile/me' },
  ...getNavGroups(),
];

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────
// Derived from the module registry so the trail can never drift from the nav.
// A leaf page shows "Group > Page"; a standalone page shows just its name.

export interface Crumb { label: string; href?: string }

/**
 * Satellite paths that carry no sidebar link of their own. Each maps to an
 * explicit "Group > Page" trail so a deep link into a tab still reads sensibly.
 */
export const BREADCRUMB_ENTRIES: Record<string, Crumb[]> = {
  '/headoffice/stock/storage':  [{ label: 'Stock', href: '/headoffice/stock' }, { label: 'Storage Locations' }],
  '/headoffice/stock/tracking': [{ label: 'Stock', href: '/headoffice/stock' }, { label: 'Item Tracking' }],
};

// One-time index: href → { group, name } built from the rendered nav groups.
const _breadcrumbIndex: Record<string, { group?: string; name: string }> = (() => {
  const idx: Record<string, { group?: string; name: string }> = {};
  for (const item of navigation) {
    if (item.href) {
      idx[item.href] = { name: item.name };
    } else if (item.children) {
      for (const child of item.children) {
        if (!idx[child.href]) idx[child.href] = { group: item.name, name: child.name };
      }
    }
  }
  return idx;
})();

/** Resolve a path to its breadcrumb trail (Group > Page). */
export function breadcrumbFor(path: string): Crumb[] {
  if (BREADCRUMB_ENTRIES[path]) return BREADCRUMB_ENTRIES[path];
  const hit = _breadcrumbIndex[path];
  if (!hit) return [];
  const trail: Crumb[] = [];
  if (hit.group) trail.push({ label: hit.group });
  trail.push({ label: hit.name });
  return trail;
}

// ─── Permission helpers ───────────────────────────────────────────────────────

// ─── PasswordInput ────────────────────────────────────────────────────────────

function PasswordInput({ value, onChange, placeholder, id, autoComplete }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

// ─── NavItem ──────────────────────────────────────────────────────────────────

function NavItem({ item, isActive, currentPath, collapsed }: any) {
  // Remember which menu groups the user expanded (persisted per user + group
  // name so a shared browser doesn't leak one login's layout to another) so
  // the sidebar reopens the same way next visit.
  let navUser = '';
  try { navUser = JSON.parse(localStorage.getItem('marlin_user') || 'null')?.username ?? ''; } catch { /* ignore */ }
  const navOpenKey = `marlin_nav_open:${navUser}:${item.name}`;
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (item.href) return isActive;
    try {
      const saved = localStorage.getItem(navOpenKey);
      if (saved != null) return saved === '1';
    } catch { /* storage unavailable — fall back to the active-group default */ }
    return isActive;
  });
  // A remembered "collapsed" must never hide the page the user is ON: force
  // the group open (without persisting) whenever it becomes the active one,
  // e.g. after a global-search jump or a deep link into a child page.
  useEffect(() => { if (isActive) setIsOpen(true); }, [isActive]);

  if (item.href) {
    if (collapsed) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={item.href}
              className={`flex items-center justify-center w-10 h-10 rounded-md transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            >
              <item.icon className="w-5 h-5 shrink-0" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">{item.name}</TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Link
        href={item.href}
        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      >
        <item.icon className="w-4 h-4 shrink-0" />
        {item.name}
      </Link>
    );
  }

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={`flex items-center justify-center w-10 h-10 rounded-md transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            <item.icon className="w-5 h-5 shrink-0" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{item.name}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div>
      <button
        onClick={() => setIsOpen(o => {
          const next = !o;
          try { localStorage.setItem(navOpenKey, next ? '1' : '0'); } catch { /* non-fatal */ }
          return next;
        })}
        className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      >
        <div className="flex items-center gap-3">
          <item.icon className="w-4 h-4 shrink-0" />
          {item.name}
        </div>
        {isOpen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
      </button>
      
      {isOpen && (
        <div className="pl-9 space-y-1">
          {item.children.map((child: any) => {
            const isChildActive = child.matchPrefix
              ? currentPath.startsWith(child.matchPrefix)
              : currentPath === child.href;
            return (
              <Link 
                key={child.href} 
                href={child.href}
                className={`block px-3 py-2 rounded-md transition-colors text-sm ${isChildActive ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              >
                <span className="flex items-center gap-2">
                  {child.name}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── AppLayout ────────────────────────────────────────────────────────────────

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const logoutMutation = useLogout();
  const { data: user } = useGetMe();
  const { data: allPerms = [] } = useListPermissions();
  const { data: hierarchies = [] } = useListHierarchies();
  const { theme, toggleTheme } = useTheme();
  const { outletsEnabled } = useOutletsEnabled();
  // Mobile drawer starts CLOSED (on md+ the sidebar is always visible via
  // md:translate-x-0, so this only governs phones). Tablets (768–1199px)
  // start with the rail collapsed to give content room; desktop keeps the
  // full sidebar exactly as before.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 768 && window.innerWidth < 1200,
  );
  const [logo, setLogo] = useState<string | null>(() => localStorage.getItem(LOGO_KEY));

  // Picking a menu item on a phone should show the page, not leave the drawer
  // covering it — close the drawer whenever the route changes. Desktop/tablet
  // ignore sidebarOpen entirely, so this is mobile-only by construction.
  useEffect(() => { setSidebarOpen(false); }, [location]);
  const { locationState, setLocation: setLocContext } = useLocationContext();

  // ── User branch info ────────────────────────────────────────────────────────
  const userBranchType = (user as any)?.branchType as 'headoffice' | 'warehouse' | 'outlet' | undefined;
  const userBranchId   = (user as any)?.branchId   as number | null | undefined;
  const userBranchName = (user as any)?.branchName as string | undefined;

  // Whether this is a location-locked user (outlet or warehouse employee)
  const isOutletEmployee    = userBranchType === 'outlet';
  const isWarehouseEmployee = userBranchType === 'warehouse';
  const isLocationEmployee  = isOutletEmployee || isWarehouseEmployee;

  // ── User hierarchy level ────────────────────────────────────────────────────
  const userHierarchy = (hierarchies as any[]).find((h: any) => h.id === (user as any)?.hierarchyId);
  const userLevel     = userHierarchy?.level ?? 99;
  const isAdmin       = userLevel === 1;

  // ── Auto-set location context for location-locked employees ─────────────────
  // When an outlet/warehouse employee logs in, pin their location automatically
  useEffect(() => {
    if (!user) return;
    if (!isLocationEmployee) return;
    if (!userBranchId) return;
    // Only auto-set if not already set to their branch (avoids overwriting on every render)
    if (locationState.locationId === userBranchId && locationState.locationType === userBranchType) return;
    setLocContext({
      locationType: userBranchType!,
      locationId: userBranchId,
      locationName: userBranchName || (isOutletEmployee ? 'Outlet' : 'Warehouse'),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, userBranchType, userBranchId]);


  // ── Permission-filtered navigation ─────────────────────────────────────────
  const filteredNavigation = navigation
    .filter(item => {
      if (isAdmin) return true; // Level 1 always sees everything

      // For leaf-level items, check canView directly.
      // `permKey` is the per-link permission row; `module` is only a fallback
      // for nav items that predate per-link rows.
      if (item.href) {
        // any-of `modules` list (e.g. Reports Center): visible if any is viewable
        if ('modules' in item && item.modules) {
          return (item.modules as string[]).some(m =>
            checkCanView(m, (user as any)?.hierarchyId, userLevel, allPerms as any[]),
          );
        }
        const leafKey = (item as any).permKey ?? item.module;
        if (leafKey) {
          return checkCanView(leafKey as string, (user as any)?.hierarchyId, userLevel, allPerms as any[]);
        }
        return true;
      }

      // For group items: show if at least one child is accessible (canView)
      if (item.children) {
        return item.children.some((child: any) =>
          checkCanView(child.permKey ?? child.module, (user as any)?.hierarchyId, userLevel, allPerms as any[])
        );
      }
      return true;
    })
    .map(item => {
      if (isAdmin || !item.children) return item;
      // Filter out children where canView is explicitly false
      return {
        ...item,
        children: item.children.filter((child: any) =>
          checkCanView(child.permKey ?? child.module, (user as any)?.hierarchyId, userLevel, allPerms as any[])
        ),
      };
    })
    .filter(item => !item.children || item.children.length > 0)
    // Drop retired/duplicate nav links (total hide, no placeholder). Pure
    // filter — the page routes and permission rows are left intact.
    .filter((item: any) => !item.href || !RETIRED_NAV_HREFS.has(item.href))
    .map((item: any) =>
      item.children
        ? { ...item, children: item.children.filter((c: any) => !RETIRED_NAV_HREFS.has(c.href)) }
        : item,
    )
    .filter((item: any) => !item.children || item.children.length > 0);

  // ── Outlet module visibility ───────────────────────────────────────────────
  // Outlet Management off ⇒ the link disappears for everyone, with no badge and
  // no placeholder, and its section collapses away if nothing else survives the
  // permission filter. Turning the setting back on restores it in its original
  // registry position, so this stays a pure filter and never reorders the nav.
  // Enforcement lives in the backend; this only controls what is offered.
  const navWithOutletVisibility = outletsEnabled
    ? filteredNavigation
    : filteredNavigation
        .filter((item: any) => item.href !== OUTLETS_HREF)
        .map((item: any) =>
          item.children
            ? { ...item, children: item.children.filter((c: any) => c.href !== OUTLETS_HREF) }
            : item,
        )
        .filter((item: any) => !item.children || item.children.length > 0);

  // Location-locked employees cannot change their location context
  const canChangeLocation = !isLocationEmployee;

  // Breadcrumb trail for the current route — Group > Page, registry-driven.
  const crumbs = breadcrumbFor(location);

  // ── Global quick search (Cmd/Ctrl+K) ────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchQ), 250);
    return () => clearTimeout(t);
  }, [searchQ]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const { data: searchResults, isFetching: searchFetching } = useQuickSearch(searchOpen ? debouncedQ : '');
  const gotoResult = (href: string) => {
    setSearchOpen(false);
    setSearchQ('');
    setLocation(href);
  };

  // ── Search group visibility: only show groups whose destination the user can view ──
  // Uses the same checkCanView helper as the sidebar so the two stay in sync.
  // Sales invoices (/headoffice/sales) has no registry entry → always accessible.
  const userHierarchyId = (user as any)?.hierarchyId as number | undefined;
  const searchCanViewItems    = isAdmin || checkCanView(pagePermKey('/production/item-master'), userHierarchyId, userLevel, allPerms as any[]);
  const searchCanViewCustomers = isAdmin || checkCanView(pagePermKey('/customers'),             userHierarchyId, userLevel, allPerms as any[]);
  const searchCanViewVendors   = isAdmin || checkCanView(pagePermKey('/vendors'),               userHierarchyId, userLevel, allPerms as any[]);
  const searchCanViewQuotations = isAdmin || checkCanView(pagePermKey('/sales/quotations'),      userHierarchyId, userLevel, allPerms as any[]);
  // Sales invoices: /headoffice/sales has no registry key — treat as always accessible

  // ── Notification bell: quotations that expired recently, for users who can see them ──
  const { data: expiredQuotes = [] } = useExpiredQuotationNotifications({ enabled: searchCanViewQuotations });

  // Change-password dialog state
  const [pwOpen, setPwOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const changePasswordMutation = useChangePassword();

  // Listen for logo changes from Profile page
  useEffect(() => {
    const handler = (e: Event) => {
      setLogo((e as CustomEvent).detail);
    };
    window.addEventListener('marlin_logo_changed', handler);
    return () => window.removeEventListener('marlin_logo_changed', handler);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('marlin_auth_token');
    localStorage.removeItem('marlin_user');
    queryClient.clear(); // wipe all cached data so next login loads fresh
    setLocation('/login');
  };

  const openChangePw = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPwError('');
    setPwOpen(true);
  };

  const handleChangePw = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError('');
    if (newPassword.length < 6) {
      setPwError('New password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError('New passwords do not match.');
      return;
    }
    try {
      await changePasswordMutation.mutateAsync({ data: { currentPassword, newPassword } });
      toast.success('Password changed successfully.');
      setPwOpen(false);
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err?.message ?? 'Failed to change password.';
      setPwError(msg);
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      {/* h-screen (not min-h-screen) pins the sidebar: only the page content
          pane scrolls, so the nav stays visible however long the page is. */}
      <div className="h-screen overflow-hidden bg-background flex flex-col md:flex-row">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-[45] bg-black/50 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        <aside
          className={`
            fixed inset-y-0 left-0 z-50 bg-card border-r border-border
            transform transition-all duration-200 ease-in-out flex flex-col
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
            md:relative md:translate-x-0
            ${collapsed ? 'w-[68px]' : 'w-64'}
            max-md:w-[80vw] max-md:max-w-sm
          `}
        >
          {/* Logo row */}
          <div className="h-16 flex items-center justify-between px-4 border-b border-border shrink-0">
            {!collapsed && (
              <Link href="/" className="flex items-center h-10 max-w-[160px]">
                <img src={logo || '/marlin-logo.jpeg'} alt="Marlin Frozen Fruits" className="h-full w-full object-contain object-left" />
              </Link>
            )}
            {collapsed && (
              <div className="w-full flex justify-center">
                <img src={logo || '/marlin-logo.jpeg'} alt="Logo" className="w-8 h-8 object-contain" />
              </div>
            )}

            {/* Collapse toggle */}
            <button
              onClick={() => {
                if (window.innerWidth < 768) {
                  setSidebarOpen(false);
                } else {
                  setCollapsed(!collapsed);
                }
              }}
              className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            </button>
          </div>

          {/* Nav items — unified, permission-filtered for all users */}
          <div className={`flex-1 overflow-y-auto py-4 space-y-1 ${collapsed ? 'px-[14px]' : 'px-3'}`}>
            {/* Unified nav groups */}
            {navWithOutletVisibility.map((item) => {
              const isActive = item.href
                ? location === item.href
                : item.children?.some((c: any) =>
                    c.matchPrefix ? location.startsWith(c.matchPrefix) : location === c.href
                  );
              return (
                <NavItem
                  key={item.name}
                  item={item}
                  isActive={!!isActive}
                  currentPath={location}
                  collapsed={collapsed}
                />
              );
            })}
          </div>

          {/* Global location context — pinned to the sidebar's bottom-left */}
          <div className={`border-t border-border shrink-0 ${collapsed ? 'py-3 px-1' : 'p-3'}`}>
            <GlobalLocationSelector collapsed={collapsed} />
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Top Header */}
          <header className="h-16 bg-card border-b border-border flex items-center justify-between px-4 lg:px-8 z-40 sticky top-0">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <Menu className="w-5 h-5" />
              </Button>

              <button
                onClick={() => setSearchOpen(true)}
                className="hidden md:flex items-center gap-2 w-64 lg:w-96 h-9 px-3 rounded-md bg-muted/50 text-sm text-muted-foreground hover:bg-muted transition-colors"
              >
                <Search className="w-4 h-4 shrink-0" />
                <span className="flex-1 text-left">Search everywhere...</span>
                <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-background px-1.5 font-mono text-[10px] font-medium">
                  <span className="text-xs">⌘</span>K
                </kbd>
              </button>

              {crumbs.length > 0 && (
                <nav aria-label="Breadcrumb" className="hidden lg:flex items-center gap-1.5 text-sm min-w-0">
                  {crumbs.map((c, i) => (
                    <span key={`${c.label}-${i}`} className="flex items-center gap-1.5 min-w-0">
                      {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                      {c.href && i < crumbs.length - 1 ? (
                        <Link href={c.href} className="text-muted-foreground hover:text-foreground transition-colors truncate">
                          {c.label}
                        </Link>
                      ) : (
                        <span className={i === crumbs.length - 1 ? 'font-medium text-foreground truncate' : 'text-muted-foreground truncate'}>
                          {c.label}
                        </span>
                      )}
                    </span>
                  ))}
                </nav>
              )}
            </div>

            <div className="flex items-center gap-2 lg:gap-4">
              {logo && (
                <div className="md:hidden flex items-center h-8">
                  <img src={logo} alt="Company logo" className="h-full object-contain max-w-[100px]" />
                </div>
              )}

              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground"
                onClick={toggleTheme}
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground" title="Notifications">
                    <Bell className="w-5 h-5" />
                    {expiredQuotes.length > 0 && (
                      <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
                        {expiredQuotes.length}
                      </span>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80 font-sans">
                  <DropdownMenuLabel>Notifications</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {expiredQuotes.length === 0 ? (
                    <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                      Nothing needs your attention.
                    </div>
                  ) : (
                    expiredQuotes.map((n) => (
                      <DropdownMenuItem
                        key={n.id}
                        className="flex items-start gap-2 py-2 cursor-pointer"
                        onClick={() => setLocation('/sales/quotations')}
                      >
                        <FileText className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">Quotation {n.quotationNumber} expired</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {n.customerName || 'Walk-in'} · ₹{Number(n.totalAmount).toLocaleString('en-IN')} · valid till {n.validTill ? new Date(n.validTill).toLocaleDateString('en-IN') : '—'}
                          </p>
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="relative h-9 w-9 rounded-full">
                    <Avatar className="h-9 w-9 border border-border">
                      <AvatarImage src={user?.photoUrl || undefined} alt={user?.name} />
                      <AvatarFallback className="bg-primary/20 text-primary">{user?.name?.charAt(0) || 'U'}</AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 font-sans">
                  <DropdownMenuLabel className="font-normal">
                    <div className="flex flex-col space-y-1">
                      <p className="text-sm font-medium leading-none">{user?.name}</p>
                      <p className="text-xs leading-none text-muted-foreground">{user?.email || user?.username}</p>
                      {/* Show branch badge for location employees */}
                      {userBranchType && userBranchName && (
                        <p className="text-[10px] leading-none text-primary mt-1 capitalize">
                          {userBranchType} · {userBranchName}
                        </p>
                      )}
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/profile/me" className="cursor-pointer w-full flex items-center">
                      <User className="mr-2 h-4 w-4" />
                      My Profile
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={openChangePw} className="cursor-pointer">
                    <KeyRound className="mr-2 h-4 w-4" />
                    Change Password
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/company/settings" className="cursor-pointer w-full flex items-center">
                      <Settings className="mr-2 h-4 w-4" />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleLogout} className="text-destructive cursor-pointer">
                    <LogOut className="mr-2 h-4 w-4" />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          {/* Page Content */}
          <div className="flex-1 overflow-auto p-4 lg:p-8 bg-background relative">
            {children}
          </div>
        </main>
      </div>

      {/* ── Global Quick Search (Cmd/Ctrl+K) ───────────────────── */}
      <CommandDialog open={searchOpen} onOpenChange={(o) => { setSearchOpen(o); if (!o) setSearchQ(''); }}>
        <CommandInput
          placeholder="Search items, customers, vendors, invoices..."
          value={searchQ}
          onValueChange={setSearchQ}
        />
        <CommandList>
          <CommandEmpty>
            {debouncedQ.trim().length < 2
              ? 'Type at least 2 characters to search.'
              : searchFetching ? 'Searching…' : 'No results found.'}
          </CommandEmpty>
          {searchResults && searchResults.items.length > 0 && searchCanViewItems && (
            <CommandGroup heading="Items">
              {searchResults.items.map(r => (
                <CommandItem key={`item-${r.id}`} value={`item-${r.id}-${r.title}`} onSelect={() => gotoResult('/production/item-master')}>
                  <Package className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span>{r.title}</span>
                  {r.subtitle && <span className="ml-2 text-xs text-muted-foreground">{r.subtitle}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {searchResults && searchResults.customers.length > 0 && searchCanViewCustomers && (
            <CommandGroup heading="Customers">
              {searchResults.customers.map(r => (
                <CommandItem key={`cust-${r.id}`} value={`cust-${r.id}-${r.title}`} onSelect={() => gotoResult('/customers')}>
                  <Users className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span>{r.title}</span>
                  {r.subtitle && <span className="ml-2 text-xs text-muted-foreground">{r.subtitle}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {searchResults && searchResults.vendors.length > 0 && searchCanViewVendors && (
            <CommandGroup heading="Vendors">
              {searchResults.vendors.map(r => (
                <CommandItem key={`vend-${r.id}`} value={`vend-${r.id}-${r.title}`} onSelect={() => gotoResult('/vendors')}>
                  <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span>{r.title}</span>
                  {r.subtitle && <span className="ml-2 text-xs text-muted-foreground">{r.subtitle}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {searchResults && searchResults.sales.length > 0 && (
            <CommandGroup heading="Sales Invoices">
              {searchResults.sales.map(r => (
                <CommandItem key={`sale-${r.id}`} value={`sale-${r.id}-${r.title}`} onSelect={() => gotoResult('/headoffice/sales')}>
                  <Receipt className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span>{r.title}</span>
                  {r.subtitle && <span className="ml-2 text-xs text-muted-foreground">{r.subtitle}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {searchResults && (searchResults.quotations?.length ?? 0) > 0 && searchCanViewQuotations && (
            <CommandGroup heading="Quotations">
              {searchResults.quotations.map(r => (
                <CommandItem key={`quote-${r.id}`} value={`quote-${r.id}-${r.title}`} onSelect={() => gotoResult('/sales/quotations')}>
                  <FileText className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span>{r.title}</span>
                  {r.subtitle && <span className="ml-2 text-xs text-muted-foreground">{r.subtitle}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>

      {/* ── Change Password Dialog ─────────────────────────────── */}
      <Dialog open={pwOpen} onOpenChange={setPwOpen}>
        <DialogContent className="sm:max-w-md font-sans">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-primary" />
              Change Password
            </DialogTitle>
            <DialogDescription>
              Enter your current password, then choose a new one.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleChangePw} className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="cp-current">Current Password</Label>
              <PasswordInput
                id="cp-current"
                value={currentPassword}
                onChange={setCurrentPassword}
                placeholder="Your current password"
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cp-new">New Password</Label>
              <PasswordInput
                id="cp-new"
                value={newPassword}
                onChange={setNewPassword}
                placeholder="At least 6 characters"
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cp-confirm">Confirm New Password</Label>
              <PasswordInput
                id="cp-confirm"
                value={confirmPassword}
                onChange={setConfirmPassword}
                placeholder="Repeat new password"
                autoComplete="new-password"
              />
            </div>

            {pwError && (
              <p className="text-sm text-destructive">{pwError}</p>
            )}

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => setPwOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={changePasswordMutation.isPending}>
                {changePasswordMutation.isPending ? 'Saving…' : 'Save Password'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
