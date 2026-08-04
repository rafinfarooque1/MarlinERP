---
name: Bill-level control over per-line fields
description: Replacing a per-row selector with one bill-level control while the payload stays per-line — mixed legacy rows must be surfaced, never hidden.
---

The purchase bill's GST Type (intra/inter) moved from a per-row select to ONE bill-level select. The payload is unchanged: every line still carries `taxType` + `taxTypeOverride`; the selector writes all lines via `setValue`, new lines copy line 0, and the pre-existing hint effect (vendor vs receiving-location registration) still syncs non-overridden lines.

**Rule:** when one control fronts a per-row stored field, the control's displayed value (derived from row 0) must not silently speak for rows that disagree. Bills saved under the old per-row control can hold BOTH types.

**Why:** an architect review failed the first version — a legacy mixed bill opened showing one type while submitting hidden conflicting line values, so the summary could quietly mix IGST with CGST/SGST.

**How to apply:** derive a `mixed` flag over the rows; while mixed, show an explicit warning ("lines differ — kept as-is unless you pick a value, which then applies to all") and amber-flag the control; leave stored rows untouched until the user actively picks. The same shape applies to any future bill-level fronting of per-line data (price mode is already bill-level in the schema, so it is exempt).
