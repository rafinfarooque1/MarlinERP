/**
 * Warehouse dispatch board — a fulfillment STATUS layer over existing sales.
 *
 * Zero books impact by construction: this module reads sales and writes only
 * the additive `sale_dispatch_status` table (one row per sale, created on the
 * first transition). It never touches sale amounts, stock quantities or
 * postings — a sale with or without a dispatch row is bitwise identical to
 * every accounting, GST and stock report.
 *
 * Status model (absence of a row = PENDING):
 *   PENDING → READY → DISPATCHED, forward-only, each step stamped who/when.
 *
 * Queue rules:
 *   • cancelled sales drop out automatically (s.cancelled_at IS NULL);
 *   • branch-transfer-generated tax invoices are never customer dispatches
 *     (s.branch_transfer_id IS NULL);
 *   • LBAC applies unconditionally (scopeSalesWhere), the sidebar location
 *     selector narrows on top (getLocationFilter, reads only).
 */
import { Router } from "express";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { pool } from "@workspace/db";
import { getUserDataScope, scopeSalesWhere } from "../lib/dataScope";
import { getLocationFilter } from "../lib/requestLocation";
import { isIsoDate } from "../lib/dateInput";
import { logActivity } from "../lib/audit";

const router = Router();

const DISPATCH_PAGE = "page:/operations/dispatch";

const STATUSES = ["PENDING", "READY", "DISPATCHED"] as const;
type DispatchStatus = (typeof STATUSES)[number];

/** Forward-only transition table: target status → required current status. */
const REQUIRED_CURRENT: Record<string, DispatchStatus> = {
  READY: "PENDING",
  DISPATCHED: "READY",
};

/** Days of sales the board shows when the caller sends no explicit window. */
const DEFAULT_WINDOW_DAYS = 30;

interface DispatchLine {
  name: string;
  quantity: number;
  unit: string;
}

function summariseLineItems(lineItems: unknown): { itemCount: number; totalQty: number; itemsSummary: string; lines: DispatchLine[] } {
  const raw = Array.isArray(lineItems) ? lineItems : [];
  const names: string[] = [];
  const lines: DispatchLine[] = [];
  let totalQty = 0;
  for (const li of raw) {
    const name = String((li as any)?.itemName ?? "").trim();
    if (name) names.push(name);
    const q = Number((li as any)?.quantity ?? 0);
    if (Number.isFinite(q)) totalQty += q;
    lines.push({
      name: name || "(unnamed item)",
      quantity: Number.isFinite(q) ? q : 0,
      unit: String((li as any)?.unit ?? "").trim(),
    });
  }
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` +${names.length - 3} more` : "";
  return {
    itemCount: raw.length,
    totalQty: Math.round(totalQty * 1000) / 1000,
    itemsSummary: shown + more,
    lines,
  };
}

function rowToQueueEntry(r: any) {
  const { itemCount, totalQty, itemsSummary, lines } = summariseLineItems(r.line_items);
  return {
    saleId: Number(r.id),
    invoiceNumber: r.invoice_number,
    saleDate: r.sale_date_s,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    customerName: r.customer_name ?? r.party_name ?? null,
    locationType: r.location_type ?? "outlet",
    locationId: r.location_id != null ? Number(r.location_id) : null,
    locationName: r.location_name ?? (r.location_type === "headoffice" ? "Head Office" : ""),
    paymentMode: r.payment_mode,
    totalAmount: Number(r.total_amount),
    itemCount,
    totalQty,
    itemsSummary,
    lines,
    status: (r.dispatch_status ?? "PENDING") as DispatchStatus,
    readyAt: r.ready_at ? (r.ready_at instanceof Date ? r.ready_at.toISOString() : String(r.ready_at)) : null,
    readyBy: r.ready_by ?? null,
    dispatchedAt: r.dispatched_at ? (r.dispatched_at instanceof Date ? r.dispatched_at.toISOString() : String(r.dispatched_at)) : null,
    dispatchedBy: r.dispatched_by ?? null,
  };
}

// ── Queue ─────────────────────────────────────────────────────────────────────
// GET /dispatch/queue?status=&q=&from=&to=
// Recent billed sales with their fulfillment status. Default window: last
// DEFAULT_WINDOW_DAYS days by sale date (explicit from/to override it).
router.get("/dispatch/queue", requireModuleView(DISPATCH_PAGE), async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) {
    res.status(400).json({ error: "from/to must be YYYY-MM-DD" });
    return;
  }
  const statusRaw = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "";
  if (statusRaw && !STATUSES.includes(statusRaw as DispatchStatus)) {
    res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
    return;
  }

  const params: unknown[] = [];
  const conds: string[] = [
    "s.branch_transfer_id IS NULL", // internal GST documents, never dispatched to a customer
    "s.cancelled_at IS NULL",       // cancelled sales drop out of the queue automatically
  ];

  if (from) { params.push(from); conds.push(`s.sale_date >= $${params.length}::date`); }
  if (to)   { params.push(to);   conds.push(`s.sale_date <= $${params.length}::date`); }
  if (!from && !to) {
    params.push(DEFAULT_WINDOW_DAYS);
    conds.push(`s.sale_date >= CURRENT_DATE - ($${params.length}::int)`);
  }
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(s.invoice_number ILIKE $${params.length} OR s.legacy_invoice_number ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`);
  }
  if (statusRaw) {
    params.push(statusRaw);
    conds.push(`COALESCE(ds.status, 'PENDING') = $${params.length}`);
  }

  // View narrowing (sidebar selector / explicit query) — reads only, ANDed on
  // top of LBAC below. Same column semantics as GET /sales.
  const viewLoc = getLocationFilter(req);
  if (viewLoc && (viewLoc.locationType === "warehouse" || viewLoc.locationType === "outlet")) {
    params.push(viewLoc.locationType); conds.push(`COALESCE(s.location_type, 'outlet') = $${params.length}`);
    params.push(viewLoc.locationId);   conds.push(`COALESCE(s.location_id, s.outlet_id) = $${params.length}`);
  } else if (viewLoc && viewLoc.locationType === "headoffice") {
    params.push("headoffice"); conds.push(`COALESCE(s.location_type, 'outlet') = $${params.length}`);
  }

  // LBAC — unconditional; the header above can only narrow this.
  const scope = await getUserDataScope((req as any).employee);
  conds.push(scopeSalesWhere(scope, params));

  const { rows } = await pool.query(
    `SELECT s.id, s.invoice_number, s.line_items, s.total_amount, s.payment_mode,
            s.created_at, s.party_name,
            to_char(s.sale_date, 'YYYY-MM-DD') AS sale_date_s,
            COALESCE(s.location_type, 'outlet') AS location_type,
            COALESCE(s.location_id, s.outlet_id) AS location_id,
            c.name AS customer_name,
            COALESCE(o.name, w.name) AS location_name,
            ds.status AS dispatch_status,
            ds.ready_at, ds.ready_by, ds.dispatched_at, ds.dispatched_by
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN sale_dispatch_status ds ON ds.sale_id = s.id
       LEFT JOIN outlets    o ON COALESCE(s.location_type, 'outlet') = 'outlet'
                             AND o.id = COALESCE(s.location_id, s.outlet_id)
       LEFT JOIN warehouses w ON s.location_type = 'warehouse'
                             AND w.id = s.location_id
      WHERE ${conds.join(" AND ")}
      ORDER BY s.created_at DESC, s.id DESC`,
    params,
  );

  res.json(rows.map(rowToQueueEntry));
});

// ── Transition ────────────────────────────────────────────────────────────────
// POST /dispatch/:saleId/status  { status: "READY" | "DISPATCHED" }
// Forward-only with a row lock so two clicks can't skip a step. The sale's own
// location decides ownership: a caller whose LBAC scope does not include it
// gets 404 (scoped resource, indistinguishable from missing).
router.post("/dispatch/:saleId/status", requireModuleAction(DISPATCH_PAGE, "edit"), async (req, res): Promise<void> => {
  const saleId = parseInt(String(req.params.saleId), 10);
  if (!Number.isFinite(saleId) || saleId <= 0) {
    res.status(400).json({ error: "Invalid sale id" });
    return;
  }
  const target = String((req.body as any)?.status ?? "").toUpperCase();
  if (target !== "READY" && target !== "DISPATCHED") {
    res.status(400).json({ error: "status must be READY or DISPATCHED" });
    return;
  }

  const scope = await getUserDataScope((req as any).employee);
  const username = (req as any).employee?.username ?? "system";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the sale row inside the scope check — foreign or missing is the
    // same 404 (scoped list ≠ scoped resource, but both refuse foreigners).
    const saleParams: unknown[] = [saleId];
    const scopeCond = scopeSalesWhere(scope, saleParams);
    const { rows: [sale] } = await client.query(
      `SELECT s.id, s.invoice_number, s.cancelled_at, s.branch_transfer_id
         FROM sales s
        WHERE s.id = $1 AND ${scopeCond}
        FOR UPDATE OF s`,
      saleParams,
    );
    if (!sale || sale.branch_transfer_id != null) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Sale not found" });
      return;
    }
    if (sale.cancelled_at != null) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This sale is cancelled — it is no longer in the dispatch queue." });
      return;
    }

    // Materialise the status row on first touch, then lock it.
    await client.query(
      `INSERT INTO sale_dispatch_status (sale_id) VALUES ($1)
       ON CONFLICT (sale_id) DO NOTHING`,
      [saleId],
    );
    const { rows: [ds] } = await client.query(
      `SELECT status FROM sale_dispatch_status WHERE sale_id = $1 FOR UPDATE`,
      [saleId],
    );
    const current = (ds?.status ?? "PENDING") as DispatchStatus;
    if (REQUIRED_CURRENT[target] !== current) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `Cannot mark ${target.toLowerCase()}: this sale is ${current.toLowerCase()}${target === "DISPATCHED" && current === "PENDING" ? " — mark it ready first" : ""}.`,
        code: "INVALID_TRANSITION",
        currentStatus: current,
      });
      return;
    }

    const { rows: [updated] } = await client.query(
      target === "READY"
        ? `UPDATE sale_dispatch_status
              SET status = 'READY', ready_at = now(), ready_by = $2, updated_at = now()
            WHERE sale_id = $1 RETURNING *`
        : `UPDATE sale_dispatch_status
              SET status = 'DISPATCHED', dispatched_at = now(), dispatched_by = $2, updated_at = now()
            WHERE sale_id = $1 RETURNING *`,
      [saleId, username],
    );
    await client.query("COMMIT");

    logActivity({
      action: "UPDATE",
      module: "Dispatch",
      entityType: "sale_dispatch",
      entityId: saleId,
      description: `Marked ${sale.invoice_number} ${target} (was ${current})`,
      user: username,
      metadata: { before: { status: current }, after: { status: target } },
    }).catch(() => {});

    res.json({
      saleId,
      invoiceNumber: sale.invoice_number,
      status: updated.status,
      readyAt: updated.ready_at ? new Date(updated.ready_at).toISOString() : null,
      readyBy: updated.ready_by ?? null,
      dispatchedAt: updated.dispatched_at ? new Date(updated.dispatched_at).toISOString() : null,
      dispatchedBy: updated.dispatched_by ?? null,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("dispatch status transition failed:", e);
    res.status(500).json({ error: "Failed to update dispatch status" });
  } finally {
    client.release();
  }
});

export default router;
