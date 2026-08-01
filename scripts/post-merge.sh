#!/bin/bash
set -e

# Post-merge setup: dependencies + build only.
#
# DO NOT add `drizzle-kit push` (or push-force) here. Most of this project's
# schema — dozens of tables and columns — is created by raw SQL boot
# migrations in artifacts/api-server/src/index.ts and is INVISIBLE to
# lib/db/src/schema/*.ts. `drizzle-kit push --force` DROPS everything it
# cannot see; on 2026-08-01 it deleted 27 tables (the entire accounting
# layer) from the development database. Schema changes are applied by the
# API server's own boot migrations when the workflow restarts after merge.
pnpm install --frozen-lockfile
