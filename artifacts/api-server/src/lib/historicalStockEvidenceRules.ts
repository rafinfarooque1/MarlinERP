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

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * A transfer-in ledger entry cannot establish receipt when the transfer lacks
 * a received date or its reservation still says the goods were in transit at
 * the requested cutoff. This is a hard approval stop, not a quantity fix.
 */
export async function historicalTransferReceiptConflicts(q: Queryable, asOf: string): Promise<any[]> {
  const { rows } = await q.query(
    `SELECT DISTINCT t.id AS transfer_id,sl.material_type,sl.ref_id,sl.branch_type AS destination_type,
            sl.branch_id AS destination_id,sl.qty_change::numeric AS quantity,
            t.received_date::text AS received_date,r.released_at::text AS reservation_released_at,
            r.status AS reservation_status
       FROM stock_transfers t
       JOIN stock_ledger sl
         ON sl.doc_type='stock_transfer' AND sl.doc_id=t.id AND sl.txn_type='transfer_in'
       LEFT JOIN stock_reservations r
         ON r.doc_type='stock_transfer' AND r.doc_id=t.id AND r.kind='in_transit'
        AND r.material_type=sl.material_type AND r.ref_id=sl.ref_id
        AND r.branch_type=t.from_type AND r.branch_id=t.from_id
      WHERE COALESCE(sl.txn_date,sl.created_at::date)<=$1::date
        AND (
          t.received_date>$1::date
          OR r.id IS NULL OR r.status='active' OR r.released_at IS NULL
          OR r.released_at::date>$1::date
        )
      ORDER BY t.id,sl.material_type,sl.ref_id,sl.branch_id`,
    [asOf],
  );
  return rows;
}
