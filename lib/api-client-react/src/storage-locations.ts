import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

/** Storage locations (freezers / cold rooms) inside a warehouse.
 *  Up to two levels of sub-locations via parentId (freezer → rack → shelf). */
export interface StorageLocation {
  id: number;
  warehouseId: number;
  warehouseName: string;
  name: string;
  /** null = top-level storage location; set = sub-location (rack/shelf). */
  parentId: number | null;
  /** Immediate parent's name (rack's freezer, shelf's rack). */
  parentName: string | null;
  /** Full path — "Freezer › Rack › Shelf" — plain name for roots. */
  pathLabel: string;
  /** 0 = root (freezer), 1 = rack, 2 = shelf. */
  depth: number;
  /** Number of DIRECT sub-locations under this location. */
  childCount: number;
  isDisabled: boolean;
  /** Disabled itself OR any ancestor disabled — what actually blocks moves in. */
  effectiveDisabled: boolean;
  placedQty: number;
  /** Σ placements sitting in this location's descendants (children + grandchildren). */
  childPlacedQty: number;
  itemCount: number;
}

export interface StoragePlacementSlice {
  storageLocationId: number;
  name: string;
  quantity: number;
  isDisabled: boolean;
}

export interface StorageStockRow {
  materialType: 'item' | 'material' | 'raw_material';
  itemId: number;
  itemName: string;
  unit: string;
  /** Warehouse truth from stock_entries. */
  totalQty: number;
  /** Σ placements across the warehouse's storage locations. */
  placedQty: number;
  /** max(0, totalQty − placedQty) — the derived Unassigned pool. */
  unassignedQty: number;
  /** > 0 when placements exceed warehouse stock (stock left since assignment). */
  overAssignedQty: number;
  placements: StoragePlacementSlice[];
}

export interface StorageStockResponse {
  warehouseId: number;
  warehouseName: string;
  rows: StorageStockRow[];
}

export function useStorageLocations(warehouseId?: number) {
  const qs = warehouseId ? `?warehouseId=${warehouseId}` : '';
  return useQuery({
    queryKey: ['/api/storage-locations', warehouseId ?? 'all'] as const,
    queryFn: ({ signal }) => customFetch<StorageLocation[]>(`/api/storage-locations${qs}`, { signal }),
  });
}

export interface StorageStockParams {
  warehouseId: number;
  q?: string;
  materialType?: string;
}

export function useStorageStock(params: StorageStockParams | null) {
  const qs = new URLSearchParams();
  if (params) {
    qs.set('warehouseId', String(params.warehouseId));
    if (params.q) qs.set('q', params.q);
    if (params.materialType) qs.set('materialType', params.materialType);
  }
  const key = qs.toString();
  return useQuery({
    queryKey: ['/api/storage-stock', key] as const,
    queryFn: ({ signal }) => customFetch<StorageStockResponse>(`/api/storage-stock?${key}`, { signal }),
    enabled: params != null,
    placeholderData: (prev) => prev,
  });
}

function useInvalidateStorage() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['/api/storage-locations'] });
    qc.invalidateQueries({ queryKey: ['/api/storage-stock'] });
  };
}

export function useCreateStorageLocation() {
  const invalidate = useInvalidateStorage();
  return useMutation({
    mutationFn: (body: { warehouseId: number; name: string; parentId?: number | null }) =>
      customFetch<StorageLocation>('/api/storage-locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateStorageLocation() {
  const invalidate = useInvalidateStorage();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name?: string; isDisabled?: boolean }) =>
      customFetch<{ ok: boolean }>(`/api/storage-locations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteStorageLocation() {
  const invalidate = useInvalidateStorage();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/storage-locations/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export interface StorageMoveBody {
  warehouseId: number;
  materialType: string;
  itemId: number;
  /** null = out of the Unassigned pool */
  fromStorageLocationId: number | null;
  /** null = back to the Unassigned pool */
  toStorageLocationId: number | null;
  quantity: number;
}

export function useMoveStorageStock() {
  const invalidate = useInvalidateStorage();
  return useMutation({
    mutationFn: (body: StorageMoveBody) =>
      customFetch<{ ok: boolean }>('/api/storage-placements/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });
}
