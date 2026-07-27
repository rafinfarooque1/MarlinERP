import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation, Redirect } from 'wouter';

import Login from './pages/auth/Login';
import ChangePassword from './pages/auth/ChangePassword';
import Dashboard from './pages/dashboard/Dashboard';

import Units from './pages/production/Units';

import Items from './pages/production/Items';
import Purchases from './pages/production/Purchases';
import ProductionList from './pages/production/Production';
import ProductionReports from './pages/production/ProductionReports';
import StockTransfers from './pages/production/StockTransfers';

import Warehouses from './pages/headoffice/Warehouses';
import Outlets from './pages/headoffice/Outlets';
import Stock from './pages/headoffice/Stock';
import InventoryReports from './pages/headoffice/InventoryReports';
import StockVerification from './pages/headoffice/StockVerification';
import HoTransfers from './pages/headoffice/HoTransfers';
import ItemPrices from './pages/headoffice/ItemPrices';
import Sales from './pages/headoffice/Sales';
import StockLedger from './pages/headoffice/StockLedger';

import Hierarchy from './pages/hr/Hierarchy';
import Employees from './pages/hr/Employees';
import Payroll from './pages/hr/Payroll';
import Attendance from './pages/hr/Attendance';
import Leave from './pages/hr/Leave';

import Customers from './pages/customers/Customers';
import Vendors from './pages/customers/Vendors';
import Coupons from './pages/customers/Coupons';
import Returns from './pages/returns/Returns';
import Outstanding from './pages/outstanding/Outstanding';

import ChartOfAccounts from './pages/accounts/ChartOfAccounts';
import Ledger from './pages/accounts/Ledger';
import CashBank from './pages/accounts/CashBank';
import Expenses from './pages/accounts/Expenses';
import GstSummary from './pages/accounts/GstSummary';
import GstReturns from './pages/accounts/GstReturns';
import Payment from './pages/accounts/Payment';
import ReceiptPage from './pages/accounts/Receipt';
import Journal from './pages/accounts/Journal';
import Contra from './pages/accounts/Contra';
import Notes from './pages/accounts/Notes';
import DayBook from './pages/accounts/DayBook';
import CashBankBook from './pages/accounts/CashBankBook';
import TrialBalance from './pages/accounts/TrialBalance';
import ItemMaster from './pages/production/ItemMaster';

import CompanySettings from './pages/company/Settings';
import Permissions from './pages/company/Permissions';
import Profile from './pages/company/Profile';
import AuditLog from './pages/company/AuditLog';
import LoginHistory from './pages/company/LoginHistory';
import Reconciliation from './pages/finance/Reconciliation';
import CashInOutlet from './pages/finance/CashInOutlet';
import ReportsCenter from './pages/reports/ReportsCenter';

import LocationPicker from './pages/sales/LocationPicker';
import ProfileMe from './pages/profile/ProfileMe';
import SalesStock from './pages/sales/SalesStock';
import SalesTransfers from './pages/sales/SalesTransfers';
import SalesPOS from './pages/sales/SalesPOS';
import SalesExpenses from './pages/sales/SalesExpenses';
import SalesCashBalance from './pages/sales/SalesCashBalance';
import SalesDashboard from './pages/sales/SalesDashboard';
import { LocationProvider } from './lib/locationContext';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 0,               // always consider cached data stale → refetch on every mount/invalidation
      gcTime: 5 * 60_000,         // keep unused data in memory for 5 min (GC only)
      refetchOnWindowFocus: false, // don't re-fetch just because user switches tabs
      refetchOnReconnect: false,   // don't blast the server on reconnect
    },
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

      <Route path="/production/items"><AuthGuard><Items /></AuthGuard></Route>
      <Route path="/production/purchase"><AuthGuard><Purchases /></AuthGuard></Route>
      <Route path="/production/production"><AuthGuard><ProductionList /></AuthGuard></Route>
      <Route path="/production/reports"><AuthGuard><ProductionReports /></AuthGuard></Route>
      <Route path="/production/stock-transfer"><AuthGuard><StockTransfers /></AuthGuard></Route>

      <Route path="/headoffice/warehouses"><AuthGuard><Warehouses /></AuthGuard></Route>
      <Route path="/headoffice/outlets"><AuthGuard><Outlets /></AuthGuard></Route>
      <Route path="/headoffice/stock"><AuthGuard><Stock /></AuthGuard></Route>
      <Route path="/headoffice/inventory-reports"><AuthGuard><InventoryReports /></AuthGuard></Route>
      <Route path="/headoffice/stock-verification"><AuthGuard><StockVerification /></AuthGuard></Route>
      <Route path="/headoffice/stock-ledger"><AuthGuard><StockLedger /></AuthGuard></Route>
      <Route path="/headoffice/transfers"><AuthGuard><HoTransfers /></AuthGuard></Route>
      <Route path="/headoffice/item-price"><AuthGuard><ItemPrices /></AuthGuard></Route>
      <Route path="/headoffice/sales"><AuthGuard><Sales /></AuthGuard></Route>

      <Route path="/hr/hierarchy"><AuthGuard><Hierarchy /></AuthGuard></Route>
      <Route path="/hr/employees"><AuthGuard><Employees /></AuthGuard></Route>
      <Route path="/hr/payroll"><AuthGuard><Payroll /></AuthGuard></Route>
      <Route path="/hr/attendance"><AuthGuard><Attendance /></AuthGuard></Route>
      <Route path="/hr/leave"><AuthGuard><Leave /></AuthGuard></Route>

      <Route path="/customers"><AuthGuard><Customers /></AuthGuard></Route>
      <Route path="/vendors"><AuthGuard><Vendors /></AuthGuard></Route>
      <Route path="/coupons"><AuthGuard><Coupons /></AuthGuard></Route>
      <Route path="/returns"><AuthGuard><Returns /></AuthGuard></Route>
      <Route path="/outstanding"><AuthGuard><Outstanding /></AuthGuard></Route>

      <Route path="/accounts/chart"><AuthGuard><ChartOfAccounts /></AuthGuard></Route>
      <Route path="/accounts/ledger"><AuthGuard><Ledger /></AuthGuard></Route>
      <Route path="/accounts/cash-bank"><AuthGuard><CashBank /></AuthGuard></Route>
      <Route path="/accounts/expenses"><AuthGuard><Expenses /></AuthGuard></Route>
      <Route path="/accounts/payments"><AuthGuard><Payment /></AuthGuard></Route>
      <Route path="/accounts/receipts"><AuthGuard><ReceiptPage /></AuthGuard></Route>
      <Route path="/accounts/journal"><AuthGuard><Journal /></AuthGuard></Route>
      <Route path="/accounts/contra"><AuthGuard><Contra /></AuthGuard></Route>
      <Route path="/accounts/notes"><AuthGuard><Notes /></AuthGuard></Route>
      <Route path="/accounts/day-book"><AuthGuard><DayBook /></AuthGuard></Route>
      <Route path="/accounts/cash-book"><AuthGuard><CashBankBook kind="cash" /></AuthGuard></Route>
      <Route path="/accounts/bank-book"><AuthGuard><CashBankBook kind="bank" /></AuthGuard></Route>
      <Route path="/accounts/trial-balance"><AuthGuard><TrialBalance /></AuthGuard></Route>
      <Route path="/accounts/gst"><AuthGuard><GstSummary /></AuthGuard></Route>
      <Route path="/accounts/gst-returns"><AuthGuard><GstReturns /></AuthGuard></Route>

      <Route path="/production/item-master"><AuthGuard><ItemMaster /></AuthGuard></Route>

      <Route path="/company/settings"><AuthGuard><CompanySettings /></AuthGuard></Route>
      <Route path="/company/permissions"><AuthGuard><Permissions /></AuthGuard></Route>
      <Route path="/company/profile"><AuthGuard><Profile /></AuthGuard></Route>
      <Route path="/company/audit"><AuthGuard><AuditLog /></AuthGuard></Route>
      <Route path="/company/login-history"><AuthGuard><LoginHistory /></AuthGuard></Route>

      <Route path="/accounts/reconciliation"><AuthGuard><Reconciliation /></AuthGuard></Route>
      <Route path="/accounts/cash-in-outlet"><AuthGuard><CashInOutlet /></AuthGuard></Route>
      <Route path="/accounts/reports"><Redirect to="/reports/sales" /></Route>
      <Route path="/reports"><Redirect to="/reports/sales" /></Route>
      <Route path="/reports/:cat"><AuthGuard><ReportsCenter /></AuthGuard></Route>

      <Route path="/profile/me"><AuthGuard><ProfileMe /></AuthGuard></Route>

      {/* Sales segment */}
      <Route path="/sales"><AuthGuard><LocationPicker /></AuthGuard></Route>
      <Route path="/sales/dashboard"><AuthGuard><SalesDashboard /></AuthGuard></Route>
      <Route path="/sales/stock"><AuthGuard><SalesStock /></AuthGuard></Route>
      <Route path="/sales/transfers"><AuthGuard><SalesTransfers /></AuthGuard></Route>
      <Route path="/sales/pos"><AuthGuard><SalesPOS /></AuthGuard></Route>
      <Route path="/sales/expenses"><AuthGuard><SalesExpenses /></AuthGuard></Route>
      <Route path="/sales/cash-balance"><AuthGuard><SalesCashBalance /></AuthGuard></Route>

      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <LocationProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
          <Toaster richColors position="top-right" />
        </LocationProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
