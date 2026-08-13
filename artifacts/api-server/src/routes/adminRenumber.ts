/**
 * Admin-controlled sales invoice renumbering — one location at a time.
 *
 * The business case: a location that billed on physical bill books before the
 * ERP wants its invoice sequence to CONTINUE that book (e.g. the next B2C
 * bill after paper number 7489 is SB2C/26-27/7490), not restart at 000001.
 * This operation rebuilds the location's whole SB2B/SB2C history onto the
 * book numbering — short FY label ("26-27"), no zero padding, chronological
 * order — and flips the location's future numbering to the same format with
 * ONE continuous serial that never resets at FY rollover.
 *
 * This is a REFERENCE-NUMBER migration only, and the code holds that line:
 *   • sales row: only invoice_number / invoice_fy / invoice_serial change
 *     (plus legacy_invoice_number keeping the old number searchable);
 *   • the paper trail is renamed IN THE SAME TRANSACTION via renameTrail()
 *     — trail receipts (books derivation excludes receipts matching a sale
 *     number: renaming one side only would double-count revenue), quotation
 *     links, payment notes;
 *   • no amounts, dates, postings, stock, GST or payment status are touched,
 *     so every derived statement is bitwise identical afterwards;
 *   • month locks are deliberately NOT consulted — this is an admin serial
 *     migration, not an invoice edit; business dates never change.
 *
 * Safety rails:
 *   • level-1 administrator only (fail closed);
 *   • preview first: the full OLD → NEW mapping without writing anything;
 *   • apply re-derives the same plan under locks and refuses if the bill
 *     count moved since the preview (expectedTotal);
 *   • both series counters are row-locked FIRST (the same lock order sale
 *     creation and reclass use), so no new number can be drawn at this
 *     location while the rename is in flight;
 *   • one transaction — every validation failure rolls the whole thing back;
 *   • a location can be migrated ONCE (sales_number_formats row = done);
 *   • every rename lands in invoice_renumber_log: who, when, old, new.
 */
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { logActivity } from "../lib/audit";
import { renameTrail } from "../lib/invoiceReclass";
import {
  SALES_SERIES,
  salesCounterScope,
  shortFyLabel,
  acquireSalesScopeLockExclusive,
} from "../lib/voucherNumber";

const router: IRouter = Router();

/** Fail-closed level-1 gate — same rule as warehouse lifecycle operations. */
async function requireLevelOne(req: any, res: any): Promise<boolean> {
  const hid = Number(req.employee?.hierarchyId);
  if (Number.isFinite(hid) && hid > 0) {
    try {
      const { rows: [h] } = await pool.query<{ level: number }>(
        `SELECT level FROM hierarchies WHERE id = $1`, [hid]);
      if (Number(h?.level) === 1) return true;
    } catch { /* fail closed */ }
  }
  res.status(403).json({ error: "Only a super administrator can renumber invoices." });
  return false;
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

type PlanRow = {
  saleId: number;
  saleDate: string;
  series: "SB2B" | "SB2C";
  oldNumber: string;
  newNumber: string;
  newSerial: number;
  cancelled: boolean;
  party: string | null;
  totalAmount: number;
  location_type: string | null;
  location_id: number | null;
  outlet_id: number | null;
};

type Plan = {
  scope: string;
  locationName: string;
  rows: PlanRow[];
  /** SB2x-prefixed bills whose number has no parseable identity — never touched. */
  oddShaped: number;
  perSeries: Record<string, { count: number; firstNew: string; lastNew: string; lastSerial: number }>;
};

function parseTarget(body: any): { locationType: string; locationId: number; b2cStart: number; b2bStart: number } | string {
  const locationType = String(body?.locationType ?? "");
  const locationId = Number(body?.locationId);
  const b2cStart = Number(body?.b2cStart);
  const b2bStart = Number(body?.b2bStart);
  if (!["warehouse", "outlet", "headoffice"].includes(locationType)) return "locationType must be warehouse, outlet or headoffice";
  if (locationType !== "headoffice" && (!Number.isInteger(locationId) || locationId <= 0)) return "locationId is required";
  if (!Number.isInteger(b2cStart) || b2cStart < 1) return "b2cStart must be a whole number of 1 or more";
  if (!Number.isInteger(b2bStart) || b2bStart < 1) return "b2bStart must be a whole number of 1 or more";
  return { locationType, locationId: locationType === "headoffice" ? 0 : locationId, b2cStart, b2bStart };
}

async function locationName(q: Q, locationType: string, locationId: number): Promise<string | null> {
  if (locationType === "headoffice") return "Head Office";
  const table = locationType === "warehouse" ? "warehouses" : "outlets";
  const { rows: [r] } = await q.query(`SELECT name FROM ${table} WHERE id = $1`, [locationId]);
  return r ? String(r.name) : null;
}

/**
 * Derive the full renumbering plan. Chronological order decides the running
 * numbers, exactly as the bills were issued: business date first, then the
 * serial the location's own allocator handed out that day (creation order),
 * then row id as the final tiebreak. Cancelled bills keep their place — a
 * void document is still a numbered document, and skipping it would shift
 * every later bill off the book's count.
 */
async function computePlan(
  q: Q,
  opts: { locationType: string; locationId: number; b2cStart: number; b2bStart: number },
  forUpdate: boolean,
): Promise<Plan | { error: string; status: number }> {
  const name = await locationName(q, opts.locationType, opts.locationId);
  if (!name) return { error: "Location not found", status: 404 };
  const scope = await salesCounterScope(q as any, { type: opts.locationType, id: opts.locationId });

  const { rows: [fmtRow] } = await q.query(
    `SELECT number_scope, created_by, created_at FROM sales_number_formats WHERE number_scope = $1`,
    [scope]
  );
  if (fmtRow) {
    return {
      status: 409,
      error: `This location's invoice numbering was already migrated (by ${fmtRow.created_by ?? "an administrator"} on ${new Date(fmtRow.created_at).toLocaleDateString("en-IN")}). It cannot be renumbered a second time.`,
    };
  }

  const { rows } = await q.query(
    `SELECT s.id, s.invoice_number, s.invoice_series, s.invoice_fy, s.invoice_serial,
            s.sale_date::text AS sale_date, s.cancelled_at, s.total_amount,
            s.location_type, s.location_id, s.outlet_id,
            COALESCE(c.name, NULLIF(TRIM(COALESCE(s.party_name, '')), '')) AS party
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.number_scope = $1
        AND s.invoice_series IN ('SB2B', 'SB2C')
        AND s.branch_transfer_id IS NULL
      ORDER BY s.invoice_series, s.sale_date, s.invoice_serial NULLS LAST, s.id
      ${forUpdate ? "FOR UPDATE OF s" : ""}`,
    [scope]
  );

  // Bills carrying an SB2x prefix without a complete parseable identity
  // (series, FY or serial unstamped) would sit outside the serial rebuild.
  // They block apply — fail closed rather than renumber around them.
  const { rows: [odd] } = await q.query(
    `SELECT count(*)::int AS c FROM sales
      WHERE number_scope = $1
        AND (invoice_number LIKE 'SB2B/%' OR invoice_number LIKE 'SB2C/%')
        AND (invoice_series IS NULL OR invoice_serial IS NULL OR invoice_fy IS NULL)`,
    [scope]
  );

  // The target shape must not already exist at this location — a short-FY
  // bill here means a previous attempt half-landed; a human must look first.
  const { rows: [preShort] } = await q.query(
    `SELECT count(*)::int AS c FROM sales
      WHERE number_scope = $1 AND invoice_series IN ('SB2B','SB2C')
        AND invoice_fy ~ '^[0-9]{2}-[0-9]{2}$'`,
    [scope]
  );
  if (Number(preShort?.c ?? 0) > 0) {
    return { status: 409, error: "Some bills at this location already carry the new number format — resolve those first." };
  }

  const counters: Record<string, number> = { SB2B: opts.b2bStart, SB2C: opts.b2cStart };
  const planRows: PlanRow[] = [];
  const perSeries: Plan["perSeries"] = {};
  for (const r of rows) {
    const series = r.invoice_series as "SB2B" | "SB2C";
    const serial = counters[series]++;
    const newFy = shortFyLabel(String(r.invoice_fy ?? ""));
    const newNumber = `${series}/${newFy}/${serial}`;
    planRows.push({
      saleId: Number(r.id),
      saleDate: String(r.sale_date),
      series,
      oldNumber: String(r.invoice_number),
      newNumber,
      newSerial: serial,
      cancelled: r.cancelled_at != null,
      party: r.party ?? null,
      totalAmount: Number(r.total_amount ?? 0),
      location_type: r.location_type,
      location_id: r.location_id,
      outlet_id: r.outlet_id,
    });
    const s = (perSeries[series] ??= { count: 0, firstNew: newNumber, lastNew: newNumber, lastSerial: serial });
    s.count += 1;
    s.lastNew = newNumber;
    s.lastSerial = serial;
  }

  return { scope, locationName: name, rows: planRows, oddShaped: Number(odd?.c ?? 0), perSeries };
}

/** Trail-integrity counts, measured with the SAME predicates before and after. */
async function trailCounts(q: Q, scope: string): Promise<{ paired: number; orphans: number }> {
  const { rows: [paired] } = await q.query(
    `SELECT count(*)::int AS c
       FROM receipts r
       JOIN sales s ON r.voucher_number = s.invoice_number
                   AND r.location_type = s.location_type AND r.location_id = s.location_id
      WHERE s.number_scope = $1 AND s.invoice_series IN ('SB2B','SB2C') AND r.source = 'sale'`,
    [scope]
  );
  const { rows: [orphans] } = await q.query(
    `WITH locs AS (SELECT DISTINCT location_type, location_id FROM sales WHERE number_scope = $1)
     SELECT count(*)::int AS c
       FROM receipts r
       JOIN locs l ON r.location_type = l.location_type AND r.location_id = l.location_id
      WHERE r.source = 'sale'
        AND (r.voucher_number LIKE 'SB2B/%' OR r.voucher_number LIKE 'SB2C/%')
        AND NOT EXISTS (
          SELECT 1 FROM sales s
           WHERE s.invoice_number = r.voucher_number
             AND s.location_type = r.location_type AND s.location_id = r.location_id
        )`,
    [scope]
  );
  return { paired: Number(paired?.c ?? 0), orphans: Number(orphans?.c ?? 0) };
}

// ── Preview: the full OLD → NEW mapping, zero writes ────────────────────────
router.post("/admin/sales-renumber/preview", async (req, res): Promise<void> => {
  if (!(await requireLevelOne(req, res))) return;
  const target = parseTarget(req.body);
  if (typeof target === "string") { res.status(400).json({ error: target }); return; }

  const plan = await computePlan(pool as unknown as Q, target, false);
  if ("error" in plan) { res.status(plan.status).json({ error: plan.error }); return; }
  const trail = await trailCounts(pool as unknown as Q, plan.scope);

  res.json({
    locationName: plan.locationName,
    scope: plan.scope,
    total: plan.rows.length,
    perSeries: plan.perSeries,
    oddShaped: plan.oddShaped,
    pairedReceipts: trail.paired,
    mappings: plan.rows.map((r) => ({
      saleId: r.saleId,
      saleDate: r.saleDate,
      series: r.series,
      party: r.party,
      totalAmount: r.totalAmount,
      oldNumber: r.oldNumber,
      newNumber: r.newNumber,
      cancelled: r.cancelled,
    })),
  });
});

// ── Apply: the same plan, executed atomically under locks ───────────────────
router.post("/admin/sales-renumber/apply", async (req, res): Promise<void> => {
  if (!(await requireLevelOne(req, res))) return;
  const target = parseTarget(req.body);
  if (typeof target === "string") { res.status(400).json({ error: target }); return; }
  const expectedTotal = Number(req.body?.expectedTotal);
  if (!Number.isInteger(expectedTotal) || expectedTotal < 0) {
    res.status(400).json({ error: "expectedTotal (from the preview) is required" });
    return;
  }
  const actor = String((req as any).employee?.username ?? "admin");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One renumbering at a time, platform-wide.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('admin_sales_renumber'))`);

    // EXCLUSIVE scope lock, taken before any row or counter lock. Every
    // number producer for this scope — sale creation's allocator and the
    // B2C→B2B reclass — takes the SHARED side of this same lock first, so
    // for the duration of this transaction nothing can draw a sales number
    // here (whatever the sale's FY, including FYs with no counter row yet)
    // and nothing can hold a counter/sale-row lock this migration will want.
    // Other locations are completely unaffected.
    const scope = await salesCounterScope(client as any, { type: target.locationType, id: target.locationId });
    await acquireSalesScopeLockExclusive(client as any, scope);

    const plan = await computePlan(client as unknown as Q, target, true);
    if ("error" in plan) {
      await client.query("ROLLBACK");
      res.status(plan.status).json({ error: plan.error });
      return;
    }
    if (plan.rows.length !== expectedTotal) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `The bill count changed since the preview (expected ${expectedTotal}, found ${plan.rows.length}). Run the preview again and re-check.`,
      });
      return;
    }
    // Fail closed on malformed bills: an SB2B/SB2C-prefixed invoice without a
    // stamped, parseable identity would sit OUTSIDE the rebuilt sequence —
    // "renumber everything" must never silently mean "everything except…".
    if (plan.oddShaped > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `${plan.oddShaped} bill(s) at this location have unreadable invoice numbers and cannot be renumbered safely. Fix those bills first, then run the preview again.`,
      });
      return;
    }

    const before = await trailCounts(client as unknown as Q, plan.scope);

    const batchId = `SRN-${Date.now()}`;
    let updated = 0, receiptsRenamed = 0, quotationsUpdated = 0;
    for (const r of plan.rows) {
      const { rowCount } = await client.query(
        `UPDATE sales
            SET invoice_number = $1,
                invoice_fy = $2,
                invoice_serial = $3,
                legacy_invoice_number = COALESCE(legacy_invoice_number, $4)
          WHERE id = $5`,
        [r.newNumber, shortFyLabel(r.newNumber.split("/")[1]), r.newSerial, r.oldNumber, r.saleId]
      );
      updated += rowCount ?? 0;
      const trail = await renameTrail(client as unknown as Q as any, {
        id: r.saleId,
        location_type: r.location_type,
        location_id: r.location_id,
        outlet_id: r.outlet_id,
      }, r.oldNumber, r.newNumber);
      receiptsRenamed += trail.receipts;
      quotationsUpdated += trail.quotations;
      await client.query(
        `INSERT INTO invoice_renumber_log
           (batch_id, sale_id, location_type, location_id, number_scope, series, old_number, new_number, performed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [batchId, r.saleId, r.location_type, r.location_id, plan.scope, r.series, r.oldNumber, r.newNumber, actor]
      );
    }

    // Flip the location onto the book format for every FUTURE bill: short FY
    // label, no padding, one continuous serial that survives FY rollover.
    await client.query(
      `INSERT INTO sales_number_formats (number_scope, fy_short, pad, continuous, created_by)
       VALUES ($1, true, 0, true, $2)`,
      [plan.scope, actor]
    );

    // Advance the continuous counters to the last serial just issued — a
    // renumbering that leaves the allocator behind bricks the next sale on
    // the unique index (invisible to every read-only check).
    for (const [series, key] of [["SB2C", "b2c"], ["SB2B", "b2b"]] as const) {
      const last = plan.perSeries[series]?.lastSerial
        ?? (series === "SB2C" ? target.b2cStart - 1 : target.b2bStart - 1);
      await client.query(
        `INSERT INTO voucher_sequences (voucher_type, fy_label, last_number)
         VALUES ($1, 'ALL', $2)
         ON CONFLICT (voucher_type, fy_label)
         DO UPDATE SET last_number = GREATEST(voucher_sequences.last_number, EXCLUDED.last_number)`,
        [`${SALES_SERIES[key].counter}@${plan.scope}`, last]
      );
    }

    // ── Prove the rename left the data sound before committing ──────────────
    if (updated !== plan.rows.length) {
      throw new Error(`renumber updated ${updated} of ${plan.rows.length} bills`);
    }
    const { rows: [dup] } = await client.query(
      `SELECT count(*)::int AS c FROM (
         SELECT invoice_number FROM sales WHERE number_scope = $1
          GROUP BY invoice_number HAVING count(*) > 1
       ) d`,
      [plan.scope]
    );
    if (Number(dup?.c ?? 0) > 0) throw new Error(`renumber left ${dup.c} duplicate number(s) at this location`);
    const after = await trailCounts(client as unknown as Q, plan.scope);
    if (after.paired !== before.paired) {
      throw new Error(`receipt pairing changed (${before.paired} → ${after.paired}) — rolled back`);
    }
    if (after.orphans > before.orphans) {
      throw new Error(`renumber orphaned ${after.orphans - before.orphans} sale receipt(s) — rolled back`);
    }

    await client.query("COMMIT");

    logActivity({
      action: "UPDATE",
      module: "sales",
      entityType: "invoice_renumber",
      description: `Renumbered ${updated} invoice(s) at ${plan.locationName} onto the bill-book series (batch ${batchId}): ` +
        Object.entries(plan.perSeries).map(([s, v]) => `${s} ${v.firstNew} → ${v.lastNew}`).join(", "),
      user: actor,
      metadata: {
        batchId, scope: plan.scope, locationType: target.locationType, locationId: target.locationId,
        total: updated, receiptsRenamed, quotationsUpdated, perSeries: plan.perSeries,
      },
    }).catch(() => {});

    res.json({
      batchId,
      locationName: plan.locationName,
      renumbered: updated,
      receiptsRenamed,
      quotationsUpdated,
      perSeries: plan.perSeries,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[admin/sales-renumber] apply failed:", (err as Error).message);
    res.status(500).json({ error: `Renumbering failed and NOTHING was changed: ${(err as Error).message}` });
  } finally {
    client.release();
  }
});

// ── The permanent audit record ───────────────────────────────────────────────
router.get("/admin/sales-renumber/log", async (req, res): Promise<void> => {
  if (!(await requireLevelOne(req, res))) return;
  const { rows } = await pool.query(
    `SELECT batch_id, sale_id, location_type, location_id, series,
            old_number, new_number, performed_by, performed_at
       FROM invoice_renumber_log
      ORDER BY id DESC
      LIMIT 500`
  );
  res.json(rows.map((r) => ({
    batchId: r.batch_id,
    saleId: Number(r.sale_id),
    locationType: r.location_type,
    locationId: r.location_id == null ? null : Number(r.location_id),
    series: r.series,
    oldNumber: r.old_number,
    newNumber: r.new_number,
    performedBy: r.performed_by,
    performedAt: r.performed_at,
  })));
});

export default router;
