---
name: Sale cancellation as a state, not an event
description: Introducing a cancelled state obliges every downstream write path to refuse it; listing queries alone are not enough.
---

# Adding a cancelled state means auditing every write path that touches it

Cancelling a sale restores stock and lots, reverses the customer balance,
deletes the auto-created receipt and stamps `cancelled_at`. Making that correct
in the cancel handler is the *easy* half.

**The rule:** when you add a terminal state to a document, every other route
that mutates that document, or derives money or stock from it, must reject the
state explicitly. Filtering it out of list and report queries is not enough.

**Why:** the reversal is only sound if nothing re-applies the thing it reversed.
Two concrete holes existed here after cancellation shipped:
- recording a payment against a cancelled invoice put the cash and the
  receivable back on a bill that no longer exists;
- raising a sales return against a cancelled invoice restored the same stock a
  second time and credited revenue that had already been reversed.

Both routes already locked the sale row `FOR UPDATE` — they simply never read
`cancelled_at`. The fix is one guard per route, inside the existing transaction
and immediately after the lock, so it cannot race a concurrent cancel.

**How to apply:**
- Grep for every route that does `SELECT ... FROM sales ... FOR UPDATE` (or the
  equivalent for whatever document gained the state) and add the guard there.
- Put the guard *after* the lock, never before it, or a concurrent cancel can
  slip in between the check and the write.
- Return a distinguishable code (`409` + `SALE_CANCELLED`) rather than a bare
  400, so the UI can explain the situation instead of showing a validation error.
- Test both directions. A guard that blocks the cancelled case but also blocks
  the *live* case is a worse bug than the one being fixed, and only a positive
  control catches it.
- **No UI surface:** cancel has never had a frontend caller — it is API-only,
  and a sale with collected money refuses to cancel until the collection is
  unwound first (admin receipt system-delete). A follow-up task exists to add
  the button — verify whether it landed before assuming this is still true.
