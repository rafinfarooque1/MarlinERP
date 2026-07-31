/** Input normalisation for money amounts arriving from HTML form fields.
 *
 *  An `<input type="number">` hands back a *string* — '1250.50', or '' once the
 *  user clears it — so a body built straight from form state fails a
 *  `zod.number()` check with "Expected number, received string". That is the
 *  whole of the Add Payment Account failure.
 *
 *  Reaching for `zod.coerce.number()` fixes the symptom and introduces a worse
 *  bug, because coercion is `Number()` and `Number()` is far too generous for
 *  money: '' -> 0, null -> 0, true -> 1, [] -> 0, '  ' -> 0. Junk would stop
 *  raising a 400 and start landing in the column as a confident zero, which is
 *  indistinguishable from a real balance of nothing.
 *
 *  All the work happens on the decimal *string*, never on a float. Binary
 *  doubles cannot hold most decimal fractions, so `Math.round(1.005 * 100)`
 *  gives 100, not 101 — rounding money in JS silently loses half-cents. Rather
 *  than pick a rounding policy and get it subtly wrong, this refuses anything
 *  finer than the column stores and hands Postgres the exact digits the caller
 *  sent, letting NUMERIC do the decimal arithmetic it exists for.
 */

/** A plain decimal, optionally signed. No exponent ('1e5'), no hex, no
 *  thousands separators, no currency symbol — none of which a money field
 *  should quietly accept, and all of which `Number()` would happily swallow. */
const PLAIN_DECIMAL_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** NUMERIC(12,2) holds 10 digits before the point and 2 after. */
const MAX_INT_DIGITS = 10;
const MAX_SCALE = 2;

export type MoneyInput =
  | {
      ok: true;
      /** Numeric form, for comparisons and JSON responses. */
      value: number;
      /** Canonical decimal string — write THIS to a NUMERIC column so the
       *  value survives the trip without passing through a float. */
      text: string;
    }
  | { ok: false; reason: string };

/**
 * Normalise an optional money field from a request body.
 *
 * Absent, null and blank all mean "not filled in" and yield `fallback`
 * (0 for an opening balance). Everything else must be a genuine finite decimal
 * the column can hold exactly — `NaN`, `Infinity`, booleans, arrays, non-numeric
 * text, more than two decimal places and out-of-range magnitudes are all
 * rejected with a reason rather than being flattened to zero or rounded away.
 */
export function optionalMoney(v: unknown, fallback = 0): MoneyInput {
  if (v === undefined || v === null) {
    return { ok: true, value: fallback, text: fallback.toFixed(MAX_SCALE) };
  }

  // Everything becomes a decimal string first, so there is exactly one set of
  // rules. A number arrives from JSON already parsed, but String() gives back
  // its shortest exact decimal form, which is what we need to inspect.
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { ok: false, reason: "must be a real number" };
    s = String(v);
  } else if (typeof v === "string") {
    s = v.trim();
    if (s === "") {
      return { ok: true, value: fallback, text: fallback.toFixed(MAX_SCALE) };
    }
  } else {
    return { ok: false, reason: "must be a number" };
  }

  // Catches 'abc', '₹1000', 'NaN', 'Infinity', '1e5' and the exponent form
  // String() produces for very large or very small numbers.
  if (!PLAIN_DECIMAL_RE.test(s)) {
    return { ok: false, reason: "must be a plain amount such as 1250.50" };
  }

  const negative = s.startsWith("-");
  const [intPart = "", fracPart = ""] = s.replace(/^-/, "").split(".");

  if (fracPart.length > MAX_SCALE) {
    return { ok: false, reason: "cannot have more than two decimal places" };
  }
  // Leading zeros are not significant in a magnitude, unlike in an account
  // number, so '007.50' is three digits' worth of value, not three digits.
  if (intPart.replace(/^0+/, "").length > MAX_INT_DIGITS) {
    return { ok: false, reason: "is larger than this field can store" };
  }

  const text = `${negative ? "-" : ""}${intPart || "0"}.${fracPart.padEnd(MAX_SCALE, "0")}`;
  return { ok: true, value: Number(text), text };
}
