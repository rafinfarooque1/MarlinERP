---
name: Voucher edit & provenance
description: How "only a human-entered voucher may be edited" is decided in the ERP, and why unknown provenance is locked for edit but still deletable.
---

# Deciding whether a voucher may be edited

Provenance must be **stored on the row**, never inferred from voucher-number
prefix, narration text, or voucher type. Several modules write plain `journal`
vouchers, and `created_by` is useless as a discriminator — payroll and advance
vouchers carry the operator's own username.

`origin` is three-valued and every consumer must respect all three:

- `manual` — a person entered it on the Vouchers screen. Editable.
- `system` — another module owns it. Locked.
- `NULL` — predates provenance tracking. **Locked**, reported to the user as
  "provenance unknown", never quietly promoted to manual.

**Why:** the only backfill signal available for historical rows is an
`activity_log` CREATE row, which only the manual route writes. Absence of that
row is not evidence of manual entry — it is absence of evidence. Guessing wrong
in the permissive direction means letting someone rewrite a payroll or
production entry and silently desynchronising the books from its source
document.

**How to apply:** stamp `origin` explicitly at *every* insert site when adding a
new voucher producer — an unstamped insert lands as NULL and its voucher becomes
permanently locked. The server's `editable` verdict is the single source of
truth; the UI must render from it rather than re-deriving the rule.

## Edit is a new capability; delete is an old one

Locking `NULL` for **edit** costs nothing — edit did not exist before. Applying
the same lock to **delete** would withdraw a capability the screen has always
had, for every historical voucher at once. So delete blocks only proven
`origin = 'system'`, and unknown rows stay deletable.

**Why:** conservatism is free on a new capability and expensive on an existing
one. Judge each verb on what its guard takes away, not on symmetry.

## Things the preserved voucher number forbids

Editing keeps the voucher **id and number**, which constrains two fields that
look freely editable:

- **Type** cannot change — the number's prefix encodes it.
- **Date** cannot cross a financial year — the number carries the FY label, and
  renumbering to match would strand the sequence allocator (see
  `invoice-numbering-sequence.md`).
