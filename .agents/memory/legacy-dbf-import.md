---
name: Legacy ERP DBF import
description: Design decisions for the Legacy ERP Import module (ZIP-of-DBF backups) — transient /tmp sessions, ZipCrypto password quirks, Management-only permission seeding.
---

# Legacy ERP Import (Company → Data Migration)

Phase A shipped: upload → extract → analyze (company name, backup date, per-table
classification + record counts, sample-rows viewer). The IMPORT step is deliberately
deferred until a real legacy backup's DBF schema is known; it must reuse the
routes/imports.ts batch machinery (see data-import-framework.md) so business rules,
history and rollback are shared — never direct inserts.

## Transient session design
- Extraction sessions live under `/tmp/legacy-imports/<dirId>/` with a `meta.json`;
  they do NOT survive restarts/redeploys, by design. Reads return **410** with a
  "server was restarted — upload again" message; the client resets to the upload
  step on that message. Never promote these to DB rows — the backup is re-uploadable
  by definition, and the import step re-reads extracted files fresh.
- The raw upload is kept in the session as `__original__` so a password retry
  re-extracts server-side instead of re-uploading 100+ MB from a phone.

## ZIP password quirks (unzipper / ZipCrypto)
- Legacy backups use ZipCrypto. unzipper throws `MISSING_PASSWORD` /
  `BAD_PASSWORD`, BUT a wrong password often "succeeds" and yields garbage —
  ZipCrypto's check is a 1-byte checksum. **Tell:** an extracted `.dbf` member
  that fails the DBF signature check (`looksLikeDbf`) means wrong password.
- The password is used once for extraction and never persisted anywhere.
- AES-encrypted ZIPs are not supported by unzipper's decrypt — surface a clear
  message rather than a generic failure.

## DBF facts
- Header: version byte (whitelist — dBase/FoxPro family), bytes 1–3 = last-update
  YYMMDD (YY is years since 1900 but some writers store 2-digit years: <70 ⇒ 2000s),
  uint32 record count @4 (INCLUDES soft-deleted rows — the `*` deletion flag),
  header len @8, 32-byte field descriptors from offset 32 until 0x0D.
- Row reads go through the `dbffile` npm package with `readMode: 'loose'`
  (legacy files are full of spec violations); it skips deleted rows — so header
  count and readable-row count can legitimately differ.
- Classification is name-regex-first (FoxPro-era Indian ERP conventions), and
  ORDER MATTERS: returns before sales ("SALERET" contains "SALE"), company/opening
  first. Field-shape hints are a weak fallback only.

## Permission seeding difference
- `page:/company/legacy-import` is seeded to **level-2 hierarchies only**
  (Management), unlike earlier module seedings that granted all pre-existing
  roles. Level 1 bypasses checks; everyone else stays default-denied. Spec says
  Management+Admin only — copying the grant-everyone seeding pattern here would
  have been a security bug.

## Hardening (post-review, all E2E-verified)
- **Session ids in URLs must be shape-validated (24-hex) BEFORE any fs call** —
  the discard endpoint does a recursive rm on the joined path; `sessionDir()`
  itself throws on a bad id as the last line of defence. Malformed/foreign id
  → 404 (don't confirm existence); well-formed but gone → 410.
- **Sessions are personal**: meta stores the owning employee ID and every
  route compares it — even level-1 admins can't open another user's session.
  The random id is not authorization.
- **The HTTP body cap only bounds COMPRESSED size.** Zip-bomb defence needs
  entry-count + per-entry + total caps checked on declared sizes first, then
  re-checked on actual inflated bytes (central directories lie).
- Per-session mutations (unlock/add-file) serialize on an in-process promise
  chain; a failed password attempt can leave partial files (memo files extract
  before the wrong-password tell) so unlock clears extracted files first.
- TTL sweep runs opportunistically on each new upload — no timers.

## Why: one-time migration modules face untrusted binary input
Upload endpoints take raw bodies (same pattern as Excel import); everything the
archive claims (member names, DBF structure) is treated as hostile: member names
are basename()d + sanitized (zip-slip), files that don't parse get a per-table
parseError instead of failing the whole analysis.

**How to apply:** any future "read a legacy binary backup" feature (Tally, Busy,
etc.) should follow this session + analysis-first shape, and the import commit
must go through import batches.
