/**
 * Stock reservations — the single store for "this stock is already promised".
 *
 * Before this existed, two commitments could be made against the same physical
 * stock: nothing recorded that quantity had been spoken for, so every check
 * compared a request against the full on-hand figure.
 *
 * `stock_reservations` is that record. It is a ledger, not a counter: one row
 * per commitment, flipped to `released` when the commitment is settled. Reserved
 * quantity is always SUMmed from active rows, never denormalised onto
 * stock_entries or stock_batches — a mirrored column is one more thing that can
 * drift from the truth.
 *
 * Two kinds, and the difference matters:
 *
 *  - `hold`       the goods are still physically at the location and still
 *                 counted in `stock_entries`, but are committed to a document
 *                 that has not shipped. A hold REDUCES available quantity:
 *                 available = on-hand − active holds.
 *
 *  - `in_transit` the goods have already left the sender (a dispatched transfer
 *                 deducts source stock at dispatch), so they are in no
 *                 location's on-hand figure. An in-transit row does NOT reduce
 *                 available — subtracting it would double-count the dispatch.
 *                 It exists so in-flight stock stays visible and can be valued
 *                 at cost as belonging to the sender until it is received.
 *
 * Every helper takes a query-able client so callers choose their atomicity.
 * Reserve, release and the movement they accompany must share one transaction.
 */

export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Discriminator shared with stock_entries, stock_batches and stock_ledger. */
export type ReservationProductKind = "item" | "material" | "raw_material";
export type ReservationKind = "hold" | "in_transit";
export type ReservationDocType = "stock_transfer" | "sale" | "production";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ReservationLine {
  batchId?: number | null;
  batchNumber?: string | null;
  quantity: number;
  unitCost?: number | null;
}

/**
 * Correlated subquery for the reserved quantity of the row aliased as `alias`.
 * The alias must expose item_id, material_type, branch_type and branch_id —
 * true of both stock_entries and stock_batches. Kept as SQL so list endpoints
 * and write-path guards cannot compute "reserved" two different ways.
 */
export function reservedSql(alias: string, kind: ReservationKind = "hold"): string {
  return `COALESCE((
    SELECT SUM(r.quantity::numeric) FROM stock_reservations r
     WHERE r.status = 'active' AND r.kind = '${kind}'
       AND r.ref_id = ${alias}.item_id
       AND r.material_type = ${alias}.material_type
       AND r.branch_type = ${alias}.branch_type
       AND r.branch_id = ${alias}.branch_id
  ), 0)`;
}

/** Reserved quantity attributable to one batch row (aliased `alias`). */
export function batchReservedSql(alias = "sb", kind: ReservationKind = "hold"): string {
  return `COALESCE((
    SELECT SUM(r.quantity::numeric) FROM stock_reservations r
     WHERE r.status = 'active' AND r.kind = '${kind}' AND r.batch_id = ${alias}.id
  ), 0)`;
}

/** Sum of active reservations of one kind for one product at one location. */
export async function reservedQuantity(c: Queryable, args: {
  refId: number; materialType?: ReservationProductKind;
  branchType: string; branchId: number; kind?: ReservationKind;
}): Promise<number> {
  const { rows: [r] } = await c.query(
    `SELECT COALESCE(SUM(quantity::numeric), 0)::float AS qty FROM stock_reservations
      WHERE status = 'active' AND kind = $5
        AND ref_id = $1 AND material_type = $2 AND branch_type = $3 AND branch_id = $4`,
    [args.refId, args.materialType ?? "item", args.branchType, args.branchId, args.kind ?? "hold"],
  );
  return r3(Number(r?.qty ?? 0));
}

/**
 * On-hand, held and available quantity for one product at one location.
 *
 * `lock: true` row-locks the stock_entries row so the caller's transaction
 * serialises against any other writer of the same row — the check and the
 * deduction it authorises must not be separated by another transaction's
 * deduction, which is exactly how stock got promised twice.
 */
export async function availabilityAt(c: Queryable, args: {
  refId: number; materialType?: ReservationProductKind;
  branchType: string; branchId: number; lock?: boolean;
}): Promise<{ entryId: number | null; quantity: number; reserved: number; available: number }> {
  const { rows: [se] } = await c.query(
    `SELECT id, quantity::numeric AS quantity FROM stock_entries
      WHERE item_id = $1 AND material_type = $2 AND branch_type = $3 AND branch_id = $4
      LIMIT 1${args.lock ? " FOR UPDATE" : ""}`,
    [args.refId, args.materialType ?? "item", args.branchType, args.branchId],
  );
  const quantity = se ? r3(Number(se.quantity)) : 0;
  const reserved = await reservedQuantity(c, { ...args, kind: "hold" });
  return {
    entryId: se ? Number(se.id) : null,
    quantity,
    reserved,
    available: r3(Math.max(0, quantity - reserved)),
  };
}

/**
 * The one refusal message for "not enough stock". Every consumption path uses
 * it, so a user never has to work out whether "available" meant on-hand or
 * on-hand minus what is already promised — both figures are always named.
 */
export function insufficientStockMessage(args: {
  productName: string; locationName?: string | null; unit?: string | null;
  quantity: number; reserved: number; requested: number;
}): string {
  const unit = args.unit ? ` ${args.unit}` : "";
  const at = args.locationName ? ` at ${args.locationName}` : "";
  const available = r3(Math.max(0, args.quantity - args.reserved));
  return `Insufficient stock of ${args.productName}${at}: ${r3(available)}${unit} available `
    + `(${r3(args.quantity)}${unit} on hand, ${r3(args.reserved)}${unit} reserved for other commitments) `
    + `— this needs ${r3(args.requested)}${unit}.`;
}

/**
 * Record a commitment. One row per batch so a reservation can say which lots
 * are promised; lines with no batch id are the untracked residual, which is
 * reservable exactly like a lot.
 */
export async function reserveStock(c: Queryable, args: {
  kind: ReservationKind;
  docType: ReservationDocType; docId: number;
  refId: number; materialType?: ReservationProductKind;
  branchType: string; branchId: number;
  lines: ReservationLine[];
  notes?: string | null;
}): Promise<void> {
  for (const line of args.lines) {
    const qty = r3(Number(line?.quantity ?? 0));
    if (!(qty > 0)) continue;
    await c.query(
      `INSERT INTO stock_reservations
         (ref_id, material_type, branch_type, branch_id, batch_id, batch_number,
          quantity, unit_cost, kind, doc_type, doc_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [args.refId, args.materialType ?? "item", args.branchType, args.branchId,
       line.batchId ?? null, line.batchNumber ?? null,
       qty, r2(Number(line.unitCost ?? 0)),
       args.kind, args.docType, args.docId, args.notes ?? null],
    );
  }
}

/**
 * Settle a document's commitments. Releasing is idempotent and never fails on
 * "nothing to release": a transfer dispatched before reservations existed has
 * no rows, and a document must still be receivable.
 */
export async function releaseReservations(c: Queryable, args: {
  docType: ReservationDocType; docId: number; kind?: ReservationKind; notes?: string | null;
}): Promise<number> {
  const params: unknown[] = [args.docType, args.docId];
  let kindCond = "";
  if (args.kind) { params.push(args.kind); kindCond = ` AND kind = $${params.length}`; }
  params.push(args.notes ?? null);
  const { rows } = await c.query(
    `UPDATE stock_reservations
        SET status = 'released', released_at = now(),
            notes = COALESCE($${params.length}, notes)
      WHERE status = 'active' AND doc_type = $1 AND doc_id = $2${kindCond}
      RETURNING id`,
    params,
  );
  return rows.length;
}

export interface InTransitRow {
  refId: number;
  materialType: ReservationProductKind;
  branchType: string;
  branchId: number;
  quantity: number;
  unitCost: number;
  value: number;
  docType: string;
  docId: number;
  batchNumber: string | null;
}

/**
 * Active in-transit stock, attributed to the sender that dispatched it. This is
 * the only place in-flight goods can be counted: they left the source's
 * stock_entries row at dispatch and do not reach the destination's until it is
 * received, so without this they belong to no location at all.
 */
export async function activeInTransit(c: Queryable, opts: {
  branchType?: string; branchId?: number; materialType?: ReservationProductKind; refId?: number;
} = {}): Promise<InTransitRow[]> {
  const conds = ["r.status = 'active'", "r.kind = 'in_transit'"];
  const params: unknown[] = [];
  if (opts.branchType) { params.push(opts.branchType); conds.push(`r.branch_type = $${params.length}`); }
  if (opts.branchId != null) { params.push(opts.branchId); conds.push(`r.branch_id = $${params.length}`); }
  if (opts.materialType) { params.push(opts.materialType); conds.push(`r.material_type = $${params.length}`); }
  if (opts.refId != null) { params.push(opts.refId); conds.push(`r.ref_id = $${params.length}`); }

  const { rows } = await c.query(
    `SELECT r.ref_id, r.material_type, r.branch_type, r.branch_id, r.batch_number,
            r.quantity::numeric AS quantity, r.unit_cost::numeric AS unit_cost,
            r.doc_type, r.doc_id
       FROM stock_reservations r
      WHERE ${conds.join(" AND ")}
      ORDER BY r.doc_id, r.id`,
    params,
  );
  return rows.map((r: any) => {
    const quantity = r3(Number(r.quantity));
    const unitCost = r2(Number(r.unit_cost ?? 0));
    return {
      refId: Number(r.ref_id),
      materialType: (r.material_type ?? "item") as ReservationProductKind,
      branchType: r.branch_type,
      branchId: Number(r.branch_id),
      quantity,
      unitCost,
      value: r2(quantity * unitCost),
      docType: r.doc_type,
      docId: Number(r.doc_id),
      batchNumber: r.batch_number ?? null,
    };
  });
}
