/**
 * Branch Transfer report — stock moved between the company's own locations.
 *
 * Read-only. One row per transfer LINE so item, batch and quantity are
 * meaningful. The sending side is "Transfer Out" and the receiving side is
 * "Transfer In": operationally they behave like a sale and a purchase, but a
 * transfer earns no revenue and buys nothing, so these figures never join the
 * sales or purchase totals.
 *
 * Location scope is enforced by the server. Requested source/destination
 * filters can only narrow what the caller is already entitled to see.
 */
import { useQuery } from '@tanstack/react-query';
import { customFetch } from './custom-fetch';

export interface BranchTransferReportRow {
  transferId: number;
  challanNumber: string;
  transferDate: string;
  sourceType: string;
  sourceId: number;
  sourceName: string;
  destType: string;
  destId: number;
  destName: string;
  itemId: number;
  itemName: string;
  materialType: string;
  materialTypeLabel: string;
  /** Batch numbers consumed by the line — empty when the line is untracked. */
  batchNumbers: string[];
  quantity: number;
  unit: string;
  /**
   * What the moved stock COST. Both fields are ABSENT — not zero — for roles
   * without the inventory-valuation right, so read them defensively; a missing
   * cost means "not permitted to see", never "free".
   */
  unitCost?: number;
  lineValue?: number;
  status: string;
  /**
   * 'received' — the quantity is what the receiver actually recorded on a
   * completed transfer. 'dispatched' — the quantity is what left the source.
   */
  quantityBasis: 'received' | 'dispatched';
  dispatchDate: string | null;
  receivedDate: string | null;
  handledBy: string | null;
  /** No dispatcher is recorded on a transfer yet — always null. */
  dispatchedBy: null;
}

export interface BranchTransferSummaryBucket {
  qty: number;
  /** Omitted for roles without the inventory-valuation right. */
  value?: number;
  transfers: number;
}

export interface BranchTransfersReportResponse {
  rows: BranchTransferReportRow[];
  totals: { lines: number; transfers: number; qty: number; value?: number };
  /** Transfer Out / Transfer In count COMPLETED transfers only. */
  summary: {
    transferOut: BranchTransferSummaryBucket;
    transferIn: BranchTransferSummaryBucket;
    inTransit: BranchTransferSummaryBucket;
  };
  /** Server's verdict on whether this caller may see transfer cost/value. */
  canViewValuation?: boolean;
  scope: { isHeadOffice: boolean };
  basisNote: string;
}

export interface BranchTransfersReportParams {
  fromDate?: string;
  toDate?: string;
  sourceType?: string;
  sourceId?: number;
  destType?: string;
  destId?: number;
  itemId?: number;
  /**
   * Ids overlap across the three product tables — item #7, material #7 and
   * packing material #7 are different products — so an itemId filter is only
   * unambiguous when the kind is pinned alongside it.
   */
  materialType?: 'item' | 'material' | 'raw_material';
  status?: string;
}

export function useBranchTransfersReport(params: BranchTransfersReportParams = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== 0) qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['/api/reports/branch-transfers', suffix],
    queryFn: () => customFetch<BranchTransfersReportResponse>(`/api/reports/branch-transfers${suffix}`),
  });
}
