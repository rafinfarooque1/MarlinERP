import { Router } from "express";
import { db, customersTable, vendorsTable, couponsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { pool } from "@workspace/db";
import {
  CreateCouponBody, UpdateCouponBody, DeleteCouponParams,
} from "@workspace/api-zod";

const router = Router();

// ── Field allowlists (bypass restrictive auto-generated schemas) ───────────
// These include `state` and all fields present in the DB schema.

const CUSTOMER_FIELDS = ['name', 'phone', 'email', 'address', 'gstNumber', 'state', 'notes'] as const;
const VENDOR_FIELDS = ['name', 'phone', 'email', 'address', 'gstNumber', 'state', 'bankName', 'accountNumber'] as const;

type StrRecord = Record<string, any>;

function pickCustomer(body: StrRecord): StrRecord {
  const r: StrRecord = {};
  for (const k of CUSTOMER_FIELDS) { if (k in body) r[k] = body[k]; }
  return r;
}

function pickVendor(body: StrRecord): StrRecord {
  const r: StrRecord = {};
  for (const k of VENDOR_FIELDS) { if (k in body) r[k] = body[k]; }
  return r;
}

// ── Customers ─────────────────────────────────────────────────────────────
router.get("/customers", async (_req, res): Promise<void> => {
  const rows = await db.select().from(customersTable).orderBy(customersTable.id);
  res.json(rows.map((r) => ({ ...r, totalPurchases: Number(r.totalPurchases) })));
});

router.post("/customers", async (req, res): Promise<void> => {
  const data = pickCustomer(req.body);
  if (!data.name || typeof data.name !== 'string') {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const [row] = await db.insert(customersTable).values(data).returning();

  // Auto-create a debtor ledger under Sundry Debtors
  try {
    const { rows: [parent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'SYS-DEBTORS'`);
    if (parent) {
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, 'asset', $2, 'balance_sheet', $3, false, $4
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
        [row.name, `CUST-${row.id}`, parent.id, `Customer ledger — ${row.name}`],
      );
    }
  } catch { /* non-fatal — ledger can be created manually */ }

  res.status(201).json({ ...row, totalPurchases: Number(row.totalPurchases) });
});

router.get("/customers/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, totalPurchases: Number(row.totalPurchases) });
});

router.patch("/customers/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const data = pickCustomer(req.body);
  if (Object.keys(data).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }
  const [row] = await db.update(customersTable).set(data).where(eq(customersTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, totalPurchases: Number(row.totalPurchases) });
});

// ── Vendors ────────────────────────────────────────────────────────────────
router.get("/vendors", async (_req, res): Promise<void> => {
  const rows = await db.select().from(vendorsTable).orderBy(vendorsTable.id);
  res.json(rows);
});

router.post("/vendors", async (req, res): Promise<void> => {
  const data = pickVendor(req.body);
  if (!data.name || typeof data.name !== 'string') {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const [row] = await db.insert(vendorsTable).values(data).returning();

  // Auto-create a creditor ledger under Sundry Creditors
  try {
    const { rows: [parent] } = await pool.query(`SELECT id FROM account_ledgers WHERE code = 'SYS-CREDITORS'`);
    if (parent) {
      await pool.query(
        `INSERT INTO account_ledgers (name, type, code, section, parent_id, is_system_group, description)
         SELECT $1, 'liability', $2, 'balance_sheet', $3, false, $4
         WHERE NOT EXISTS (SELECT 1 FROM account_ledgers WHERE code = $2)`,
        [row.name, `VEND-${row.id}`, parent.id, `Vendor ledger — ${row.name}`],
      );
    }
  } catch { /* non-fatal */ }

  res.status(201).json(row);
});

router.get("/vendors/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [row] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, id)).limit(1);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.patch("/vendors/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const data = pickVendor(req.body);
  if (Object.keys(data).length === 0) { res.status(400).json({ error: "No valid fields to update" }); return; }
  const [row] = await db.update(vendorsTable).set(data).where(eq(vendorsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

// ── Customer ledger (sales history as Dr/Cr statement) ────────────────────
router.get("/customers/:id/ledger", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query<any>(
    `SELECT
       s.id,
       s.invoice_number,
       s.sale_date,
       s.total_amount,
       s.payment_status,
       s.amount_paid,
       (s.total_amount - s.amount_paid) AS balance_due
     FROM sales s
     WHERE s.customer_id = $1
     ORDER BY s.sale_date ASC, s.id ASC`,
    [id],
  );

  let running = 0;
  const entries = rows.map((r: any) => {
    const debit = Number(r.total_amount);
    running += debit;
    return {
      date: r.sale_date,
      description: r.invoice_number ?? `Sale #${r.id}`,
      entryType: 'sale',
      debit,
      credit: 0,
      balance: running,
      paymentStatus: r.payment_status,
    };
  });

  const totalBilled = rows.reduce((s: number, r: any) => s + Number(r.total_amount), 0);
  const totalPaid   = rows.reduce((s: number, r: any) => s + Number(r.amount_paid), 0);

  res.json({ balance: totalBilled - totalPaid, totalBilled, totalPaid, entries });
});

// ── Vendor ledger (purchase history as Dr/Cr statement) ───────────────────
router.get("/vendors/:id/ledger", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await pool.query<any>(
    `SELECT
       p.id,
       p.invoice_number,
       p.purchase_date,
       p.total_amount
     FROM purchases p
     WHERE p.vendor_id = $1
     ORDER BY p.purchase_date ASC, p.id ASC`,
    [id],
  );

  let running = 0;
  const entries = rows.map((r: any) => {
    const credit = Number(r.total_amount);
    running += credit;
    return {
      date: r.purchase_date,
      description: r.invoice_number ? `Ref: ${r.invoice_number}` : `Purchase #${r.id}`,
      entryType: 'purchase',
      debit: 0,
      credit,
      balance: running,
    };
  });

  const totalPurchased = rows.reduce((s: number, r: any) => s + Number(r.total_amount), 0);
  res.json({ balance: totalPurchased, totalPurchased, entries });
});

// ── Coupons ────────────────────────────────────────────────────────────────
router.get("/coupons", async (_req, res): Promise<void> => {
  const rows = await db.select().from(couponsTable).orderBy(couponsTable.id);
  res.json(rows.map((r) => ({ ...r, discountValue: Number(r.discountValue) })));
});

router.post("/coupons", async (req, res): Promise<void> => {
  const parsed = CreateCouponBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + parsed.data.validDays);
  const [row] = await db.insert(couponsTable).values({
    ...parsed.data,
    discountValue: String(parsed.data.discountValue),
    expiryDate: expiryDate.toISOString().split("T")[0],
  }).returning();
  res.status(201).json({ ...row, discountValue: Number(row.discountValue) });
});

router.patch("/coupons/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const parsed = UpdateCouponBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const updateData: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.discountValue !== undefined) updateData.discountValue = String(parsed.data.discountValue);
  const [row] = await db.update(couponsTable).set(updateData).where(eq(couponsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...row, discountValue: Number(row.discountValue) });
});

router.delete("/coupons/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  await db.delete(couponsTable).where(eq(couponsTable.id, id));
  res.status(204).send();
});

export default router;
