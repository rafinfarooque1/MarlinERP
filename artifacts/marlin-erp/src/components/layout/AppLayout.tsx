import React, { useState } from 'react';
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
  User
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLogout, useGetMe } from '@workspace/api-client-react';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

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

function NavItem({ item, isActive, currentPath }: { item: any, isActive: boolean, currentPath: string }) {
  const [isOpen, setIsOpen] = useState(isActive);
  const Icon = item.icon;

  if (!item.children) {
    return (
      <Link href={item.href} className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
        <Icon className="w-4 h-4" />
        {item.name}
      </Link>
    );
  }

  return (
    <div className="space-y-1">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      >
        <div className="flex items-center gap-3">
          <Icon className="w-4 h-4" />
          {item.name}
        </div>
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
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

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        setLocation('/login');
      }
    });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-card border-r border-border transform transition-transform duration-200 ease-in-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0`}>
        <div className="flex flex-col h-full">
          <div className="h-16 flex items-center px-6 border-b border-border">
            <h1 className="text-xl font-bold font-sans tracking-tight text-primary">MARLIN<span className="text-foreground">ERP</span></h1>
          </div>
          
          <div className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
            {navigation.map((item) => {
              const isActive = item.href ? location === item.href : item.children?.some(c => location.startsWith(c.href));
              return <NavItem key={item.name} item={item} isActive={!!isActive} currentPath={location} />;
            })}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-card border-b border-border flex items-center justify-between px-4 lg:px-8 z-40 sticky top-0">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setSidebarOpen(!sidebarOpen)}>
              <Menu className="w-5 h-5" />
            </Button>
            
            <div className="hidden md:flex items-center relative w-64 lg:w-96">
              <Search className="w-4 h-4 absolute left-3 text-muted-foreground" />
              <Input placeholder="Search everywhere..." className="pl-9 bg-muted/50 border-transparent focus-visible:bg-transparent" />
            </div>
          </div>
          
          <div className="flex items-center gap-2 lg:gap-4">
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
  );
}
