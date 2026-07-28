/**
 * Identification and lifecycle status for the three product master tables.
 *
 *   items         → finished SKUs        (UI: "Item Name (SKU)")
 *   materials     → raw materials        (UI: "Raw Material")
 *   raw_materials → packing materials    (UI: "Packing Material")
 *
 * The tables stay separate and their id spaces OVERLAP FROM 1, so every helper
 * here carries the kind discriminator — the same one `stock_entries`,
 * `stock_batches` and `stock_ledger` use.
 *
 * `item_code`, `barcode` and `status` are added by the startup migration, which
 * makes them invisible to the Drizzle query builder: read and write them
 * through explicit SQL only, or they silently come back undefined.
 */

export type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

export type ProductKind = "item" | "material" | "raw_material";

export const PRODUCT_KINDS: readonly ProductKind[] = ["item", "material", "raw_material"] as const;

export const PRODUCT_TABLE: Record<ProductKind, string> = {
  item: "items",
  material: "materials",
  raw_material: "raw_materials",
};

/** What a user calls each kind — used in error messages, not in SQL. */
export const PRODUCT_LABEL: Record<ProductKind, string> = {
  item: "Item (SKU)",
  material: "Raw Material",
  raw_material: "Packing Material",
};

/**
 * Code prefixes follow the USER-FACING type, not the table name: the table
 * `materials` holds Raw Materials (RM) and `raw_materials` holds Packing
 * Materials (PM). Getting this backwards would print RM codes on packing film.
 */
export const CODE_PREFIX: Record<ProductKind, string> = {
  item: "FG",
  material: "RM",
  raw_material: "PM",
};

/** Second barcode digit, so a scan alone reveals which master table to read. */
const BARCODE_KIND_DIGIT: Record<ProductKind, string> = {
  item: "1",
  material: "2",
  raw_material: "3",
};

/** One sequence per kind, so FG/RM/PM numbering runs independently. */
const CODE_SEQUENCE: Record<ProductKind, string> = {
  item: "item_code_seq_item",
  material: "item_code_seq_material",
  raw_material: "item_code_seq_raw_material",
};

export const PRODUCT_STATUSES = ["active", "inactive"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const isProductKind = (v: unknown): v is ProductKind =>
  typeof v === "string" && (PRODUCT_KINDS as readonly string[]).includes(v);

export const isProductStatus = (v: unknown): v is ProductStatus =>
  typeof v === "string" && (PRODUCT_STATUSES as readonly string[]).includes(v);

/** EAN-13 mod-10 check digit over the first 12 digits. */
export function ean13CheckDigit(twelveDigits: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = twelveDigits.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * A real, scannable EAN-13 in the "restricted circulation / in-store" range:
 * leading 2, then the kind digit, then a 10-digit sequence, then the check
 * digit. The 2-prefix is reserved worldwide for internal use, so these can
 * never collide with a manufacturer's GTIN printed on bought-in packaging.
 */
export function buildBarcode(kind: ProductKind, seq: number): string {
  const body = `2${BARCODE_KIND_DIGIT[kind]}${String(seq).padStart(10, "0")}`;
  return body + ean13CheckDigit(body);
}

/** Human-readable code, e.g. FG-0007 / RM-0001 / PM-0001. */
export function buildItemCode(kind: ProductKind, seq: number): string {
  return `${CODE_PREFIX[kind]}-${String(seq).padStart(4, "0")}`;
}

/**
 * Reserve the next code + barcode for a new product of this kind.
 * `nextval` is transaction-safe and never reuses a number, so two concurrent
 * creations can't land on the same code even if one later rolls back.
 */
export async function nextProductIdentity(
  c: Queryable,
  kind: ProductKind,
): Promise<{ itemCode: string; barcode: string; seq: number }> {
  const { rows } = await c.query(`SELECT nextval($1::regclass)::bigint AS seq`, [CODE_SEQUENCE[kind]]);
  const seq = Number(rows[0]?.seq ?? 0);
  return { itemCode: buildItemCode(kind, seq), barcode: buildBarcode(kind, seq), seq };
}

/**
 * The parent product's identity, stamped onto every batch a purchase or a
 * production run creates so a scanned lot resolves to a price without a
 * second lookup. A zero MRP means "not priced yet" and is returned as null
 * rather than ₹0.00, which would read as a real price of nothing.
 */
export async function productBatchIdentity(
  c: Queryable,
  kind: ProductKind,
  productId: number,
): Promise<{ barcode: string | null; mrp: number | null }> {
  const { rows } = await c.query(
    `SELECT barcode, mrp FROM ${PRODUCT_TABLE[kind]} WHERE id = $1 LIMIT 1`,
    [productId],
  );
  const row = rows[0];
  if (!row) return { barcode: null, mrp: null };
  const mrp = Number(row.mrp ?? 0);
  return { barcode: row.barcode || null, mrp: mrp > 0 ? mrp : null };
}

export interface ProductRef {
  kind: ProductKind;
  id: number;
}

/**
 * Names of any discontinued products among `refs`.
 *
 * Used to keep inactive products out of NEW documents. Never call this on an
 * edit or approval path: historical documents must stay editable and reachable
 * even after the products on them are discontinued.
 */
export async function inactiveProductNames(c: Queryable, refs: ProductRef[]): Promise<string[]> {
  const byKind = new Map<ProductKind, Set<number>>();
  for (const ref of refs) {
    const id = Number(ref.id);
    if (!isProductKind(ref.kind) || !Number.isFinite(id) || id <= 0) continue;
    if (!byKind.has(ref.kind)) byKind.set(ref.kind, new Set());
    byKind.get(ref.kind)!.add(id);
  }

  const names: string[] = [];
  for (const [kind, ids] of byKind) {
    const { rows } = await c.query(
      `SELECT name, item_code FROM ${PRODUCT_TABLE[kind]}
        WHERE id = ANY($1::int[]) AND COALESCE(status, 'active') <> 'active'
        ORDER BY id`,
      [[...ids]],
    );
    for (const r of rows) names.push(r.item_code ? `${r.name} (${r.item_code})` : r.name);
  }
  return names;
}

export const INACTIVE_PRODUCT_CODE = "INACTIVE_PRODUCT";

/**
 * Guard for create routes: returns a ready-to-send error message when any
 * referenced product is discontinued, or null when every one is active.
 */
export async function blockedByInactiveProducts(
  c: Queryable,
  refs: ProductRef[],
): Promise<string | null> {
  const names = await inactiveProductNames(c, refs);
  if (names.length === 0) return null;
  const list = names.join(", ");
  return names.length === 1
    ? `${list} is marked inactive and cannot be used on a new entry. Reactivate it in Item Master first.`
    : `These items are marked inactive and cannot be used on a new entry: ${list}. Reactivate them in Item Master first.`;
}
