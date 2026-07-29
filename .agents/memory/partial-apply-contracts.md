---
name: "Failure contracts for multi-step operations (\"nothing was changed\")"
description: Why a transactional-safety claim must be computed from what actually ran, never asserted at the catch site — and why the reassuring branch is the dangerous one.
---

# "Your data was not changed" must be computed, never asserted

When one step of an operation is transactional, it is tempting to describe the
*whole* operation with that step's guarantee. That is how a restore path ended up
returning a hardcoded `dataUnchanged: true` from its catch block: the database
step really did run in a single transaction, but the file and settings steps ran
**after** it committed, so a failure there left live data already replaced while
the response insisted nothing had happened.

**The rule:** track what actually completed (a flag set immediately after each
irreversible step), then derive the failure contract from those flags. A catch
block cannot know how far execution got unless something told it.

**Why:** this is the one error message a person reads during an incident, and
acting on it is destructive either way. "Nothing changed" invites a blind retry;
"partly applied" calls for rolling back to the safety copy first. Getting it
backwards is worse than saying nothing.

**How to apply:**
- Any operation with an irreversible step followed by more work: restores,
  migrations, multi-system writes (DB + object storage + external API).
- Set a flag right after the point of no return, not at the top of the next step.
- Derive the reassuring branch from the flags; make the *absence* of information
  mean "assume the worst", i.e. `dataUnchanged: e?.dataUnchanged === true`, never
  `?? true`.
- Propagate it to every layer. A truthful server is undone by a UI whose catch
  block says "your data has not been changed" from a hardcoded string — fix the
  client at the same time, or the lie just moves.
- Don't auto-roll-back. Reversing a partial apply is itself the same risky
  operation, run while the system is in an unexpected state. Report precisely and
  name the safety copy instead.

**Testing it:** a failure *before* the irreversible step passes trivially and
proves nothing about the branch that matters. The only honest proof is temporary
fault injection immediately after the commit, then verifying the response says
partly-applied. Remove the injection and grep for it afterwards.

## Corollary: you cannot explain a rejection after hanging up

Aborting an oversize streamed upload with `req.destroy()` and *then* writing the
status leaves the client with a connection reset and no status at all — curl
reports HTTP 000. The check placed after the stream pipeline never runs either,
because destroying the request makes the pipeline reject.

**The rule:** write the response first, then destroy. Swallow the resulting
pipeline rejection only when it is the abort you caused, and re-throw anything
else. Where the size is declared up front (`Content-Length`, which browsers always
send for a file body) refuse before reading a byte — no temp file, no half-read
socket, and nothing to unwind.

**How to test:** exercise both shapes, since they take different paths — one
request with `Content-Length`, one with `Transfer-Encoding: chunked`. Lower the
limit temporarily rather than generating a file at the real cap.

**Testing trap:** `curl --data-binary` sends
`application/x-www-form-urlencoded` by default, so a global body parser consumes
the stream and the route sees an empty body. Set the real content type
explicitly, and don't use `-F` (multipart) against a raw-body route — the
boundary preamble lands in the file and looks like a corrupt archive.
