#!/bin/sh
# Registers WABrain's signed webhook in the bundled OpenWA, once (safe to re-run).
#
# Runs deploy/scripts/register-webhook.mjs inside a one-off API container, on the compose network,
# with the API service's OPENWA_BASE_URL, OPENWA_SESSION_ID and OPENWA_WEBHOOK_SECRET. The OpenWA
# admin key is handed to that one-off container only, to mint an operator key that expires in
# 10 minutes and is deleted right after use. The running API and worker never receive it.
#
# Usage:
#   deploy/register-webhook.sh                  # admin key from OPENWA_API_MASTER_KEY in deploy/.env
#   OPENWA_OPERATOR_KEY=... deploy/register-webhook.sh   # use a short-lived operator key you created
#   WEBHOOK_URL=https://brain.example.com/webhooks/openwa deploy/register-webhook.sh
# Extra arguments are passed to "docker compose" (e.g. -p myproject).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
env_file="$here/.env"

if [ -z "${OPENWA_OPERATOR_KEY:-}" ] && [ -z "${OPENWA_ADMIN_KEY:-}" ] && [ -f "$env_file" ]; then
  OPENWA_ADMIN_KEY=$(sed -n 's/^[[:space:]]*OPENWA_API_MASTER_KEY[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//')
fi
export OPENWA_ADMIN_KEY="${OPENWA_ADMIN_KEY:-}" OPENWA_OPERATOR_KEY="${OPENWA_OPERATOR_KEY:-}"
export WEBHOOK_URL="${WEBHOOK_URL:-http://api:8787/webhooks/openwa}"

# -e NAME (without a value) copies the variable from this shell, so keys never appear in arguments.
exec docker compose -f "$here/docker-compose.yml" "$@" run --rm --no-deps \
  -e OPENWA_ADMIN_KEY -e OPENWA_OPERATOR_KEY -e WEBHOOK_URL \
  api node scripts/register-webhook.mjs
