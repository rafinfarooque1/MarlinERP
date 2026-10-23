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
};

export type HistoricalBatchAllocation = {
  docType: string;
  docId: number;
  batchNumber: string;
  quantity: unknown;
  unitCost: unknown;
  purchaseCost?: boolean;
};

export function resolveHistoricalBatchCoverage(
  expectedQuantity: number,
  movements: HistoricalBatchLedgerMove[],
  allocations: HistoricalBatchAllocation[],
): { ok: true; unitCost: number; batchNumber: string } | { ok: false; reason: string } {
  if (!Number.isFinite(expectedQuantity) || expectedQuantity <= 0) {
    return { ok: false, reason: "cutoff quantity is not positive and finite" };
  }
  if (!movements.length || movements.some((m) => !m.txnDate)) {
    return { ok: false, reason: "one or more historical movements have no business date" };
  }
  const allowed = new Set(["purchase", "sale", "sale_reversal", "sale_cancellation", "transfer_in", "transfer_out"]);
  if (movements.some((m) => !allowed.has(m.txnType) || m.docId == null)) {
    return { ok: false, reason: "movement type or source document is unsupported or missing" };
  }
  const ledgerQty = movements.reduce((sum, m) => sum + Number(m.qtyChange), 0);
  if (Math.abs(ledgerQty - expectedQuantity) > 0.001) {
    return { ok: false, reason: `dated ledger quantity ${ledgerQty} does not reconcile to cutoff quantity ${expectedQuantity}` };
  }
  const docs = new Map<string, number>();
  for (const m of movements) {
    const key = `${m.docType}:${m.docId}`;
    docs.set(key, (docs.get(key) ?? 0) + Number(m.qtyChange));
  }
  const allocated = new Map<string, number>();
  for (const a of allocations) {
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
    if (qty == null || (Math.abs(net) > 0.001 && Math.abs(Math.abs(net) - qty) > 0.001)) {
      return { ok: false, reason: `batch allocation for ${key} does not reconcile to its net ledger movement` };
    }
  }
  if ([...allocated.keys()].some((key) => !docs.has(key))) {
    return { ok: false, reason: "source batch allocation has no matching ledger movement" };
  }
  const batches = new Set(allocations.map((a) => a.batchNumber));
  if (batches.size !== 1) return { ok: false, reason: "multiple batch identities contribute to the cutoff balance" };
  const costRows = allocations.filter((a) => a.purchaseCost);
  if (!costRows.length) return { ok: false, reason: "no purchase-backed batch cost was found" };
  const costs = new Set(costRows.map((a) => Number(a.unitCost).toFixed(4)));
  if (costs.size !== 1 || allocations.some((a) => Number(a.unitCost).toFixed(4) !== [...costs][0])) {
    return { ok: false, reason: "batch costs conflict with the purchase-backed unit cost" };
  }
  return { ok: true, unitCost: Number(costRows[0].unitCost), batchNumber: [...batches][0] };
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
       SELECT doc_id AS transfer_id,material_type,ref_id,branch_type AS destination_type,
              branch_id AS destination_id,SUM(qty_change::numeric)::numeric AS quantity
         FROM stock_ledger
        WHERE doc_type='stock_transfer' AND txn_type='transfer_in'
          AND COALESCE(txn_date,created_at::date)<=$1::date
        GROUP BY doc_id,material_type,ref_id,branch_type,branch_id
     )
     SELECT t.id AS transfer_id,sl.material_type,sl.ref_id,sl.destination_type,
            sl.destination_id,sl.quantity,
            t.received_date::text AS received_date,
            COALESCE(t.received_date,rv.voucher_date,p.purchase_date)::text AS receipt_evidence_date,
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
