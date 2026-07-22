import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation, Redirect } from 'wouter';

import Login from './pages/auth/Login';
import ChangePassword from './pages/auth/ChangePassword';
import Dashboard from './pages/dashboard/Dashboard';

import Units from './pages/production/Units';
import Materials from './pages/production/Materials';
import RawMaterials from './pages/production/RawMaterials';
import Items from './pages/production/Items';
import Purchases from './pages/production/Purchases';
import ProductionList from './pages/production/Production';
import StockTransfers from './pages/production/StockTransfers';

import Warehouses from './pages/headoffice/Warehouses';
import Outlets from './pages/headoffice/Outlets';
import Stock from './pages/headoffice/Stock';
import HoTransfers from './pages/headoffice/HoTransfers';
import ItemPrices from './pages/headoffice/ItemPrices';
import Sales from './pages/headoffice/Sales';
import Payments from './pages/headoffice/Payments';

import Hierarchy from './pages/hr/Hierarchy';
import Employees from './pages/hr/Employees';
import Payroll from './pages/hr/Payroll';
import Attendance from './pages/hr/Attendance';
import Leave from './pages/hr/Leave';

import Customers from './pages/customers/Customers';
import Vendors from './pages/customers/Vendors';
import Coupons from './pages/customers/Coupons';

import ChartOfAccounts from './pages/accounts/ChartOfAccounts';
import Ledger from './pages/accounts/Ledger';
import CashBank from './pages/accounts/CashBank';
import Expenses from './pages/accounts/Expenses';
import GstSummary from './pages/accounts/GstSummary';
import Payment from './pages/accounts/Payment';
import ReceiptPage from './pages/accounts/Receipt';
import ItemMaster from './pages/production/ItemMaster';

import CompanySettings from './pages/company/Settings';
import Permissions from './pages/company/Permissions';
import Profile from './pages/company/Profile';
import AuditLog from './pages/company/AuditLog';
import Reconciliation from './pages/finance/Reconciliation';
import CashInOutlet from './pages/finance/CashInOutlet';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

function AuthGuard({ children, allowMustChange = false }: { children: React.ReactNode; allowMustChange?: boolean }) {
  const token = localStorage.getItem('marlin_auth_token');
  if (!token) return <Redirect to="/login" />;
  // Enforce forced password-change before allowing access to any other page
  if (!allowMustChange) {
    try {
      const user = JSON.parse(localStorage.getItem('marlin_user') ?? '{}');
      if (user.mustChangePassword) return <Redirect to="/change-password" />;
    } catch { /* ignore */ }
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-bold font-mono text-primary">404</h1>
        <p className="text-xl text-muted-foreground">Location not found in database.</p>
        <a href="/" className="inline-block mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md">Return to Dashboard</a>
      </div>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />

      <Route path="/">
        <AuthGuard><Dashboard /></AuthGuard>
      </Route>
      <Route path="/dashboard">
        <AuthGuard><Dashboard /></AuthGuard>
      </Route>
      <Route path="/change-password">
        <AuthGuard allowMustChange><ChangePassword /></AuthGuard>
      </Route>

      <Route path="/production/units"><AuthGuard><Units /></AuthGuard></Route>
      <Route path="/production/materials"><AuthGuard><Materials /></AuthGuard></Route>
      <Route path="/production/raw-materials"><AuthGuard><RawMaterials /></AuthGuard></Route>
      <Route path="/production/items"><AuthGuard><Items /></AuthGuard></Route>
      <Route path="/production/purchase"><AuthGuard><Purchases /></AuthGuard></Route>
      <Route path="/production/production"><AuthGuard><ProductionList /></AuthGuard></Route>
      <Route path="/production/stock-transfer"><AuthGuard><StockTransfers /></AuthGuard></Route>

      <Route path="/headoffice/warehouses"><AuthGuard><Warehouses /></AuthGuard></Route>
      <Route path="/headoffice/outlets"><AuthGuard><Outlets /></AuthGuard></Route>
      <Route path="/headoffice/stock"><AuthGuard><Stock /></AuthGuard></Route>
      <Route path="/headoffice/transfers"><AuthGuard><HoTransfers /></AuthGuard></Route>
      <Route path="/headoffice/item-price"><AuthGuard><ItemPrices /></AuthGuard></Route>
      <Route path="/headoffice/sales"><AuthGuard><Sales /></AuthGuard></Route>
      <Route path="/headoffice/payments"><AuthGuard><Payments /></AuthGuard></Route>

      <Route path="/hr/hierarchy"><AuthGuard><Hierarchy /></AuthGuard></Route>
      <Route path="/hr/employees"><AuthGuard><Employees /></AuthGuard></Route>
      <Route path="/hr/payroll"><AuthGuard><Payroll /></AuthGuard></Route>
      <Route path="/hr/attendance"><AuthGuard><Attendance /></AuthGuard></Route>
      <Route path="/hr/leave"><AuthGuard><Leave /></AuthGuard></Route>

      <Route path="/customers"><AuthGuard><Customers /></AuthGuard></Route>
      <Route path="/vendors"><AuthGuard><Vendors /></AuthGuard></Route>
      <Route path="/coupons"><AuthGuard><Coupons /></AuthGuard></Route>

      <Route path="/accounts/chart"><AuthGuard><ChartOfAccounts /></AuthGuard></Route>
      <Route path="/accounts/ledger"><AuthGuard><Ledger /></AuthGuard></Route>
      <Route path="/accounts/cash-bank"><AuthGuard><CashBank /></AuthGuard></Route>
      <Route path="/accounts/expenses"><AuthGuard><Expenses /></AuthGuard></Route>
      <Route path="/accounts/payments"><AuthGuard><Payment /></AuthGuard></Route>
      <Route path="/accounts/receipts"><AuthGuard><ReceiptPage /></AuthGuard></Route>
      <Route path="/accounts/gst"><AuthGuard><GstSummary /></AuthGuard></Route>

      <Route path="/production/item-master"><AuthGuard><ItemMaster /></AuthGuard></Route>

      <Route path="/company/settings"><AuthGuard><CompanySettings /></AuthGuard></Route>
      <Route path="/company/permissions"><AuthGuard><Permissions /></AuthGuard></Route>
      <Route path="/company/profile"><AuthGuard><Profile /></AuthGuard></Route>
      <Route path="/company/audit"><AuthGuard><AuditLog /></AuthGuard></Route>

      <Route path="/accounts/reconciliation"><AuthGuard><Reconciliation /></AuthGuard></Route>
      <Route path="/accounts/cash-in-outlet"><AuthGuard><CashInOutlet /></AuthGuard></Route>

      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster richColors position="top-right" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
