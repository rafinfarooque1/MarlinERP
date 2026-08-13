/**
 * THE money formatter — docs/UI_CONVENTIONS.md "Currency format".
 *
 * Every money figure shown in the UI renders as ₹1,23,456.00: Indian digit
 * grouping (en-IN locale) with exactly two decimals. New and modernized
 * surfaces must import this helper instead of hand-rolling
 * `toLocaleString`/`toFixed` variants, so the format can never drift
 * page-by-page.
 *
 * (Legacy pages carry local `inr()` helpers with the same output; they get
 * folded into this import as each module is modernized — byte-identical
 * output, so switching is always safe.)
 */
export const inr = (n: number | string | null | undefined): string =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Plain quantity/number formatter with Indian grouping, no currency sign. */
export const inrNum = (n: number | string | null | undefined, maxDp = 3): string =>
  Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: maxDp });
