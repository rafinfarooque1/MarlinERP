/**
 * Finished-item creation core — the ONE insert path shared by the manual
 * Item Master route (POST /items) and the ERP Migration Wizard (mapping-stage
 * "create new item" and the Item Master import module).
 *
 * Takes a Queryable so a caller that owns a transaction (the demo import runs
 * a whole batch in one never-committed transaction) creates the item INSIDE
 * it. Identity (item_code / barcode) comes from the shared per-kind sequence
 * via nextProductIdentity — never hand-rolled (see product-identity).
 */
import { pool } from "@workspace/db";
import { isValidGstSlab, gstSlabErrorMessage } from "./gst";
import { nextProductIdentity, isProductStatus, type Queryable } from "./productIdentity";

export interface ItemCreateInput {
  name: string;
  unit: string;
  hsnCode?: string | null;
  taxRate?: number | null;
  description?: string | null;
  cost?: number | null;
  reorderLevel?: number | null;
  mrp?: number | null;
  itemCode?: string | null;
  barcode?: string | null;
  status?: string | null;
}

const trimOrNull = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/** Validate the fields the same way the manual route does. Returns an error
 *  message or null. Callers turn it into their own 400/row-error shape. */
export function itemCreateError(input: ItemCreateInput): string | null {
  if (!String(input.name ?? "").trim() || !String(input.unit ?? "").trim()) {
    return "name and unit are required";
  }
  if (input.taxRate != null && !isValidGstSlab(input.taxRate)) {
    return gstSlabErrorMessage(input.taxRate);
  }
  const code = trimOrNull(input.itemCode);
  const barcode = trimOrNull(input.barcode);
  if (code && (/\s/.test(code) || code.length > 32)) return "Item code cannot contain spaces or exceed 32 characters";
  if (barcode && (/\s/.test(barcode) || barcode.length > 64)) return "Barcode cannot contain spaces or exceed 64 characters";
  return null;
}

/**
 * Insert the item row. Throws on invalid input (callers that already ran
 * itemCreateError never hit that) and lets 23505 unique violations
 * (duplicate code/barcode) propagate for the caller to translate.
 */
export async function createItemCore(
  q: Queryable,
  input: ItemCreateInput,
): Promise<{ id: number; itemCode: string; barcode: string; row: any }> {
  const err = itemCreateError(input);
  if (err) throw new Error(err);
  const generated = await nextProductIdentity(q, "item");
  const itemCode = trimOrNull(input.itemCode) ?? generated.itemCode;
  const barcode = trimOrNull(input.barcode) ?? generated.barcode;
  const status = isProductStatus(input.status) ? input.status : "active";
  const { rows: [row] } = await q.query(
    `INSERT INTO items (name, hsn_code, tax_rate, unit, description, cost, reorder_level, mrp, item_code, barcode, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [String(input.name).trim(), trimOrNull(input.hsnCode) ?? "", Number(input.taxRate ?? 0),
     String(input.unit).trim(), trimOrNull(input.description), Number(input.cost ?? 0),
     Number(input.reorderLevel ?? 10), Number(input.mrp ?? 0), itemCode, barcode, status],
  );
  return { id: Number(row.id), itemCode, barcode, row };
}
