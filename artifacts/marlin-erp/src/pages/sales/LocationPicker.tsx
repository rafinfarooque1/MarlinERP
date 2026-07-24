import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { customFetch } from '@workspace/api-client-react';
import { useLocationContext } from '@/lib/locationContext';
import { MapPin, Warehouse, Store, ChevronRight, Layers } from 'lucide-react';

export default function LocationPicker() {
  const [, navigate] = useLocation();
  const { setLocation } = useLocationContext();

  const { data: warehouses = [], isLoading: wLoading } = useQuery<any[]>({
    queryKey: ['warehouses'],
    queryFn: () => customFetch('/api/warehouses'),
  });

  const { data: outlets = [], isLoading: oLoading } = useQuery<any[]>({
    queryKey: ['outlets'],
    queryFn: () => customFetch('/api/outlets'),
  });

  const isLoading = wLoading || oLoading;

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
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <MapPin className="w-6 h-6 text-primary" />
            Select Selling Location
          </h1>
          <p className="text-muted-foreground mt-1">
            Choose the warehouse or outlet you are selling from today.
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-20 rounded-xl bg-muted/30 animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {/* All Locations option */}
            {(warehouses.length > 0 || outlets.length > 0) && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground px-1">
                  Overview
                </p>
                <button
                  onClick={handleSelectAll}
                  className="w-full flex items-center gap-4 p-4 rounded-xl bg-primary/5 border-2 border-primary/20 hover:border-primary/50 hover:bg-primary/10 transition-all text-left group"
                >
                  <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                    <Layers className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold">All Locations</p>
                    <p className="text-xs text-muted-foreground">
                      View dashboard totals across all {warehouses.length} warehouse{warehouses.length !== 1 ? 's' : ''} and {outlets.length} outlet{outlets.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                </button>
              </div>
            )}

            {warehouses.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground px-1">
                  Warehouses
                </p>
                {warehouses.map((wh: any) => (
                  <button
                    key={wh.id}
                    onClick={() => handleSelect('warehouse', wh.id, wh.name)}
                    className="w-full flex items-center gap-4 p-4 rounded-xl bg-card border border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left group"
                  >
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                      <Warehouse className="w-5 h-5 text-blue-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold">{wh.name}</p>
                      {wh.address && <p className="text-xs text-muted-foreground truncate">{wh.address}</p>}
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                  </button>
                ))}
              </div>
            )}

            {outlets.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground px-1">
                  Outlets
                </p>
                {outlets.map((outlet: any) => (
                  <button
                    key={outlet.id}
                    onClick={() => handleSelect('outlet', outlet.id, outlet.name)}
                    className="w-full flex items-center gap-4 p-4 rounded-xl bg-card border border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left group"
                  >
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                      <Store className="w-5 h-5 text-emerald-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold">{outlet.name}</p>
                      {outlet.address && <p className="text-xs text-muted-foreground truncate">{outlet.address}</p>}
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                  </button>
                ))}
              </div>
            )}

            {warehouses.length === 0 && outlets.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <MapPin className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p>No warehouses or outlets found. Add them under Accounts → Warehouses / Outlets.</p>
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
