/**
 * Shared helper: groups a flat allBalances list (from useGetCashInOutlet)
 * into a warehouse → [outlets] hierarchy.
 *
 * The outlet entries carry parentWarehouseId from the API.
 * Outlets without a matching parent warehouse appear in `orphanOutlets`.
 */

export interface BalanceEntry {
  locationType: string;
  locationId: number;
  locationName: string;
  cashBalance: number;
  pendingDeposits: number;
  availableBalance: number;
  parentWarehouseId?: number | null;
  [key: string]: any;
}

export interface WhNode extends BalanceEntry {
  outlets: BalanceEntry[];
}

export function buildHierarchy(allBalances: BalanceEntry[]): {
  /** Warehouses, each carrying their child outlets array */
  nodes: WhNode[];
  /** Outlets with no matching warehouse in the list */
  orphanOutlets: BalanceEntry[];
} {
  const warehouses = allBalances.filter(b => b.locationType === 'warehouse');
  const outlets    = allBalances.filter(b => b.locationType === 'outlet');
  const whIdSet    = new Set(warehouses.map(w => w.locationId));

  const nodes: WhNode[] = warehouses.map(wh => ({
    ...wh,
    outlets: outlets
      .filter(o => o.parentWarehouseId === wh.locationId)
      .sort((a, b) => a.locationName.localeCompare(b.locationName)),
  }));

  // sort warehouses alphabetically
  nodes.sort((a, b) => a.locationName.localeCompare(b.locationName));

  const orphanOutlets = outlets
    .filter(o => !o.parentWarehouseId || !whIdSet.has(o.parentWarehouseId))
    .sort((a, b) => a.locationName.localeCompare(b.locationName));

  return { nodes, orphanOutlets };
}

/** Build hierarchy from separate warehouse + outlet lists (for LocationPicker) */
export function buildPickerHierarchy(
  warehouses: { id: number; name: string; address?: string }[],
  outlets: { id: number; name: string; address?: string; warehouseId?: number }[],
) {
  const sortedWh = [...warehouses].sort((a, b) => a.name.localeCompare(b.name));
  const whIdSet  = new Set(warehouses.map(w => w.id));

  const nodes = sortedWh.map(wh => ({
    ...wh,
    outlets: outlets
      .filter(o => o.warehouseId === wh.id)
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));

  const orphanOutlets = outlets
    .filter(o => !o.warehouseId || !whIdSet.has(o.warehouseId))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { nodes, orphanOutlets };
}
