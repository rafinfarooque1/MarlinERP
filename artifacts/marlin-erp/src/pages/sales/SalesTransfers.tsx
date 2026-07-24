import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLocationContext } from '@/lib/locationContext';
import { useListStockTransfers } from '@workspace/api-client-react';
import { ArrowLeftRight, Calendar } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

function statusBadge(status: string) {
  if (status === 'completed') return <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Completed</Badge>;
  if (status === 'rejected') return <Badge className="text-[10px] bg-red-500/10 text-red-600 border-red-500/20">Rejected</Badge>;
  return <Badge className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20">In Transit</Badge>;
}

export default function SalesTransfers() {
  const [, navigate] = useLocation();
  const { locationState } = useLocationContext();

  useEffect(() => {
    if (!locationState.locationType || !locationState.locationId) {
      navigate('/sales');
    }
  }, [locationState, navigate]);

  const { data: allTransfers = [], isLoading } = useListStockTransfers();

  const { locationType, locationId, locationName } = locationState;

  // Filter transfers where this location is the source or destination
  // API returns camelCase: fromType, fromId, toType, toId
  const transfers = (allTransfers as any[]).filter(t => {
    const fromMatch = t.fromType === locationType && Number(t.fromId) === locationId;
    const toMatch   = t.toType   === locationType && Number(t.toId)   === locationId;
    return fromMatch || toMatch;
  });

  if (!locationType || !locationId) return null;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ArrowLeftRight className="w-6 h-6 text-primary" />
            Transfers — {locationName}
          </h1>
          <p className="text-muted-foreground mt-1">Stock movements involving this location</p>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Challan</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Items</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                  </TableRow>
                ))
              ) : transfers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                    <ArrowLeftRight className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>No transfers involving {locationName}</p>
                  </TableCell>
                </TableRow>
              ) : transfers.map((t: any) => (
                <TableRow key={t.id} className="hover:bg-muted/10">
                  <TableCell className="font-mono text-xs text-primary font-bold">{t.challanNumber ?? `#${t.id}`}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {t.transferDate ? new Date(t.transferDate).toLocaleDateString('en-IN') : '—'}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{t.fromName ?? `${t.fromBranchType} #${t.fromBranchId}`}</TableCell>
                  <TableCell className="text-sm">{t.toName ?? `${t.toBranchType} #${t.toBranchId}`}</TableCell>
                  <TableCell>{statusBadge(t.status)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{(t.lineItems ?? t.items ?? []).length} item(s)</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {transfers.length > 0 && (
            <div className="p-3 border-t border-border text-sm text-muted-foreground">
              {transfers.length} transfer(s) total
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
