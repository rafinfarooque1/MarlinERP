/**
 * How old inventory is, in the two senses that matter to frozen fruit:
 * how close a lot is to expiry, and how long stock has sat without moving.
 *
 * Both classifications live here so a report, a dashboard tile and a future
 * alert cannot disagree about what "near expiry" or "dead stock" means. The
 * thresholds are data, not literals scattered through SQL.
 */

// ── Expiry tiers ─────────────────────────────────────────────────────────────
// Ordered narrowest-first: a lot 5 days from expiry belongs in the 7-day tier,
// not the 90-day one, so each lot is counted exactly once.
export const EXPIRY_TIER_DAYS = [7, 15, 30, 60, 90] as const;

export type ExpiryBucket = "expired" | "d7" | "d15" | "d30" | "d60" | "d90" | "ok" | "no_expiry";

export const EXPIRY_BUCKETS: ExpiryBucket[] = ["expired", "d7", "d15", "d30", "d60", "d90", "ok", "no_expiry"];

export const EXPIRY_BUCKET_LABELS: Record<ExpiryBucket, string> = {
  expired:   "Expired",
  d7:        "0–7 days",
  d15:       "8–15 days",
  d30:       "16–30 days",
  d60:       "31–60 days",
  d90:       "61–90 days",
  ok:        "Over 90 days",
  no_expiry: "No expiry date",
};

/** Tone hint so every surface colours the same bucket the same way. */
export const EXPIRY_BUCKET_TONE: Record<ExpiryBucket, "critical" | "warn" | "caution" | "ok" | "none"> = {
  expired:   "critical",
  d7:        "critical",
  d15:       "warn",
  d30:       "warn",
  d60:       "caution",
  d90:       "caution",
  ok:        "ok",
  no_expiry: "none",
};

/**
 * Which tier a lot falls in. `null` days means the lot carries no expiry date —
 * reported as its own bucket rather than silently treated as safe, because an
 * undated lot is a data gap, not a fresh one.
 */
export function expiryBucket(daysToExpiry: number | null | undefined): ExpiryBucket {
  if (daysToExpiry == null) return "no_expiry";
  if (daysToExpiry < 0) return "expired";
  for (const tier of EXPIRY_TIER_DAYS) {
    if (daysToExpiry <= tier) return (`d${tier}` as ExpiryBucket);
  }
  return "ok";
}

/** True for anything a manager should act on: expired, or inside `withinDays`. */
export function isAtRisk(daysToExpiry: number | null | undefined, withinDays = 90): boolean {
  if (daysToExpiry == null) return false;
  return daysToExpiry < 0 || daysToExpiry <= withinDays;
}

/** Legacy two-state status kept for the batch drill-down, which shows a badge
 *  per lot rather than a tier. */
export function expiryStatus(daysToExpiry: number | null, nearDays: number): "ok" | "near_expiry" | "expired" | "no_expiry" {
  if (daysToExpiry == null) return "no_expiry";
  if (daysToExpiry < 0) return "expired";
  if (daysToExpiry <= nearDays) return "near_expiry";
  return "ok";
}

export interface BucketSummaryRow {
  bucket: ExpiryBucket;
  label: string;
  batches: number;
  quantity: number;
  value: number;
}

/** Roll rows up per tier, always emitting every tier so a zero reads as zero
 *  rather than as a missing row the caller has to guess about. */
export function summarizeExpiryBuckets(
  rows: Array<{ bucket: ExpiryBucket; quantity: number; value: number }>,
  buckets: ExpiryBucket[] = EXPIRY_BUCKETS,
): BucketSummaryRow[] {
  return buckets.map((bucket) => {
    const mine = rows.filter((r) => r.bucket === bucket);
    return {
      bucket,
      label: EXPIRY_BUCKET_LABELS[bucket],
      batches: mine.length,
      quantity: Math.round(mine.reduce((s, r) => s + r.quantity, 0) * 1000) / 1000,
      value: Math.round(mine.reduce((s, r) => s + r.value, 0) * 100) / 100,
    };
  });
}

// ── Movement classes (dead / slow-moving stock) ───────────────────────────────
// Measured from the last movement of that product at that location in the stock
// ledger. Stock that has never moved is `dead` regardless of age: it was
// received and then forgotten, which is precisely the case worth surfacing.
export const MOVEMENT_CLASS_DAYS = { fast: 30, slow: 90, dormant: 180 } as const;

export type MovementClass = "fast" | "slow" | "dormant" | "dead";

export const MOVEMENT_CLASSES: MovementClass[] = ["fast", "slow", "dormant", "dead"];

export const MOVEMENT_CLASS_LABELS: Record<MovementClass, string> = {
  fast:    `Moving (last ${MOVEMENT_CLASS_DAYS.fast} days)`,
  slow:    `Slow (${MOVEMENT_CLASS_DAYS.fast + 1}–${MOVEMENT_CLASS_DAYS.slow} days)`,
  dormant: `Dormant (${MOVEMENT_CLASS_DAYS.slow + 1}–${MOVEMENT_CLASS_DAYS.dormant} days)`,
  dead:    `Dead (over ${MOVEMENT_CLASS_DAYS.dormant} days or never moved)`,
};

export function movementClass(daysSinceLastMovement: number | null | undefined): MovementClass {
  if (daysSinceLastMovement == null) return "dead";
  if (daysSinceLastMovement <= MOVEMENT_CLASS_DAYS.fast) return "fast";
  if (daysSinceLastMovement <= MOVEMENT_CLASS_DAYS.slow) return "slow";
  if (daysSinceLastMovement <= MOVEMENT_CLASS_DAYS.dormant) return "dormant";
  return "dead";
}
