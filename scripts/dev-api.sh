#!/bin/sh
# Starts the API for local/preview development.
# If no SESSION_SECRET is configured, a random dev-only key is generated once
# into a git-ignored file so logins survive restarts. A SESSION_SECRET set in
# .env.development.local (project Vars) is loaded afterwards and takes precedence.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_SECRET_FILE="$ROOT/.dev-session-secret.env"

if [ ! -f "$DEV_SECRET_FILE" ]; then
  node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64'))" > "$DEV_SECRET_FILE"
  chmod 600 "$DEV_SECRET_FILE"
fi

cd "$ROOT/artifacts/api-server"
pnpm run build
NODE_ENV=development PORT="${API_PORT:-8080}" exec node \
  --env-file-if-exists="$DEV_SECRET_FILE" \
  --env-file-if-exists="$ROOT/.env.development.local" \
  --enable-source-maps ./dist/index.mjs
