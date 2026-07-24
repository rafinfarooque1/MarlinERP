import { useLocationContext } from '@/lib/locationContext';
import { useListOutlets } from '@workspace/api-client-react';
import Sales from '@/pages/headoffice/Sales';

export default function SalesPOS() {
  const { locationState } = useLocationContext();
  const { data: outlets = [] } = useListOutlets();

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
    return <Sales />;
  }

  // Warehouse — show warehouse sales + child outlet sales
  // Specific outlet/warehouse — show only that location
  return (
    <Sales
      forceLocationType={locationType as 'warehouse' | 'outlet'}
      forceLocationId={locationId!}
      forceLocationName={locationName}
      forceChildOutletIds={isWarehouse && childOutletIds.length > 0 ? childOutletIds : undefined}
    />
  );
}
