import { isIsoDate } from "./dateInput";

export type EvidenceKey = {
  materialType: string;
  refId: number;
  branchType: string;
  branchId: number;
};

export function historicalEvidenceKey(row: EvidenceKey): string {
  return `${row.materialType}:${row.refId}:${row.branchType}:${row.branchId}`;
}

export function missingHistoricalEvidenceKeys(expected: EvidenceKey[], submitted: EvidenceKey[]): string[] {
  const present = new Set(submitted.map(historicalEvidenceKey));
  return expected.map(historicalEvidenceKey).filter((key) => !present.has(key));
}

export function duplicateHistoricalEvidenceKeys(rows: EvidenceKey[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = historicalEvidenceKey(row);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

export type HistoricalBatchLedgerMove = {
  txnType: string;
  txnDate: string | null;
  docType: string;
  docId: number | null;
  qtyChange: unknown;
  unitCost?: unknown;
};

export type HistoricalBatchAllocation = {
  docType: string;
  docId: number;
  batchNumber: string;
  quantity: unknown;
  unitCost: unknown;
  purchaseCost?: boolean;
  costEvidence?: boolean;
};

export type HistoricalPurchaseBatchCost = {
  batchNumber: string;
  unitCost: unknown;
};

export function resolveHistoricalBatchCoverage(
  expectedQuantity: number,
  movements: HistoricalBatchLedgerMove[],
  allocations: HistoricalBatchAllocation[],
  purchaseBatchCosts: HistoricalPurchaseBatchCost[] = [],
): { ok: true; unitCost: number; value: number; batchNumber: string } | { ok: false; reason: string } {
  if (!Number.isFinite(expectedQuantity) || expectedQuantity <= 0) {
    return { ok: false, reason: "cutoff quantity is not positive and finite" };
  }
  if (!movements.length || movements.some((m) => !isIsoDate(m.txnDate))) {
    return { ok: false, reason: "one or more historical movements have a missing or invalid business date" };
  }
  const allowed = new Set([
    "purchase", "purchase_reversal", "purchase_return", "sale", "sale_reversal", "sale_cancellation",
    "adjustment",
    "sales_return", "transfer_in", "transfer_out",
  ]);
  if (movements.some((m) => !allowed.has(m.txnType) || m.docId == null)) {
    return { ok: false, reason: "movement type or source document is unsupported or missing" };
  }
  const ledgerQty = movements.reduce((sum, m) => sum + Number(m.qtyChange), 0);
  if (Math.abs(ledgerQty - expectedQuantity) > 0.001) {
    return { ok: false, reason: `dated ledger quantity ${ledgerQty} does not reconcile to cutoff quantity ${expectedQuantity}` };
  }
  const docs = new Map<string, number>();
  const docMoves = new Map<string, HistoricalBatchLedgerMove[]>();
  for (const m of movements) {
    const key = `${m.docType}:${m.docId}`;
    docs.set(key, (docs.get(key) ?? 0) + Number(m.qtyChange));
    docMoves.set(key, [...(docMoves.get(key) ?? []), m]);
  }
  // A purchase line can be removed from the current bill after it is confirmed
  // to have been a non-stock charge, while its old stock-ledger row remains.
  // Reconcile that stale positive movement only when one fully-consumed sale
  // has the exact same dated ledger quantity, batch, and recorded cost. This
  // pair can neutralize a zero-balance lot, but is never cost evidence for stock
  // remaining at the cutoff.
  const reconciledAllocations = [...allocations];
  for (const [purchaseKey, net] of docs) {
    const purchaseMoves = docMoves.get(purchaseKey) ?? [];
    if (!purchaseKey.startsWith("purchase:") || net <= 0.001
        || reconciledAllocations.some((a) => `${a.docType}:${a.docId}` === purchaseKey)
        || purchaseMoves.length !== 1 || purchaseMoves[0].txnType !== "purchase") continue;
    const cost = Number(purchaseMoves[0].unitCost);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const matches = [...docs.entries()].flatMap(([saleKey, saleNet]) => {
      if (!saleKey.startsWith("sale:") || Math.abs(saleNet + net) > 0.001) return [];
      const saleAllocations = reconciledAllocations.filter((a) => `${a.docType}:${a.docId}` === saleKey);
      const quantity = saleAllocations.reduce((sum, a) => sum + Number(a.quantity), 0);
      const batchCosts = new Set(saleAllocations.map((a) =>
        `${a.batchNumber}\u0000${Number(a.unitCost).toFixed(4)}`));
      if (Math.abs(quantity - net) > 0.001 || batchCosts.size !== 1) return [];
      const [identity] = [...batchCosts][0].split("\u0000");
      const match = saleAllocations[0];
      if (Math.abs(Number(match.unitCost) - cost) > 0.0001) return [];
      return [{ saleKey, batchNumber: identity }];
    });
    if (matches.length !== 1) continue;
    reconciledAllocations.push({
      docType: "purchase",
      docId: Number(purchaseKey.slice("purchase:".length)),
      batchNumber: matches[0].batchNumber,
      quantity: net,
      unitCost: cost,
    });
  }

  const allocated = new Map<string, number>();
  for (const a of reconciledAllocations) {
    const qty = Number(a.quantity);
    const cost = Number(a.unitCost);
    if (!a.batchNumber || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(cost) || cost <= 0) {
      return { ok: false, reason: "a source allocation has missing batch identity, quantity, or positive cost" };
    }
    const key = `${a.docType}:${a.docId}`;
    allocated.set(key, (allocated.get(key) ?? 0) + qty);
  }
  if (!allocations.length) return { ok: false, reason: "no source batch allocations were found" };
  for (const [key, net] of docs) {
    const qty = allocated.get(key);
    const moves = docMoves.get(key) ?? [];
    const purchased = moves.filter((m) => m.txnType === "purchase")
      .reduce((sum, m) => sum + Math.max(0, Number(m.qtyChange)), 0);
    const purchaseReversed = moves.filter((m) => m.txnType === "purchase_reversal")
      .reduce((sum, m) => sum + Math.min(0, Number(m.qtyChange)), 0);
    const balancedPurchaseReversal = purchased > 0 && purchaseReversed < 0
      && Math.abs(purchased + purchaseReversed) <= 0.001;
    if (Math.abs(net) <= 0.001 && balancedPurchaseReversal && qty != null) {
      return { ok: false, reason: `zero-net purchase document ${key} has active batch allocations` };
    }
    if (Math.abs(net) <= 0.001 && qty == null) {
      if (balancedPurchaseReversal) continue;
      const sold = moves.filter((m) => m.txnType === "sale")
        .reduce((sum, m) => sum + Math.min(0, Number(m.qtyChange)), 0);
      const restored = moves.filter((m) => m.txnType === "sale_reversal" || m.txnType === "sale_cancellation")
        .reduce((sum, m) => sum + Math.max(0, Number(m.qtyChange)), 0);
      if (!(sold < 0 && restored > 0 && Math.abs(sold + restored) <= 0.001)) {
        return { ok: false, reason: `zero-net movement for ${key} is not a balanced sale reversal` };
      }
      continue;
    }
    if (qty == null || (Math.abs(net) > 0.001 && Math.abs(Math.abs(net) - qty) > 0.001)) {
      return { ok: false, reason: `batch allocation for ${key} does not reconcile to its net ledger movement` };
    }
  }
  if ([...allocated.keys()].some((key) => !docs.has(key))) {
    return { ok: false, reason: "source batch allocation has no matching ledger movement" };
  }
  const batchBalances = new Map<string, number>();
  for (const [key, net] of docs) {
    if (Math.abs(net) <= 0.001) continue;
    const sign = Math.sign(net);
    for (const a of reconciledAllocations.filter((row) => `${row.docType}:${row.docId}` === key)) {
      batchBalances.set(a.batchNumber, (batchBalances.get(a.batchNumber) ?? 0) + sign * Number(a.quantity));
    }
  }
  if ([...batchBalances.values()].some((qty) => qty < -0.001)) {
    return { ok: false, reason: "a batch has a negative reconstructed cutoff balance" };
  }
  const positiveBatches = [...batchBalances].filter(([, qty]) => qty > 0.001);
  const reconstructedQty = positiveBatches.reduce((sum, [, qty]) => sum + qty, 0);
  if (Math.abs(reconstructedQty - expectedQuantity) > 0.001) {
    return { ok: false, reason: `batch balances total ${reconstructedQty} but cutoff quantity is ${expectedQuantity}` };
  }
  const purchaseCosts = new Map<string, Set<string>>();
  for (const row of reconciledAllocations.filter((a) => a.purchaseCost || a.costEvidence)) {
    const costs = purchaseCosts.get(row.batchNumber) ?? new Set<string>();
    costs.add(Number(row.unitCost).toFixed(4));
    purchaseCosts.set(row.batchNumber, costs);
  }
  for (const row of purchaseBatchCosts) {
    const batchNumber = String(row.batchNumber ?? "").trim();
    const unitCost = Number(row.unitCost);
    if (!batchNumber || !Number.isFinite(unitCost) || unitCost <= 0) {
      return { ok: false, reason: "purchase-backed batch cost evidence is invalid" };
    }
    const costs = purchaseCosts.get(batchNumber) ?? new Set<string>();
    costs.add(unitCost.toFixed(4));
    purchaseCosts.set(batchNumber, costs);
  }
  let totalValue = 0;
  for (const [batch, qty] of positiveBatches) {
    const costs = purchaseCosts.get(batch);
    if (!costs?.size) return { ok: false, reason: `batch ${batch} has no purchase-backed cost` };
    if (costs.size !== 1) return { ok: false, reason: `batch ${batch} has conflicting purchase costs` };
    const cost = Number([...costs][0]);
    if (reconciledAllocations.some((a) => a.batchNumber === batch && Number(a.unitCost).toFixed(4) !== cost.toFixed(4))) {
      return { ok: false, reason: `batch ${batch} movements conflict with its purchase-backed cost` };
    }
    totalValue += qty * cost;
  }
  if (!positiveBatches.length) return { ok: false, reason: "no positive historical batch balance remains at the cutoff" };
  return {
    ok: true,
    unitCost: totalValue / expectedQuantity,
    value: Math.round(totalValue * 100) / 100,
    batchNumber: positiveBatches.map(([batch]) => batch).join(", "),
  };
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export function isHistoricalTransferReceiptReconciled(
  row: {
    received_date?: string | null;
    receipt_evidence_date?: string | null;
    quantity: unknown;
    received_quantity: unknown;
    dispatched_quantity: unknown;
    reserved_quantity_at_cutoff: unknown;
    reservation_count: unknown;
    all_reservations_released_by_cutoff: unknown;
  },
  asOf: string,
): boolean {
  if (row.received_date && row.received_date > asOf) return false;
  const evidenceDate = row.received_date ?? row.receipt_evidence_date;
  const hasDatedReceipt = Boolean(evidenceDate && evidenceDate <= asOf);
  const releasedByCutoff = row.all_reservations_released_by_cutoff === true;
  if (!hasDatedReceipt && !releasedByCutoff) return false;

  const receiptQty = Number(row.received_quantity);
  const ledgerQty = Number(row.quantity);
  const dispatchedQty = Number(row.dispatched_quantity);
  const reservedQty = Number(row.reserved_quantity_at_cutoff);
  if (![receiptQty, ledgerQty, dispatchedQty, reservedQty].every(Number.isFinite)) return false;
  if (receiptQty <= 0 || Math.abs(receiptQty - ledgerQty) > 0.001) return false;
  if (dispatchedQty < receiptQty || Number(row.reservation_count) < 1) return false;

  // A legitimate partial receipt has an open sender reservation for exactly
  // the undelivered balance. It must not invalidate the received destination
  // quantity or move the shortfall out of transit.
  const expectedShortfall = Math.max(0, dispatchedQty - receiptQty);
  return Math.abs(reservedQty - expectedShortfall) <= 0.001;
}

/**
 * A receipt is safe at the cutoff only when its linked receipt evidence, the
 * destination ledger quantity, and the sender's remaining transit reservation
 * reconcile. This keeps an actual partial receipt on-hand while retaining its
 * unreceived balance in transit.
 */
export async function historicalTransferReceiptConflicts(q: Queryable, asOf: string): Promise<any[]> {
  const { rows } = await q.query(
    `WITH transfer_receipts AS (
       SELECT sl.doc_id AS transfer_id,sl.material_type,sl.ref_id,
              sl.branch_type AS destination_type,sl.branch_id AS destination_id,
              SUM(sl.qty_change::numeric)::numeric AS quantity,
              MAX(sl.created_at::date)::text AS receipt_created_date
         FROM stock_ledger sl
         JOIN stock_transfers source_transfer
           ON sl.doc_type='stock_transfer' AND source_transfer.id=sl.doc_id
         LEFT JOIN journal_vouchers source_voucher
           ON source_voucher.id=source_transfer.receive_voucher_id
         LEFT JOIN purchases source_purchase
           ON source_purchase.id=source_transfer.purchase_id
          AND source_purchase.branch_transfer_id=source_transfer.id
        WHERE sl.txn_type='transfer_in'
          AND COALESCE(source_transfer.received_date::date,source_voucher.voucher_date::date,
                       source_purchase.purchase_date::date,sl.created_at::date)<=$1::date
        GROUP BY sl.doc_id,sl.material_type,sl.ref_id,sl.branch_type,sl.branch_id
     )
     SELECT t.id AS transfer_id,sl.material_type,sl.ref_id,sl.destination_type,
            sl.destination_id,sl.quantity,
            t.received_date::text AS received_date,
             COALESCE(t.received_date::date,rv.voucher_date::date,p.purchase_date::date,
                      sl.receipt_created_date::date)::text AS receipt_evidence_date,
            dispatched.quantity AS dispatched_quantity,received.quantity AS received_quantity,
            reservations.reserved_quantity_at_cutoff,reservations.reservation_count,
            reservations.all_reservations_released_by_cutoff
       FROM stock_transfers t
       JOIN transfer_receipts sl ON sl.transfer_id=t.id
       LEFT JOIN journal_vouchers rv ON rv.id=t.receive_voucher_id
       LEFT JOIN purchases p ON p.id=t.purchase_id AND p.branch_transfer_id=t.id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(NULLIF(x.value->>'quantity','')::numeric),0)::numeric AS quantity
           FROM jsonb_array_elements(COALESCE(t.line_items,'[]'::jsonb)) x(value)
          WHERE COALESCE(x.value->>'materialType','item')=sl.material_type
            AND NULLIF(x.value->>'itemId','')::int=sl.ref_id
       ) dispatched ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(NULLIF(x.value->>'quantity','')::numeric),0)::numeric AS quantity
           FROM jsonb_array_elements(COALESCE(t.received_line_items,'[]'::jsonb)) x(value)
          WHERE COALESCE(x.value->>'materialType','item')=sl.material_type
            AND NULLIF(x.value->>'itemId','')::int=sl.ref_id
       ) received ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS reservation_count,
                COALESCE(SUM(r.quantity::numeric) FILTER (
                  WHERE r.status IN ('active','released')
                    AND (r.released_at IS NULL OR r.released_at::date>$1::date)
                 ),0)::numeric AS reserved_quantity_at_cutoff,
                 COALESCE(BOOL_AND(
                   r.status='released' AND r.released_at IS NOT NULL
                   AND r.released_at::date<=$1::date
                 ) FILTER (WHERE r.status IN ('active','released')),FALSE)
                   AS all_reservations_released_by_cutoff
           FROM stock_reservations r
          WHERE r.doc_type='stock_transfer' AND r.doc_id=t.id AND r.kind='in_transit'
            AND r.material_type=sl.material_type AND r.ref_id=sl.ref_id
            AND r.branch_type=t.from_type AND r.branch_id=t.from_id
       ) reservations ON TRUE
       ORDER BY t.id,sl.material_type,sl.ref_id,sl.destination_id`,
    [asOf],
  );
  return rows.filter((row) => !isHistoricalTransferReceiptReconciled(row, asOf));
}
