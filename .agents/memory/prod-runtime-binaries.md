---
name: Deployed runtime is missing dev-workspace CLI binaries
description: Why spawn/execFile of workspace tools (zip, unzip, ...) works in dev and dies with ENOENT in production, and what to do instead.
---

# The dev workspace PATH is not the deployment PATH

The workspace's nix runtime path ships convenience binaries (`zip`, `unzip`,
and friends) that the deployed production runtime does NOT have. Code that
shells out to them passes every dev test and fails only in production with
`spawn <bin> ENOENT` — the worst possible place for a disaster-recovery
feature to fail (this is exactly how Backup & Restore broke).

**The rule:** application features must not spawn workspace CLI binaries.
Use an in-process library (e.g. `archiver` to write zips, `unzipper` to read
them — both now deps of the api-server) unless the binary is verified present
in production.

**Known exception that IS present in production:** `pg_dump`/`pg_restore` —
the backup's database dump succeeded in prod while the zip step failed, so the
postgres client tools ship with the deployed runtime.

**How to apply:** grep for `execFile`/`spawn`/`exec(` before trusting a
feature in production; `which <bin>` in the workspace proves nothing about the
deployment. When replacing zip extraction, keep a zip-slip guard — an uploaded
archive is untrusted input (see tests/backup-archive.test.mjs for the
byte-patched hostile-archive fixture; archiver normalises `../` so a naive
fixture tests nothing).
