---
name: Attachment access control in a location-scoped ERP
description: Why "signed in" is not sufficient authorisation for uploaded documents, and the two-case rule used instead.
---

## An unguessable URL is not an authorisation check

Uploaded bills are served from object storage behind the global auth guard. That
alone is not enough in this app: expenses are scoped by location, so a branch
user who obtains a path must not be able to read another branch's document.

**Why:** the whole point of location scoping is that a branch sees its own
spend. A document store that ignores it reintroduces the leak the scoping was
built to prevent, and a bill can carry a vendor's bank details.

**How to apply:** an object is readable in exactly two cases —

1. **The caller uploaded it and has not attached it yet.** The uploader's id is
   part of the object path (`uploads/<employeeId>/<uuid>`), so this is settled
   from the path alone with no lookup and no bookkeeping table to keep in step.
   This case exists so a user can preview a file before saving the record.
2. **It is attached to a record the caller may already see.** Resolve the path
   against the attachment columns and apply the same location rule the list
   endpoint applies.

Report anything else as **404, not 403** — a 403 confirms that some other
branch's document exists.

## A presigned PUT cannot enforce what was vetted at request time

Size and content-type are validated when the upload URL is issued, but the
signed PUT does not bind them, so what actually lands in the bucket may be
something else entirely.

**Why:** the practical risk is a smuggled HTML file served inline from the app's
own origin, i.e. stored XSS.

**How to apply:** treat the stored content type as untrusted on the way out —
pin anything unexpected to `application/octet-stream`, and always send
`X-Content-Type-Options: nosniff`, a `default-src 'none'; sandbox` CSP, and
`Content-Disposition: attachment`.
