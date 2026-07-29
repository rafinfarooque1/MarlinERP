# Disaster Recovery — Marlin Frozen Fruits ERP

How to bring the ERP back when the running system is gone: deleted, corrupted,
locked out, or being moved to a new server.

Read this **before** you need it. The one step that cannot be done after the
disaster is [keeping an off-platform copy](#0-the-only-step-that-must-happen-in-advance).

---

## What a full recovery needs

Five things, and a backup archive only covers three of them:

| # | Piece | Where it lives | In the archive? |
|---|-------|----------------|-----------------|
| 1 | Source code | GitHub — `github.com/rafinfarooque1/MarlinERP` | No |
| 2 | Database | `database.dump` inside the archive | Yes |
| 3 | Uploaded files | `uploads/` inside the archive | Yes |
| 4 | Settings | `settings.json` inside the archive | Yes |
| 5 | Secrets | Nowhere — see [step 3](#3-configure-environment-variables) | **No, by design** |

Secrets are deliberately absent. An archive that carried the database password
would turn every downloaded backup into a credential leak.

---

## 0. The only step that must happen in advance

**Download at least one archive and keep it somewhere that is not Replit.**

Backups are written to this app's own object storage. That protects you from a
bad edit, a wrong delete or a broken migration — the everyday disasters. It does
**not** protect you from losing the Replit account or the project, because the
backup would go with it. A copy that shares a blast radius with the original is a
convenience copy, not disaster recovery.

Company → Backup & Restore → download icon on any row. The page shows a
"Copy kept off Replit" tile that stays amber until you have done this.

**Also keep the source code pushed to GitHub.** At the time of writing, the
GitHub `origin` is reachable but sits at a *different commit* from the local
working copy, so a recovery cloning `origin` today would come back with older
code than is running. Push before you rely on this document:

```bash
git push origin main
```

There is a second remote, `gitsafe-backup`, which is Replit's internal checkpoint
store. It is not a substitute — it is reachable only from inside Replit, which is
exactly what you may have lost.

---

## Recovery procedure

### 1. Clone the source code

```bash
git clone https://github.com/rafinfarooque1/MarlinERP.git
cd MarlinERP
pnpm install
```

This is a pnpm monorepo. `pnpm install` from the root is required — installing
inside a single package will not link the shared libraries.

### 2. Create a PostgreSQL database

Any PostgreSQL **16.x** server. The archive records the version it came from
(`version.json` → `databaseVersion`); restoring into an *older* major version
will fail, and the ERP will tell you so rather than restoring half the data.

The database must be **empty**. Restore replaces everything it touches, but it
does not clean up unrelated tables left behind by something else.

### 3. Configure environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Full connection string for the database from step 2. |
| `SESSION_SECRET` | Yes | Any long random string. **Does not need to match the old one** — see [signatures](#about-the-signature-warning). |
| `PRIVATE_OBJECT_DIR` | For files | Where uploads and archives are stored. |
| `PUBLIC_OBJECT_SEARCH_PATHS` | For files | Public asset lookup paths. |
| `ALLOWED_ORIGINS` | Optional | CORS allow-list. Defaults to the dev domain. |
| `TOKEN_MAX_AGE_HOURS` | Optional | Session lifetime. Defaults to 8 hours. |
| `NODE_ENV` | Optional | Set to `production` when deploying. |

`pg_dump`, `pg_restore` and `psql` must be on the PATH — the module shells out to
the real PostgreSQL tools rather than hand-rolling SQL, and their major version
must be **at least** the server's.

### 4. Start the ERP and sign in

Start the API server and the web app. On first boot with an empty database the
server creates its schema and **seeds a default administrator if no user exists**.

That seeding is what makes this recoverable at all: without it, restoring a
database you cannot log in to would be a locked door with the key inside. Change
that password immediately after step 9.

### 5. Open Backup & Restore

Company → Backup & Restore.

Restore is limited to **Head Office users with Approve rights** on this page.
A level-1 (Management) account has it implicitly, which includes the seeded
administrator.

### 6. Upload the archive

"Upload an archive" and pick the ZIP you kept in step 0.

It is streamed straight to disk, validated, and then catalogued exactly like a
backup this server made itself. Validation runs immediately — read the findings
before continuing. **Errors** block the restore; **warnings** do not.

#### About the signature warning

You will almost certainly see the signature reported as **unverifiable**, and on
a recovered host that is the *correct and expected* result — not a sign of
tampering.

The manifest is signed with a key derived from `SESSION_SECRET`. A new host has a
new secret, so it cannot reproduce the old signature. Nothing is wrong. What
still protects you is the SHA-256 checksum recorded for every file inside the
archive: those are verified on every validation and would catch real corruption
or alteration. A signature that could be checked anywhere would have required
shipping the key inside the archive, which would make it worthless.

`invalid` is different, and means the manifest does not match its signature on a
host that *can* check it. Do not restore that archive.

### 7. Restore

Click the restore icon on the uploaded row, confirm with your password, and let
it run. It performs, in order:

1. Validate the archive.
2. **Take a safety backup of the current data** — the undo button for this restore.
3. Restore the database, inside a single transaction.
4. Write the uploaded files back to storage.
5. Restore settings and resynchronise voucher numbering.
6. Verify the result against the manifest.

**If step 3 fails, nothing was changed.** PostgreSQL applies DDL
transactionally, so a failed database restore leaves the database **exactly** as
it was, and the page says so: "Your data was not changed".

**If a step after 3 fails, part of the restore is already applied** — the
database has been replaced even though the overall restore is reported as failed.
The page says that too, and names the safety backup from step 2 to restore in
order to get back. Read the "State of your data" line in the failure report
rather than assuming either outcome; it is the one line that distinguishes them.

There is no automatic rollback. Reversing a partial restore means restoring the
safety backup, which is itself a restore, and running one automatically while the
system is already in an unexpected state risks turning one problem into two.

Uploaded files and settings ride along with a `complete` archive; there is no
separate "restore files" or "restore settings" action to run afterwards.

### 8. Restart the server

The restore report ends by telling you to do this, and it matters: the database
was replaced underneath a running application, so open connections and cached
query results may still describe the old data. Until the restart, pages can show
stale or inconsistent figures.

### 9. Verify, then re-secure

Check the verification list in the restore report — row counts against the
manifest, structure fingerprint, and a double-entry check that debits equal
credits. Then, by hand:

- Sign in as a real user.
- Open Accounts → Trial Balance and confirm it balances.
- Spot-check the most recent sale, production batch and payment you remember.
- **Change the seeded administrator password**, and confirm the user list is the
  one you expect.
- Take a fresh backup, download it, and put it somewhere off-platform. You are
  now protecting a new system.

After a successful restore the ERP holds exactly what it held when the backup was
taken. Anything recorded after that moment is not in the archive and is gone.

---

## What is deliberately *not* in a backup

- **Secrets and connection strings** — see the table above.
- **The backup catalogue itself.** The list of backups, the schedule, and the
  restore history live in a separate `backup_meta` schema that is excluded from
  every dump. If they were included, restoring last week's archive would roll the
  catalogue back to last week and erase the record of every newer archive —
  including the safety copy the restore had just taken, leaving it orphaned in
  storage with nothing pointing at it. The catalogue describes *this host*, not
  the company's data, so it is rebuilt empty and starts recording again.
- **`node_modules` and build output** — recreated by `pnpm install`.

## Retention, and what can be deleted

Automatic pruning only ever removes **automatic** backups and **safety copies**.
Backups a person created are never deleted for them, and the newest safety copy
is never pruned — it is the undo button for the last restore. The delete button
refuses it for the same reason.

## Scheduling

The scheduler is an hourly catch-up, not a fixed midnight tick: every hour it
asks whether a backup is now due and takes one if so. A container that was asleep
or restarting at the scheduled minute therefore still gets its backup, late
rather than never.

## Proving a backup works before you need it

Use **Verify** (the flask icon) on any row. It restores the archive into a
throwaway database, recounts every table against the manifest, compares the
schema fingerprint, and checks that debits equal credits — then deletes the
scratch database. It touches nothing live, so it is safe to run any time.

An untested backup is a hope, not a plan. The page marks archives "Proven" only
once they have actually been restored somewhere.
