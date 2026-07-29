---
name: Guard the effective value, not the request body
description: Why write guards that inspect req.body are routinely bypassable in this codebase — session-derived stamping and partial PATCHes both route around them.
---

# Guard the effective value, not the request body

A guard that reads `req.body.someField` is checking what the caller *said*, not
what the write will actually do. In this codebase those two come apart in two
routine, non-adversarial ways.

**Why:**

1. **Session-derived stamping.** Location ownership on customers/vendors is not
   taken from the body — it is stamped from the authenticated employee's session,
   with the body acting only as an optional override for Head Office users. A
   guard reading `req.body.locationType` therefore sees `undefined` for every
   ordinary location-stationed user, waves the request through, and the stamping
   code immediately writes the very value the guard exists to forbid.

2. **Partial PATCH.** A PATCH carries only changed fields. Checking
   `parsed.data.branchType` misses a payload that changes just `branchId` — which
   is enough to walk a record from one forbidden location to another without the
   discriminator field ever appearing in the request.

**How to apply:**

- Compute the **resulting state** first — merge the current row with the patch,
  or run the session/override resolution — then guard *that* value, then write.
- Order matters twice over: the guard must sit after the effective value is known
  but **before** the insert/update, so a refusal cannot strand a half-created row.
  Where stamping was previously done after the insert, hoist the computation
  above it rather than adding a second check.
- For "is this a *move*?" rules, compare against the current row and allow the
  no-op case, otherwise unrelated edits (a phone number) to a record already at
  the forbidden location get refused and those records freeze permanently.
- A passing acceptance test that only exercises the Head-Office/admin path proves
  nothing here — that path supplies the field in the body. The bypass lives on
  the ordinary-user path.

## A guard is only as good as the write it authorised

Having decided a row may exist *at this value*, the write of that value cannot be
best-effort. Insert-then-stamp with a swallowed error on the stamp produces
exactly the unscoped row the guard existed to prevent — and does it silently.

**How to apply:** put the insert and the stamp in one transaction so a failed
stamp rolls the insert back. The stamp usually has to stay a separate statement
(startup-migration columns are invisible to Drizzle's insert), which is precisely
why it needs the transaction rather than a convenient \`.catch(() => {})\`. Express
5 forwards async rejections to the error handler, so a rolled-back transaction
surfaces as a 500 on its own — no bespoke try/catch needed.
