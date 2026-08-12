/**
 * Reports Center — unified hub for every business report with CSV/PDF export.
 * Route: /reports
 *
 * Categories are permission-gated with the same module names as the
 * Permissions page: users only see categories whose module they can view.
 */
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/empty-state';
import { usePermission } from '@/lib/usePermission';
import {
  FileBarChart2, ShoppingCart, Receipt, Boxes, Factory, Users, Landmark, TrendingUp, Lock,
  ArrowLeftRight, FileText,
} from 'lucide-react';

import SalesSection from './sections/SalesReports';
import { QuotationsSection } from './sections/QuotationReports';
import PurchasesSection from './sections/PurchasesReports';
import InventorySection from './sections/InventoryReports';
import TransfersSection from './sections/TransfersReports';
import ProductionSection from './sections/ProductionReports';
import PartiesSection from './sections/PartiesReports';
import FinancialSection from './sections/FinancialReports';
import ProfitabilitySection from './sections/ProfitabilityReports';

type Category = 'sales' | 'quotations' | 'purchases' | 'inventory' | 'transfers' | 'production' | 'parties' | 'financial' | 'profitability';

const CATEGORIES: { value: Category; label: string; icon: typeof ShoppingCart }[] = [
  { value: 'sales', label: 'Sales', icon: ShoppingCart },
  { value: 'quotations', label: 'Quotations', icon: FileText },
  { value: 'purchases', label: 'Purchases', icon: Receipt },
  { value: 'inventory', label: 'Inventory', icon: Boxes },
  { value: 'transfers', label: 'Branch Transfers', icon: ArrowLeftRight },
  { value: 'production', label: 'Production', icon: Factory },
  { value: 'parties', label: 'Parties', icon: Users },
  { value: 'financial', label: 'Financial', icon: Landmark },
  { value: 'profitability', label: 'Profitability', icon: TrendingUp },
];

export default function ReportsCenter() {
  const [location, setLocation] = useLocation();
  // Derive active category from URL path: /reports/:cat
  const catFromUrl = location.split('/')[2] as Category | undefined;

  // Reports is a single sidebar link, so it is a single permission row: seeing
  // the page means seeing its categories. The categories used to be gated by
  // seven unrelated module rows, which meant an admin could not actually grant
  // "Reports" — they had to reverse-engineer which other modules it borrowed.
  const perm = usePermission('page:/reports/sales');

  const visible: Record<Category, boolean> = {
    sales: perm.canView,
    quotations: perm.canView,
    purchases: perm.canView,
    inventory: perm.canView,
    transfers: perm.canView,
    production: perm.canView,
    parties: perm.canView,
    financial: perm.canView,
    profitability: perm.canView,
  };
  const isLoading = perm.isLoading;

  const visibleCats = CATEGORIES.filter((c) => visible[c.value]);
  // Drive active category from URL; fall back to first permitted category
  const active: Category | undefined =
    catFromUrl && visible[catFromUrl] ? catFromUrl : visibleCats[0]?.value;

  return (
    <AppLayout>
      <div className="space-y-5">
        <PageHeader
          title="Reports Center"
          description="Sales, purchases, inventory, branch transfers, production, parties, financial & profitability — with CSV and PDF export"
          icon={FileBarChart2}
        />

        {!isLoading && visibleCats.length === 0 ? (
          <EmptyState
            icon={Lock}
            title="No reports available"
            hint="You don't have permission to view any reports. Contact your administrator to request access."
          />
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
            {active === 'quotations' && <QuotationsSection />}
            {active === 'purchases' && <PurchasesSection />}
            {active === 'inventory' && <InventorySection />}
            {active === 'transfers' && <TransfersSection />}
            {active === 'production' && <ProductionSection />}
            {active === 'parties' && (
              <PartiesSection canCustomers={perm.canView} canVendors={perm.canView} />
            )}
            {active === 'financial' && <FinancialSection />}
            {active === 'profitability' && <ProfitabilitySection />}
          </>
        )}
      </div>
    </AppLayout>
  );
}
