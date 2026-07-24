import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import { useListStock, useListItems } from '@workspace/api-client-react';
import { Package, AlertTriangle } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

export default function SalesStock() {
  const [, navigate] = useLocation();
  const { locationState } = useLocationContext();

  useEffect(() => {
    if (!locationState.locationType || !locationState.locationId) {
      navigate('/sales');
    }
  }, [locationState, navigate]);

  const { data: stock = [], isLoading } = useListStock(
    locationState.locationType && locationState.locationId
      ? { branchType: locationState.locationType as any, branchId: locationState.locationId }
      : {},
    { query: { enabled: !!locationState.locationType && !!locationState.locationId } }
  );

  const { data: items = [] } = useListItems();
  const itemMap = new Map((items as any[]).map(i => [i.id, i]));

  const sortedStock = [...(stock as any[])].sort((a, b) => Number(b.quantity) - Number(a.quantity));

  if (!locationState.locationType || !locationState.locationId) return null;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Package className="w-6 h-6 text-primary" />
            Stock — {locationState.locationName}
          </h1>
          <p className="text-muted-foreground mt-1">Current inventory at this location</p>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Item</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={4}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                  </TableRow>
                ))
              ) : sortedStock.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-16 text-muted-foreground">
                    <Package className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>No stock at this location</p>
                  </TableCell>
                </TableRow>
              ) : sortedStock.map((entry: any) => {
                const item = itemMap.get(entry.itemId);
                const qty = Number(entry.quantity ?? 0);
                const isLow = qty > 0 && qty < 10;
                const isEmpty = qty <= 0;
                return (
                  <TableRow key={entry.id} className={isEmpty ? 'opacity-50' : ''}>
                    <TableCell className="font-medium">{entry.itemName || item?.name || `Item #${entry.itemId}`}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{item?.unit ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono font-bold">{qty.toLocaleString('en-IN')}</TableCell>
                    <TableCell>
                      {isEmpty ? (
                        <Badge variant="destructive" className="text-[10px]">Out of Stock</Badge>
                      ) : isLow ? (
                        <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">
                          <AlertTriangle className="w-3 h-3 mr-1" />Low
                        </Badge>
                      ) : (
                        <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">In Stock</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {sortedStock.length > 0 && (
            <div className="p-3 border-t border-border flex justify-between text-sm">
              <span className="text-muted-foreground">{sortedStock.filter((s: any) => Number(s.quantity) > 0).length} item types with stock</span>
              <span className="font-bold">{sortedStock.reduce((s: number, e: any) => s + Number(e.quantity ?? 0), 0).toLocaleString('en-IN')} total units</span>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
