import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProductionReportTotals {
  batchCount: number;
  producedQty: number;
  wastageQty: number;
  wastageValue: number;
  totalCost: number;
}

export interface ProductionOutputRow {
  itemId: number;
  itemName: string;
  unit: string;
  batchCount: number;
  producedQty: number;
  wastageQty: number;
  totalCost: number | null;
  avgCostPerUnit: number | null;
}

export interface ProductionConsumptionRow {
  materialType: 'material' | 'raw_material';
  materialId: number;
  materialName: string;
  unit: string;
  consumedQty: number;
  consumedCost: number | null;
  expectedQty: number | null;
  varianceQty: number | null;
}

export interface ProductionWastageRow {
  productionId: number;
  batchNumber: string;
  productionDate: string;
  itemId: number;
  itemName: string;
  unit: string;
  producedQty: number;
  wastageQty: number;
  wastageValue: number;
  lines: Array<{ quantity: number; reason: string }>;
}

export interface ProductionBatchCostRow {
  id: number;
  batchNumber: string;
  productionDate: string;
  itemId: number;
  itemName: string;
  unit: string;
  producedQty: number;
  wastageQty: number;
  materialCost: number | null;
  overheadPercent: number | null;
  overheadAmount: number | null;
  totalCost: number | null;
  costPerUnit: number | null;
}

export interface ProductionReports {
  from: string | null;
  to: string | null;
  totals: ProductionReportTotals;
  output: ProductionOutputRow[];
  consumption: ProductionConsumptionRow[];
  wastage: ProductionWastageRow[];
  batches: ProductionBatchCostRow[];
}

// ── Query keys & hooks ────────────────────────────────────────────────────────

export const getProductionReportsQueryKey = (from?: string, to?: string) =>
  ['/api/productions/reports', from ?? '', to ?? ''] as const;

export function useProductionReports(from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return useQuery({
    queryKey: getProductionReportsQueryKey(from, to),
    queryFn: ({ signal }) =>
      customFetch<ProductionReports>(`/api/productions/reports${qs ? `?${qs}` : ''}`, { signal }),
  });
}
