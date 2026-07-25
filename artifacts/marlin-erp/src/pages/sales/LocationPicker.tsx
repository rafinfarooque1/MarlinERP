import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { customFetch, useGetMe } from '@workspace/api-client-react';
import { useLocationContext } from '@/lib/locationContext';
import { buildPickerHierarchy } from '@/lib/locationHierarchy';
import { MapPin, Warehouse, Store, ChevronRight, Layers } from 'lucide-react';

export default function LocationPicker() {
  const [, navigate] = useLocation();
  const { setLocation } = useLocationContext();
  const { data: user } = useGetMe();

  const userBranchType = (user as any)?.branchType as 'warehouse' | 'outlet' | null | undefined;
  const userBranchId   = (user as any)?.branchId   as number | null | undefined;

  const { data: warehouses = [], isLoading: wLoading } = useQuery<any[]>({
    queryKey: ['warehouses'],
    queryFn: () => customFetch('/api/warehouses'),
  });
  const { data: outlets = [], isLoading: oLoading } = useQuery<any[]>({
    queryKey: ['outlets'],
    queryFn: () => customFetch('/api/outlets'),
  });

  // ── Outlet employees: skip the picker entirely ────────────────────────────
  useEffect(() => {
    if (userBranchType === 'outlet' && userBranchId) {
      navigate('/sales/pos');
    }
  }, [userBranchType, userBranchId, navigate]);

  const isLoading = wLoading || oLoading;

  // ── Filter locations by employee's assigned branch ────────────────────────
  // Warehouse employees: show only their warehouse + its child outlets
  // HO / admin: show all
  const isWarehouseEmployee = userBranchType === 'warehouse';

  const visibleWarehouses = isWarehouseEmployee
    ? warehouses.filter(w => w.id === userBranchId)
    : warehouses;

  const visibleOutlets = isWarehouseEmployee
    ? outlets.filter(o => o.warehouseId === userBranchId)
    : outlets;

  const { nodes, orphanOutlets } = buildPickerHierarchy(visibleWarehouses, visibleOutlets);
  const totalCount = visibleWarehouses.length + visibleOutlets.length;

  const handleSelect = (locationType: 'warehouse' | 'outlet', locationId: number, locationName: string) => {
    setLocation({ locationType, locationId, locationName });
    navigate('/sales/pos');
  };

  const handleSelectAll = () => {
    setLocation({ locationType: 'all', locationId: null, locationName: 'All Locations' });
    navigate('/sales/dashboard');
  };

  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto space-y-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <MapPin className="w-6 h-6 text-primary" />
            Select Selling Location
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {isWarehouseEmployee
              ? 'Choose the outlet you are selling from today.'
              : 'Choose the warehouse or outlet you are selling from today.'}
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-16 rounded-xl bg-muted/30 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">

            {/* ── All Locations — only for HO/admin employees ── */}
            {!isWarehouseEmployee && totalCount > 0 && (
              <button
                onClick={handleSelectAll}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-primary/5 border-2 border-primary/20 hover:border-primary/50 hover:bg-primary/10 transition-all text-left group"
              >
                <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                  <Layers className="w-4.5 h-4.5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">All Locations</p>
                  <p className="text-xs text-muted-foreground">
                    Dashboard totals across all {warehouses.length} warehouse{warehouses.length !== 1 ? 's' : ''} &amp; {outlets.length} outlet{outlets.length !== 1 ? 's' : ''}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
              </button>
            )}

            {/* ── Warehouses with their outlets ── */}
            {nodes.map(wh => (
              <div key={`wh-${wh.id}`} className="space-y-1">
                {/* Warehouse row */}
                <button
                  onClick={() => handleSelect('warehouse', wh.id, wh.name)}
                  className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-card border border-border hover:border-blue-400/50 hover:bg-blue-500/5 transition-all text-left group"
                >
                  <div className="w-9 h-9 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                    <Warehouse className="w-4.5 h-4.5 text-blue-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm">{wh.name}</p>
                    {wh.address && <p className="text-xs text-muted-foreground truncate">{wh.address}</p>}
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-blue-500 transition-colors shrink-0" />
                </button>

                {/* Outlets nested under this warehouse */}
                {wh.outlets.map((o: any) => (
                  <button
                    key={`outlet-${o.id}`}
                    onClick={() => handleSelect('outlet', o.id, o.name)}
                    className="w-full flex items-center gap-3 pl-10 pr-4 py-3 rounded-xl bg-card border border-border hover:border-emerald-400/50 hover:bg-emerald-500/5 transition-all text-left group ml-4"
                    style={{ width: 'calc(100% - 1rem)' }}
                  >
                    <div className="w-7 h-7 rounded-md bg-emerald-500/10 flex items-center justify-center shrink-0">
                      <Store className="w-3.5 h-3.5 text-emerald-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{o.name}</p>
                      {o.address && <p className="text-xs text-muted-foreground truncate">{o.address}</p>}
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-emerald-500 transition-colors shrink-0" />
                  </button>
                ))}
              </div>
            ))}

            {/* ── Orphan outlets (no parent warehouse) — only for HO employees ── */}
            {!isWarehouseEmployee && orphanOutlets.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground px-1 pt-2">
                  Other Outlets
                </p>
                {orphanOutlets.map((o: any) => (
                  <button
                    key={`outlet-${o.id}`}
                    onClick={() => handleSelect('outlet', o.id, o.name)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-card border border-border hover:border-emerald-400/50 hover:bg-emerald-500/5 transition-all text-left group"
                  >
                    <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                      <Store className="w-4.5 h-4.5 text-emerald-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">{o.name}</p>
                      {o.address && <p className="text-xs text-muted-foreground truncate">{o.address}</p>}
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-emerald-500 transition-colors shrink-0" />
                  </button>
                ))}
              </div>
            )}

            {totalCount === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <MapPin className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p>No warehouses or outlets found. Add them under Accounts → Warehouses / Outlets.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
