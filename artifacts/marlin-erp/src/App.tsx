import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import Login from './pages/auth/Login';
import ChangePassword from './pages/auth/ChangePassword';
import Dashboard from './pages/dashboard/Dashboard';

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

import CompanySettings from './pages/company/Settings';
import Permissions from './pages/company/Permissions';
import Profile from './pages/company/Profile';

const queryClient = new QueryClient();

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
      <Route path="/change-password" component={ChangePassword} />
      <Route path="/" component={Dashboard} />
      <Route path="/dashboard" component={Dashboard} />
      
      <Route path="/production/materials" component={Materials} />
      <Route path="/production/raw-materials" component={RawMaterials} />
      <Route path="/production/items" component={Items} />
      <Route path="/production/purchase" component={Purchases} />
      <Route path="/production/production" component={ProductionList} />
      <Route path="/production/stock-transfer" component={StockTransfers} />
      
      <Route path="/headoffice/warehouses" component={Warehouses} />
      <Route path="/headoffice/outlets" component={Outlets} />
      <Route path="/headoffice/stock" component={Stock} />
      <Route path="/headoffice/transfers" component={HoTransfers} />
      <Route path="/headoffice/item-price" component={ItemPrices} />
      <Route path="/headoffice/sales" component={Sales} />

      <Route path="/hr/hierarchy" component={Hierarchy} />
      <Route path="/hr/employees" component={Employees} />
      <Route path="/hr/payroll" component={Payroll} />
      <Route path="/hr/attendance" component={Attendance} />
      <Route path="/hr/leave" component={Leave} />

      <Route path="/customers" component={Customers} />
      <Route path="/vendors" component={Vendors} />
      <Route path="/coupons" component={Coupons} />

      <Route path="/accounts/chart" component={ChartOfAccounts} />
      <Route path="/accounts/ledger" component={Ledger} />
      <Route path="/accounts/cash-bank" component={CashBank} />
      <Route path="/accounts/expenses" component={Expenses} />
      <Route path="/accounts/gst" component={GstSummary} />

      <Route path="/company/settings" component={CompanySettings} />
      <Route path="/company/permissions" component={Permissions} />
      <Route path="/company/profile" component={Profile} />

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
