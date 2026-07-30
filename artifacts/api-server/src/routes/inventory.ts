import { Router } from "express";
import { requireModuleAction, requireModuleView, requireHeadOffice } from "../middleware/permissions";
import { db, itemsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { GetItemParams, DeleteItemParams } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { isValidGstSlab, gstSlabErrorMessage } from "../lib/gst";
import { logActivity } from "../lib/audit";
import {
  nextProductIdentity, isProductStatus, PRODUCT_STATUSES,
  type ProductKind,
} from "../lib/productIdentity";

const router = Router();

/** Item masters are company-wide: only Head Office may change them. */
const hoOnly = requireHeadOffice("items");

/** Reject non-slab GST rates (undefined/null = untouched, allowed). */
function slabViolation(taxRate: unknown, res: any): boolean {
  if (taxRate != null && !isValidGstSlab(taxRate)) {
    res.status(400).json({ error: gstSlabErrorMessage(taxRate) });
    return true;
  }
  return false;
}

// ── Identification field handling ──────────────────────────────────────────
// item_code / barcode / status are raw-migration columns, so every read below
// names them explicitly and every write goes through raw SQL.

/** Trim to null. An empty string means "not supplied", never "clear it". */
const trimOrNull = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/** Validate an optional code/barcode. Returns an error message or null. */
function identifierError(value: string | null, label: string, max: number): string | null {
  if (value == null) return null;
  if (/\s/.test(value)) return `${label} cannot contain spaces`;
  if (value.length > max) return `${label} cannot be longer than ${max} characters`;
  return null;
}

/** Shared validation for the identification fields on create and edit. */
function identityViolation(body: any, res: any): boolean {
  const itemCode = trimOrNull(body.itemCode);
  const barcode = trimOrNull(body.barcode);
  const codeErr = identifierError(itemCode, "Item code", 32) ?? identifierError(barcode, "Barcode", 64);
  if (codeErr) { res.status(400).json({ error: codeErr }); return true; }
  if (body.status != null && body.status !== "" && !isProductStatus(body.status)) {
    res.status(400).json({ error: `Status must be one of: ${PRODUCT_STATUSES.join(", ")}` });
    return true;
  }
  return false;
}

/**
 * Turn a unique-violation into a message that names the clashing field.
 * The partial unique indexes are `uq_<table>_item_code` / `uq_<table>_barcode`.
 */
function duplicateIdentityError(e: any): string | null {
  if (e?.code !== "23505") return null;
  const constraint = String(e.constraint ?? "");
  if (constraint.endsWith("_barcode")) return "That barcode is already used by another item. Barcodes must be unique.";
  if (constraint.endsWith("_item_code")) return "That item code is already used by another item. Item codes must be unique.";
  return null;
}

/** Wrap a write so a duplicate code/barcode returns 409, not a 500. */
async function handleWrite(res: any, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    const dup = duplicateIdentityError(e);
    if (dup) { res.status(409).json({ error: dup }); return; }
    throw e;
  }
}

/** Optional `?status=active|inactive` filter, appended to a WHERE clause. */
function statusFilter(req: any, res: any): { sql: string; params: string[] } | null {
  const raw = typeof req.query?.status === "string" ? req.query.status.trim() : "";
  if (!raw || raw === "all") return { sql: "", params: [] };
  if (!isProductStatus(raw)) {
    res.status(400).json({ error: `status must be one of: ${PRODUCT_STATUSES.join(", ")}, all` });
    return null;
  }
  return { sql: ` WHERE COALESCE(status, 'active') = $1`, params: [raw] };
}

/**
 * Resolve the code + barcode for a NEW product: honour what was typed,
 * auto-issue the rest from the per-kind sequence.
 */
async function resolveNewIdentity(kind: ProductKind, body: any) {
  const generated = await nextProductIdentity(pool, kind);
  return {
    itemCode: trimOrNull(body.itemCode) ?? generated.itemCode,
    barcode: trimOrNull(body.barcode) ?? generated.barcode,
    status: isProductStatus(body.status) ? body.status : "active",
  };
}

// ── Shared helpers ─────────────────────────────────────────────────────────
const fmtMaterial = (r: any) => ({
  id: r.id, name: r.name, unit: r.unit, description: r.description,
  currentStock: Number(r.current_stock), hsnCode: r.hsn_code || '',
  taxRate: Number(r.tax_rate || 0),
  // cost is NOT accepted on creation/edit — it is derived from weighted-avg purchase price
  cost: Number(r.avg_cost || r.cost || 0),
  avgCost: Number(r.avg_cost || 0),
  mrp: Number(r.mrp || 0),
  itemCode: r.item_code || '', barcode: r.barcode || '',
  status: r.status || 'active',
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const fmtItem = (r: any) => ({
  id: r.id, name: r.name, hsnCode: r.hsn_code, taxRate: Number(r.tax_rate),
  unit: r.unit, description: r.description,
  // `items.production_stock` is a retired counter: sales never decremented it,
  // so it drifted to a fraction of reality. Read queries supply `derived_stock`
  // computed from the stock truth; create/update responses fall back to the
  // column, which is correct there because a new item holds no stock yet.
  productionStock: Number(r.derived_stock ?? r.production_stock ?? 0),
  mrp: Number(r.mrp || 0),
  cost: Number(r.cost || 0),
  reorderLevel: Number(r.reorder_level ?? 10), avgCost: Number(r.avg_cost || 0),
  itemCode: r.item_code || '', barcode: r.barcode || '',
  status: r.status || 'active',
  createdAt: r.created_at, updatedAt: r.updated_at,
});

// ── Materials ─────────────────────────────────────────────────────────────
// Fills item/material pickers on Item Master, Production, Purchases, Transfers.
router.get("/materials", requireModuleView(["page:/production/item-master", "page:/production/production", "page:/production/purchase", "page:/transfers"]), async (req, res): Promise<void> => {
  const filter = statusFilter(req, res);
  if (!filter) return;
  const result = await pool.query(
    `SELECT id, name, unit, description, current_stock, hsn_code, tax_rate, cost, avg_cost, mrp,
            item_code, barcode, status, created_at, updated_at
       FROM materials${filter.sql} ORDER BY id`, filter.params
  );
  res.json(result.rows.map(fmtMaterial));
});

router.post("/materials", hoOnly, requireModuleAction("page:/production/item-master", "add"), async (req, res): Promise<void> => {
  // cost intentionally excluded — auto-derived from weighted-avg purchase price
  const { name, unit, description, hsnCode, taxRate, mrp } = req.body;
  if (!name || !unit) { res.status(400).json({ error: "name and unit are required" }); return; }
  if (slabViolation(taxRate, res)) return;
  if (identityViolation(req.body, res)) return;
  const ident = await resolveNewIdentity("material", req.body);
  await handleWrite(res, async () => {
    const result = await pool.query(
      `INSERT INTO materials (name, unit, description, hsn_code, tax_rate, mrp, item_code, barcode, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, unit, description || null, hsnCode || '', Number(taxRate ?? 0), Number(mrp ?? 0),
       ident.itemCode, ident.barcode, ident.status]
    );
    res.status(201).json(fmtMaterial(result.rows[0]));
  });
});

router.get("/materials/:id", requireModuleView("page:/production/item-master"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const result = await pool.query(`SELECT * FROM materials WHERE id = $1 LIMIT 1`, [id]);
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtMaterial(result.rows[0]));
});

router.patch("/materials/:id", hoOnly, requireModuleAction("page:/production/item-master", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  // cost intentionally excluded — managed by purchase weighted-avg, not manual entry
  const { name, unit, description, hsnCode, taxRate, mrp } = req.body;
  if (slabViolation(taxRate, res)) return;
  if (identityViolation(req.body, res)) return;
  await handleWrite(res, async () => {
    const result = await pool.query(
      `UPDATE materials SET
        name = COALESCE($1, name),
        unit = COALESCE($2, unit),
        description = COALESCE($3, description),
        hsn_code = COALESCE($4, hsn_code),
        tax_rate = COALESCE($5, tax_rate),
        mrp = COALESCE($6, mrp),
        item_code = COALESCE($8, item_code),
        barcode = COALESCE($9, barcode),
        status = COALESCE($10, status),
        updated_at = now()
       WHERE id = $7 RETURNING *`,
      [name ?? null, unit ?? null, description ?? null, hsnCode ?? null,
       taxRate != null ? Number(taxRate) : null,
       mrp != null ? Number(mrp) : null, id,
       trimOrNull(req.body.itemCode), trimOrNull(req.body.barcode),
       isProductStatus(req.body.status) ? req.body.status : null]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(fmtMaterial(result.rows[0]));
  });
});

router.delete("/materials/:id", hoOnly, requireModuleAction("page:/production/item-master", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await pool.query(`DELETE FROM materials WHERE id = $1`, [id]);
  res.status(204).send();
});

// ── Raw Materials ──────────────────────────────────────────────────────────
// Fills item/material pickers on Item Master, Production, Purchases, Transfers.
router.get("/raw-materials", requireModuleView(["page:/production/item-master", "page:/production/production", "page:/production/purchase", "page:/transfers"]), async (req, res): Promise<void> => {
  const filter = statusFilter(req, res);
  if (!filter) return;
  const result = await pool.query(
    // avg_cost must be selected: fmtMaterial derives the usable cost from it,
    // and the packing-material `cost` column is left at 0 (purchases only roll avg_cost).
    `SELECT id, name, unit, description, current_stock, hsn_code, tax_rate, cost, avg_cost, mrp,
            item_code, barcode, status, created_at, updated_at
       FROM raw_materials${filter.sql} ORDER BY id`, filter.params
  );
  res.json(result.rows.map(fmtMaterial));
});

router.post("/raw-materials", hoOnly, requireModuleAction("page:/production/item-master", "add"), async (req, res): Promise<void> => {
  const { name, unit, description, hsnCode, taxRate, cost, mrp } = req.body;
  if (!name || !unit) { res.status(400).json({ error: "name and unit are required" }); return; }
  if (slabViolation(taxRate, res)) return;
  if (identityViolation(req.body, res)) return;
  const ident = await resolveNewIdentity("raw_material", req.body);
  await handleWrite(res, async () => {
    const result = await pool.query(
      `INSERT INTO raw_materials (name, unit, description, hsn_code, tax_rate, cost, mrp, item_code, barcode, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, unit, description || null, hsnCode || '', Number(taxRate ?? 0), Number(cost ?? 0), Number(mrp ?? 0),
       ident.itemCode, ident.barcode, ident.status]
    );
    res.status(201).json(fmtMaterial(result.rows[0]));
  });
});

router.get("/raw-materials/:id", requireModuleView("page:/production/item-master"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const result = await pool.query(`SELECT * FROM raw_materials WHERE id = $1 LIMIT 1`, [id]);
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtMaterial(result.rows[0]));
});

router.patch("/raw-materials/:id", hoOnly, requireModuleAction("page:/production/item-master", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { name, unit, description, hsnCode, taxRate, cost, mrp } = req.body;
  if (slabViolation(taxRate, res)) return;
  if (identityViolation(req.body, res)) return;
  await handleWrite(res, async () => {
    const result = await pool.query(
      `UPDATE raw_materials SET
        name = COALESCE($1, name),
        unit = COALESCE($2, unit),
        description = COALESCE($3, description),
        hsn_code = COALESCE($4, hsn_code),
        tax_rate = COALESCE($5, tax_rate),
        cost = COALESCE($6, cost),
        mrp = COALESCE($7, mrp),
        item_code = COALESCE($9, item_code),
        barcode = COALESCE($10, barcode),
        status = COALESCE($11, status),
        updated_at = now()
       WHERE id = $8 RETURNING *`,
      [name ?? null, unit ?? null, description ?? null, hsnCode ?? null,
       taxRate != null ? Number(taxRate) : null, cost != null ? Number(cost) : null,
       mrp != null ? Number(mrp) : null, id,
       trimOrNull(req.body.itemCode), trimOrNull(req.body.barcode),
       isProductStatus(req.body.status) ? req.body.status : null]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(fmtMaterial(result.rows[0]));
  });
});

router.delete("/raw-materials/:id", hoOnly, requireModuleAction("page:/production/item-master", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  await pool.query(`DELETE FROM raw_materials WHERE id = $1`, [id]);
  res.status(204).send();
});

// ── Items (Finished SKUs) ──────────────────────────────────────────────────
// Fills item pickers across Item Master, Production, Purchases, Item Prices,
// HO Sales (POS), Returns, Stock and Transfers.
router.get("/items", requireModuleView(["page:/production/item-master", "page:/production/production", "page:/production/purchase", "page:/headoffice/item-price", "page:/sales/pos", "page:/returns", "page:/headoffice/stock", "page:/transfers"]), async (req, res): Promise<void> => {
  const filter = statusFilter(req, res);
  if (!filter) return;
  const result = await pool.query(
    `SELECT id, name, hsn_code, tax_rate, unit, description, production_stock, mrp, cost, reorder_level, avg_cost,
            item_code, barcode, status, created_at, updated_at,
            COALESCE((SELECT SUM(se.quantity::numeric) FROM stock_entries se
                       WHERE se.item_id = items.id AND se.material_type = 'item'), 0)::float AS derived_stock
       FROM items${filter.sql} ORDER BY id`, filter.params
  );
  res.json(result.rows.map(fmtItem));
});

router.post("/items", hoOnly, requireModuleAction("page:/production/item-master", "add"), async (req, res): Promise<void> => {
  const { name, hsnCode, taxRate, unit, description, cost, reorderLevel, mrp } = req.body;
  if (!name || !unit) { res.status(400).json({ error: "name and unit are required" }); return; }
  if (slabViolation(taxRate, res)) return;
  if (identityViolation(req.body, res)) return;
  const ident = await resolveNewIdentity("item", req.body);
  await handleWrite(res, async () => {
    const result = await pool.query(
      `INSERT INTO items (name, hsn_code, tax_rate, unit, description, cost, reorder_level, mrp, item_code, barcode, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, hsnCode || '', Number(taxRate ?? 0), unit, description || null, Number(cost ?? 0),
       Number(reorderLevel ?? 10), Number(mrp ?? 0), ident.itemCode, ident.barcode, ident.status]
    );
    res.status(201).json(fmtItem(result.rows[0]));
  });
});

router.get("/items/:id", requireModuleView("page:/production/item-master"), async (req, res): Promise<void> => {
  const { id: rawId } = GetItemParams.parse(req.params);
  const result = await pool.query(
    `SELECT items.*,
            COALESCE((SELECT SUM(se.quantity::numeric) FROM stock_entries se
                       WHERE se.item_id = items.id AND se.material_type = 'item'), 0)::float AS derived_stock
       FROM items WHERE id = $1 LIMIT 1`, [rawId]);
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtItem(result.rows[0]));
});

router.patch("/items/:id", hoOnly, requireModuleAction("page:/production/item-master", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { name, hsnCode, taxRate, unit, description, cost, reorderLevel, mrp } = req.body;
  if (slabViolation(taxRate, res)) return;
  if (identityViolation(req.body, res)) return;
  await handleWrite(res, async () => {
    const result = await pool.query(
      `UPDATE items SET
        name = COALESCE($1, name),
        hsn_code = COALESCE($2, hsn_code),
        tax_rate = COALESCE($3, tax_rate),
        unit = COALESCE($4, unit),
        description = COALESCE($5, description),
        cost = COALESCE($6, cost),
        reorder_level = COALESCE($7, reorder_level),
        mrp = COALESCE($8, mrp),
        item_code = COALESCE($10, item_code),
        barcode = COALESCE($11, barcode),
        status = COALESCE($12, status),
        updated_at = now()
       WHERE id = $9 RETURNING *`,
      [name ?? null, hsnCode ?? null, taxRate != null ? Number(taxRate) : null,
       unit ?? null, description ?? null,
       cost != null ? Number(cost) : null,
       reorderLevel != null ? Number(reorderLevel) : null,
       mrp != null ? Number(mrp) : null, id,
       trimOrNull(req.body.itemCode), trimOrNull(req.body.barcode),
       isProductStatus(req.body.status) ? req.body.status : null]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(fmtItem(result.rows[0]));
  });
});

router.delete("/items/:id", hoOnly, requireModuleAction("page:/production/item-master", "delete"), async (req, res): Promise<void> => {
  const { id } = DeleteItemParams.parse(req.params);
  await db.delete(itemsTable).where(eq(itemsTable.id, id));
  res.status(204).send();
});

// ── Assets (Fixed-asset master) ────────────────────────────────────────────
// Assets are NOT sale inventory: they live in their OWN `assets` table and are
// never pushed through stock_entries/stock_batches, so no stock/POS/production/
// transfer query can ever pick one up (those all scope by material_type on the
// polymorphic stock tables, which assets never write to). Surfaced in Item
// Master as another type; company-wide master, so Head-Office-only to write.
const fmtAsset = (r: any) => ({
  id: r.id,
  name: r.name,
  unit: r.unit,
  description: r.description ?? "",
  itemCode: r.item_code || "",
  status: r.status || "active",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

router.get("/assets", requireModuleView(["page:/production/item-master", "page:/production/purchase"]), async (req, res): Promise<void> => {
  const filter = statusFilter(req, res);
  if (!filter) return;
  const result = await pool.query(
    `SELECT id, name, unit, description, item_code, status, created_at, updated_at
       FROM assets${filter.sql} ORDER BY id`, filter.params,
  );
  res.json(result.rows.map(fmtAsset));
});

router.post("/assets", hoOnly, requireModuleAction("page:/production/item-master", "add"), async (req, res): Promise<void> => {
  // No MRP/GST/HSN/selling price — assets are capital items, not sale inventory.
  const { name, unit, description } = req.body;
  if (!name || !unit) { res.status(400).json({ error: "name and unit are required" }); return; }
  const itemCode = trimOrNull(req.body.itemCode);
  const codeErr = identifierError(itemCode, "Asset code", 32);
  if (codeErr) { res.status(400).json({ error: codeErr }); return; }
  if (req.body.status != null && req.body.status !== "" && !isProductStatus(req.body.status)) {
    res.status(400).json({ error: `Status must be one of: ${PRODUCT_STATUSES.join(", ")}` }); return;
  }
  const status = isProductStatus(req.body.status) ? req.body.status : "active";
  await handleWrite(res, async () => {
    const result = await pool.query(
      `INSERT INTO assets (name, unit, description, item_code, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, unit, description || null, itemCode, status],
    );
    logActivity({
      action: "CREATE", module: "inventory", entityType: "asset", entityId: result.rows[0].id,
      description: `New asset "${name}" created`,
      metadata: { after: { name, unit, itemCode, status } },
    }).catch(() => {});
    res.status(201).json(fmtAsset(result.rows[0]));
  });
});

router.get("/assets/:id", requireModuleView(["page:/production/item-master", "page:/production/purchase"]), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const result = await pool.query(`SELECT * FROM assets WHERE id = $1 LIMIT 1`, [id]);
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmtAsset(result.rows[0]));
});

router.patch("/assets/:id", hoOnly, requireModuleAction("page:/production/item-master", "edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { name, unit, description } = req.body;
  const itemCode = trimOrNull(req.body.itemCode);
  const codeErr = identifierError(itemCode, "Asset code", 32);
  if (codeErr) { res.status(400).json({ error: codeErr }); return; }
  if (req.body.status != null && req.body.status !== "" && !isProductStatus(req.body.status)) {
    res.status(400).json({ error: `Status must be one of: ${PRODUCT_STATUSES.join(", ")}` }); return;
  }
  await handleWrite(res, async () => {
    const result = await pool.query(
      `UPDATE assets SET
         name = COALESCE($1, name),
         unit = COALESCE($2, unit),
         description = COALESCE($3, description),
         item_code = COALESCE($5, item_code),
         status = COALESCE($6, status),
         updated_at = now()
       WHERE id = $4 RETURNING *`,
      [name ?? null, unit ?? null, description ?? null, id, itemCode,
       isProductStatus(req.body.status) ? req.body.status : null],
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(fmtAsset(result.rows[0]));
  });
});

router.delete("/assets/:id", hoOnly, requireModuleAction("page:/production/item-master", "delete"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  // An asset that has been purchased carries capitalised value on the books;
  // the FK is ON DELETE RESTRICT, so refuse rather than orphan the acquisition.
  try {
    await pool.query(`DELETE FROM assets WHERE id = $1`, [id]);
  } catch (e: any) {
    if (e?.code === "23503") {
      res.status(409).json({ error: "This asset has purchase records and cannot be deleted. Mark it inactive instead." });
      return;
    }
    throw e;
  }
  logActivity({
    action: "DELETE", module: "inventory", entityType: "asset", entityId: id,
    description: `Asset #${id} deleted`,
  }).catch(() => {});
  res.status(204).send();
});

export default router;
