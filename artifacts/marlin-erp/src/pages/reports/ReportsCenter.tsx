/**
 * Reports Center — unified hub for every business report with CSV/PDF export.
 * Route: /reports
 *
 * Categories are permission-gated with the same module names as the
 * Permissions page: users only see categories whose module they can view.
 */
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import {
  FileBarChart2, ShoppingCart, Receipt, Boxes, Factory, Users, Landmark, TrendingUp, Lock,
} from 'lucide-react';

import SalesSection from './sections/SalesReports';
import PurchasesSection from './sections/PurchasesReports';
import InventorySection from './sections/InventoryReports';
import ProductionSection from './sections/ProductionReports';
import PartiesSection from './sections/PartiesReports';
import FinancialSection from './sections/FinancialReports';
import ProfitabilitySection from './sections/ProfitabilityReports';

type Category = 'sales' | 'purchases' | 'inventory' | 'production' | 'parties' | 'financial' | 'profitability';

const CATEGORIES: { value: Category; label: string; icon: typeof ShoppingCart }[] = [
  { value: 'sales', label: 'Sales', icon: ShoppingCart },
  { value: 'purchases', label: 'Purchases', icon: Receipt },
  { value: 'inventory', label: 'Inventory', icon: Boxes },
  { value: 'production', label: 'Production', icon: Factory },
  { value: 'parties', label: 'Parties', icon: Users },
  { value: 'financial', label: 'Financial', icon: Landmark },
  { value: 'profitability', label: 'Profitability', icon: TrendingUp },
];

export default function ReportsCenter() {
  const [location, setLocation] = useLocation();
  // Derive active category from URL path: /reports/:cat
  const catFromUrl = location.split('/')[2] as Category | undefined;

  // Category → module gating (module names must match the Permissions page)
  const sales = usePermission('Sales');
  const purchases = usePermission('Purchases');
  const stock = usePermission('Stock');
  const production = usePermission('Production');
  const customers = usePermission('Customers');
  const vendors = usePermission('Vendors');
  const accounts = usePermission('Chart of Accounts');

  const visible: Record<Category, boolean> = {
    sales: sales.canView,
    purchases: purchases.canView,
    inventory: stock.canView,
    production: production.canView,
    parties: customers.canView || vendors.canView,
    financial: accounts.canView,
    profitability: accounts.canView,
  };
  const isLoading = sales.isLoading || accounts.isLoading;

  const visibleCats = CATEGORIES.filter((c) => visible[c.value]);
  // Drive active category from URL; fall back to first permitted category
  const active: Category | undefined =
    catFromUrl && visible[catFromUrl] ? catFromUrl : visibleCats[0]?.value;

  return (
    <AppLayout>
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <FileBarChart2 className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Reports Center</h1>
            <p className="text-sm text-muted-foreground">Sales, purchases, inventory, production, parties, financial &amp; profitability — with CSV and PDF export</p>
          </div>
        </div>

        {!isLoading && visibleCats.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
            <Lock className="w-8 h-8 text-muted-foreground" />
            <p className="text-muted-foreground">You don't have permission to view any reports.<br />Contact your administrator to request access.</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
              {visibleCats.map((c) => {
                const Icon = c.icon;
                const isActive = active === c.value;
                return (
                  <button
                    key={c.value}
                    onClick={() => setLocation('/reports/' + c.value)}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {c.label}
                  </button>
                );
              })}
            </div>

            {active === 'sales' && <SalesSection />}
            {active === 'purchases' && <PurchasesSection />}
            {active === 'inventory' && <InventorySection />}
            {active === 'production' && <ProductionSection />}
            {active === 'parties' && (
              <PartiesSection canCustomers={customers.canView} canVendors={vendors.canView} />
            )}
            {active === 'financial' && <FinancialSection />}
            {active === 'profitability' && <ProfitabilitySection />}
          </>
        )}
      </div>
    </AppLayout>
  );
}
