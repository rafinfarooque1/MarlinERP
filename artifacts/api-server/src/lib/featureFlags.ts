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
 *   - no outlet may be created, edited, deleted or transferred to/from
 *   - existing outlets stay fully visible for reports, audits and old documents
 *   - the nav entry appears for Head Office administrators only, badged legacy
 *
 * ON:
 *   - the module reactivates with no database change whatsoever; the parent
 *     `outlets.warehouse_id` column already models the hierarchy it needs
 */

const FLAG_DEFAULTS = {
  outletsEnabled: false,
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
