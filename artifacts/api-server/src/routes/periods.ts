/**
 * Accounting-period (month) locking — admin lock/unlock with full audit,
 * a pre-lock verification summary, and the locked-month list that both the
 * write-path guards (lib/periodLock.ts) and the frontend pre-checks read.
 *
 * Lock/unlock is ADMIN ONLY (hierarchy level 1 — the Administrator root).
 * Management (level 2) can view the page but never change lock state.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireModuleView } from "../middleware/permissions";
import { logActivity } from "../lib/audit";
import {
  isMonthLocked,
  listLockedMonths,
  monthLabel,
} from "../lib/periodLock";
import { buildDerivedPostings } from "./journal";
import { companyBalances, companyFinancials } from "../lib/dashboardFinancials";
import { closingStockValuation } from "../lib/valuation";

const router: IRouter = Router();

const username = (req: Request) => String((req as any).employee?.username ?? "system");

/** Admin = hierarchy level 1 exactly. Fails closed on a missing/unknown role. */
async function isAdmin(req: Request): Promise<boolean> {
  const hierarchyId = (req as any).employee?.hierarchyId ?? null;
  if (hierarchyId == null) return false;
  const { rows: [lvl] } = await pool.query<any>(
    `SELECT level FROM hierarchies WHERE id = $1`, [hierarchyId],
  );
  return lvl?.level != null && Number(lvl.level) === 1;
}

function parseYm(req: Request): { year: number; month: number } | null {
  const year = parseInt(String(req.params.year), 10);
  const month = parseInt(String(req.params.month), 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

// ── Locked-month list ────────────────────────────────────────────────────────
// Read by every signed-in client for pre-checks (the friendly "month is
// locked" message before a save is even attempted), so it is auth-only —
// the same convention as the hierarchies/permissions GETs. It leaks nothing
// beyond which months are frozen.
router.get("/accounting-periods/locks", async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await listLockedMonths(pool));
  } catch (err) {
    console.error("[periods] list locks failed:", err);
    res.status(500).json({ error: "Failed to load locked months" });
  }
});

// ── Lock/unlock history ──────────────────────────────────────────────────────
router.get(
  "/accounting-periods/events",
  requireModuleView("page:/accounts/periods"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);
      const { rows } = await pool.query(
        `SELECT id, year, month, action, username, reason, created_at
           FROM period_lock_events ORDER BY created_at DESC, id DESC LIMIT $1`,
        [limit],
      );
      res.json(rows.map((r: any) => ({
        id: Number(r.id),
        year: Number(r.year),
        month: Number(r.month),
        monthLabel: monthLabel(Number(r.year), Number(r.month)),
        action: String(r.action),
        username: String(r.username ?? ""),
        reason: r.reason == null ? null : String(r.reason),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })));
    } catch (err) {
      console.error("[periods] list events failed:", err);
      res.status(500).json({ error: "Failed to load period lock history" });
    }
  },
);

// ── Month-close verification summary ─────────────────────────────────────────
// Shown to the admin BEFORE locking (spec §16). Money figures for the month,
// balance-sheet positions as of month end, plus B2B/B2C invoice counts.
router.get(
  "/accounting-periods/:year/:month/summary",
  requireModuleView("page:/accounts/periods"),
  async (req: Request, res: Response): Promise<void> => {
    const ym = parseYm(req);
    if (!ym) { res.status(400).json({ error: "Invalid year/month" }); return; }
    try {
      const { year, month } = ym;
      const fromDate = `${year}-${String(month).padStart(2, "0")}-01`;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const toDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

      const [salesAgg, purchasesAgg, receiptsAgg, paymentsAgg, financials, balances, stock] =
        await Promise.all([
          // Real customer sales only — cross-GSTIN branch-transfer invoices are
          // stock movements, not revenue (they'd double the month's sales).
          pool.query(
            `SELECT COALESCE(SUM(total_amount), 0) AS total,
                    COALESCE(SUM(tax_total), 0) AS tax,
                    COUNT(*) FILTER (WHERE invoice_series = 'SB2B') AS b2b_count,
                    COUNT(*) FILTER (WHERE invoice_series = 'SB2C') AS b2c_count,
                    COUNT(*) FILTER (WHERE invoice_series IS DISTINCT FROM 'SB2B'
                                       AND invoice_series IS DISTINCT FROM 'SB2C') AS other_count,
                    COUNT(*) AS count
               FROM sales
              WHERE cancelled_at IS NULL AND branch_transfer_id IS NULL
                AND sale_date >= $1 AND sale_date <= $2`,
            [fromDate, toDate],
          ),
          pool.query(
            `SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS count
               FROM purchases
              WHERE branch_transfer_id IS NULL
                AND purchase_date >= $1 AND purchase_date <= $2`,
            [fromDate, toDate],
          ),
          pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
               FROM receipts WHERE receipt_date >= $1 AND receipt_date <= $2`,
            [fromDate, toDate],
          ),
          pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
               FROM payments WHERE payment_date >= $1 AND payment_date <= $2`,
            [fromDate, toDate],
          ),
          companyFinancials(buildDerivedPostings, { fromDate, toDate }),
          companyBalances(buildDerivedPostings, { toDate }),
          closingStockValuation(pool, {}),
        ]);

      const s = salesAgg.rows[0];
      res.json({
        year, month, monthLabel: monthLabel(year, month),
        fromDate, toDate,
        locked: await isMonthLocked(pool, year, month),
        totals: {
          sales: Number(s.total),
          salesCount: Number(s.count),
          purchases: Number(purchasesAgg.rows[0].total),
          purchasesCount: Number(purchasesAgg.rows[0].count),
          receipts: Number(receiptsAgg.rows[0].total),
          receiptsCount: Number(receiptsAgg.rows[0].count),
          payments: Number(paymentsAgg.rows[0].total),
          paymentsCount: Number(paymentsAgg.rows[0].count),
          expenses: financials.expenses.total,
          gstOnSales: Number(s.tax),
        },
        asOfMonthEnd: {
          receivables: balances.accountsReceivable,
          payables: balances.accountsPayable,
          cash: balances.cashBalance,
          bank: balances.bankBalance,
        },
        // Valuation is current-state (historical stock is not derivable) —
        // labelled as such in the UI.
        inventoryCurrentValue: stock.total,
        invoiceCounts: {
          b2b: Number(s.b2b_count),
          b2c: Number(s.b2c_count),
          other: Number(s.other_count),
        },
      });
    } catch (err) {
      console.error("[periods] summary failed:", err);
      res.status(500).json({ error: "Failed to build month summary" });
    }
  },
);

// ── Lock a month ─────────────────────────────────────────────────────────────
router.post(
  "/accounting-periods/:year/:month/lock",
  requireModuleView("page:/accounts/periods"),
  async (req: Request, res: Response): Promise<void> => {
    const ym = parseYm(req);
    if (!ym) { res.status(400).json({ error: "Invalid year/month" }); return; }
    if (!(await isAdmin(req))) {
      res.status(403).json({ error: "Only an Administrator can lock a month." });
      return;
    }
    if (req.body?.confirm !== true) {
      res.status(400).json({ error: "Locking a month requires explicit confirmation." });
      return;
    }
    const { year, month } = ym;
    // A future month cannot be locked — it would block day-to-day billing the
    // moment the calendar reaches it, with nothing in it to protect yet.
    const now = new Date();
    if (year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1)) {
      res.status(400).json({ error: "A future month cannot be locked." });
      return;
    }
    const user = username(req);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: inserted } = await client.query(
        `INSERT INTO accounting_period_locks (year, month, locked_by)
         VALUES ($1, $2, $3) ON CONFLICT (year, month) DO NOTHING RETURNING year`,
        [year, month, user],
      );
      if (inserted.length === 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: `${monthLabel(year, month)} is already locked.` });
        return;
      }
      await client.query(
        `INSERT INTO period_lock_events (year, month, action, username) VALUES ($1, $2, 'lock', $3)`,
        [year, month, user],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[periods] lock failed:", err);
      res.status(500).json({ error: "Failed to lock the month" });
      return;
    } finally {
      client.release();
    }
    logActivity({
      action: "UPDATE", module: "accounts", entityType: "accounting_period",
      description: `Locked accounting period ${monthLabel(year, month)}`,
      user, metadata: { year, month, action: "lock" },
    }).catch(() => {});
    res.json({ ok: true, year, month, status: "locked" });
  },
);

// ── Unlock a month ───────────────────────────────────────────────────────────
router.post(
  "/accounting-periods/:year/:month/unlock",
  requireModuleView("page:/accounts/periods"),
  async (req: Request, res: Response): Promise<void> => {
    const ym = parseYm(req);
    if (!ym) { res.status(400).json({ error: "Invalid year/month" }); return; }
    if (!(await isAdmin(req))) {
      res.status(403).json({ error: "Only an Administrator can unlock a month." });
      return;
    }
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) {
      res.status(400).json({ error: "A reason is required to unlock a month." });
      return;
    }
    if (req.body?.confirm !== true) {
      res.status(400).json({ error: "Unlocking a month requires explicit confirmation." });
      return;
    }
    const { year, month } = ym;
    const user = username(req);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: removed } = await client.query(
        `DELETE FROM accounting_period_locks WHERE year = $1 AND month = $2 RETURNING year`,
        [year, month],
      );
      if (removed.length === 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: `${monthLabel(year, month)} is not locked.` });
        return;
      }
      await client.query(
        `INSERT INTO period_lock_events (year, month, action, username, reason)
         VALUES ($1, $2, 'unlock', $3, $4)`,
        [year, month, user, reason],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[periods] unlock failed:", err);
      res.status(500).json({ error: "Failed to unlock the month" });
      return;
    } finally {
      client.release();
    }
    logActivity({
      action: "UPDATE", module: "accounts", entityType: "accounting_period",
      description: `Unlocked accounting period ${monthLabel(year, month)} — ${reason}`,
      user, metadata: { year, month, action: "unlock", reason },
    }).catch(() => {});
    res.json({ ok: true, year, month, status: "open" });
  },
);

export default router;
