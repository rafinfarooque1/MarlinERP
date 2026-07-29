/**
 * Immutable Stock Ledger — every inventory movement writes one or more entries here.
 * Entries are append-only; no UPDATE or DELETE on this table.
 */

export interface LedgerEntry {
  txnType: string;       // sale | sale_reversal | sale_cancellation | purchase | purchase_reversal | production_consumption | production_output | transfer_out | transfer_in | sales_return | purchase_return
  materialType: string;  // item | material | raw_material
  refId: number;         // item_id / material_id / raw_material_id
  itemName: string;
  unit: string;
  branchType: string;
  branchId: number;
  branchName: string;
  qtyChange: number;     // signed: positive = in, negative = out
  unitCost?: number;
  docType: string;       // purchase | production | stock_transfer | sales_return | purchase_return
  docId?: number | null;
  notes?: string | null;
}

/** Bulk-insert ledger entries. Silently skips empty arrays. */
export async function writeStockLedger(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  entries: LedgerEntry[],
): Promise<void> {
  if (!entries.length) return;
  for (const e of entries) {
    await db.query(
      `INSERT INTO stock_ledger
         (txn_type, material_type, ref_id, item_name, unit,
          branch_type, branch_id, branch_name, qty_change,
          unit_cost, doc_type, doc_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        e.txnType, e.materialType, e.refId,
        e.itemName ?? '', e.unit ?? '',
        e.branchType, e.branchId, e.branchName ?? '',
        e.qtyChange, e.unitCost ?? 0,
        e.docType, e.docId ?? null, e.notes ?? null,
      ],
    );
  }
}

/** Resolve name + unit for a batch of (materialType, id) pairs via pool queries. */
export async function batchResolveMeta(
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  lines: Array<{ materialType: string; refId: number }>,
): Promise<Map<string, { name: string; unit: string }>> {
  const byType: Record<string, number[]> = {};
  for (const l of lines) {
    if (!byType[l.materialType]) byType[l.materialType] = [];
    byType[l.materialType].push(l.refId);
  }
  const out = new Map<string, { name: string; unit: string }>();
  for (const [mt, ids] of Object.entries(byType)) {
    const tbl = mt === 'raw_material' ? 'raw_materials' : mt === 'item' ? 'items' : 'materials';
    const { rows } = await pool.query(
      `SELECT id, name, COALESCE(unit,'') AS unit FROM ${tbl} WHERE id = ANY($1)`,
      [ids],
    );
    for (const r of rows) out.set(`${mt}:${r.id}`, { name: r.name ?? '', unit: r.unit ?? '' });
  }
  return out;
}
