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
  BookOpen,
  Warehouse,
  Store,
  Package,
  ArrowLeftRight,
  MapPin,
  Receipt,
  Banknote,
  Layers,
} from 'lucide-react';
import { useLocationContext } from '@/lib/locationContext';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { useLogout, useGetMe, useChangePassword, useListPermissions, useListHierarchies } from '@workspace/api-client-react';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

const LOGO_KEY = 'marlin_company_logo';

// ─── Navigation definition ────────────────────────────────────────────────────
// Each child has a `module` key matching the Permissions page MODULE_GROUPS.
// The `branchGroups` array lists which branchTypes can see this section.
// Omitting `branchGroups` = visible to all (incl. HO employees).
const navigation = [
  {
    name: 'Dashboard',
    icon: LayoutDashboard,
    href: '/',
    // Only show main Dashboard in Accounts segment for HO/warehouse employees
    // Outlet employees are redirected to Sales segment anyway
    branchGroups: ['warehouse', 'production', null],
  },
  {
    name: 'My Profile',
    icon: User,
    href: '/profile/me',
    // Always visible — every employee can access their own profile
  },
  {
    name: 'Production',
    icon: Factory,
    // Warehouses + HO can see Production; outlets cannot
    branchGroups: ['warehouse', 'production', null],
    children: [
      { name: 'Units',           href: '/production/units',          module: 'Materials'       },
      { name: 'Item Master',     href: '/production/item-master',    module: 'Items'           },
      { name: 'Batches',         href: '/production/production',     module: 'Production'      },
      { name: 'Stock Transfers', href: '/production/stock-transfer', module: 'Stock Transfers' },
      { name: 'Purchases',       href: '/production/purchase',       module: 'Purchases'       },
    ],
  },
  {
    name: 'Inventory',
    icon: Building2,
    branchGroups: ['warehouse', 'production', null],
    children: [
      { name: 'Stock',        href: '/headoffice/stock',              module: 'Stock'              },
      { name: 'Reports',      href: '/headoffice/inventory-reports',  module: 'Inventory Reports'  },
      { name: 'Verification', href: '/headoffice/stock-verification', module: 'Stock Verification' },
      { name: 'Transfers',   href: '/headoffice/transfers',   module: 'HO Transfers' },
      { name: 'Warehouses',  href: '/headoffice/warehouses',  module: 'Warehouses'   },
      { name: 'Outlets',     href: '/headoffice/outlets',     module: 'Outlets'      },
      { name: 'Item Prices', href: '/headoffice/item-price',  module: 'Item Prices'  },
    ],
  },
  {
    name: 'Sales',
    icon: Calculator,
    branchGroups: ['warehouse', null],
    children: [
      { name: 'Orders',      href: '/headoffice/sales', module: 'Sales'     },
      { name: 'Returns',     href: '/returns',          module: 'Sales'     },
      { name: 'Outstanding', href: '/outstanding',      module: 'Sales'     },
      { name: 'Customers',   href: '/customers',        module: 'Customers' },
      { name: 'Vendors',     href: '/vendors',          module: 'Vendors'   },
      { name: 'Coupons',     href: '/coupons',          module: 'Coupons'   },
    ],
  },
  {
    name: 'HR',
    icon: Users,
    branchGroups: [null], // HO only
    children: [
      { name: 'Employees',  href: '/hr/employees',  module: 'Employees'  },
      { name: 'Attendance', href: '/hr/attendance', module: 'Attendance' },
      { name: 'Leave',      href: '/hr/leave',      module: 'Leave'      },
      { name: 'Payroll',    href: '/hr/payroll',    module: 'Payroll'    },
      { name: 'Hierarchy',  href: '/hr/hierarchy',  module: 'Hierarchy'  },
    ],
  },
  {
    name: 'Accounts',
    icon: UsersRound,
    branchGroups: [null], // HO only
    children: [
      { name: 'Chart of Accounts', href: '/accounts/chart',           module: 'Chart of Accounts' },
      { name: 'Ledger',            href: '/accounts/ledger',          module: 'Ledger'            },
      { name: 'Payments',          href: '/accounts/payments',        module: 'Payments'          },
      { name: 'Receipts',          href: '/accounts/receipts',        module: 'Payments'          },
      { name: 'Journal',           href: '/accounts/journal',         module: 'Vouchers'          },
      { name: 'Contra',            href: '/accounts/contra',          module: 'Vouchers'          },
      { name: 'Credit/Debit Notes', href: '/accounts/notes',          module: 'Vouchers'          },
      { name: 'Day Book',          href: '/accounts/day-book',        module: 'Books'             },
      { name: 'Cash Book',         href: '/accounts/cash-book',       module: 'Books'             },
      { name: 'Bank Book',         href: '/accounts/bank-book',       module: 'Books'             },
      { name: 'Trial Balance',     href: '/accounts/trial-balance',   module: 'Books'             },
      { name: 'GST Summary',       href: '/accounts/gst',             module: 'GST Summary'       },
      { name: 'GST Returns',       href: '/accounts/gst-returns',     module: 'GST Returns'       },
      { name: 'Reconciliation',    href: '/accounts/reconciliation',  module: 'Reconciliation'    },
      { name: 'Cash Balance',      href: '/accounts/cash-in-outlet',  module: 'Cash Balance'      },
      { name: 'Reports',           href: '/accounts/reports',         module: 'Chart of Accounts' },
    ],
  },
  {
    name: 'Company',
    icon: Settings,
    // Company group — most items are admin-only (Settings module guards them)
    children: [
      { name: 'Settings',         href: '/company/settings',     module: 'Settings'     },
      { name: 'Company Profile',  href: '/company/profile',      module: 'Settings'     },
      { name: 'Permissions',      href: '/company/permissions',  module: 'Permissions'  },
      { name: 'Audit Log',        href: '/company/audit',        module: 'Settings'     },
    ],
  },
];

const salesNavItems = [
  { name: 'Dashboard',     icon: LayoutDashboard,  href: '/sales/dashboard',    module: 'Point of Sale'      },
  { name: 'Point of Sale', icon: ShoppingCart,     href: '/sales/pos',          module: 'Point of Sale'      },
  { name: 'Stock',         icon: Package,          href: '/sales/stock',        module: 'Location Stock'     },
  { name: 'Transfers',     icon: ArrowLeftRight,   href: '/sales/transfers',    module: 'Location Transfers' },
  { name: 'Expenses',      icon: Receipt,          href: '/sales/expenses',     module: 'Location Expenses'  },
  { name: 'Cash Balance',  icon: Banknote,         href: '/sales/cash-balance', module: 'Cash Balance'       },
];

// ─── Permission helpers ───────────────────────────────────────────────────────

/** Returns true if the current user can view this module.
 *  Mirrors the logic in usePermission.ts — if no DB row exists, default is canView=true. */
function checkCanView(
  module: string | undefined,
  hierarchyId: number | undefined,
  level: number,
  perms: any[],
): boolean {
  if (!module) return true;           // no module restriction
  if (level === 1) return true;       // level 1 = admin = full access always
  const perm = perms.find((p: any) => p.hierarchyId === hierarchyId && p.module === module);
  if (!perm) return true;             // no explicit row → default view-only (canView: true)
  return perm.canView ?? true;
}

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
  const [isOpen, setIsOpen] = useState(isActive);

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
        onClick={() => setIsOpen(!isOpen)}
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
            const isChildActive = currentPath === child.href;
            return (
              <Link 
                key={child.href} 
                href={child.href}
                className={`block px-3 py-2 rounded-md transition-colors text-sm ${isChildActive ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              >
                {child.name}
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
  const logoutMutation = useLogout();
  const { data: user } = useGetMe();
  const { data: allPerms = [] } = useListPermissions();
  const { data: hierarchies = [] } = useListHierarchies();
  const { theme, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [logo, setLogo] = useState<string | null>(() => localStorage.getItem(LOGO_KEY));
  const { locationState, setLocation: setLocContext } = useLocationContext();
  const isSalesSegment = location.startsWith('/sales');

  // ── User branch info ────────────────────────────────────────────────────────
  const userBranchType = (user as any)?.branchType as 'warehouse' | 'outlet' | 'production' | null | undefined;
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

  // ── Redirect outlet employees to Sales segment ──────────────────────────────
  useEffect(() => {
    if (!user) return;
    if (!isOutletEmployee) return;
    // If they somehow landed on an Accounts segment page, push them to Sales
    if (!location.startsWith('/sales') && location !== '/change-password' && location !== '/login') {
      setLocation('/sales/pos');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isOutletEmployee, location]);

  // ── Permission-filtered navigation ─────────────────────────────────────────
  const filteredNavigation = navigation
    .filter(item => {
      if (isAdmin) return true; // Level 1 always sees everything

      // branchGroups: if defined, the item is only shown for listed branch types
      if ('branchGroups' in item && item.branchGroups) {
        const allowed = (item.branchGroups as (string | null)[]).includes(userBranchType ?? null);
        if (!allowed) return false;
      }

      // For leaf-level items, check canView directly
      if (item.href) return true; // Dashboard, always show

      // For group items: show if at least one child is accessible (canView)
      if (item.children) {
        return item.children.some((child: any) =>
          checkCanView(child.module, (user as any)?.hierarchyId, userLevel, allPerms as any[])
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
          checkCanView(child.module, (user as any)?.hierarchyId, userLevel, allPerms as any[])
        ),
      };
    })
    .filter(item => !item.children || item.children.length > 0);

  // ── Permission-filtered sales nav ───────────────────────────────────────────
  const filteredSalesNavItems = salesNavItems.filter(item =>
    isAdmin || checkCanView(item.module, (user as any)?.hierarchyId, userLevel, allPerms as any[])
  );

  // ── Sales segment access ────────────────────────────────────────────────────
  const SALES_MODULES = ['Point of Sale', 'Location Stock', 'Location Transfers', 'Location Expenses', 'Cash Balance'];
  const hasSalesAccess = isAdmin || isLocationEmployee || SALES_MODULES.some(mod => {
    const perm = (allPerms as any[]).find((p: any) => p.hierarchyId === (user as any)?.hierarchyId && p.module === mod);
    return perm ? !!(perm.canView || perm.canAdd || perm.canEdit) : userLevel <= 4;
  });

  // Outlet employees only see Sales segment — hide the Accounts switcher button
  const showAccountsSegment = !isOutletEmployee;
  // Location-locked employees cannot change their location
  const canChangeLocation = !isLocationEmployee;

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
      <div className="min-h-screen bg-background flex flex-col md:flex-row">
        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
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
          `}
        >
          {/* Logo row */}
          <div className="h-16 flex items-center justify-between px-4 border-b border-border shrink-0">
            {!collapsed && (
              logo ? (
                <Link href={isOutletEmployee ? '/sales/pos' : '/'} className="flex items-center h-10 max-w-[160px]">
                  <img src={logo} alt="Company logo" className="h-full w-full object-contain object-left" />
                </Link>
              ) : (
                <h1 className="text-xl font-bold font-sans tracking-tight text-primary select-none">
                  MARLIN<span className="text-foreground">ERP</span>
                </h1>
              )
            )}
            {collapsed && (
              <div className="w-full flex justify-center">
                {logo ? (
                  <img src={logo} alt="Logo" className="w-8 h-8 object-contain" />
                ) : (
                  <span className="text-lg font-bold text-primary select-none">M</span>
                )}
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

          {/* Segment switcher — only when both segments are accessible */}
          {!collapsed && hasSalesAccess && showAccountsSegment && (
            <div className="px-3 pt-3 pb-1 shrink-0">
              <div className="flex gap-1 p-1 bg-muted/50 rounded-lg">
                <button
                  onClick={() => setLocation('/sales')}
                  className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-md font-semibold transition-colors ${isSalesSegment ? 'bg-card shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <ShoppingCart className="w-3 h-3" /> Sales
                </button>
                <button
                  onClick={() => setLocation('/')}
                  className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-md font-semibold transition-colors ${!isSalesSegment ? 'bg-card shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <BookOpen className="w-3 h-3" /> Accounts
                </button>
              </div>
            </div>
          )}

          {/* Outlet employee: show "Sales" label (no switcher) */}
          {!collapsed && isOutletEmployee && (
            <div className="px-3 pt-3 pb-1 shrink-0">
              <div className="flex gap-1 p-1 bg-muted/50 rounded-lg">
                <div className="flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-md font-semibold bg-card shadow text-foreground">
                  <ShoppingCart className="w-3 h-3" /> Sales
                </div>
              </div>
            </div>
          )}

          {/* Nav items */}
          <div className={`flex-1 overflow-y-auto py-4 space-y-1 ${collapsed ? 'px-[14px]' : 'px-3'}`}>
            {isSalesSegment || isOutletEmployee ? (
              /* ── Sales segment sidebar ── */
              <>
                {locationState.locationType ? (
                  <>
                    {/* Current location header */}
                    {!collapsed && (
                      <div className="mb-3 px-2 py-2 bg-muted/30 rounded-lg">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                          {locationState.locationType === 'all' ? 'Viewing' : 'Selling from'}
                        </p>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {locationState.locationType === 'warehouse'
                              ? <Warehouse className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                              : locationState.locationType === 'outlet'
                              ? <Store className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              : <Layers className="w-3.5 h-3.5 text-primary shrink-0" />}
                            <span className="text-sm font-semibold truncate">{locationState.locationName}</span>
                          </div>
                          {/* Only non-location-locked users can change their location */}
                          {canChangeLocation && (
                            <Link href="/sales" className="text-[10px] text-primary hover:underline shrink-0">change</Link>
                          )}
                        </div>
                      </div>
                    )}
                    {/* Sales sub-nav (permission filtered) */}
                    {filteredSalesNavItems.map(item => {
                      const isActive = location === item.href;
                      if (collapsed) {
                        return (
                          <Tooltip key={item.href}>
                            <TooltipTrigger asChild>
                              <Link href={item.href} className={`flex items-center justify-center w-10 h-10 rounded-md transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                                <item.icon className="w-5 h-5 shrink-0" />
                              </Link>
                            </TooltipTrigger>
                            <TooltipContent side="right">{item.name}</TooltipContent>
                          </Tooltip>
                        );
                      }
                      return (
                        <Link key={item.href} href={item.href} className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                          <item.icon className="w-4 h-4 shrink-0" />
                          {item.name}
                        </Link>
                      );
                    })}
                  </>
                ) : (
                  /* No location selected */
                  !collapsed ? (
                    <Link href="/sales" className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${location === '/sales' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                      <MapPin className="w-4 h-4 shrink-0" />
                      Choose Location
                    </Link>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link href="/sales" className="flex items-center justify-center w-10 h-10 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                          <MapPin className="w-5 h-5" />
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent side="right">Choose Location</TooltipContent>
                    </Tooltip>
                  )
                )}
              </>
            ) : (
              /* ── Accounts segment sidebar (permission + branch filtered) ── */
              filteredNavigation.map((item) => {
                const isActive = item.href
                  ? location === item.href
                  : item.children?.some((c: any) => location.startsWith(c.href));
                return (
                  <NavItem
                    key={item.name}
                    item={item}
                    isActive={!!isActive}
                    currentPath={location}
                    collapsed={collapsed}
                  />
                );
              })
            )}
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

              <div className="hidden md:flex items-center relative w-64 lg:w-96">
                <Search className="w-4 h-4 absolute left-3 text-muted-foreground" />
                <Input placeholder="Search everywhere..." className="pl-9 bg-muted/50 border-transparent focus-visible:bg-transparent" />
              </div>
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

              <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground">
                <Bell className="w-5 h-5" />
                <span className="absolute top-2 right-2 w-2 h-2 bg-primary rounded-full" />
              </Button>

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
                  {showAccountsSegment && (
                    <DropdownMenuItem asChild>
                      <Link href="/company/settings" className="cursor-pointer w-full flex items-center">
                        <Settings className="mr-2 h-4 w-4" />
                        Settings
                      </Link>
                    </DropdownMenuItem>
                  )}
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
