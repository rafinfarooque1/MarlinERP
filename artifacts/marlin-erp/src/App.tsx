import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation, Redirect, Link } from 'wouter';

import Login from './pages/auth/Login';
import ChangePassword from './pages/auth/ChangePassword';
import Dashboard from './pages/dashboard/Dashboard';

import Units from './pages/production/Units';

import Items from './pages/production/Items';
import Purchases from './pages/production/Purchases';
import ProductionList from './pages/production/Production';
import ProductionReports from './pages/production/ProductionReports';
import Transfers from './pages/Transfers';

import Warehouses from './pages/headoffice/Warehouses';
import Outlets from './pages/headoffice/Outlets';
import { OutletsEnabledRoute } from './components/OutletsEnabledRoute';
import Stock from './pages/headoffice/Stock';
import InventoryReports from './pages/headoffice/InventoryReports';
import StockVerification from './pages/headoffice/StockVerification';
import ItemPrices from './pages/headoffice/ItemPrices';
import Sales from './pages/headoffice/Sales';
import Quotations from './pages/headoffice/Quotations';
import StockLedger from './pages/headoffice/StockLedger';

import Hierarchy from './pages/hr/Hierarchy';
import Employees from './pages/hr/Employees';
import Payroll from './pages/hr/Payroll';
import Attendance from './pages/hr/Attendance';
import Leave from './pages/hr/Leave';
import Advances from './pages/hr/Advances';
import RentManagement from './pages/hr/RentManagement';

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
import ReceiptVoucher from './pages/operations/ReceiptVoucher';
import PaymentVoucher from './pages/operations/PaymentVoucher';
import Journal from './pages/accounts/Journal';
import Contra from './pages/accounts/Contra';
import Notes from './pages/accounts/Notes';
import Vouchers from './pages/accounts/Vouchers';
import DayBook from './pages/accounts/DayBook';
import CashBankBook from './pages/accounts/CashBankBook';
import TrialBalance from './pages/accounts/TrialBalance';
import ItemMaster from './pages/production/ItemMaster';

import AssetPurchases from './pages/assets/AssetPurchases';
import AssetRegister from './pages/assets/AssetRegister';
import AssetCategories from './pages/assets/AssetCategories';
import AssetTransfers from './pages/assets/AssetTransfers';
import AssetDisposal from './pages/assets/AssetDisposal';
import AssetReports from './pages/assets/AssetReports';

import CompanySettings from './pages/company/Settings';
import Permissions from './pages/company/Permissions';
import Profile from './pages/company/Profile';
import AuditLog from './pages/company/AuditLog';
import LoginHistory from './pages/company/LoginHistory';
import BackupRestore from './pages/company/BackupRestore';
import ImportData from './pages/company/ImportData';
import Reconciliation from './pages/finance/Reconciliation';
import CashInOutlet from './pages/finance/CashInOutlet';
import ReportsCenter from './pages/reports/ReportsCenter';

import LocationPicker from './pages/sales/LocationPicker';
import ProfileMe from './pages/profile/ProfileMe';
import SalesStock from './pages/sales/SalesStock';

import SalesPOS from './pages/sales/SalesPOS';
import SalesExpenses from './pages/sales/SalesExpenses';
import SalesCashBalance from './pages/sales/SalesCashBalance';
import SalesDashboard from './pages/sales/SalesDashboard';
import { LocationProvider } from './lib/locationContext';
import { RoutePermissionGuard } from './components/RoutePermissionGuard';
import { SessionProvider, useSession } from './lib/sessionContext';
import { Button } from './components/ui/button';
import { AlertTriangle, Loader2 } from 'lucide-react';

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
  const { stage, retry, signOut, user } = useSession();
  if (stage === 'unauthenticated') return <Redirect to="/login" />;
  if (stage === 'restoring') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <div className="text-center space-y-3">
          <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
          <p className="text-sm text-muted-foreground">Restoring your secure session…</p>
        </div>
      </div>
    );
  }
  if (stage === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
        <div className="max-w-md text-center space-y-4">
          <AlertTriangle className="w-9 h-9 text-destructive mx-auto" />
          <div>
            <h1 className="text-xl font-semibold">Unable to start the ERP</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We could not load your access settings. Your session is still active; please try again.
            </p>
          </div>
          <div className="flex justify-center gap-2">
            <Button onClick={retry}>Retry</Button>
            <Button variant="outline" onClick={signOut}>Sign out</Button>
          </div>
        </div>
      </div>
    );
  }
  // Enforce forced password-change before allowing access to any other page
  // The value is derived only from the verified /auth/me bootstrap response;
  // localStorage is user-controlled and must never decide this security gate.
  if (!allowMustChange && user?.mustChangePassword) return <Redirect to="/change-password" />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-bold font-mono text-primary">404</h1>
        <p className="text-xl text-muted-foreground">Location not found in database.</p>
        <Link href="/" className="inline-block mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md">Return to Dashboard</Link>
      </div>
    </div>
  );
}

/**
 * Convenience: AuthGuard + RoutePermissionGuard in one wrapper.
 * The `href` is the canonical route href used to look up the permission key.
 */
function PermGuard({
  href,
  pageName,
  children,
  allowMustChange = false,
  unrestricted = false,
}: {
  href: string;
  pageName: string;
  children: React.ReactNode;
  allowMustChange?: boolean;
  unrestricted?: boolean;
}) {
  return (
    <AuthGuard allowMustChange={allowMustChange}>
      <RoutePermissionGuard href={href} pageName={pageName} unrestricted={unrestricted}>
        {children}
      </RoutePermissionGuard>
    </AuthGuard>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />

      <Route path="/">
        <PermGuard href="/" pageName="Dashboard"><Dashboard /></PermGuard>
      </Route>
      <Route path="/dashboard">
        <PermGuard href="/" pageName="Dashboard"><Dashboard /></PermGuard>
      </Route>
      <Route path="/change-password">
        <PermGuard href="/change-password" pageName="Change Password" allowMustChange unrestricted>
          <ChangePassword />
        </PermGuard>
      </Route>

      <Route path="/production/units">
        <PermGuard href="/production/units" pageName="Units"><Units /></PermGuard>
      </Route>
      <Route path="/production/items">
        {/* Satellite: governed by item-master permission */}
        <PermGuard href="/production/items" pageName="Items"><Items /></PermGuard>
      </Route>
      <Route path="/production/purchase">
        <PermGuard href="/production/purchase" pageName="Purchases"><Purchases /></PermGuard>
      </Route>
      <Route path="/production/production">
        <PermGuard href="/production/production" pageName="Production Batches"><ProductionList /></PermGuard>
      </Route>
      <Route path="/production/reports">
        <PermGuard href="/production/reports" pageName="Production Reports"><ProductionReports /></PermGuard>
      </Route>

      {/* Unified transfers page — all roles */}
      <Route path="/transfers">
        <PermGuard href="/transfers" pageName="Stock Transfer"><Transfers /></PermGuard>
      </Route>
      {/* Legacy redirects so any bookmarks / old links still work */}
      <Route path="/production/stock-transfer"><Redirect to="/transfers" /></Route>
      <Route path="/headoffice/transfers"><Redirect to="/transfers" /></Route>
      <Route path="/sales/transfers">
        {/* Satellite: /sales/transfers → /transfers permission */}
        <PermGuard href="/sales/transfers" pageName="Stock Transfer"><Transfers /></PermGuard>
      </Route>

      <Route path="/headoffice/warehouses">
        <PermGuard href="/headoffice/warehouses" pageName="Warehouses"><Warehouses /></PermGuard>
      </Route>
      <Route path="/headoffice/outlets">
        <PermGuard href="/headoffice/outlets" pageName="Outlets">
          <OutletsEnabledRoute><Outlets /></OutletsEnabledRoute>
        </PermGuard>
      </Route>
      <Route path="/headoffice/stock">
        <PermGuard href="/headoffice/stock" pageName="Stock"><Stock /></PermGuard>
      </Route>
      <Route path="/headoffice/inventory-reports">
        <PermGuard href="/headoffice/inventory-reports" pageName="Inventory Reports"><InventoryReports /></PermGuard>
      </Route>
      <Route path="/headoffice/stock-verification">
        <PermGuard href="/headoffice/stock-verification" pageName="Stock Verification"><StockVerification /></PermGuard>
      </Route>
      <Route path="/headoffice/stock-ledger">
        <PermGuard href="/headoffice/stock-ledger" pageName="Stock Ledger"><StockLedger /></PermGuard>
      </Route>
      <Route path="/headoffice/item-price">
        <PermGuard href="/headoffice/item-price" pageName="Item Prices"><ItemPrices /></PermGuard>
      </Route>
      <Route path="/headoffice/sales">
        {/* Legacy direct link; Sales is governed by Point of Sale. */}
        <PermGuard href="/sales/pos" pageName="Sales"><Sales /></PermGuard>
      </Route>

      <Route path="/hr/hierarchy">
        <PermGuard href="/hr/hierarchy" pageName="Hierarchy"><Hierarchy /></PermGuard>
      </Route>
      <Route path="/hr/employees">
        <PermGuard href="/hr/employees" pageName="Employees"><Employees /></PermGuard>
      </Route>
      <Route path="/hr/payroll">
        <PermGuard href="/hr/payroll" pageName="Payroll"><Payroll /></PermGuard>
      </Route>
      <Route path="/hr/attendance">
        <PermGuard href="/hr/attendance" pageName="Attendance"><Attendance /></PermGuard>
      </Route>
      <Route path="/hr/leave">
        {/* Satellite: /hr/leave → /hr/attendance permission */}
        <PermGuard href="/hr/leave" pageName="Leave"><Leave /></PermGuard>
      </Route>
      <Route path="/hr/advances">
        <PermGuard href="/hr/advances" pageName="Advances"><Advances /></PermGuard>
      </Route>
      <Route path="/hr/rent">
        <PermGuard href="/hr/rent" pageName="Rent Management"><RentManagement /></PermGuard>
      </Route>

      <Route path="/customers">
        <PermGuard href="/customers" pageName="Customers"><Customers /></PermGuard>
      </Route>
      <Route path="/vendors">
        <PermGuard href="/vendors" pageName="Vendors"><Vendors /></PermGuard>
      </Route>
      <Route path="/coupons">
        <PermGuard href="/coupons" pageName="Coupons"><Coupons /></PermGuard>
      </Route>
      <Route path="/returns">
        <PermGuard href="/returns" pageName="Returns"><Returns /></PermGuard>
      </Route>
      <Route path="/outstanding">
        <PermGuard href="/outstanding" pageName="Outstanding"><Outstanding /></PermGuard>
      </Route>

      <Route path="/accounts/chart">
        <PermGuard href="/accounts/chart" pageName="Chart of Accounts"><ChartOfAccounts /></PermGuard>
      </Route>
      <Route path="/accounts/ledger">
        <PermGuard href="/accounts/ledger" pageName="Ledger Statement"><Ledger /></PermGuard>
      </Route>
      <Route path="/accounts/cash-bank">
        <PermGuard href="/accounts/cash-bank" pageName="Cash & Bank"><CashBank /></PermGuard>
      </Route>
      <Route path="/accounts/expenses">
        <PermGuard href="/accounts/expenses" pageName="Expenses"><Expenses /></PermGuard>
      </Route>
      <Route path="/accounts/vouchers">
        <PermGuard href="/accounts/vouchers" pageName="Vouchers"><Vouchers /></PermGuard>
      </Route>
      <Route path="/accounts/payments">
        {/* Satellite: /accounts/payments → /accounts/vouchers permission */}
        <PermGuard href="/accounts/payments" pageName="Payments"><Payment /></PermGuard>
      </Route>
      <Route path="/accounts/receipts">
        {/* Satellite: /accounts/receipts → /accounts/vouchers permission */}
        <PermGuard href="/accounts/receipts" pageName="Receipts"><ReceiptPage /></PermGuard>
      </Route>
      <Route path="/accounts/journal">
        {/* Satellite: /accounts/journal → /accounts/vouchers permission */}
        <PermGuard href="/accounts/journal" pageName="Journal"><Journal /></PermGuard>
      </Route>
      <Route path="/accounts/contra">
        {/* Satellite: /accounts/contra → /accounts/vouchers permission */}
        <PermGuard href="/accounts/contra" pageName="Contra"><Contra /></PermGuard>
      </Route>
      <Route path="/accounts/notes">
        {/* Satellite: /accounts/notes → /accounts/vouchers permission */}
        <PermGuard href="/accounts/notes" pageName="Credit / Debit Notes"><Notes /></PermGuard>
      </Route>
      <Route path="/accounts/day-book">
        <PermGuard href="/accounts/day-book" pageName="Day Book"><DayBook /></PermGuard>
      </Route>
      <Route path="/accounts/cash-book">
        <PermGuard href="/accounts/cash-book" pageName="Cash Book"><CashBankBook kind="cash" /></PermGuard>
      </Route>
      <Route path="/accounts/bank-book">
        <PermGuard href="/accounts/bank-book" pageName="Bank Book"><CashBankBook kind="bank" /></PermGuard>
      </Route>
      <Route path="/accounts/trial-balance">
        <PermGuard href="/accounts/trial-balance" pageName="Trial Balance"><TrialBalance /></PermGuard>
      </Route>
      <Route path="/accounts/gst">
        <PermGuard href="/accounts/gst" pageName="GST Summary"><GstSummary /></PermGuard>
      </Route>
      <Route path="/accounts/gst-returns">
        <PermGuard href="/accounts/gst-returns" pageName="GST Returns"><GstReturns /></PermGuard>
      </Route>

      <Route path="/production/item-master">
        <PermGuard href="/production/item-master" pageName="Item Master"><ItemMaster /></PermGuard>
      </Route>

      {/* Assets — standalone Asset Management module */}
      <Route path="/assets/purchases">
        <PermGuard href="/assets/purchases" pageName="Asset Purchases"><AssetPurchases /></PermGuard>
      </Route>
      <Route path="/assets/register">
        <PermGuard href="/assets/register" pageName="Asset Register"><AssetRegister /></PermGuard>
      </Route>
      <Route path="/assets/categories">
        <PermGuard href="/assets/categories" pageName="Asset Categories"><AssetCategories /></PermGuard>
      </Route>
      <Route path="/assets/transfers">
        <PermGuard href="/assets/transfers" pageName="Asset Transfers"><AssetTransfers /></PermGuard>
      </Route>
      <Route path="/assets/disposal">
        <PermGuard href="/assets/disposal" pageName="Asset Disposal"><AssetDisposal /></PermGuard>
      </Route>
      <Route path="/assets/reports">
        <PermGuard href="/assets/reports" pageName="Asset Reports"><AssetReports /></PermGuard>
      </Route>

      <Route path="/company/settings">
        <PermGuard href="/company/settings" pageName="Settings"><CompanySettings /></PermGuard>
      </Route>
      <Route path="/company/permissions">
        <PermGuard href="/company/permissions" pageName="Permissions"><Permissions /></PermGuard>
      </Route>
      <Route path="/company/profile">
        <PermGuard href="/company/profile" pageName="Company Profile"><Profile /></PermGuard>
      </Route>
      <Route path="/company/audit">
        <PermGuard href="/company/audit" pageName="Audit Log"><AuditLog /></PermGuard>
      </Route>
      <Route path="/company/login-history">
        <PermGuard href="/company/login-history" pageName="Login History"><LoginHistory /></PermGuard>
      </Route>
      <Route path="/company/backup">
        <PermGuard href="/company/backup" pageName="Backup & Restore"><BackupRestore /></PermGuard>
      </Route>
      <Route path="/company/import">
        <PermGuard href="/company/import" pageName="Import Data"><ImportData /></PermGuard>
      </Route>
      <Route path="/accounts/reconciliation">
        <PermGuard href="/accounts/reconciliation" pageName="Reconciliation"><Reconciliation /></PermGuard>
      </Route>
      <Route path="/accounts/cash-in-outlet">
        <PermGuard href="/accounts/cash-in-outlet" pageName="Cash Balance"><CashInOutlet /></PermGuard>
      </Route>
      <Route path="/accounts/reports"><Redirect to="/reports/sales" /></Route>
      <Route path="/reports"><Redirect to="/reports/sales" /></Route>
      <Route path="/reports/:cat">
        <PermGuard href="/reports/sales" pageName="Reports"><ReportsCenter /></PermGuard>
      </Route>

      {/* /profile/me has no permission row — unrestricted for all logged-in users */}
      <Route path="/profile/me">
        <AuthGuard><ProfileMe /></AuthGuard>
      </Route>

      {/* Sales segment */}
      <Route path="/sales">
        {/* Location picker — no permission row needed */}
        <AuthGuard><LocationPicker /></AuthGuard>
      </Route>
      <Route path="/sales/dashboard">
        {/* Satellite: /sales/dashboard → / (Dashboard) permission */}
        <PermGuard href="/sales/dashboard" pageName="Sales Dashboard"><SalesDashboard /></PermGuard>
      </Route>
      <Route path="/sales/stock">
        {/* Satellite: /sales/stock → /headoffice/stock permission */}
        <PermGuard href="/sales/stock" pageName="Stock"><SalesStock /></PermGuard>
      </Route>

      <Route path="/sales/pos">
        <PermGuard href="/sales/pos" pageName="Point of Sale"><SalesPOS /></PermGuard>
      </Route>
      <Route path="/sales/quotations">
        <PermGuard href="/sales/quotations" pageName="Quotations"><Quotations /></PermGuard>
      </Route>
      <Route path="/operations/receipt-voucher">
        <PermGuard href="/operations/receipt-voucher" pageName="Receipt Voucher"><ReceiptVoucher /></PermGuard>
      </Route>

      <Route path="/operations/payment-voucher">
        <PermGuard href="/operations/payment-voucher" pageName="Payment Voucher"><PaymentVoucher /></PermGuard>
      </Route>

      <Route path="/sales/expenses">
        <PermGuard href="/sales/expenses" pageName="Expenses"><SalesExpenses /></PermGuard>
      </Route>
      <Route path="/sales/cash-balance">
        {/* Satellite: /sales/cash-balance → /accounts/cash-in-outlet permission */}
        <PermGuard href="/sales/cash-balance" pageName="Cash Balance"><SalesCashBalance /></PermGuard>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <TooltipProvider>
          <LocationProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <Router />
            </WouterRouter>
            <Toaster richColors position="top-right" />
          </LocationProvider>
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
