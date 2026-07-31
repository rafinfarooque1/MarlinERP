/**
 * UPI Virtual Payment Address (VPA) handling.
 *
 * A UPI ID is stored in exactly two places, and both feed the SAME invoice QR:
 *   - `company_settings.upi_id`      — the company-wide fallback
 *   - `warehouses.upi_id`            — the location's own ID, which wins
 *
 * Because a bad VPA produces a QR that scans fine and then fails inside the
 * customer's UPI app — with nothing on the invoice to explain why — the value
 * is validated once, here, and both write paths use this module. Keeping the
 * rule in one place is what stops the two fields from drifting apart.
 */

/**
 * Accepts `handle@provider`.
 *
 * Deliberately permissive: Indian PSPs issue handles across a wide range of
 * shapes (`name@okhdfcbank`, `9876543210@ybl`, `some.user-1@paytm`), so this
 * checks structure only and does not attempt to whitelist providers. A
 * whitelist would reject legitimate new PSPs the moment they launch.
 */
const VPA_PATTERN = /^[A-Za-z0-9.\-_]{2,64}@[A-Za-z][A-Za-z0-9.\-]{1,63}$/;

export const UPI_ID_ERROR = 'upiId must be a valid UPI address, e.g. marlin@okhdfcbank';

export type UpiNormalizeResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Normalise a UPI ID coming off a request body.
 *
 * Returns `null` for "no UPI ID" so an intentionally cleared field becomes SQL
 * NULL rather than an empty string — otherwise the QR builders, which only
 * check for a falsy value, would still be fed `''` and every consumer would
 * need its own emptiness check.
 *
 * Surrounding whitespace is trimmed rather than rejected: it is almost always
 * an artefact of pasting the VPA out of a banking app.
 */
export function normalizeUpiId(raw: unknown): UpiNormalizeResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'upiId must be a string or null' };
  const vpa = raw.trim();
  if (!vpa) return { ok: true, value: null };
  if (!VPA_PATTERN.test(vpa)) return { ok: false, error: UPI_ID_ERROR };
  return { ok: true, value: vpa };
}

/** Structural check only — see {@link normalizeUpiId} for the write path. */
export function isValidUpiId(vpa: string): boolean {
  return VPA_PATTERN.test(vpa);
}
