/**
 * Opening Stock import — one document per (batch, location), modeled on the
 * physical stock-verification path so the movement reaches every stock
 * surface the same way a counted adjustment does:
 *
 *   - stock_entries credited (the quantity truth),
 *   - items.production_stock kept in sync at Head Office,
 *   - an auditable OPN- lot per line (creditBatch, source 'adjustment'),
 *   - weighted-average cost folded in when the file carries a rate,
 *   - a stock_ledger trail dated on the OPENING date from the file
 *     (Closing(D) = Opening(D+1) — see stock-ledger),
 *   - anchored on a stock_verifications row so rollback knows exactly what
 *     the batch created.
 *
 * Quantities are ADDITIVE inbound (never an absolute set): opening stock is
 * "what the old ERP handed over", and silently zeroing stock that already
 * exists here would be a destructive surprise.
 *
 * Runs entirely on the CALLER's client inside a SAVEPOINT — the demo import
 * and the all-or-nothing production commit both own the outer transaction.
 */
import { type PgPoolClient as PoolClient } from "@workspace/db";
import { creditBatch, debitBatchByNumber, updateAvgCostOnInbound, updateAvgCostOnReversal, inboundCostForItem } from "./batches";
import { writeStockLedger, batchResolveMeta } from "./stockLedger";
import { productBatchIdentity } from "./productIdentity";
import { buildBranchMaps } from "../routes/stock";
import { type ProdLocation, locationLabel } from "./productionCosting";

const r3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

export interface OpeningStockLine {
  itemId: number;
  quantity: number;
  /** GST-exclusive unit cost from the file; absent → the item's current
   *  inbound cost (avg cost, falling back to master cost). */
  unitCost?: number | null;
}

export interface OpeningStockDocInput {
  /** Business date the opening balances are AS OF. */
  openingDate: string; // YYYY-MM-DD
  lines: OpeningStockLine[];
  loc: ProdLocation;
  user: string;
  notes?: string | null;
}

export interface ImportedOpeningStockResult {
  verificationId: number;
  lines: Array<{ itemId: number; quantity: number; unitCost: number }>;
}

export async function importOpeningStockDoc(
  client: PoolClient,
  doc: OpeningStockDocInput,
): Promise<ImportedOpeningStockResult> {
  const loc = doc.loc;
  // Stock convention: HO rows carry branch_id 1 (see ho-location-convention).
  const branchId = loc.type === "headoffice" ? 1 : loc.id;

  try {
    await client.query("SAVEPOINT import_doc");

    const { rows: [verif] } = await client.query(
      `INSERT INTO stock_verifications (branch_type, branch_id, verify_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [loc.type, branchId, doc.openingDate,
       doc.notes ?? "Opening stock imported from old ERP", doc.user],
    );
    const verifId = Number(verif.id);

    const [ledgerMeta, branchNameOf] = await Promise.all([
      batchResolveMeta(client, doc.lines.map((l) => ({ materialType: "item" as const, refId: l.itemId }))),
      buildBranchMaps(),
    ]);

    const outLines: Array<{ itemId: number; quantity: number; unitCost: number }> = [];
    const ledgerEntries: Array<Record<string, unknown>> = [];

    // Ascending item id — the codebase's stable lock order.
    for (const l of [...doc.lines].sort((a, b) => a.itemId - b.itemId)) {
      const itemId = Number(l.itemId);
      const qty = r3(Number(l.quantity));
      if (!(qty > 0)) throw new Error(`Item #${itemId}: opening quantity must be positive.`);
      const m = ledgerMeta.get(`item:${itemId}`);
      if (!m) throw new Error(`Item #${itemId} no longer exists — re-validate the batch.`);

      const unitCost = l.unitCost != null && Number(l.unitCost) > 0
        ? Number(l.unitCost)
        : await inboundCostForItem(client, itemId);

      const { rows: [se] } = await client.query(
        `SELECT id FROM stock_entries
          WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3
          LIMIT 1 FOR UPDATE`,
        [itemId, loc.type, branchId],
      );
      if (se) {
        await client.query(
          `UPDATE stock_entries SET quantity = quantity::numeric + $1, updated_at = now() WHERE id = $2`,
          [qty, se.id],
        );
      } else {
        await client.query(
          `INSERT INTO stock_entries (item_id, material_type, branch_type, branch_id, quantity, cost_price)
           VALUES ($1, 'item', $2, $3, $4, $5)`,
          [itemId, loc.type, branchId, qty, unitCost],
        );
      }
      if (loc.type === "headoffice") {
        await client.query(
          `UPDATE items SET production_stock = production_stock::numeric + $1, updated_at = now() WHERE id = $2`,
          [qty, itemId],
        );
      }
      await updateAvgCostOnInbound(client, itemId, qty, unitCost);
      await creditBatch(client, {
        itemId, materialType: "item", branchType: loc.type, branchId,
        batchNumber: `OPN-${verifId}`, mfgDate: null, expiryDate: null,
        quantity: qty, unitCost,
        source: "adjustment", sourceId: verifId,
        ...(await productBatchIdentity(client, "item", itemId)),
      });

      ledgerEntries.push({
        txnType: "adjustment", materialType: "item", refId: itemId,
        itemName: m.name ?? "", unit: m.unit ?? "",
        branchType: loc.type, branchId, branchName: branchNameOf(loc.type, branchId),
        qtyChange: qty, unitCost,
        docType: "stock_verification", docId: verifId,
        txnDate: doc.openingDate,
        notes: "Opening stock (imported from old ERP)",
      });
      outLines.push({ itemId, quantity: qty, unitCost });
    }

    await client.query(
      `UPDATE stock_verifications SET lines = $1 WHERE id = $2`,
      [JSON.stringify(outLines.map((ol) => ({
        itemId: ol.itemId, countedQty: ol.quantity, systemQty: 0,
        variance: ol.quantity, reason: "count_correction",
      }))), verifId],
    );
    await writeStockLedger(client, ledgerEntries as any);

    await client.query("RELEASE SAVEPOINT import_doc");
    return { verificationId: verifId, lines: outLines };
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT import_doc").catch(() => {});
    throw e;
  }
}

/**
 * Reversal-equivalent rollback, inside the CALLER's transaction. Returns a
 * blocking reason, or null when fully reversed — same contract as
 * rollbackImportedSale/Purchase.
 */
export async function rollbackImportedOpeningStock(
  client: PoolClient,
  verificationId: number,
): Promise<string | null> {
  const { rows: [verif] } = await client.query(
    `SELECT id, branch_type, branch_id, lines,
            to_char(verify_date, 'YYYY-MM-DD') AS verify_date
       FROM stock_verifications WHERE id = $1 FOR UPDATE`,
    [verificationId],
  );
  if (!verif) return null; // already gone
  const branchType = String(verif.branch_type);
  const branchId = Number(verif.branch_id);
  const lines = (verif.lines ?? []) as Array<{ itemId: number; countedQty: number }>;
  const batchNumber = `OPN-${verificationId}`;

  // The opening lots must still be intact — stock a sale, production run or
  // transfer has drawn from cannot be silently un-imported.
  for (const l of lines) {
    const { rows: [lot] } = await client.query(
      `SELECT quantity::numeric AS quantity FROM stock_batches
        WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3 AND batch_number = $4
        FOR UPDATE`,
      [l.itemId, branchType, branchId, batchNumber],
    );
    if (!lot || Number(lot.quantity) + 0.0005 < Number(l.countedQty)) {
      return `opening stock for item #${l.itemId} has since been used (lot ${batchNumber}) — reverse that activity first`;
    }
  }

  const meta = await batchResolveMeta(client, lines.map((l) => ({ materialType: "item" as const, refId: l.itemId })));
  const branchNameOf = await buildBranchMaps();
  const ledgerEntries: Array<Record<string, unknown>> = [];

  for (const l of [...lines].sort((a, b) => Number(a.itemId) - Number(b.itemId))) {
    const itemId = Number(l.itemId);
    const qty = Number(l.countedQty);
    // Cost first — the unwind derives the prior average from totals as they
    // stand right now (same ordering as the purchase rollback).
    const { rows: [lot] } = await client.query(
      `SELECT unit_cost::numeric AS unit_cost FROM stock_batches
        WHERE item_id = $1 AND material_type = 'item' AND branch_type = $2 AND branch_id = $3 AND batch_number = $4`,
      [itemId, branchType, branchId, batchNumber],
    );
    const cost = Number(lot?.unit_cost ?? 0);
    await updateAvgCostOnReversal(client, itemId, qty, cost);
    if (branchType === "headoffice") {
      await client.query(
        `UPDATE items SET production_stock = GREATEST(0, production_stock::numeric - $1), updated_at = now() WHERE id = $2`,
        [qty, itemId],
      );
    }
    await client.query(
      `UPDATE stock_entries SET quantity = GREATEST(0, quantity::numeric - $1), updated_at = now()
        WHERE item_id = $2 AND material_type = 'item' AND branch_type = $3 AND branch_id = $4`,
      [qty, itemId, branchType, branchId],
    );
    await debitBatchByNumber(client, {
      itemId, materialType: "item", branchType, branchId, batchNumber, quantity: qty,
    });
    const m = meta.get(`item:${itemId}`);
    ledgerEntries.push({
      txnType: "adjustment", materialType: "item", refId: itemId,
      itemName: m?.name ?? "", unit: m?.unit ?? "",
      branchType, branchId, branchName: branchNameOf(branchType, branchId),
      qtyChange: -qty, unitCost: cost,
      docType: "stock_verification", docId: verificationId,
      // Dated on the opening date: rollback must read, on any report date,
      // as if the import never happened.
      txnDate: String(verif.verify_date ?? "") || null,
      notes: "Opening stock import rolled back",
    });
  }

  await client.query(
    `DELETE FROM stock_batches
      WHERE source = 'adjustment' AND source_id = $1 AND batch_number = $2
        AND branch_type = $3 AND branch_id = $4 AND quantity::numeric <= 0.0005`,
    [verificationId, batchNumber, branchType, branchId],
  );
  await writeStockLedger(client, ledgerEntries as any);
  await client.query(`DELETE FROM stock_verifications WHERE id = $1`, [verificationId]);
  return null;
}
