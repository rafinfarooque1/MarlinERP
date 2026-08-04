import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getUserDataScope, scopeSalesWhere, scopeLocationTypeWhere } from "../lib/dataScope";
import { hasModuleAction } from "../middleware/permissions";

const router: IRouter = Router();

/**
 * Global quick search (Cmd+K palette, Phase 7).
 *
 * GET /search?q= — searches items, customers, vendors and sale invoices
 * (LIMIT 8 per group). Permission-aware: a result group is only populated when
 * the employee may view a page that shows that kind of record, with the same
 * default-DENY semantics as requireModuleView (level 1 = everything, missing
 * permission row = hidden). Search must never be a side door to records the
 * role cannot open from the sidebar.
 *
 * LBAC: results are automatically scoped to the employee's assigned location —
 * customers and vendors by their location_type/location_id, sales by
 * their location columns.
 */
const GROUP_MODULES: Record<string, string[]> = {
  items: ["page:/production/item-master"],
  customers: ["page:/customers"],
  vendors: ["page:/vendors"],
  sales: ["page:/sales/pos", "page:/outstanding", "page:/returns"],
  quotations: ["page:/sales/quotations"],
};

router.get("/search", async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const empty = { items: [], customers: [], vendors: [], sales: [], quotations: [] };
  if (q.length < 2) { res.json(empty); return; }

  const employee = (req as any).employee as { branchType: string; branchId: number; hierarchyId: number } | undefined;
  if (!employee) { res.status(401).json({ error: "Authentication required" }); return; }

  const hierarchyId = employee.hierarchyId;

  const groups = Object.keys(GROUP_MODULES);
  const visible = await Promise.all(
    groups.map((g) => hasModuleAction(hierarchyId, GROUP_MODULES[g], "view")),
  );
  const visibleGroups = new Set(groups.filter((_, i) => visible[i]));
  const canView = (group: keyof typeof GROUP_MODULES): boolean => visibleGroups.has(group);

  // Resolve data scope once; all queries below will use it
  const scope = await getUserDataScope(employee);
  const like = `%${q}%`;

  const custParams: any[] = [like];
  const custScope = scopeLocationTypeWhere(scope, custParams, "c");

  const vendParams: any[] = [like];
  const vendScope = scopeLocationTypeWhere(scope, vendParams, "v", true); // HO vendors visible to all

  const salesParams: any[] = [like];
  const salesScope = scopeSalesWhere(scope, salesParams);

  const quotParams: any[] = [like];
  const quotScope = scopeLocationTypeWhere(scope, quotParams, "q");

  const [items, customers, vendors, sales, quotations] = await Promise.all([
    canView("items")
      ? pool.query(`SELECT id, name, unit FROM items WHERE name ILIKE $1 ORDER BY name LIMIT 8`, [like])
      : Promise.resolve({ rows: [] as any[] }),
    canView("customers")
      ? pool.query(
          `SELECT c.id, c.name, c.phone FROM customers c
           WHERE (c.name ILIKE $1 OR c.phone ILIKE $1) AND ${custScope}
           ORDER BY c.name LIMIT 8`,
          custParams,
        )
      : Promise.resolve({ rows: [] as any[] }),
    canView("vendors")
      ? pool.query(
          `SELECT v.id, v.name, v.phone FROM vendors v
           WHERE (v.name ILIKE $1 OR v.phone ILIKE $1) AND ${vendScope}
           ORDER BY v.name LIMIT 8`,
          vendParams,
        )
      : Promise.resolve({ rows: [] as any[] }),
    canView("sales")
      ? pool.query(
          `SELECT s.id, s.invoice_number, s.total_amount, s.sale_date::text AS sale_date, c.name AS customer_name,
                  CASE WHEN s.location_type = 'headoffice' THEN 'Head Office'
                       ELSE COALESCE(o.name, w.name) END AS location_name
           FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
           LEFT JOIN outlets    o ON s.location_type = 'outlet'    AND o.id = s.location_id
           LEFT JOIN warehouses w ON s.location_type = 'warehouse' AND w.id = s.location_id
           WHERE (s.invoice_number ILIKE $1 OR s.legacy_invoice_number ILIKE $1 OR c.name ILIKE $1)
             AND s.branch_transfer_id IS NULL AND ${salesScope}
           ORDER BY s.id DESC LIMIT 8`,
          salesParams,
        )
      : Promise.resolve({ rows: [] as any[] }),
    // Quotations match on number, customer name/phone/GST, and item names
    // inside the stored line_items JSONB — no join to a lines table exists.
    canView("quotations")
      ? pool.query(
          `SELECT q.id, q.quotation_number, q.total_amount, q.status,
                  to_char(q.quote_date, 'YYYY-MM-DD') AS quote_date,
                  c.name AS customer_name
           FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id
           WHERE (q.quotation_number ILIKE $1 OR c.name ILIKE $1 OR c.phone ILIKE $1
                  OR c.gst_number ILIKE $1
                  OR EXISTS (
                       SELECT 1 FROM jsonb_array_elements(q.line_items) li
                        WHERE li->>'itemName' ILIKE $1))
             AND ${quotScope}
           ORDER BY q.id DESC LIMIT 8`,
          quotParams,
        )
      : Promise.resolve({ rows: [] as any[] }),
  ]);

  res.json({
    items: items.rows.map((r: any) => ({ id: r.id, title: r.name, subtitle: r.unit ?? "" })),
    customers: customers.rows.map((r: any) => ({ id: r.id, title: r.name, subtitle: r.phone ?? "" })),
    vendors: vendors.rows.map((r: any) => ({ id: r.id, title: r.name, subtitle: r.phone ?? "" })),
    // Numbers run per location, so the same invoice number can exist at two
    // places — the location name is what tells the results apart.
    sales: sales.rows.map((r: any) => ({
      id: r.id,
      title: r.invoice_number,
      subtitle: `${r.customer_name ?? "Walk-in"} · ₹${Number(r.total_amount).toLocaleString("en-IN")} · ${r.sale_date}${r.location_name ? ` · ${r.location_name}` : ""}`,
    })),
    quotations: quotations.rows.map((r: any) => ({
      id: r.id,
      title: r.quotation_number,
      subtitle: `${r.customer_name ?? "Walk-in"} · ₹${Number(r.total_amount).toLocaleString("en-IN")} · ${r.quote_date} · ${String(r.status).toUpperCase()}`,
    })),
  });
});

export default router;
