import { Router } from "express";
import { db, pool, bomTemplatesTable, itemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logActivity } from "../lib/audit";

// ── Bill of Materials templates ──────────────────────────────────────────────
// One template per finished item (unique item_id). Line quantities are per
// ONE unit of finished output; the production form scales them by the batch's
// gross output (produced + wastage) to warn about over-consumption.

const router = Router();

type BomLine = { materialType: "material" | "raw_material"; materialId: number; quantity: number };

function validateLines(raw: unknown): { ok: true; lines: BomLine[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "BOM must have at least one material line" };
  }
  const lines: BomLine[] = [];
  const seen = new Set<string>();
  for (const l of raw as any[]) {
    const materialType = l?.materialType;
    const materialId = Number(l?.materialId);
    const quantity = Number(l?.quantity);
    if (materialType !== "material" && materialType !== "raw_material") {
      return { ok: false, error: "Each BOM line needs a materialType of 'material' or 'raw_material'" };
    }
    if (!Number.isInteger(materialId) || materialId <= 0) {
      return { ok: false, error: "Each BOM line needs a valid material" };
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, error: "Each BOM line needs a quantity greater than 0" };
    }
    const key = `${materialType}:${materialId}`;
    if (seen.has(key)) return { ok: false, error: "Duplicate material in BOM lines" };
    seen.add(key);
    lines.push({ materialType, materialId, quantity });
  }
  return { ok: true, lines };
}

router.get("/bom-templates", async (_req, res): Promise<void> => {
  const rows = await db.select().from(bomTemplatesTable).orderBy(bomTemplatesTable.id);
  const items = await db.select().from(itemsTable);
  const iMap = new Map(items.map((i) => [i.id, i.name]));
  res.json(rows.map((r) => ({ ...r, itemName: iMap.get(r.itemId) ?? `Item #${r.itemId}` })));
});

router.get("/bom-templates/item/:itemId", async (req, res): Promise<void> => {
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isFinite(itemId)) { res.status(400).json({ error: "Invalid item id" }); return; }
  const [row] = await db.select().from(bomTemplatesTable).where(eq(bomTemplatesTable.itemId, itemId)).limit(1);
  if (!row) { res.status(404).json({ error: "No BOM template for this item" }); return; }
  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, itemId)).limit(1);
  res.json({ ...row, itemName: item?.name ?? `Item #${itemId}` });
});

router.post("/bom-templates", async (req, res): Promise<void> => {
  const itemId = Number(req.body?.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) { res.status(400).json({ error: "itemId required" }); return; }
  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, itemId)).limit(1);
  if (!item) { res.status(404).json({ error: "Item not found" }); return; }

  const v = validateLines(req.body?.lines);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  const [existing] = await db.select().from(bomTemplatesTable).where(eq(bomTemplatesTable.itemId, itemId)).limit(1);
  if (existing) { res.status(409).json({ error: `A BOM template already exists for ${item.name}` }); return; }

  const notes = typeof req.body?.notes === "string" && req.body.notes.trim() ? req.body.notes.trim() : null;
  const [row] = await db.insert(bomTemplatesTable).values({ itemId, lines: v.lines, notes }).returning();

  logActivity({
    action: "CREATE", module: "production", entityType: "bom_template", entityId: row.id,
    description: `BOM template created for ${item.name} (${v.lines.length} materials per unit)`,
    metadata: { after: { itemId, itemName: item.name, lineCount: v.lines.length } },
  }).catch(() => {});

  res.status(201).json({ ...row, itemName: item.name });
});

router.put("/bom-templates/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [existing] = await db.select().from(bomTemplatesTable).where(eq(bomTemplatesTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "BOM template not found" }); return; }

  const updates: Record<string, unknown> = {};
  if (req.body?.lines !== undefined) {
    const v = validateLines(req.body.lines);
    if (!v.ok) { res.status(400).json({ error: v.error }); return; }
    updates.lines = v.lines;
  }
  if (req.body?.notes !== undefined) {
    updates.notes = typeof req.body.notes === "string" && req.body.notes.trim() ? req.body.notes.trim() : null;
  }
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

  const [row] = await db.update(bomTemplatesTable).set(updates).where(eq(bomTemplatesTable.id, id)).returning();
  const [item] = await db.select().from(itemsTable).where(eq(itemsTable.id, row.itemId)).limit(1);

  logActivity({
    action: "UPDATE", module: "production", entityType: "bom_template", entityId: id,
    description: `BOM template updated for ${item?.name ?? `Item #${row.itemId}`}`,
    metadata: { after: { itemId: row.itemId, lineCount: (row.lines as any[])?.length ?? 0 } },
  }).catch(() => {});

  res.json({ ...row, itemName: item?.name ?? `Item #${row.itemId}` });
});

router.delete("/bom-templates/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [existing] = await db.select().from(bomTemplatesTable).where(eq(bomTemplatesTable.id, id)).limit(1);
  if (!existing) { res.status(404).json({ error: "BOM template not found" }); return; }
  await db.delete(bomTemplatesTable).where(eq(bomTemplatesTable.id, id));

  logActivity({
    action: "DELETE", module: "production", entityType: "bom_template", entityId: id,
    description: `BOM template deleted for item #${existing.itemId}`,
    metadata: { before: { itemId: existing.itemId } },
  }).catch(() => {});

  res.json({ success: true });
});

export default router;
