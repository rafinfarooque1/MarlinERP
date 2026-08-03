import { useLocationContext } from '@/lib/locationContext';
import { useAllOutlets } from '@/lib/locationStructure';
import Sales from '@/pages/headoffice/Sales';
import { Redirect } from 'wouter';

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

  // A direct link or restored tab can arrive before an HO user has picked a
  // selling location. Never render a blank page: continue through the existing
  // picker, which applies the user's server-authorized location scope.
  if (!locationType) return <Redirect to="/sales" />;

  // All Locations — show full sales list with no location filter
  if (isAll) {
    return <Sales permissionModule="page:/sales/pos" />;
  }

  // Warehouse — show warehouse sales + child outlet sales
  // Specific outlet/warehouse — show only that location
  return (
    <Sales
      permissionModule="page:/sales/pos"
      forceLocationType={locationType as 'warehouse' | 'outlet' | 'headoffice'}
      forceLocationId={locationId!}
      forceLocationName={locationName}
      forceChildOutletIds={isWarehouse && childOutletIds.length > 0 ? childOutletIds : undefined}
    />
  );
}
