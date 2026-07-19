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
} from 'lucide-react';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { useLogout, useGetMe, useChangePassword } from '@workspace/api-client-react';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

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
      { name: 'BOM Templates', href: '/production/bom' },
      { name: 'Batches', href: '/production/batches' },
    ],
  },
  {
    name: 'Inventory',
    icon: Building2,
    children: [
      { name: 'Stock', href: '/inventory/stock' },
      { name: 'Transfers', href: '/inventory/transfers' },
      { name: 'Warehouses', href: '/inventory/warehouses' },
    ],
  },
  {
    name: 'Sales',
    icon: Calculator,
    children: [
      { name: 'Orders', href: '/sales/orders' },
      { name: 'Customers', href: '/sales/customers' },
      { name: 'Vendors', href: '/sales/vendors' },
      { name: 'Purchases', href: '/sales/purchases' },
    ],
  },
  {
    name: 'HR',
    icon: Users,
    children: [
      { name: 'Employees', href: '/hr/employees' },
      { name: 'Attendance', href: '/hr/attendance' },
      { name: 'Leave', href: '/hr/leave' },
      { name: 'Payroll', href: '/hr/payroll' },
    ],
  },
  {
    name: 'Accounts',
    icon: UsersRound,
    children: [
      { name: 'Ledger', href: '/accounts/ledger' },
      { name: 'Cash & Bank', href: '/accounts/cash-bank' },
      { name: 'Expenses', href: '/accounts/expenses' },
    ],
  },
  {
    name: 'Company',
    icon: Building2,
    children: [
      { name: 'Settings', href: '/company/settings' },
      { name: 'Profile', href: '/company/profile' },
      { name: 'Branches', href: '/company/branches' },
      { name: 'Hierarchy', href: '/company/hierarchy' },
      { name: 'Permissions', href: '/company/permissions' },
      { name: 'Audit Log', href: '/company/audit' },
    ],
  },
];

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

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const logoutMutation = useLogout();
  const { data: user } = useGetMe();
  const { theme, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [logo, setLogo] = useState<string | null>(() => localStorage.getItem(LOGO_KEY));

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

              {/* Theme toggle */}
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
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/company/profile" className="cursor-pointer w-full flex items-center">
                      <User className="mr-2 h-4 w-4" />
                      Profile
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
