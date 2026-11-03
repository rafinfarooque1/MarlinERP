import { isIsoDate } from "./dateInput";
import { assertStockDatesOpen } from "./dailyStockClosures";

/**
 * Immutable Stock Ledger — every inventory movement writes one or more entries here.
 * Entries are append-only; no UPDATE or DELETE on this table, with ONE narrow,
 * deliberate exception: `txn_date` (the document's BUSINESS date) follows its
 * document. Date restatements are allowed only while both the old and new
 * business dates remain open; closed dates are immutable.
 * `created_at` is the immutable insert-time audit stamp and is never rewritten;
 * document edits themselves are recorded in the activity log.
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
  /**
   * The BUSINESS date of the movement (the document's own date), YYYY-MM-DD.
   * created_at records when the row was inserted; txn_date records when the
   * movement happened commercially. Dates before the future-only baseline and
   * dates already closed by the daily close are refused.
   * Omitted → the current company-local business date.
   */
  txnDate?: string | null;
  snapshotUnitCost?: number | null;
}

type TransferCheckpointReplayPlan = {
  materialType: string;
  refId: number;
  branchType: string;
  branchId: number;
  txnDate: string;
  quantityDelta: number;
  unitCost: number;
  sourceId: number;
  snapshots: Array<{ date: string; quantity: number; value: number }>;
};

export async function prepareTransferCheckpointReplay(
  db: { query: (...args: any[]) => Promise<any> },
  entries: LedgerEntry[],
): Promise<Map<string, TransferCheckpointReplayPlan>> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const key = `${entry.materialType}:${entry.refId}:${entry.branchType}:${entry.branchId}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const plans = new Map<string, TransferCheckpointReplayPlan>();
  for (const [key, group] of groups) {
    const first = group[0];
    const txnDate = String(first.txnDate ?? "");
    const quantityDelta = group.reduce((sum, entry) => sum + Number(entry.qtyChange), 0);

    const futureResult = await db.query(
      `SELECT DISTINCT ON (as_of_date)
              as_of_date::text AS as_of_date, quantity::numeric AS quantity,
              unit_cost::numeric AS unit_cost, value::numeric AS value
         FROM stock_cost_snapshots
        WHERE material_type = $1 AND ref_id = $2 AND branch_type = $3 AND branch_id = $4
          AND as_of_date >= $5::date
        ORDER BY as_of_date, id DESC`,
      [first.materialType, first.refId, first.branchType, first.branchId, txnDate],
    );
    const future = (futureResult.rows ?? []) as Array<{
      as_of_date: string; quantity: string | number; unit_cost: string | number; value: string | number;
    }>;
    if (!future.some(row => row.as_of_date > txnDate)) continue;

    const unitCost = Number(first.snapshotUnitCost);
    const sourceId = Number(first.docId);
    if (
      !isIsoDate(txnDate) || !Number.isInteger(sourceId) || quantityDelta <= 0 || unitCost <= 0
      || group.some(e => e.txnType !== "transfer_in" || e.docType !== "stock_transfer"
        || e.docId == null || Number(e.docId) !== sourceId || Number(e.qtyChange) <= 0
        || e.txnDate !== first.txnDate
        || e.snapshotUnitCost == null || e.unitCost == null
        || Number(e.snapshotUnitCost) !== unitCost
        || Number(e.unitCost) !== Number(first.unitCost)
        || Number(e.snapshotUnitCost) !== Number(e.unitCost))
    ) {
      throw Object.assign(new Error(
        "Historical checkpoint replay is supported only for transfer receipts whose cost matches the destination valuation.",
      ), { status: 409, statusCode: 409, code: "STOCK_CHECKPOINT_REPLAY_UNSAFE" });
    }

    const priorResult = await db.query(
      `SELECT as_of_date::text AS as_of_date, quantity::numeric AS quantity,
              unit_cost::numeric AS unit_cost, value::numeric AS value
         FROM stock_cost_snapshots
        WHERE material_type = $1 AND ref_id = $2 AND branch_type = $3 AND branch_id = $4
          AND as_of_date < $5::date
        ORDER BY as_of_date DESC, id DESC LIMIT 1`,
      [first.materialType, first.refId, first.branchType, first.branchId, txnDate],
    );
    const prior = priorResult.rows?.[0] as {
      as_of_date: string; quantity: string | number; unit_cost: string | number; value: string | number;
    } | undefined;
    if (!prior) {
      throw Object.assign(new Error("Cannot replay this receipt: no checkpoint exists before its date."), {
        status: 409, statusCode: 409, code: "STOCK_CHECKPOINT_REPLAY_UNSAFE",
      });
    }

    const lastDate = future[future.length - 1].as_of_date;
    const movementResult = await db.query(
      `SELECT txn_date::text AS txn_date, COALESCE(SUM(qty_change::numeric), 0)::numeric AS quantity_delta
         FROM stock_ledger
        WHERE material_type = $1 AND ref_id = $2 AND branch_type = $3 AND branch_id = $4
          AND txn_date > $5::date AND txn_date <= $6::date
        GROUP BY txn_date ORDER BY txn_date`,
      [first.materialType, first.refId, first.branchType, first.branchId, prior.as_of_date, lastDate],
    );
    const movements = new Map<string, number>(
      (movementResult.rows ?? []).map((row: any) => [String(row.txn_date), Number(row.quantity_delta)]),
    );
    let expected = Number(prior.quantity);
    let previousDate = prior.as_of_date;
    const checkpoints = [prior, ...future];
    for (const checkpoint of checkpoints) {
      const date = checkpoint.as_of_date;
      if (date === prior.as_of_date) continue;
      for (const [movementDate, quantity] of movements) {
        if (movementDate > previousDate && movementDate <= date) expected += quantity;
      }
      const quantity = Number(checkpoint.quantity);
      const cost = Number(checkpoint.unit_cost);
      const value = Number(checkpoint.value);
      if (
        Math.abs(expected - quantity) > 0.0001
        || Math.abs(cost - unitCost) > 0.0001
        || Math.abs(value - quantity * unitCost) > 0.01
      ) {
        throw Object.assign(new Error(
          `Cannot safely replay the receipt: stock history for ${first.materialType}:${first.refId} does not reconcile through ${date}.`,
        ), { status: 409, statusCode: 409, code: "STOCK_CHECKPOINT_REPLAY_UNSAFE" });
      }
      previousDate = date;
    }

    const { rows: stockRows } = await db.query(
      `SELECT quantity::numeric AS quantity FROM stock_entries
        WHERE material_type = $1 AND item_id = $2 AND branch_type = $3 AND branch_id = $4
        FOR UPDATE`,
      [first.materialType, first.refId, first.branchType, first.branchId],
    );
    const currentQuantity = Number(stockRows?.[0]?.quantity);
    const lastCheckpointQuantity = Number(future[future.length - 1].quantity);
    if (!Number.isFinite(currentQuantity) || Math.abs(currentQuantity - lastCheckpointQuantity - quantityDelta) > 0.0001) {
      throw Object.assign(new Error(
        "Cannot safely replay the receipt: current stock does not match the latest checkpoint.",
      ), { status: 409, statusCode: 409, code: "STOCK_CHECKPOINT_REPLAY_UNSAFE" });
    }

    const sameDay = future.find(row => row.as_of_date === txnDate);
    const receiptQuantity = sameDay
      ? Number(sameDay.quantity) + quantityDelta
      : Number(prior.quantity)
        + [...movements].reduce((sum, [date, quantity]) => date <= txnDate ? sum + quantity : sum, 0)
        + quantityDelta;
    const snapshots = [{
      date: txnDate,
      quantity: receiptQuantity,
      value: receiptQuantity * unitCost,
    }];
    for (const checkpoint of future) {
      if (checkpoint.as_of_date <= txnDate) continue;
      const quantity = Number(checkpoint.quantity) + quantityDelta;
      snapshots.push({ date: checkpoint.as_of_date, quantity, value: quantity * unitCost });
    }
    plans.set(key, {
      materialType: first.materialType, refId: first.refId,
      branchType: first.branchType, branchId: first.branchId,
      txnDate, quantityDelta, unitCost, sourceId, snapshots,
    });
  }
  return plans;
}

/** Bulk-insert ledger entries. Silently skips empty arrays. */
export async function writeStockLedger(
  db: { query: (...args: any[]) => Promise<any> },
  entries: LedgerEntry[],
  options: { allowTransferCheckpointReplay?: boolean } = {},
): Promise<void> {
  if (!entries.length) return;
  // Callers must pass their transaction client: refusing a non-replayable
  // backdate must also roll back the quantity mutation preceding this writer.
  // Validate the complete date set before appending audit/checkpoint records.
  const { normalizedDates } = await assertStockDatesOpen(db, entries.map(e => e.txnDate));
  const normalizedEntries = entries.map((entry, index) => ({
    ...entry,
    txnDate: normalizedDates[index],
  }));
  const replayPlans = options.allowTransferCheckpointReplay
    ? await prepareTransferCheckpointReplay(db, normalizedEntries)
    : new Map<string, TransferCheckpointReplayPlan>();
  for (const e of normalizedEntries) {
    if (e.txnDate != null && !isIsoDate(e.txnDate)) throw new Error("Invalid stock business date");
    const key = `${e.materialType}:${e.refId}:${e.branchType}:${e.branchId}`;
    if (replayPlans.has(key)) continue;
    const result = await db.query(
      `SELECT MAX(as_of_date)::text AS latest_date
         FROM stock_cost_snapshots
        WHERE material_type = $1 AND ref_id = $2 AND branch_type = $3 AND branch_id = $4
          AND as_of_date > COALESCE($5::date, CURRENT_DATE)`,
      [e.materialType, e.refId, e.branchType, e.branchId, e.txnDate ?? null],
    ) as { rows: Array<{ latest_date: string | null }> };
    if (result.rows[0]?.latest_date) {
      throw Object.assign(new Error(
        `Stock date ${e.txnDate ?? "today"} precedes the latest inventory checkpoint `
        + `${result.rows[0].latest_date} for ${e.materialType}:${e.refId} at ${e.branchType}:${e.branchId}. `
        + "Historical checkpoint replay is unavailable; use a current-date correction.",
      ), { status: 409, statusCode: 409, code: "STOCK_CHECKPOINT_BACKDATE" });
    }
  }
  for (const e of normalizedEntries) {
    const key = `${e.materialType}:${e.refId}:${e.branchType}:${e.branchId}`;
    if (replayPlans.has(key)) {
      await db.query(
        `INSERT INTO stock_ledger
           (txn_type, material_type, ref_id, item_name, unit,
            branch_type, branch_id, branch_name, qty_change,
            unit_cost, doc_type, doc_id, notes, txn_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date)`,
        [
          e.txnType, e.materialType, e.refId, e.itemName ?? "", e.unit ?? "",
          e.branchType, e.branchId, e.branchName ?? "", e.qtyChange,
          e.unitCost ?? 0, e.docType, e.docId ?? null, e.notes ?? null, e.txnDate,
        ],
      );
      continue;
    }
    await db.query(
      `INSERT INTO stock_ledger
         (txn_type, material_type, ref_id, item_name, unit,
          branch_type, branch_id, branch_name, qty_change,
          unit_cost, doc_type, doc_id, notes, txn_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::date, CURRENT_DATE))`,
      [
        e.txnType, e.materialType, e.refId,
        e.itemName ?? '', e.unit ?? '',
        e.branchType, e.branchId, e.branchName ?? '',
        e.qtyChange, e.unitCost ?? 0,
        e.docType, e.docId ?? null, e.notes ?? null,
        e.txnDate ?? null,
      ],
    );
    // Capture the post-movement quantity and weighted-average cost in the same
    // transaction as the stock change. A checkpoint is append-only; the latest
    // checkpoint for a key/date is the authoritative dated position.
    await db.query(
      `INSERT INTO stock_cost_snapshots
         (as_of_date, material_type, ref_id, branch_type, branch_id,
          quantity, unit_cost, value, source, source_id)
       SELECT COALESCE($7::date, CURRENT_DATE), se.material_type, se.item_id,
              se.branch_type, se.branch_id, se.quantity::numeric,
                  COALESCE(NULLIF($8::numeric, 0), NULLIF(previous_cost.unit_cost, 0), NULLIF(se.cost_price::numeric, 0), 0),
                  (se.quantity::numeric * COALESCE(NULLIF($8::numeric, 0), NULLIF(previous_cost.unit_cost, 0), NULLIF(se.cost_price::numeric, 0), 0))::numeric,
              $1, $6
         FROM stock_entries se
          LEFT JOIN LATERAL (
            SELECT CASE WHEN scs.quantity > 0 THEN scs.value::numeric / scs.quantity::numeric
                        ELSE scs.unit_cost::numeric END AS unit_cost
              FROM stock_cost_snapshots scs
             WHERE scs.material_type = se.material_type AND scs.ref_id = se.item_id
               AND scs.branch_type = se.branch_type AND scs.branch_id = se.branch_id
               AND $1 IN ('sale', 'transfer_out', 'production_consumption')
             ORDER BY scs.as_of_date DESC, scs.id DESC LIMIT 1
          ) previous_cost ON TRUE
        WHERE se.item_id = $2 AND se.material_type = $3
          AND se.branch_type = $4 AND se.branch_id = $5`,
       [
         e.txnType, e.refId, e.materialType, e.branchType, e.branchId,
         e.docId ?? null, e.txnDate ?? null, e.snapshotUnitCost ?? null,
       ],
    );
  }
  for (const plan of replayPlans.values()) {
    for (const snapshot of plan.snapshots) {
      await db.query(
        `INSERT INTO stock_cost_snapshots
           (as_of_date, material_type, ref_id, branch_type, branch_id,
            quantity, unit_cost, value, source, source_id)
         VALUES ($1::date,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,'transfer_checkpoint_replay',$9)`,
        [
          snapshot.date, plan.materialType, plan.refId, plan.branchType, plan.branchId,
          snapshot.quantity, plan.unitCost, snapshot.value, plan.sourceId,
        ],
      );
    }
  }
}

/**
 * Format a DATE value as YYYY-MM-DD for LedgerEntry.txnDate. pg returns DATE
 * columns as JS Date objects (local midnight), so format with LOCAL parts —
 * toISOString() would shift the day in a non-UTC timezone.
 */
export const toTxnDate = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

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
