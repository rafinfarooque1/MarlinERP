import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

/**
 * Global quick search (Cmd+K palette, Phase 7).
 *
 * GET /search?q= — searches items, customers, vendors and sale invoices
 * (LIMIT 8 per group). Permission-aware: a result group is only populated
 * when the employee's hierarchy can view the corresponding module, using the
 * same default-allow semantics as requireModuleView (level 1 = everything,
 * missing permission row = visible).
 */
const GROUP_MODULES: Record<string, string[]> = {
  items: ["Items"],
  customers: ["Customers"],
  vendors: ["Vendors"],
  sales: ["Sales", "Point of Sale"],
};

router.get("/search", async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const empty = { items: [], customers: [], vendors: [], sales: [] };
  if (q.length < 2) { res.json(empty); return; }

  const hierarchyId = (req as any).employee?.hierarchyId;
  if (!hierarchyId) { res.status(401).json({ error: "Authentication required" }); return; }

  const allModules = Object.values(GROUP_MODULES).flat();
  const { rows: permRows } = await pool.query<any>(
    `SELECT (SELECT level FROM hierarchies WHERE id = $1) AS level,
            (SELECT json_object_agg(module, can_view) FROM permissions
              WHERE hierarchy_id = $1 AND module = ANY($2::text[])) AS flags`,
    [hierarchyId, allModules],
  );
  const level = Number(permRows[0]?.level ?? 99);
  const flags: Record<string, boolean | null> = permRows[0]?.flags ?? {};
  const canView = (group: keyof typeof GROUP_MODULES): boolean =>
    level === 1 || GROUP_MODULES[group].some((m) => flags[m] !== false);

  const like = `%${q}%`;
  const [items, customers, vendors, sales] = await Promise.all([
    canView("items")
      ? pool.query(`SELECT id, name, unit FROM items WHERE name ILIKE $1 ORDER BY name LIMIT 8`, [like])
      : Promise.resolve({ rows: [] as any[] }),
    canView("customers")
      ? pool.query(`SELECT id, name, phone FROM customers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT 8`, [like])
      : Promise.resolve({ rows: [] as any[] }),
    canView("vendors")
      ? pool.query(`SELECT id, name, phone FROM vendors WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT 8`, [like])
      : Promise.resolve({ rows: [] as any[] }),
    canView("sales")
      ? pool.query(
          `SELECT s.id, s.invoice_number, s.total_amount, s.sale_date::text AS sale_date, c.name AS customer_name
           FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
           WHERE s.invoice_number ILIKE $1 OR c.name ILIKE $1
           ORDER BY s.id DESC LIMIT 8`, [like])
      : Promise.resolve({ rows: [] as any[] }),
  ]);

  res.json({
    items: items.rows.map((r: any) => ({ id: r.id, title: r.name, subtitle: r.unit ?? "" })),
    customers: customers.rows.map((r: any) => ({ id: r.id, title: r.name, subtitle: r.phone ?? "" })),
    vendors: vendors.rows.map((r: any) => ({ id: r.id, title: r.name, subtitle: r.phone ?? "" })),
    sales: sales.rows.map((r: any) => ({
      id: r.id,
      title: r.invoice_number,
      subtitle: `${r.customer_name ?? "Walk-in"} · ₹${Number(r.total_amount).toLocaleString("en-IN")} · ${r.sale_date}`,
    })),
  });
});

export default router;
