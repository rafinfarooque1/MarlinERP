---
name: Leave approval workflow
description: Which leave lifecycle transitions touch attendance/pay, which lock each one takes, and why rejection must not use the attendance-write lock.
---

# Leave approval workflow

Pending leave has ZERO effect on attendance or pay. Attendance flips to
`leave` only at approval; accrual and payroll read only the attendance table,
so gating the stamp gates the money.

**Approval is a salary write.** It takes the attendance-write path (accrual
lock + signed-off-month refusal), re-checks pending under the lock, and must
never overwrite a day that has a real check-in.
**Why:** approving without the lock races attendance corrections and payroll
sign-off; overwriting a worked day converts real hours into a flat leave day.

**Rejection takes only the accrual lock, NOT the attendance-write path.**
**Why:** a range touching a signed-off payroll month would otherwise be
un-rejectable — stranded pending forever. Rejection normally has nothing to
undo; its cleanup only removes stamps the OLD apply-time sync left behind.

**Reverting a stamp means DELETE, never `status='absent'`.**
**Why:** an untracked month (no attendance rows) is paid in full; one leftover
`absent` row flips the whole month to tracked and zeroes the pay. Deleting
restores the pre-application state exactly.

**Cancel is owner-only (even Head Office gets 403) and pending-only.**
**Why:** approvers withdrawing someone's request must reject with a reason so
the audit trail says who and why; a silent third-party cancel hides that.

Approver authority = the page EDIT right, scoped by branch: HO sees all,
a non-HO holder of edit sees own-branch requests, everyone else own rows only.
Self-approval is refused server-side even for level-1/HO.

Decision ordering: page right 403 → location scope 404 → self-approval 403 →
not-pending 409 (scope must stay 404, never 403 — existence is a disclosure).
