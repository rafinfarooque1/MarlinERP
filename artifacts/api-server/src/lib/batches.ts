// ── Batch-level inventory helpers (Phase 3) ─────────────────────────────────
// stock_entries stays the quantity source of truth. stock_batches is an
// additive breakdown per (location, item) into batches with mfg/expiry dates
// and unit cost. Batches floor at 0 and may total less than the stock entry
// (untracked legacy residual) but must never exceed real movements.
//
// All helpers accept a query-able client (pool or a transaction client) so
// callers can choose their atomicity.

export type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

export interface BatchBreakdownEntry {
  batchId?: number;
  batchNumber: string;
  mfgDate: string | null;
  expiryDate: string | null;
  quantity: number;
  unitCost: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Upsert (credit) quantity into a batch at a location. No-op for qty <= 0. */
export async function creditBatch(c: Queryable, args: {
  itemId: number; branchType: string; branchId: number;
  batchNumber: string; mfgDate?: string | null; expiryDate?: string | null;
  quantity: number; unitCost?: number; source?: string; sourceId?: number | null;
}): Promise<void> {
  if (!(args.quantity > 0)) return;
  await c.query(
    `INSERT INTO stock_batches (item_id, branch_type, branch_id, batch_number, mfg_date, expiry_date, quantity, unit_cost, source, source_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (item_id, branch_type, branch_id, batch_number) DO UPDATE SET
       quantity    = stock_batches.quantity + EXCLUDED.quantity,
       mfg_date    = COALESCE(stock_batches.mfg_date, EXCLUDED.mfg_date),
       expiry_date = COALESCE(stock_batches.expiry_date, EXCLUDED.expiry_date),
       unit_cost   = CASE WHEN EXCLUDED.unit_cost > 0 THEN EXCLUDED.unit_cost ELSE stock_batches.unit_cost END,
       updated_at  = now()`,
    [args.itemId, args.branchType, args.branchId, args.batchNumber,
     args.mfgDate ?? null, args.expiryDate ?? null, r3(args.quantity), r2(args.unitCost ?? 0),
     args.source ?? null, args.sourceId ?? null]
  );
}

/** FEFO plan: earliest expiry first (NULL expiry last), then oldest batch.
 *  Read-only unless `lock` is set (pass true inside a transaction that will
 *  consume the planned batches, to serialize concurrent consumers). */
export async function planFEFO(c: Queryable, itemId: number, branchType: string, branchId: number, quantity: number, lock = false): Promise<{
  plan: Array<BatchBreakdownEntry & { batchId: number; available: number }>;
  shortfall: number;
}> {
  const { rows } = await c.query(
    `SELECT id, batch_number, mfg_date, expiry_date, quantity, unit_cost
     FROM stock_batches
     WHERE item_id = $1 AND branch_type = $2 AND branch_id = $3 AND quantity > 0
     ORDER BY expiry_date ASC NULLS LAST, id ASC${lock ? " FOR UPDATE" : ""}`,
    [itemId, branchType, branchId]
  );
  const plan: Array<BatchBreakdownEntry & { batchId: number; available: number }> = [];
  let remaining = quantity;
  for (const b of rows) {
    if (remaining <= 0) break;
    const avail = Number(b.quantity);
    const take = Math.min(avail, remaining);
    if (take <= 0) continue;
    plan.push({
      batchId: b.id, batchNumber: b.batch_number, mfgDate: b.mfg_date, expiryDate: b.expiry_date,
      quantity: r3(take), unitCost: Number(b.unit_cost), available: avail,
    });
    remaining = r3(remaining - take);
  }
  return { plan, shortfall: r3(Math.max(0, remaining)) };
}

/** Decrement a single batch by up to `want`; returns what was actually taken.
 *  The owner predicate (item + location) is mandatory so a crafted batch id can
 *  never decrement someone else's stock. Row-locked for transactional callers. */
async function takeFromBatch(c: Queryable, batchRowId: number, want: number, owner: { itemId: number; branchType: string; branchId: number }): Promise<BatchBreakdownEntry | null> {
  const { rows: [b] } = await c.query(
    `SELECT id, batch_number, mfg_date, expiry_date, quantity, unit_cost FROM stock_batches
     WHERE id = $1 AND item_id = $2 AND branch_type = $3 AND branch_id = $4 FOR UPDATE`,
    [batchRowId, owner.itemId, owner.branchType, owner.branchId]
  );
  if (!b) return null;
  const take = r3(Math.min(Number(b.quantity), want));
  if (take <= 0) return null;
  await c.query(`UPDATE stock_batches SET quantity = GREATEST(0, quantity - $1), updated_at = now() WHERE id = $2`, [take, b.id]);
  return { batchId: b.id, batchNumber: b.batch_number, mfgDate: b.mfg_date, expiryDate: b.expiry_date, quantity: take, unitCost: Number(b.unit_cost) };
}

/**
 * Consume `quantity` from batches at a location. Explicit override picks are
 * honoured first (capped at batch availability); any remainder is consumed
 * FEFO. Returns the consumed breakdown, which may total less than requested
 * when batches don't cover the full quantity (untracked residual absorbs it).
 */
export async function consumeBatches(c: Queryable, args: {
  itemId: number; branchType: string; branchId: number; quantity: number;
  override?: Array<{ batchId: number; quantity: number }>;
}): Promise<BatchBreakdownEntry[]> {
  const consumed: BatchBreakdownEntry[] = [];
  let remaining = r3(Math.max(0, args.quantity));
  const owner = { itemId: args.itemId, branchType: args.branchType, branchId: args.branchId };

  if (Array.isArray(args.override)) {
    for (const ov of args.override) {
      if (remaining <= 0) break;
      const want = Math.min(Number(ov.quantity) || 0, remaining);
      if (want <= 0) continue;
      const took = await takeFromBatch(c, Number(ov.batchId), want, owner);
      if (took) { consumed.push(took); remaining = r3(remaining - took.quantity); }
    }
  }

  if (remaining > 0) {
    const { plan } = await planFEFO(c, args.itemId, args.branchType, args.branchId, remaining, true);
    for (const p of plan) {
      const took = await takeFromBatch(c, p.batchId, p.quantity, owner);
      if (took) { consumed.push(took); remaining = r3(remaining - took.quantity); }
    }
  }
  return consumed;
}

/**
 * Server-side validation of a manual batch override for one transfer line.
 * Rules: entries well-formed, no duplicate batches, batches must exist at the
 * given location for the given item with enough quantity, and the override
 * total must equal the line quantity exactly (±0.001).
 * Locks the batch rows (call inside the consuming transaction).
 */
export async function validateBatchOverride(c: Queryable, args: {
  itemId: number; branchType: string; branchId: number; quantity: number;
  override: Array<{ batchId: number; quantity: number }>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const seen = new Set<number>();
  let total = 0;
  // Lock in stable batch-id order so concurrent transfers can't deadlock
  const ordered = [...args.override].sort((a, b) => Number(a?.batchId) - Number(b?.batchId));
  for (const ov of ordered) {
    const batchId = Number(ov?.batchId);
    const qty = Number(ov?.quantity);
    if (!Number.isInteger(batchId) || batchId <= 0 || !(qty > 0)) {
      return { ok: false, error: "Invalid batch override entry" };
    }
    if (seen.has(batchId)) return { ok: false, error: "Duplicate batch in override" };
    seen.add(batchId);

    const { rows: [b] } = await c.query(
      `SELECT id, batch_number, quantity FROM stock_batches
       WHERE id = $1 AND item_id = $2 AND branch_type = $3 AND branch_id = $4 FOR UPDATE`,
      [batchId, args.itemId, args.branchType, args.branchId]
    );
    if (!b) return { ok: false, error: `Batch #${batchId} not found for this item at the source location` };
    if (qty > Number(b.quantity) + 0.001) {
      return { ok: false, error: `Batch ${b.batch_number} has only ${Number(b.quantity)} available (requested ${qty})` };
    }
    total = r3(total + qty);
  }
  if (Math.abs(total - r3(args.quantity)) > 0.001) {
    return { ok: false, error: `Batch override total (${total}) must equal the line quantity (${r3(args.quantity)})` };
  }
  return { ok: true };
}

/** Credit a previously-consumed breakdown back to a location (reversals). */
export async function restoreBatches(c: Queryable, itemId: number, branchType: string, branchId: number, breakdown: BatchBreakdownEntry[] | null | undefined, source?: string, sourceId?: number | null): Promise<void> {
  for (const b of breakdown ?? []) {
    if (!b || !(Number(b.quantity) > 0)) continue;
    await creditBatch(c, {
      itemId, branchType, branchId,
      batchNumber: b.batchNumber, mfgDate: b.mfgDate ?? null, expiryDate: b.expiryDate ?? null,
      quantity: Number(b.quantity), unitCost: Number(b.unitCost ?? 0),
      source: source ?? "transfer", sourceId: sourceId ?? null,
    });
  }
}

/**
 * Weighted-average cost update. Call AFTER the inbound quantity has been
 * applied to stock_entries: prevQty is derived as (current total − inQty).
 * Zero-cost inbounds are ignored so they never drag the average to 0.
 */
export async function updateAvgCostOnInbound(c: Queryable, itemId: number, inQty: number, inCost: number): Promise<void> {
  if (!(inQty > 0) || !(inCost > 0)) return;
  const { rows: [tot] } = await c.query(
    `SELECT COALESCE(SUM(quantity::numeric), 0) AS q FROM stock_entries
      WHERE item_id = $1 AND material_type = 'item'`, [itemId]
  );
  const { rows: [it] } = await c.query(
    `SELECT COALESCE(avg_cost, 0) AS avg_cost, COALESCE(cost, 0) AS cost FROM items WHERE id = $1`, [itemId]
  );
  if (!it) return;
  const totalNow = Number(tot?.q ?? 0);
  const prevQty = Math.max(0, r3(totalNow - inQty));
  const prevAvg = Number(it.avg_cost) > 0 ? Number(it.avg_cost) : Number(it.cost);
  const newAvg = prevQty <= 0 || prevAvg <= 0
    ? inCost
    : (prevQty * prevAvg + inQty * inCost) / (prevQty + inQty);
  await c.query(`UPDATE items SET avg_cost = $1, updated_at = now() WHERE id = $2`, [r2(newAvg), itemId]);
}

/** Cost to book for inbounds whose true cost is unknown (e.g. production output pre-Phase-5): moving average, falling back to the item's manual cost. */
export async function inboundCostForItem(c: Queryable, itemId: number): Promise<number> {
  const { rows: [it] } = await c.query(
    `SELECT COALESCE(avg_cost, 0) AS avg_cost, COALESCE(cost, 0) AS cost FROM items WHERE id = $1`, [itemId]
  );
  if (!it) return 0;
  return Number(it.avg_cost) > 0 ? Number(it.avg_cost) : Number(it.cost);
}
