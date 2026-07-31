---
name: Money input normalisation
description: Why HTML number fields break zod.number() contracts, why zod.coerce is the wrong fix, and why money must be validated as a decimal string rather than a float.
---

An `<input type="number">` hands React Hook Form a **string** — `'1250.50'`, or `''` once the
user clears it. A request body built straight from form state therefore fails any
`zod.number()` check with `Expected number, received string`, and if the submit handler papers
over the mismatch with `as any` the compiler stops being able to warn about it.

## Do not reach for `zod.coerce.number()`

Coercion is `Number()`, which is far too generous for money:

| input  | `Number()` |
|--------|-----------|
| `''`   | `0`       |
| `'  '` | `0`       |
| `null` | `0`       |
| `true` | `1`       |
| `[]`   | `0`       |

**Why:** the validation error disappears and junk starts landing in the column as a confident
zero, which is indistinguishable from a real balance of nothing. Swapping a loud 400 for a
silent wrong number is a downgrade.

`.finite()` is the load-bearing check people forget: `Number('Infinity')` **is** a number and
sails through a bare `.number()`.

## Validate the decimal string, never the float

Binary doubles cannot represent most decimal fractions, so `Math.round(1.005 * 100)` is `100`,
not `101` — rounding money in JS silently loses half-cents and will not agree with what
Postgres NUMERIC does.

**Why:** picking a rounding policy in JS means getting it subtly wrong. Refuse anything finer
than the column stores and hand Postgres the caller's exact digits; NUMERIC exists to do
decimal arithmetic.

**How to apply:**
- Normalise every input (number or string) to a decimal string first, then run one set of rules.
  `String(n)` gives a number's shortest exact decimal form; it also yields `'1e+21'` for huge
  values, which a plain-decimal regex then rejects for free.
- Reject exponent/hex/thousands-separator/currency-symbol forms explicitly.
- Enforce the column's **scale** (reject >2dp rather than rounding) and its **precision**
  (count integer digits after stripping leading zeros) so a Postgres 22003 becomes a 400.
- Return both the canonical `text` (write this to the NUMERIC column) and a `value` number for
  JSON/comparisons.
- Check the magnitude bound against the *final* digits, not a pre-rounding float.

## Keep the two schemas from drifting

Frontend and backend must agree on what the user may submit, or the form accepts a figure the
API turns round and rejects. Mirror the scale rule client-side with zod's `.multipleOf(0.01)`
(it uses decimal-safe remainder arithmetic, unlike a hand-rolled `n * 100` check) — and note
that a `step="0.01"` input also triggers the browser's own native tooltip first.

## A missing `<FormMessage />` hides the client-side half entirely

A field whose `FormItem` has no `<FormMessage />` renders **no** validation error, so the form
looks like it submitted and the only error anyone ever sees is the backend's. Grep for form
fields lacking one before concluding a validation rule "doesn't fire".
