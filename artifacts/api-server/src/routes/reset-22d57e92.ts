/**
 * TEMPORARY ONE-TIME DATA RESET ENDPOINT
 * DELETE THIS FILE after the reset is confirmed.
 * UUID in the path makes it unguessable from the outside.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router = Router();

router.post("/admin/reset-22d57e92-8524-41c7-894c-1dd447a273a6", async (req, res) => {
  try {
    // Truncate all user-data tables in one shot; CASCADE handles FK order,
    // RESTART IDENTITY resets all sequences back to 1.
    await db.execute(sql`
      TRUNCATE TABLE
        sales,
        purchases,
        productions,
        stock_transfers,
        stock_entries,
        raw_materials,
        attendance,
        leaves,
        payroll,
        pay_components,
        employees,
        permissions,
        bom_templates,
        item_prices,
        items,
        materials,
        customers,
        vendors,
        outlets,
        warehouses,
        hierarchies,
        coupons,
        account_ledgers,
        cash_bank_accounts,
        expenses,
        activity_log,
        company_settings
      RESTART IDENTITY CASCADE
    `);

    res.json({ ok: true, message: "All production data wiped. Fresh start." });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

export default router;
