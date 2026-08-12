import { pool as _pool } from "@workspace/db";

type Queryable = { query: (text: string, params?: any[]) => Promise<any> };

export interface OtherCharge { ledgerId: number; amount: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Internal ledger code prefixes a user must never post an "other charge" to —
 *  the same set the voucher screens hide (see marlin-erp systemLedgers.ts). */
const SYSTEM_CODE_RE = /^(SYS-|SAL-EMP-|SAL-PAY-|ADV-EMP-|GST-|STD-BRANCH-)/;

/**
 * Other Purchase Charges — incidental expenses on a purchase bill (freight,
 * hamali, courier, loading…). They post Dr <chosen expense ledger> / Cr vendor
 * in the derived postings and are NEVER part of inventory cost: line costing
 * ignores them by construction.
 *
 * Validation is on the EFFECTIVE ledger, server-side, because the dropdown
 * filter on the client is a convenience, not a guard:
 *  · must exist, be active and be postable (not a group);
 *  · must be an expense ledger — anything else would silently reclassify the
 *    P&L (a charge parked on an asset ledger never hits profit);
 *  · must NOT sit inside the Purchase (SYS-PUR) subtree — routing "freight"
 *    into a purchase ledger would inflate cost of goods in the books while
 *    stock stays valued without it, and the two would never reconcile;
 *  · must not be an internal system ledger.
 */
export async function validateOtherCharges(
  q: Queryable,
  raw: unknown,
): Promise<{ error: string } | { charges: OtherCharge[]; total: number }> {
  if (raw === undefined || raw === null) return { charges: [], total: 0 };
  if (!Array.isArray(raw)) return { error: "Other charges must be a list of { ledgerId, amount }" };
  if (raw.length === 0) return { charges: [], total: 0 };
  if (raw.length > 50) return { error: "Too many other-charge rows on one bill (max 50)" };

  const charges: OtherCharge[] = [];
  for (const c of raw as any[]) {
    const ledgerId = Number(c?.ledgerId);
    const amount = Number(c?.amount);
    if (!Number.isInteger(ledgerId) || ledgerId <= 0) {
      return { error: "Every other charge needs an expense ledger — pick one from the list" };
    }
    if (!Number.isFinite(amount) || amount <= 0.004) {
      return { error: "Every other charge needs an amount above zero" };
    }
    // Paise precision, judged on the rounded value so 1500.005 is refused
    // rather than silently becoming 1500.01 (or .00) somewhere downstream.
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
      return { error: "Other charge amounts cannot go beyond paise (2 decimal places)" };
    }
    charges.push({ ledgerId, amount: r2(amount) });
  }

  const ids = [...new Set(charges.map((c) => c.ledgerId))];
  const { rows } = await q.query(
    `WITH RECURSIVE up(start_id, id, parent_id, code) AS (
       SELECT id, id, parent_id, code FROM account_ledgers WHERE id = ANY($1::int[])
       UNION ALL
       SELECT up.start_id, p.id, p.parent_id, p.code
         FROM account_ledgers p JOIN up ON p.id = up.parent_id
     )
     SELECT l.id, l.name, l.type, l.is_group, l.is_system_group, l.is_active, l.code,
            EXISTS (SELECT 1 FROM up WHERE up.start_id = l.id AND up.code = 'SYS-PUR') AS under_purchase
       FROM account_ledgers l WHERE l.id = ANY($1::int[])`,
    [ids],
  );
  const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));
  for (const id of ids) {
    const l = byId.get(id);
    if (!l) return { error: `Other charge ledger #${id} is not in the Chart of Accounts` };
    const label = `"${l.name}"`;
    if (l.is_group || l.is_system_group) return { error: `${label} is a group — pick a postable expense ledger under it` };
    if (l.is_active === false) return { error: `${label} is inactive — reactivate it in the Chart of Accounts or pick another expense ledger` };
    if (String(l.type) !== "expense") return { error: `${label} is not an expense ledger — other charges must post to a P&L expense account` };
    if (l.under_purchase) return { error: `${label} sits under Purchase in the Chart of Accounts — record the charge on a freight/expense ledger, not a purchase account` };
    if (l.code && SYSTEM_CODE_RE.test(String(l.code))) return { error: `${label} is an internal system ledger — pick a normal expense ledger` };
  }

  return { charges, total: r2(charges.reduce((s, c) => s + c.amount, 0)) };
}

/**
 * Sale Other Charges — the SALE side of the same "other charges" idea (packing,
 * freight, hamali, courier, packing-income recovery…). It differs from the
 * PURCHASE validator above on ONE axis only: a sale charge may credit an
 * INCOME ledger (a real recovery the customer pays on top of goods) OR an
 * expense ledger (an expense recovery — a credit balance on an expense ledger
 * is normal here, see books.ts). What it must NEVER do is route into the SALES
 * (SYS-SAL) subtree — that would masquerade extra recovery as goods revenue and
 * inflate the GSTR-1 taxable value / turnover — nor into PURCHASE (SYS-PUR),
 * nor onto an internal system ledger. Purchase charges stay expense-only via
 * validateOtherCharges above.
 */
export async function validateSaleOtherCharges(
  q: Queryable,
  raw: unknown,
): Promise<{ error: string } | { charges: OtherCharge[]; total: number }> {
  if (raw === undefined || raw === null) return { charges: [], total: 0 };
  if (!Array.isArray(raw)) return { error: "Other charges must be a list of { ledgerId, amount }" };
  if (raw.length === 0) return { charges: [], total: 0 };
  if (raw.length > 50) return { error: "Too many other-charge rows on one bill (max 50)" };

  const charges: OtherCharge[] = [];
  for (const c of raw as any[]) {
    const ledgerId = Number(c?.ledgerId);
    const amount = Number(c?.amount);
    if (!Number.isInteger(ledgerId) || ledgerId <= 0) {
      return { error: "Every other charge needs an income or expense ledger — pick one from the list" };
    }
    if (!Number.isFinite(amount) || amount <= 0.004) {
      return { error: "Every other charge needs an amount above zero" };
    }
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
      return { error: "Other charge amounts cannot go beyond paise (2 decimal places)" };
    }
    charges.push({ ledgerId, amount: r2(amount) });
  }

  const ids = [...new Set(charges.map((c) => c.ledgerId))];
  const { rows } = await q.query(
    `WITH RECURSIVE up(start_id, id, parent_id, code) AS (
       SELECT id, id, parent_id, code FROM account_ledgers WHERE id = ANY($1::int[])
       UNION ALL
       SELECT up.start_id, p.id, p.parent_id, p.code
         FROM account_ledgers p JOIN up ON p.id = up.parent_id
     )
     SELECT l.id, l.name, l.type, l.is_group, l.is_system_group, l.is_active, l.code,
            EXISTS (SELECT 1 FROM up WHERE up.start_id = l.id AND up.code = 'SYS-SAL') AS under_sales,
            EXISTS (SELECT 1 FROM up WHERE up.start_id = l.id AND up.code = 'SYS-PUR') AS under_purchase
       FROM account_ledgers l WHERE l.id = ANY($1::int[])`,
    [ids],
  );
  const byId = new Map<number, any>(rows.map((r: any) => [Number(r.id), r]));
  for (const id of ids) {
    const l = byId.get(id);
    if (!l) return { error: `Other charge ledger #${id} is not in the Chart of Accounts` };
    const label = `"${l.name}"`;
    if (l.is_group || l.is_system_group) return { error: `${label} is a group — pick a postable income or expense ledger under it` };
    if (l.is_active === false) return { error: `${label} is inactive — reactivate it in the Chart of Accounts or pick another ledger` };
    if (String(l.type) !== "income" && String(l.type) !== "expense") {
      return { error: `${label} is not an income or expense ledger — sale charges must post to a P&L account` };
    }
    if (l.under_sales) return { error: `${label} sits under Sales in the Chart of Accounts — record the charge on a separate income/expense ledger, not the Sales account` };
    if (l.under_purchase) return { error: `${label} sits under Purchase in the Chart of Accounts — record the charge on a freight/expense or income ledger, not a purchase account` };
    if (l.code && SYSTEM_CODE_RE.test(String(l.code))) return { error: `${label} is an internal system ledger — pick a normal income or expense ledger` };
  }

  return { charges, total: r2(charges.reduce((s, c) => s + c.amount, 0)) };
}

/** Read a stored other_charges jsonb value defensively (old rows, hand edits). */
export function parseStoredOtherCharges(raw: unknown): OtherCharge[] {
  if (!Array.isArray(raw)) return [];
  return (raw as any[])
    .map((c) => ({ ledgerId: Number(c?.ledgerId), amount: r2(Number(c?.amount)) }))
    .filter((c) => Number.isInteger(c.ledgerId) && c.ledgerId > 0 && Number.isFinite(c.amount) && c.amount > 0.004);
}

export const otherChargesTotal = (charges: OtherCharge[]): number =>
  r2(charges.reduce((s, c) => s + c.amount, 0));
