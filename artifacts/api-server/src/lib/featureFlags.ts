/**
 * Company-level feature flags, stored in `company_settings.general_settings`
 * (a raw JSONB column added by migration — invisible to Drizzle, so every read
 * here is raw SQL).
 *
 * ── Outlet Management ───────────────────────────────────────────────────────
 * Outlets were folded into warehouses. The module is retired but NOT deleted:
 * every historical outlet sale, stock movement, accounting entry and GST filing
 * must stay readable forever, so the records and their routes remain in place
 * and only *write* operations are sealed off.
 *
 * OFF (the default, and the state of every new install):
 *   - no outlet may be created, edited, deleted, transferred to/from, sold at,
 *     priced, staffed, or newly assigned a customer, vendor or expense
 *   - existing outlets stay fully visible for reports, audits and old documents
 *   - the module disappears from the UI entirely — no nav entry for anyone, no
 *     "legacy" badge, no outlet option in any location picker, and the page
 *     itself answers direct URLs with an Access Disabled screen
 *
 * ON:
 *   - the module reactivates with no database change whatsoever; the parent
 *     `outlets.warehouse_id` column already models the hierarchy it needs
 */

const FLAG_DEFAULTS = {
  outletsEnabled: false,
  // POS entry availability. Both default ON so deployments never silently hide
  // functionality that exists today. These gate NEW/EDITED transaction entry
  // only — historical invoices keep displaying whatever they stored.
  posDiscountsEnabled: true,
  posCouponsEnabled: true,
} as const;

export type FeatureFlag = keyof typeof FLAG_DEFAULTS;

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Read one flag. Absent settings row, absent JSON key and unparseable values
 *  all fall back to the documented default rather than guessing. */
export async function getFeatureFlag(db: Queryable, flag: FeatureFlag): Promise<boolean> {
  try {
    const { rows: [row] } = await db.query(`SELECT general_settings FROM company_settings LIMIT 1`);
    const gs = (row?.general_settings as Record<string, unknown> | null) ?? {};
    const v = gs[flag];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true';
    return FLAG_DEFAULTS[flag];
  } catch {
    return FLAG_DEFAULTS[flag];
  }
}

export const OUTLETS_DISABLED_MESSAGE =
  'Outlet Management is turned off. Outlets are retained read-only for historical records — ' +
  'existing outlet data stays available in reports and audits, but no outlet can be created, ' +
  'changed, deleted or used for transfers. Turn Outlet Management back on in Settings to use them again.';

export const OUTLETS_DISABLED_CODE = 'OUTLETS_DISABLED';

/** True when the request must be refused because it writes to an outlet while
 *  the module is off. Read paths must never call this. */
export async function outletWritesBlocked(db: Queryable): Promise<boolean> {
  return !(await getFeatureFlag(db, 'outletsEnabled'));
}

// ── POS discount / coupon availability ──────────────────────────────────────
// UI hiding alone is not enforcement: the sale routes must refuse NEW discount
// or coupon amounts while the matching flag is off. Edits of historical
// discounted/couponed sales are still allowed to carry their EXISTING amounts —
// the guard compares against what the sale already stored, so switching a flag
// off never strands an old invoice (see "guard the effective value").

export const DISCOUNTS_DISABLED_MESSAGE =
  'Discounts are turned off in Settings. Remove the discount to save this sale, ' +
  'or ask an administrator to enable discounts under Settings → Point of Sale.';
export const DISCOUNTS_DISABLED_CODE = 'DISCOUNTS_DISABLED';

export const COUPONS_DISABLED_MESSAGE =
  'Coupon codes are turned off in Settings. Remove the coupon to save this sale, ' +
  'or ask an administrator to enable coupons under Settings → Point of Sale.';
export const COUPONS_DISABLED_CODE = 'COUPONS_DISABLED';

/** Both POS entry flags in one round-trip — the sale routes need the pair.
 *
 *  FAIL CLOSED: unlike getFeatureFlag, a settings-read failure here is NOT
 *  swallowed into the defaults. The defaults are `true` (permissive), so
 *  falling back on a DB error would let discounts through at the exact moment
 *  an admin has them switched off. A read error propagates, the sale write
 *  500s, and nothing is permitted that couldn't be verified. An absent
 *  settings row or absent key still means the documented default (true) —
 *  only a FAILED read is refused. */
export async function getPosEntryFlags(db: Queryable): Promise<{ discountsEnabled: boolean; couponsEnabled: boolean }> {
  const { rows: [row] } = await db.query(`SELECT general_settings FROM company_settings LIMIT 1`);
  const gs = (row?.general_settings as Record<string, unknown> | null) ?? {};
  const read = (flag: FeatureFlag): boolean => {
    const v = gs[flag];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true';
    return FLAG_DEFAULTS[flag];
  };
  return { discountsEnabled: read('posDiscountsEnabled'), couponsEnabled: read('posCouponsEnabled') };
}
