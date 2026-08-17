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
 *   • a location can be migrated ONCE (sales_number_formats row = done) —
 *     unless a super admin deliberately clears the lock via reset-lock below,
 *     which reopens the screen for a CORRECTED re-run and nothing else;
 *   • every rename lands in invoice_renumber_log: who, when, old, new.
 */
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { createHash } from "node:crypto";
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
  /** A completed migration batch exists for this scope — this is a corrected
   *  re-run after a deliberate lock reset, not a first migration. */
  isRerun: boolean;
  perSeries: Record<string, { count: number; firstNew: string; lastNew: string; lastSerial: number }>;
};

type PlanError = { error: string; status: number; code?: string };

type Target = {
  locationType: string;
  locationId: number;
  b2cStart: number;
  b2bStart: number;
  /**
   * 'restart'  — rebuild the sequence from the chosen starting serials
   *              (bill-book continuation, the original Ragiguda use case);
   * 'preserve' — KEEP every bill's existing serial and change only the printed
   *              shape: SB2C/2026-27/000528 → SB2C/26-27/528. Gaps left by
   *              deleted bills stay gaps — no bill's number moves to another
   *              bill, so a printed copy in a customer's hands still matches.
   */
  mode: "restart" | "preserve";
};

function parseTarget(body: any): Target | string {
  const locationType = String(body?.locationType ?? "");
  const locationId = Number(body?.locationId);
  const mode = body?.mode == null ? "restart" : String(body.mode);
  if (mode !== "restart" && mode !== "preserve") return "mode must be 'restart' or 'preserve'";
  // Starting serials only exist in restart mode — preserve keeps each bill's own.
  const b2cStart = mode === "preserve" ? 1 : Number(body?.b2cStart);
  const b2bStart = mode === "preserve" ? 1 : Number(body?.b2bStart);
  if (!["warehouse", "outlet", "headoffice"].includes(locationType)) return "locationType must be warehouse, outlet or headoffice";
  if (locationType !== "headoffice" && (!Number.isInteger(locationId) || locationId <= 0)) return "locationId is required";
  if (!Number.isInteger(b2cStart) || b2cStart < 1) return "b2cStart must be a whole number of 1 or more";
  if (!Number.isInteger(b2bStart) || b2bStart < 1) return "b2bStart must be a whole number of 1 or more";
  return { locationType, locationId: locationType === "headoffice" ? 0 : locationId, b2cStart, b2bStart, mode };
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
  opts: Target,
  forUpdate: boolean,
): Promise<Plan | PlanError> {
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
      code: "ALREADY_MIGRATED",
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

  // The target shape must not already exist at this location — UNLESS a
  // super admin deliberately cleared the migration lock via reset-lock, which
  // records a durable series='RESET' event row in invoice_renumber_log inside
  // the same transaction that deletes the marker. Renumbering FROM the
  // current short-FY state is then exactly the point, and
  // legacy_invoice_number's COALESCE keeps the original pre-migration number
  // through any number of re-runs. The RESET event (not merely "some batch
  // exists") is what authorises the re-run: a marker row deleted by hand in
  // SQL, or short-FY bills with no reset on record, still fail closed here —
  // manual tampering and genuinely half-landed states need a human first.
  const { rows: [preShort] } = await q.query(
    `SELECT count(*)::int AS c FROM sales
      WHERE number_scope = $1 AND invoice_series IN ('SB2B','SB2C')
        AND invoice_fy ~ '^[0-9]{2}-[0-9]{2}$'`,
    [scope]
  );
  const { rows: [resetEv] } = await q.query(
    `SELECT count(*)::int AS c FROM invoice_renumber_log
      WHERE number_scope = $1 AND series = 'RESET'`,
    [scope]
  );
  const isRerun = Number(resetEv?.c ?? 0) > 0;
  if (Number(preShort?.c ?? 0) > 0 && !isRerun) {
    return { status: 409, error: "Some bills at this location already carry the new number format — resolve those first." };
  }

  const counters: Record<string, number> = { SB2B: opts.b2bStart, SB2C: opts.b2cStart };
  const planRows: PlanRow[] = [];
  const perSeries: Plan["perSeries"] = {};
  for (const r of rows) {
    const series = r.invoice_series as "SB2B" | "SB2C";
    // preserve: the bill keeps its own stamped serial — only the shape changes.
    // A row without a parseable serial maps to 0 here for display; the
    // oddShaped tripwire blocks apply outright, so 0 can never be written.
    const serial = opts.mode === "preserve"
      ? (Number.isFinite(Number(r.invoice_serial)) && r.invoice_serial != null ? Number(r.invoice_serial) : 0)
      : counters[series]++;
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
    // lastSerial drives the counter advance after apply — it must be the MAX
    // serial, which in preserve mode is not necessarily the last row visited
    // (chronological order can interleave FYs).
    if (serial >= s.lastSerial) {
      s.lastSerial = serial;
      s.lastNew = newNumber;
    }
  }

  return { scope, locationName: name, rows: planRows, oddShaped: Number(odd?.c ?? 0), isRerun, perSeries };
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

/**
 * Fingerprint of the exact plan the administrator saw: scope, mode and the
 * full ordered old→new mapping. Apply refuses when its re-derived plan hashes
 * differently — expectedTotal alone cannot catch "same bill count, different
 * location/mode/start" after the selects changed mid-preview.
 */
function planChecksum(scope: string, mode: string, rows: Array<{ saleId: number; oldNumber: string; newNumber: string }>): string {
  const h = createHash("sha256");
  h.update(`${scope}|${mode}`);
  for (const r of rows) h.update(`|${r.saleId}:${r.oldNumber}>${r.newNumber}`);
  return h.digest("hex");
}

// ── Preview: the full OLD → NEW mapping, zero writes ────────────────────────
router.post("/admin/sales-renumber/preview", async (req, res): Promise<void> => {
  if (!(await requireLevelOne(req, res))) return;
  const target = parseTarget(req.body);
  if (typeof target === "string") { res.status(400).json({ error: target }); return; }

  const plan = await computePlan(pool as unknown as Q, target, false);
  if ("error" in plan) { res.status(plan.status).json({ error: plan.error, code: plan.code }); return; }
  const trail = await trailCounts(pool as unknown as Q, plan.scope);

  res.json({
    locationName: plan.locationName,
    scope: plan.scope,
    mode: target.mode,
    planChecksum: planChecksum(plan.scope, target.mode, plan.rows),
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
  const expectedChecksum = typeof req.body?.planChecksum === "string" ? req.body.planChecksum : "";
  if (!/^[0-9a-f]{64}$/.test(expectedChecksum)) {
    res.status(400).json({ error: "planChecksum (from the preview) is required" });
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
      res.status(plan.status).json({ error: plan.error, code: plan.code });
      return;
    }
    if (plan.rows.length !== expectedTotal) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `The bill count changed since the preview (expected ${expectedTotal}, found ${plan.rows.length}). Run the preview again and re-check.`,
      });
      return;
    }
    // The plan must be BITWISE the one previewed — same location, same mode,
    // same start serials, same bills mapping to the same new numbers.
    if (planChecksum(plan.scope, target.mode, plan.rows) !== expectedChecksum) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: "The plan changed since the preview (different bills, numbers or settings). Run the preview again and re-check.",
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
    //
    // First migration: never rewind an existing counter (GREATEST) — deleted
    // bills may have consumed higher serials that must not be re-issued.
    // Corrected RE-RUN after a lock reset: the whole scope was just rebuilt,
    // so the counter must FOLLOW the corrected sequence — GREATEST would
    // preserve the old run's high-water mark and leave a permanent hole in
    // the bill book (e.g. correct top bill 7533 but next bill drawn at 7590).
    // Rewinding is safe here because this transaction holds the exclusive
    // scope lock, every SB2x bill in scope was renumbered under FOR UPDATE,
    // and the floors below still cover every SB2x serial the plan does not
    // renumber: branch-transfer twins, and serials the log proves were issued
    // to bills that no longer exist (a bill renumbered in a previous batch
    // and deleted afterwards must never have its number re-issued to a new
    // sale). The one residue this cannot see is a bill BOTH created and
    // deleted after the previous migration — no durable trace of its serial
    // survives anywhere; that is the documented, super-admin-accepted cost of
    // a corrected re-run. The duplicate self-check above the COMMIT backstops
    // everything visible.
    // Rewinding is only ever correct for a RESTART-mode corrected re-run (the
    // scope was rebuilt onto lower serials on purpose). A PRESERVE-mode apply
    // never moves a serial down, so its counter must only ever move forward —
    // GREATEST — and it additionally folds in the high-water mark of the OLD
    // per-FY counter rows: the counter key changes to 'ALL' here, and serials
    // burned by since-deleted bills live only in those old rows. Without this
    // floor, warehouse:2's counter at 918 with top stored bill 898 would
    // re-issue 899–918 — numbers that were once printed on real bills.
    const rewind = plan.isRerun && target.mode === "restart";
    for (const [series, key] of [["SB2C", "b2c"], ["SB2B", "b2b"]] as const) {
      const planLast = plan.perSeries[series]?.lastSerial
        ?? (target.mode === "preserve" ? 0 : (series === "SB2C" ? target.b2cStart - 1 : target.b2bStart - 1));
      const { rows: [outside] } = await client.query(
        `SELECT COALESCE(MAX(invoice_serial), 0)::int AS m FROM sales
          WHERE number_scope = $1 AND invoice_series = $2 AND branch_transfer_id IS NOT NULL`,
        [plan.scope, series]
      );
      const { rows: [ghost] } = await client.query(
        `SELECT COALESCE(MAX((split_part(l.new_number, '/', 3))::int), 0)::int AS m
           FROM invoice_renumber_log l
          WHERE l.number_scope = $1 AND l.series = $2
            AND split_part(l.new_number, '/', 3) ~ '^[0-9]+$'
            AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = l.sale_id)`,
        [plan.scope, series]
      );
      const floors = [planLast, Number(outside?.m ?? 0), Number(ghost?.m ?? 0)];
      if (!rewind) {
        const { rows: [prior] } = await client.query(
          `SELECT COALESCE(MAX(last_number), 0)::int AS m FROM voucher_sequences
            WHERE voucher_type = $1`,
          [`${SALES_SERIES[key].counter}@${plan.scope}`]
        );
        floors.push(Number(prior?.m ?? 0));
      }
      const last = Math.max(...floors);
      await client.query(
        `INSERT INTO voucher_sequences (voucher_type, fy_label, last_number)
         VALUES ($1, 'ALL', $2)
         ON CONFLICT (voucher_type, fy_label)
         DO UPDATE SET last_number = ${rewind
           ? "EXCLUDED.last_number"
           : "GREATEST(voucher_sequences.last_number, EXCLUDED.last_number)"}`,
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

// ── Reset the migration lock — deliberate, super-admin, ONE location ────────
// Deletes exactly one sales_number_formats row so the migration screen reopens
// for that location and a CORRECTED renumbering can be run. Nothing else is
// touched: invoices, receipts, quotations, ledgers, counters and the
// invoice_renumber_log audit trail all stay exactly as they are. Duplicate
// protection is unchanged — the corrected apply recreates the row, which
// locks the location again.
//
// Window to know about: between the reset and the corrected apply, the
// location's allocator falls back to the DEFAULT number format (long FY,
// zero-padded, per-FY counters). Any bill created in that window is included
// in the corrected re-run and folded into the book series.
router.post("/admin/sales-renumber/reset-lock", async (req, res): Promise<void> => {
  if (!(await requireLevelOne(req, res))) return;
  const locationType = String(req.body?.locationType ?? "");
  const locationId = Number(req.body?.locationId);
  if (!["warehouse", "outlet", "headoffice"].includes(locationType)) {
    res.status(400).json({ error: "locationType must be warehouse, outlet or headoffice" });
    return;
  }
  if (locationType !== "headoffice" && (!Number.isInteger(locationId) || locationId <= 0)) {
    res.status(400).json({ error: "locationId is required" });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "confirm: true is required — this reopens a one-time migration" });
    return;
  }
  const locId = locationType === "headoffice" ? 0 : locationId;
  const actor = String((req as any).employee?.username ?? "admin");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const name = await locationName(client as unknown as Q, locationType, locId);
    if (!name) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Location not found" });
      return;
    }
    const scope = await salesCounterScope(client as any, { type: locationType, id: locId });
    // Exclusive scope lock: the format row must never vanish from under an
    // allocator mid-draw or an apply mid-migration for this scope.
    await acquireSalesScopeLockExclusive(client as any, scope);
    const { rows: [marker] } = await client.query(
      `SELECT number_scope, created_by, created_at FROM sales_number_formats
        WHERE number_scope = $1 FOR UPDATE`,
      [scope]
    );
    if (!marker) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: `${name} has no migration lock — its numbering was never migrated (or the lock was already cleared).` });
      return;
    }
    const { rows: batches } = await client.query(
      `SELECT batch_id, count(*)::int AS bills, min(performed_by) AS performed_by, min(performed_at) AS performed_at
         FROM invoice_renumber_log WHERE number_scope = $1
        GROUP BY batch_id ORDER BY min(performed_at)`,
      [scope]
    );
    const { rowCount } = await client.query(
      `DELETE FROM sales_number_formats WHERE number_scope = $1`, [scope]);
    if (rowCount !== 1) throw new Error(`expected to delete exactly 1 marker row, deleted ${rowCount}`);

    // The durable audit of the unlock, committed ATOMICALLY with it. This
    // series='RESET' row is also what authorises the corrected re-run in
    // computePlan — deleting the marker by hand in SQL leaves no such row,
    // so the half-landed tripwire still fails closed. sale_id 0 = no sale.
    const resetBatchId = `SRNRESET-${Date.now()}`;
    await client.query(
      `INSERT INTO invoice_renumber_log
         (batch_id, sale_id, location_type, location_id, number_scope, series, old_number, new_number, performed_by)
       VALUES ($1, 0, $2, $3, $4, 'RESET', $5, $6, $7)`,
      [
        resetBatchId, locationType, locId, scope,
        `lock created by ${marker.created_by ?? "unknown"} at ${new Date(marker.created_at).toISOString()}`,
        "migration lock cleared — corrected re-run permitted",
        actor,
      ]
    );
    await client.query("COMMIT");

    logActivity({
      action: "DELETE",
      module: "sales",
      entityType: "invoice_renumber_lock",
      description: `Cleared the invoice-numbering migration lock for ${name} (${scope}) — originally migrated by ${marker.created_by ?? "an administrator"}. The location can now be renumbered again; the previous renumber audit log is preserved.`,
      user: actor,
      metadata: { scope, locationType, locationId: locId, clearedCreatedBy: marker.created_by, clearedCreatedAt: marker.created_at, priorBatches: batches },
    }).catch(() => {});

    res.json({
      locationName: name,
      scope,
      resetBatchId,
      cleared: { createdBy: marker.created_by ?? null, createdAt: marker.created_at },
      priorBatches: batches.map((b) => ({
        batchId: b.batch_id,
        bills: Number(b.bills),
        performedBy: b.performed_by,
        performedAt: b.performed_at,
      })),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[admin/sales-renumber] reset-lock failed:", (err as Error).message);
    res.status(500).json({ error: `Reset failed and nothing was changed: ${(err as Error).message}` });
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
