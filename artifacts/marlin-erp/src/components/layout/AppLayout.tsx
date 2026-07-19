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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLogout, useGetMe } from '@workspace/api-client-react';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const LOGO_KEY = 'marlin_company_logo';

const navigation = [
  {
    name: 'Dashboard',
    icon: LayoutDashboard,
    href: '/',
  },
  {
    name: 'Production',
    icon: Factory,
    children: [
      { name: 'Units', href: '/production/units' },
      { name: 'Materials', href: '/production/materials' },
      { name: 'Raw Materials', href: '/production/raw-materials' },
      { name: 'Items', href: '/production/items' },
      { name: 'Purchases', href: '/production/purchase' },
      { name: 'Production', href: '/production/production' },
      { name: 'Stock Transfer', href: '/production/stock-transfer' },
    ],
  },
  {
    name: 'Head Office',
    icon: Building2,
    children: [
      { name: 'Warehouses', href: '/headoffice/warehouses' },
      { name: 'Outlets', href: '/headoffice/outlets' },
      { name: 'Stock', href: '/headoffice/stock' },
      { name: 'Transfers', href: '/headoffice/transfers' },
      { name: 'Item Prices', href: '/headoffice/item-price' },
      { name: 'Sales', href: '/headoffice/sales' },
    ],
  },
  {
    name: 'HR',
    icon: Users,
    children: [
      { name: 'Hierarchy', href: '/hr/hierarchy' },
      { name: 'Employees', href: '/hr/employees' },
      { name: 'Payroll', href: '/hr/payroll' },
      { name: 'Attendance', href: '/hr/attendance' },
      { name: 'Leave', href: '/hr/leave' },
    ],
  },
  {
    name: 'Customer & Vendor',
    icon: UsersRound,
    children: [
      { name: 'Customers', href: '/customers' },
      { name: 'Vendors', href: '/vendors' },
      { name: 'Coupons', href: '/coupons' },
    ],
  },
  {
    name: 'Accounts',
    icon: Calculator,
    children: [
      { name: 'Chart of Accounts', href: '/accounts/chart' },
      { name: 'Ledger', href: '/accounts/ledger' },
      { name: 'Cash & Bank', href: '/accounts/cash-bank' },
      { name: 'Expenses', href: '/accounts/expenses' },
      { name: 'GST Summary', href: '/accounts/gst' },
    ],
  },
  {
    name: 'Company',
    icon: Settings,
    children: [
      { name: 'Settings', href: '/company/settings' },
      { name: 'Permissions', href: '/company/permissions' },
      { name: 'Profile', href: '/company/profile' },
    ],
  },
];

function NavItem({ item, isActive, currentPath, collapsed }: { item: any, isActive: boolean, currentPath: string, collapsed: boolean }) {
  const [isOpen, setIsOpen] = useState(isActive);
  const Icon = item.icon;

  if (!item.children) {
    if (collapsed) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link href={item.href} className={`flex items-center justify-center w-10 h-10 rounded-md transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
              <Icon className="w-5 h-5" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-sans">{item.name}</TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Link href={item.href} className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
        <Icon className="w-4 h-4 shrink-0" />
        {item.name}
      </Link>
    );
  }

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setIsOpen(!isOpen)}
            className={`flex items-center justify-center w-10 h-10 rounded-md transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            <Icon className="w-5 h-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="font-sans">
          <p className="font-medium mb-1">{item.name}</p>
          {item.children.map((child: any) => (
            <Link key={child.href} href={child.href} className="block text-xs text-muted-foreground hover:text-foreground py-0.5">
              {child.name}
            </Link>
          ))}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="space-y-1">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      >
        <div className="flex items-center gap-3">
          <Icon className="w-4 h-4 shrink-0" />
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

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const logoutMutation = useLogout();
  const { data: user } = useGetMe();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [logo, setLogo] = useState<string | null>(() => localStorage.getItem(LOGO_KEY));

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
                <Link href="/" className="flex items-center h-10 max-w-[160px]">
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

            {/* Collapse toggle — always visible */}
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

          {/* Nav items */}
          <div className={`flex-1 overflow-y-auto py-4 space-y-1 ${collapsed ? 'px-[14px]' : 'px-3'}`}>
            {navigation.map((item) => {
              const isActive = item.href
                ? location === item.href
                : item.children?.some(c => location.startsWith(c.href));
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
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Top Header */}
          <header className="h-16 bg-card border-b border-border flex items-center justify-between px-4 lg:px-8 z-40 sticky top-0">
            <div className="flex items-center gap-4">
              {/* Mobile hamburger */}
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
              {/* Company logo in header (visible on mobile when sidebar is hidden) */}
              {logo && (
                <div className="md:hidden flex items-center h-8">
                  <img src={logo} alt="Company logo" className="h-full object-contain max-w-[100px]" />
                </div>
              )}

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
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/company/profile" className="cursor-pointer w-full flex items-center">
                      <User className="mr-2 h-4 w-4" />
                      Profile
                    </Link>
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
    </TooltipProvider>
  );
}
