import { useLocationContext } from '@/lib/locationContext';
import { useAllOutlets } from '@/lib/locationStructure';
import Sales from '@/pages/headoffice/Sales';

export default function SalesPOS() {
  const { locationState } = useLocationContext();
  // Historical aggregation, not a selector: a warehouse's figures must keep
  // including sales its child outlets made, whether or not outlets are on show.
  const { data: outlets = [] } = useAllOutlets();

  const { locationType, locationId, locationName } = locationState;
  const isAll       = locationType === 'all';
  const isWarehouse = locationType === 'warehouse' && !!locationId && !isAll;

  // Child outlet IDs for warehouse mode
  const childOutletIds = isWarehouse
    ? (outlets as any[]).filter(o => Number(o.warehouseId) === locationId).map((o: any) => o.id as number)
    : [];

  // Nothing selected yet — show nothing (SalesDashboard handles the redirect)
  if (!locationType) return null;

  // All Locations — show full sales list with no location filter
  if (isAll) {
    return <Sales permissionModule="page:/sales/pos" />;
  }

  // Warehouse — show warehouse sales + child outlet sales
  // Specific outlet/warehouse — show only that location
  return (
    <Sales
      permissionModule="page:/sales/pos"
      forceLocationType={locationType as 'warehouse' | 'outlet'}
      forceLocationId={locationId!}
      forceLocationName={locationName}
      forceChildOutletIds={isWarehouse && childOutletIds.length > 0 ? childOutletIds : undefined}
    />
  );
}
