import { Router } from "express";
import { db, bomTemplatesTable, itemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

// ── List all BOM templates ────────────────────────────────────────────────────

router.get("/bom-templates", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: bomTemplatesTable.id,
      itemId: bomTemplatesTable.itemId,
      itemName: itemsTable.name,
      lines: bomTemplatesTable.lines,
      notes: bomTemplatesTable.notes,
      createdAt: bomTemplatesTable.createdAt,
      updatedAt: bomTemplatesTable.updatedAt,
    })
    .from(bomTemplatesTable)
    .leftJoin(itemsTable, eq(bomTemplatesTable.itemId, itemsTable.id))
    .orderBy(itemsTable.name);

  res.json(rows.map(r => ({ ...r, lines: r.lines ?? [] })));
});

// ── Get BOM template by item ID ───────────────────────────────────────────────

router.get("/bom-templates/item/:itemId", async (req, res): Promise<void> => {
  const itemId = parseInt(req.params.itemId, 10);
  if (isNaN(itemId)) { res.status(400).json({ error: "Invalid itemId" }); return; }

  const [row] = await db
    .select({
      id: bomTemplatesTable.id,
      itemId: bomTemplatesTable.itemId,
      itemName: itemsTable.name,
      lines: bomTemplatesTable.lines,
      notes: bomTemplatesTable.notes,
    })
    .from(bomTemplatesTable)
    .leftJoin(itemsTable, eq(bomTemplatesTable.itemId, itemsTable.id))
    .where(eq(bomTemplatesTable.itemId, itemId))
    .limit(1);

  if (!row) { res.status(404).json({ error: "No BOM template for this item" }); return; }
  res.json({ ...row, lines: row.lines ?? [] });
});

// ── Create BOM template ───────────────────────────────────────────────────────

router.post("/bom-templates", async (req, res): Promise<void> => {
  const { itemId, lines, notes } = req.body;
  if (!itemId || !Array.isArray(lines)) {
    res.status(400).json({ error: "itemId and lines are required" });
    return;
  }

  // Upsert: if a template already exists for this item, update it
  const [existing] = await db
    .select({ id: bomTemplatesTable.id })
    .from(bomTemplatesTable)
    .where(eq(bomTemplatesTable.itemId, itemId))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(bomTemplatesTable)
      .set({ lines, notes: notes ?? null, updatedAt: new Date() })
      .where(eq(bomTemplatesTable.id, existing.id))
      .returning();
    res.status(200).json({ ...updated, lines: updated.lines ?? [] });
    return;
  }

  const [row] = await db
    .insert(bomTemplatesTable)
    .values({ itemId, lines, notes: notes ?? null })
    .returning();

  res.status(201).json({ ...row, lines: row.lines ?? [] });
});

// ── Update BOM template ───────────────────────────────────────────────────────

router.put("/bom-templates/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { lines, notes } = req.body;
  if (!Array.isArray(lines)) { res.status(400).json({ error: "lines must be an array" }); return; }

  const [row] = await db
    .update(bomTemplatesTable)
    .set({ lines, notes: notes ?? null, updatedAt: new Date() })
    .where(eq(bomTemplatesTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, lines: row.lines ?? [] });
});

// ── Delete BOM template ───────────────────────────────────────────────────────

router.delete("/bom-templates/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .delete(bomTemplatesTable)
    .where(eq(bomTemplatesTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ success: true });
});

export default router;
