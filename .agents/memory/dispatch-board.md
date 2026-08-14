---
name: Dispatch board (fulfillment status layer)
description: Pattern for per-document workflow status layers (dispatch queue over sales) — additive table, absence-of-row = initial status, zero books impact.
---

# Per-document status layers (Dispatch board decision)

The Operations › Dispatch board tracks physical fulfillment of billed sales
(PENDING → READY → DISPATCHED) as a status layer that never touches sales,
stock or postings.

**The rule:** a workflow status over an existing document goes in its own
additive table keyed to the parent, where **absence of a row = the initial
status** and reads never materialise rows.

**Why:** bolting status columns onto the parent table entangles fulfillment
with accounting truth; the additive shape makes "zero books impact" provable
(hash books figures before/after transitions) and lets historical documents
stay out of the queue by default (the board windows recent documents — a
rollout must not flood it with years of "pending").

**How to apply:**
- Transition validation must run under the status row's lock, and the
  parent's exclusion rules (cancelled, branch-transfer, foreign location)
  must be re-checked there too — filtering the queue alone is not enough.
- Refusals return 409 with the current status so the UI can resync.
- Suites must treat existing status rows as REAL operational data: only
  transition a document that provably starts row-less, and prove refused
  targets came out bitwise identical (see dev-data-as-fixtures).
