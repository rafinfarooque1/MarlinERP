---
name: Guard route coverage & permissive-flag failure mode
description: Two review-caught gaps — a privilege-bearing attribute must be guarded on EVERY route that can set it, and feature flags that default to permissive must fail closed on read errors.
---

## 1. Guard every route that can produce the privileged state

Blocking a privileged attribute on the EDIT route alone is theatre: CREATE can
mint the same state and DELETE can revoke it. Example: hierarchy `level = 1`
grants full RBAC access (middleware override), so the PATCH guard blocking
level transitions to/from 1 was bypassable by simply POSTing a new level-1
role, and the unguarded DELETE could remove the administrative role entirely.

**Why:** the privilege lives in the resulting ROW STATE, not in any one verb.
**How to apply:** when adding a guard for a privilege-bearing value, enumerate
create / edit / delete / any bulk or import route that can write that column,
and guard each one. Add a regression test per route, not per feature.

## 2. Flags that default to permissive must fail closed on read errors

A `getFlag()` helper that catches all errors and returns the default is fine
when the default is restrictive (`false`), but silently FAIL-OPEN when the
default is permissive (`true`): a settings-read failure re-enables the very
thing an admin switched off. Absent row/key = documented default; FAILED read
= propagate (let the write 500).

**Why:** enforcement that evaporates exactly when the DB hiccups is not
enforcement; the caller can't tell "unset" from "unknown".
**How to apply:** separate the two cases in the reader. For permissive-default
flags used in write guards, never swallow the query error.
